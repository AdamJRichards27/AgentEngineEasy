import { Router } from "express";
import { sql } from "drizzle-orm";
import { db, EXPECTED_MIGRATIONS } from "@aee/db";
import { logger, observeHistogram } from "@aee/events";
import { dispatchOperationalAlert } from "../lib/operationalAlerts.js";
import { checkDocumentStorageReadiness } from "../lib/documentStorage.js";
import { failedStartupTaskNames } from "../lib/startupHealth.js";
import { isProductionEnvironment } from "../lib/env.js";

export const healthRouter = Router();

// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Liveness/readiness/degraded split (previously one combined "/" check
// that conflated "is the process alive" with "can it reach the
// database"). The distinction matters operationally: an orchestrator that
// restarts the process on a failed *liveness* check will happily
// kill-and-restart a perfectly healthy process during a transient DB
// blip, which does nothing to fix the DB and adds a restart storm on top
// of it. Readiness failing should pull the instance out of load-balancer
// rotation; liveness failing should trigger a restart. Two different
// signals, two different endpoints.
//
// - GET /api/health/live  — liveness. True as soon as this Express
//   process can execute a handler at all. No dependency checks: if the
//   process is genuinely wedged (event loop blocked), it won't even get
//   here, and that's what an orchestrator's liveness-probe TIMEOUT should
//   catch — this handler's own logic never needs to detect that itself.
// - GET /api/health/ready — readiness. Checks both hard dependencies this
//   API cannot function without: Postgres and durable document storage.
//   Three provable states:
//     ok         — dependency checks succeeded within DEGRADED_LATENCY_MS.
//     degraded   — a dependency check succeeded but took longer than
//                  DEGRADED_LATENCY_MS (still 200 — keep routing traffic,
//                  this is a signal for an alert, not a reason to fail
//                  out of rotation).
//     unavailable — a dependency check failed or is unreachable (503).
//   AE GROW Pilot Readiness WP2a additionally checks drizzle's migration
//   bookkeeping table against the journal embedded in this build
//   (packages/db EXPECTED_MIGRATIONS):
//     behind    — the table has >= 1 row but fewer than expected, or its
//                 newest row predates the build's newest migration:
//                 "unavailable" in EVERY environment (a migration-managed
//                 database that is behind is a real defect).
//     untracked — the table is missing or empty (a `drizzle-kit push`-managed
//                 database, e.g. Replit dev): "unavailable" in production
//                 (the pilot runbook requires db:migrate — fail closed);
//                 outside production the instance stays ready and the
//                 /ready body carries `migrations: "untracked
//                 (push-managed database)"`, with a warning logged once per
//                 process.
//   and makes readiness "unavailable" when a readiness-tracked boot task
//   (entitlement catalogue seed, run.access backfill, Stage 2 workflow
//   catalogue seed — lib/startupHealth.ts) failed.
// - GET /api/health — kept byte-for-byte identical to its pre-Step-2
//   response shape ({status, service} / {status, service, database}) for
//   backward compatibility with anything already depending on it; it now
//   delegates to the same readiness check as /ready rather than
//   duplicating the query.

const DEGRADED_LATENCY_MS = 500;

export type ReadinessStatus = "ok" | "degraded" | "unavailable";
export const UNTRACKED_MIGRATIONS_WARNING = "untracked (push-managed database)";

export interface ReadinessResult {
  status: ReadinessStatus;
  durationMs: number;
  reasons: string[];
  /** Present only for a non-production, push-managed (untracked) database. */
  migrations?: typeof UNTRACKED_MIGRATIONS_WARNING;
}

export interface MigrationStatus {
  applied: number;
  latestAppliedWhen: number | null;
  expected: number;
  expectedLatestTag: string;
  upToDate: boolean;
  /** True when the bookkeeping table is missing or has zero rows (push-managed database). */
  untracked: boolean;
}

/**
 * Compares drizzle's own bookkeeping table against the migration journal
 * embedded in this build. A missing bookkeeping table (a database created
 * with `drizzle-kit push`, never baselined — see
 * docs/foundation-remediation/F3_BUILD_SAFETY_AND_MIGRATIONS.md) or an
 * empty one is reported as `untracked` — see the module comment for how
 * readiness treats that per environment.
 */
