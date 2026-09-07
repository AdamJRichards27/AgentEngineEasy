import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@aee/db";
import { logger, observeHistogram } from "@aee/events";
import { dispatchOperationalAlert } from "../lib/operationalAlerts.js";
import { checkDocumentStorageReadiness } from "../lib/documentStorage.js";

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
// - GET /api/health — kept byte-for-byte identical to its pre-Step-2
//   response shape ({status, service} / {status, service, database}) for
//   backward compatibility with anything already depending on it; it now
//   delegates to the same readiness check as /ready rather than
//   duplicating the query.

const DEGRADED_LATENCY_MS = 500;

export type ReadinessStatus = "ok" | "degraded" | "unavailable";
export interface ReadinessResult {
  status: ReadinessStatus;
  durationMs: number;
  reasons: string[];
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
  return { status, durationMs, reasons };
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
  res.status(200).json({ status: result.status, service: "agent-engine-easy-api", reasons: result.reasons });
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
