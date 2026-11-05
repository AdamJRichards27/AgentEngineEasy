// Owner t277u item 7: scheduled expiry and deletion for contact exports and sensitive audit values.
//   - Exports: no export FILE is ever stored (the CSV is generated at download time), so the
//     only export data at rest is the scope (contact id list) in the contact_export_prepared
//     row. After the 7-day window the sweep deletes that scope (ids replaced by a count +
//     expiredAt) and writes contact_export_expired. Downloads already 410 after 7 days.
//   - Audit values: encrypted before/after values past value retention (default 2 years) are
//     replaced by "[expired]"; metadata stays (7-year policy, never deleted here).
// Observable: a run record per run (audit_logs retention_sweep_run with counts, duration,
// failed ids), metrics retention_sweep_run_total / retention_sweep_item_total, structured logs.
// Idempotent and retry-safe: each item is a compare-and-set on its own row; already-processed
// rows no longer match the selection; a failed item is simply picked up by the next run.
// OPT-IN scheduling: AE_RETENTION_SWEEP_ENABLED=true (never under NODE_ENV=test), interval
// AE_RETENTION_SWEEP_INTERVAL_MINUTES (default 60). In-process overlap guard.
import { and, eq, lt, notLike } from "drizzle-orm";
import { auditLogs, db } from "@aee/db";
import { incrementCounter, logger } from "@aee/events";
import { purgeExpiredAuditValues } from "./auditValueVault.js";

export const EXPORT_TTL_DAYS = 7;

export async function expireExports(now: Date = new Date(), opts: { failOn?: Set<number> } = {}): Promise<{ examined: number; expired: number; failed: number[] }> {
  const cutoff = new Date(now.getTime() - EXPORT_TTL_DAYS * 86_400_000);
  const rows = await db
    .select({ id: auditLogs.id, brokerageId: auditLogs.brokerageId, updatedValue: auditLogs.updatedValue, providerReference: auditLogs.providerReference })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "contact_export_prepared"), lt(auditLogs.createdAt, cutoff), notLike(auditLogs.updatedValue, '%"expiredAt"%')));
  let expired = 0;
  const failed: number[] = [];
  for (const r of rows) {
    try {
      if (opts.failOn?.has(r.id)) throw new Error("injected failure");
      const meta = JSON.parse(r.updatedValue ?? "{}") as { scope?: { partyIds?: number[]; [k: string]: unknown }; [k: string]: unknown };
      const partyCount = meta.scope?.partyIds?.length ?? 0;
      const scrubbed = { ...meta, scope: { ...(meta.scope ?? {}), partyIds: [], partyCount }, expiredAt: now.toISOString() };
      await db.transaction(async (tx) => {
        const done = await tx
          .update(auditLogs)
          .set({ updatedValue: JSON.stringify(scrubbed) })
          .where(and(eq(auditLogs.id, r.id), eq(auditLogs.updatedValue, r.updatedValue ?? "")))
          .returning({ id: auditLogs.id });
        if (!done.length) return; // processed concurrently — idempotent
        await tx.insert(auditLogs).values({ brokerageId: r.brokerageId, userId: null, action: "contact_export_expired", recordType: "contact_export", recordId: String(r.id), providerReference: r.providerReference, updatedValue: JSON.stringify({ exportId: r.id, partyCount, deleted: "scope", at: now.toISOString() }) });
        expired++;
      });
    } catch {
      failed.push(r.id);
    }
  }
  return { examined: rows.length, expired, failed };
}

let running = false;
export async function runRetentionSweep(now: Date = new Date(), opts: { failExports?: Set<number>; failAuditValues?: Set<number> } = {}) {
  if (running) {
    incrementCounter("retention_sweep_run_total", { outcome: "skipped_overlap" });
    return { outcome: "skipped_overlap" as const };
  }
  running = true;
  const started = Date.now();
  try {
    const exports = await expireExports(now, { failOn: opts.failExports });
    const values = await purgeExpiredAuditValues(now, { failOn: opts.failAuditValues });
    incrementCounter("retention_sweep_item_total", { kind: "export", outcome: "processed" }, exports.expired);
    incrementCounter("retention_sweep_item_total", { kind: "export", outcome: "failed" }, exports.failed.length);
    incrementCounter("retention_sweep_item_total", { kind: "audit_value", outcome: "processed" }, values.purged);
    incrementCounter("retention_sweep_item_total", { kind: "audit_value", outcome: "failed" }, values.failed.length);
    const outcome = exports.failed.length || values.failed.length ? ("partial" as const) : ("completed" as const);
    const record = {
      outcome,
      durationMs: Date.now() - started,
      exports: { examined: exports.examined, expired: exports.expired, failed: exports.failed.length, failedIds: exports.failed.slice(0, 50) },
      auditValues: { examined: values.examined, purged: values.purged, failed: values.failed.length, failedIds: values.failed.slice(0, 50) },
      at: now.toISOString(),
    };
    const [run] = await db.insert(auditLogs).values({ brokerageId: null, userId: null, action: "retention_sweep_run", recordType: "retention_sweep", recordId: "system", updatedValue: JSON.stringify(record) }).returning({ id: auditLogs.id });
    incrementCounter("retention_sweep_run_total", { outcome });
    logger.info("retention_sweep_run", { runId: run.id, ...record, exports: { ...record.exports, failedIds: undefined }, auditValues: { ...record.auditValues, failedIds: undefined } });
    return { ...record, runId: run.id };
  } catch (err) {
    incrementCounter("retention_sweep_run_total", { outcome: "failed" });
    logger.error("retention_sweep_failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    running = false;
  }
}

let registered = false;
let handle: ReturnType<typeof setInterval> | null = null;
export function registerRetentionSweep(options: { startScheduler?: boolean } = {}): void {
  if (registered) return;
  registered = true;
  const enabled = process.env.AE_RETENTION_SWEEP_ENABLED === "true";
  const minutes = Math.max(5, Math.min(1440, Number(process.env.AE_RETENTION_SWEEP_INTERVAL_MINUTES ?? 60) || 60));
  const start = options.startScheduler ?? (enabled && process.env.NODE_ENV !== "test");
  if (!start) {
    logger.info("retention_sweep_scheduler_disabled", { enabled, nodeEnv: process.env.NODE_ENV ?? null });
    return;
  }
  handle = setInterval(() => {
    runRetentionSweep().catch(() => undefined);
  }, minutes * 60_000);
  handle.unref?.();
  logger.info("retention_sweep_scheduler_started", { intervalMinutes: minutes });
}
export function stopRetentionSweepScheduler(): void {
  if (handle) clearInterval(handle);
  handle = null;
}