export async function checkMigrationStatus(): Promise<MigrationStatus> {
  const presence = await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  const present = Boolean((presence.rows?.[0] as { present?: unknown } | undefined)?.present);
  let applied = 0;
  let latestAppliedWhen: number | null = null;
  if (present) {
    const result = await db.execute(
      sql`select count(*)::int as applied, max(created_at)::text as latest from drizzle.__drizzle_migrations`,
    );
    const row = (result.rows?.[0] ?? {}) as { applied?: unknown; latest?: unknown };
    applied = Number(row.applied ?? 0);
    latestAppliedWhen = row.latest === null || row.latest === undefined ? null : Number(row.latest);
  }
  // drizzle's migrator treats a migration as applied when its journal
  // `when` is <= the latest recorded created_at; require that AND the
  // row count, so neither a truncated table nor a stale latest row passes.
  const upToDate =
    applied >= EXPECTED_MIGRATIONS.count &&
    latestAppliedWhen !== null &&
    latestAppliedWhen >= EXPECTED_MIGRATIONS.latestWhen;
  return {
    applied,
    latestAppliedWhen,
    expected: EXPECTED_MIGRATIONS.count,
    expectedLatestTag: EXPECTED_MIGRATIONS.latestTag,
    upToDate,
    untracked: applied === 0,
  };
}

let untrackedMigrationsWarned = false;

/** Test hook: re-arms the once-per-process untracked-migrations warning. */
export function __resetUntrackedMigrationsWarningForTesting(): void {
  untrackedMigrationsWarned = false;
}

