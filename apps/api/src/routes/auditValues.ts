// Owner t276u: restricted access to encrypted before/after contact values in audit_logs.
// Only a Brokerage Administrator of the row's brokerage who is explicitly listed in
// AE_AUDIT_VALUE_READER_USER_IDS (deploy config, empty by default), with a stated reason.
// Every access AND every refusal is itself audited (audit_values_accessed /
// audit_values_access_refused). Rows past retention return 410.
import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { auditLogs, db } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { AuditValueUnavailable, ENVELOPE_PREFIX, isPastRetention, openAuditValue } from "../lib/auditValueVault.js";

export const auditValuesRouter = Router();

function readers(): Set<number> {
  return new Set(
    String(process.env.AE_AUDIT_VALUE_READER_USER_IDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

const body = z.object({ reason: z.string().trim().min(5).max(500) });

auditValuesRouter.post("/audit/contact-values/:auditId", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const auditId = Number(req.params.auditId);
  const parsed = body.safeParse(req.body);
  const note = async (action: string, extra: Record<string, unknown>) =>
    logAudit(
      {
        brokerageId: user.brokerageId,
        userId: user.id,
        action,
        recordType: "audit_log",
        recordId: String(Number.isInteger(auditId) ? auditId : 0),
        updatedValue: JSON.stringify({ performedBy: { userId: user.id, role: user.role }, reason: parsed.success ? parsed.data.reason : null, ...extra }),
      },
      { strict: true },
    );
  if (user.role !== "Brokerage Administrator" || !readers().has(user.id)) {
    await note("audit_values_access_refused", { refusal: "NOT_AUTHORISED" });
    res.status(403).json({ error: "Access to audited contact values is restricted.", code: "AUDIT_VALUES_RESTRICTED" });
    return;
  }
  if (!parsed.success) {
    await note("audit_values_access_refused", { refusal: "REASON_REQUIRED" });
    res.status(400).json({ error: "A reason (5-500 characters) is required.", code: "AUDIT_VALUES_REASON_REQUIRED" });
    return;
  }
  if (!Number.isInteger(auditId) || auditId <= 0) {
    res.status(400).json({ error: "Invalid audit id" });
    return;
  }
  const [row] = await db.select().from(auditLogs).where(and(eq(auditLogs.id, auditId), eq(auditLogs.brokerageId, user.brokerageId))).limit(1);
  const hasValues = !!row && ((row.previousValue ?? "").includes(ENVELOPE_PREFIX) || (row.updatedValue ?? "").includes(ENVELOPE_PREFIX) || (row.updatedValue ?? "").includes("[expired]") || (row.previousValue ?? "") === "[expired]");
  if (!row || !hasValues) {
    await note("audit_values_access_refused", { refusal: "NOT_FOUND" });
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (isPastRetention(row.createdAt) || row.previousValue === "[expired]" || (row.updatedValue ?? "").includes("[expired]")) {
    await note("audit_values_access_refused", { refusal: "EXPIRED" });
    res.status(410).json({ error: "These values are past their retention period.", code: "AUDIT_VALUE_EXPIRED" });
    return;
  }
  try {
    const meta = row.updatedValue ? (JSON.parse(row.updatedValue) as Record<string, unknown>) : {};
    const before = row.previousValue?.startsWith(ENVELOPE_PREFIX) ? openAuditValue(row.previousValue) : null;
    const after = typeof meta.after === "string" && meta.after.startsWith(ENVELOPE_PREFIX) ? openAuditValue(meta.after) : null;
    await note("audit_values_accessed", { fields: meta.fields ?? null });
    res.setHeader("Cache-Control", "no-store");
    res.json({ auditId, action: row.action, recordType: row.recordType, recordId: row.recordId, createdAt: row.createdAt, before, after, fields: meta.fields ?? null, requestedBy: meta.requestedBy ?? null, performedBy: meta.performedBy ?? null, authorityRef: meta.authorityRef ?? null });
  } catch (err) {
    const reason = err instanceof AuditValueUnavailable ? err.reason : "KEY_MISMATCH";
    await note("audit_values_access_refused", { refusal: reason });
    res.status(503).json({ error: "These values cannot be decrypted with the configured key.", code: "AUDIT_VALUE_UNAVAILABLE", reason });
  }
});