/** Exported for tests — runs the actual dependency check without touching Express req/res, so the three-state logic can be asserted directly rather than only through an HTTP response. */
export async function checkReadiness(): Promise<ReadinessResult> {
  const start = process.hrtime.bigint();
  const reasons: string[] = [];
  let status: ReadinessStatus = "ok";
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.error("readiness_check_failed", { error: err instanceof Error ? err.message : String(err), durationMs });
    await dispatchOperationalAlert({
      type: "DB_READINESS_FAILURE",
      summary: "Database readiness check failed",
      dedupKey: "readiness:database",
      details: { durationMs },
    });
    observeHistogram("health_check_duration_ms", durationMs, { status: "unavailable" });
    return { status: "unavailable", durationMs, reasons: ["database unreachable"] };
  }
  const databaseDurationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  let migrations: MigrationStatus;
  try {
    migrations = await checkMigrationStatus();
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.error("readiness_migration_check_failed", { error: err instanceof Error ? err.message : String(err), durationMs });
    await dispatchOperationalAlert({
      type: "DB_READINESS_FAILURE",
      summary: "Database migration status could not be read",
      dedupKey: "readiness:migrations",
      details: { durationMs },
    });
    observeHistogram("health_check_duration_ms", durationMs, { status: "unavailable" });
    return { status: "unavailable", durationMs, reasons: ["database migration status unavailable"] };
  }
  let migrationsWarning: ReadinessResult["migrations"];
  if (!migrations.upToDate && migrations.untracked && !isProductionEnvironment()) {
    migrationsWarning = UNTRACKED_MIGRATIONS_WARNING;
    if (!untrackedMigrationsWarned) {
      untrackedMigrationsWarned = true;
      logger.warn("readiness_migrations_untracked", {
        expected: migrations.expected,
        expectedLatestTag: migrations.expectedLatestTag,
        operatorAction:
          "drizzle.__drizzle_migrations is missing or empty (push-managed database). Readiness does not " +
          "verify the schema outside production; production refuses readiness until db:migrate has run.",
      });
    }
  } else if (!migrations.upToDate) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.error("readiness_migrations_pending", {
      applied: migrations.applied,
      expected: migrations.expected,
      expectedLatestTag: migrations.expectedLatestTag,
      latestAppliedWhen: migrations.latestAppliedWhen,
    });
    await dispatchOperationalAlert({
      type: "DB_READINESS_FAILURE",
      summary: "Database migrations are behind this build",
      dedupKey: "readiness:migrations",
      details: { applied: migrations.applied, expected: migrations.expected, expectedLatestTag: migrations.expectedLatestTag },
    });
    observeHistogram("health_check_duration_ms", durationMs, { status: "unavailable" });
    return {
      status: "unavailable",
      durationMs,
      reasons: [
        migrations.untracked
          ? `database migrations untracked: drizzle.__drizzle_migrations is missing or empty (0 of ${migrations.expected} recorded; production requires db:migrate)`
          : `database migrations not fully applied (${migrations.applied} of ${migrations.expected} recorded)`,
      ],
    };
  }
  const failedStartupTasks = failedStartupTaskNames();
  if (failedStartupTasks.length > 0) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    // Already logged and alerted once at failure time (lib/startupHealth.ts).
    observeHistogram("health_check_duration_ms", durationMs, { status: "unavailable" });
    return {
      status: "unavailable",
      durationMs,
      reasons: failedStartupTasks.map((task) => `startup task failed: ${task}`),
    };
  }
  const storageStart = process.hrtime.bigint();
  const storage = await checkDocumentStorageReadiness();
  const storageDurationMs = Number(process.hrtime.bigint() - storageStart) / 1_000_000;
  if (!storage.ready) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.error("storage_readiness_check_failed", {
      error: storage.message ?? "object storage unavailable",
      durationMs,
    });
    await dispatchOperationalAlert({
      type: "STORAGE_READINESS_FAILURE",
      summary: "Document storage readiness check failed",
      dedupKey: "readiness:document-storage",
      details: { durationMs },
    });
    observeHistogram("health_check_duration_ms", durationMs, { status: "unavailable" });
    return { status: "unavailable", durationMs, reasons: ["document storage unreachable"] };
  }
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  if (databaseDurationMs > DEGRADED_LATENCY_MS) {
    status = "degraded";
    reasons.push(`database query took ${databaseDurationMs.toFixed(1)}ms (> ${DEGRADED_LATENCY_MS}ms threshold)`);
  }
  if (storageDurationMs > DEGRADED_LATENCY_MS) {
    status = "degraded";
    reasons.push(`document storage check took ${storageDurationMs.toFixed(1)}ms (> ${DEGRADED_LATENCY_MS}ms threshold)`);
  }
  if (status === "degraded") {
    logger.warn("readiness_check_degraded", {
      durationMs,
      databaseDurationMs,
      storageDurationMs,
      thresholdMs: DEGRADED_LATENCY_MS,
    });
  }
  observeHistogram("health_check_duration_ms", durationMs, { status });
  return migrationsWarning ? { status, durationMs, reasons, migrations: migrationsWarning } : { status, durationMs, reasons };
}

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok", service: "agent-engine-easy-api" });
});

healthRouter.get("/ready", async (_req, res) => {
  const result = await checkReadiness();
  if (result.status === "unavailable") {
    res.status(503).json({ status: "unavailable", service: "agent-engine-easy-api", reasons: result.reasons });
    return;
  }
  res.status(200).json({
    status: result.status,
    service: "agent-engine-easy-api",
    reasons: result.reasons,
    ...(result.migrations ? { migrations: result.migrations } : {}),
  });
});

// Backward-compatible combined endpoint — see module comment. Response
// shape deliberately unchanged from before Step 2: {status: "ok"} /
// {status: "degraded", database: "unreachable"}, 503 only on the
// unavailable case (the degraded-latency case, new in Step 2, is folded
// into "ok" here so nothing that already parses this exact shape breaks —
// GET /ready is the endpoint that surfaces the three-state distinction).
healthRouter.get("/", async (_req, res) => {
  const result = await checkReadiness();
  if (result.status === "unavailable") {
    res.status(503).json({ status: "degraded", service: "agent-engine-easy-api", database: "unreachable" });
    return;
  }
  res.json({ status: "ok", service: "agent-engine-easy-api" });
});
