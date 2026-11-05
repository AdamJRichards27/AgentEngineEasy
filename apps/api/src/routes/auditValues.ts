// Owner t276u: restricted access to encrypted before/after contact values in audit_logs.
// Only a Brokerage Administrator of the row's brokerage who is explicitly listed in
// AE_AUDIT_VALUE_READER_USER_IDS (deploy config, empty by default), with a stated reason.
// Every access AND every refusal is itself audited (audit_values_accessed /
// audit_values_access_refused). Rows past retention return 410.
import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { auditLogs, db } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { AUDIT_METADATA_RETENTION_DAYS, AuditValueUnavailable, ENVELOPE_PREFIX, isPastRetention, openAuditValue, retentionDays } from "../lib/auditValueVault.js";

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

// ---------------------------------------------------------------------------------------------
// t280u read contracts for the desktop audit screens. Values are NEVER returned by these routes.
// ---------------------------------------------------------------------------------------------

/** Server-authoritative capability: may this caller read encrypted audit values? */
export function isAuditValueReader(user: { id: number; role: string }): boolean {
  return user.role === "Brokerage Administrator" && readers().has(user.id);
}

auditValuesRouter.get("/audit/capabilities", requireAuth, (req, res) => {
  const user = req.authedUser!;
  res.setHeader("Cache-Control", "no-store");
  res.json({
    isAuditValueReader: isAuditValueReader(user),
    // Authoritative for the Settings "Audit history" card and both metadata routes.
    canReadAuditMetadata: user.role === "Brokerage Administrator",
    canReadAuditAccessHistory: user.role === "Brokerage Administrator",
    valueRetentionDays: retentionDays(),
    metadataRetentionDays: AUDIT_METADATA_RETENTION_DAYS,
  });
});

async function metadataGate(req: import("express").Request, res: import("express").Response, route: string): Promise<boolean> {
  const user = req.authedUser!;
  if (user.role === "Brokerage Administrator") {
    // t284u: same-brokerage administrators may read metadata and access history; every read is logged.
    await logAudit({ brokerageId: user.brokerageId, userId: user.id, action: "audit_metadata_viewed", recordType: "audit_log", recordId: "0", updatedValue: JSON.stringify({ route, query: { recordType: typeof req.query.recordType === "string" ? req.query.recordType.slice(0, 64) : null, recordId: typeof req.query.recordId === "string" ? req.query.recordId.slice(0, 64) : null, auditId: typeof req.query.auditId === "string" ? req.query.auditId.slice(0, 12) : null }, performedBy: { userId: user.id, role: user.role } }) }, { strict: true });
    return true;
  }
  await logAudit({ brokerageId: user.brokerageId, userId: user.id, action: "audit_metadata_access_refused", recordType: "audit_log", recordId: "0", updatedValue: JSON.stringify({ route, performedBy: { userId: user.id, role: user.role } }) }, { strict: true });
  res.status(403).json({ error: "Audit history is restricted to brokerage administrators.", code: "AUDIT_METADATA_RESTRICTED" });
  return false;
}

const VALUE_ACCESS_ACTIONS = ["audit_values_accessed", "audit_values_access_refused"];

// GET /audit/metadata?recordType=&recordId=&beforeId=&limit= — same-brokerage metadata only.
auditValuesRouter.get("/audit/metadata", requireAuth, async (req, res) => {
  if (!(await metadataGate(req, res, "metadata"))) return;
  const user = req.authedUser!;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const beforeId = Number(req.query.beforeId);
  const conds = [eq(auditLogs.brokerageId, user.brokerageId)];
  if (typeof req.query.recordType === "string" && req.query.recordType.length > 0 && req.query.recordType.length <= 64) conds.push(eq(auditLogs.recordType, req.query.recordType));
  if (typeof req.query.recordId === "string" && /^[\w:-]{1,64}$/.test(req.query.recordId)) conds.push(eq(auditLogs.recordId, req.query.recordId));
  if (Number.isInteger(beforeId) && beforeId > 0) conds.push(lt(auditLogs.id, beforeId));
  const rows = await db
    .select({ id: auditLogs.id, action: auditLogs.action, recordType: auditLogs.recordType, recordId: auditLogs.recordId, userId: auditLogs.userId, createdAt: auditLogs.createdAt, previousValue: auditLogs.previousValue, updatedValue: auditLogs.updatedValue })
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.id))
    .limit(limit);
  const valueDays = retentionDays();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    entries: rows.map((r) => {
      const hasValues = (r.previousValue ?? "").includes(ENVELOPE_PREFIX) || (r.updatedValue ?? "").includes(ENVELOPE_PREFIX);
      const valuesExpired = r.previousValue === "[expired]" || (r.updatedValue ?? "").includes("[expired]") || (hasValues && isPastRetention(r.createdAt));
      return {
        auditId: r.id,
        action: r.action,
        recordType: r.recordType,
        recordId: r.recordId,
        userId: r.userId,
        createdAt: r.createdAt,
        hasEncryptedValues: hasValues && !valuesExpired,
        valuesExpired,
        valuesRetainedUntil: hasValues || valuesExpired ? new Date(r.createdAt.getTime() + valueDays * 86_400_000).toISOString() : null,
        metadataRetainedUntil: new Date(r.createdAt.getTime() + AUDIT_METADATA_RETENTION_DAYS * 86_400_000).toISOString(),
      };
    }),
    nextBeforeId: rows.length === limit ? rows[rows.length - 1].id : null,
  });
});

// GET /audit/access-history?auditId= — who read or was refused audit values (and why).
auditValuesRouter.get("/audit/access-history", requireAuth, async (req, res) => {
  if (!(await metadataGate(req, res, "access-history"))) return;
  const user = req.authedUser!;
  const conds = [eq(auditLogs.brokerageId, user.brokerageId), inArray(auditLogs.action, VALUE_ACCESS_ACTIONS)];
  if (req.query.auditId !== undefined) {
    if (!/^\d{1,10}$/.test(String(req.query.auditId))) {
      res.status(400).json({ error: "Invalid audit id", code: "AUDIT_ID_INVALID" });
      return;
    }
    conds.push(eq(auditLogs.recordId, String(req.query.auditId)));
  }
  const rows = await db
    .select({ id: auditLogs.id, action: auditLogs.action, recordId: auditLogs.recordId, userId: auditLogs.userId, createdAt: auditLogs.createdAt, updatedValue: auditLogs.updatedValue })
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.id))
    .limit(200);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    accesses: rows.map((r) => {
      const m = r.updatedValue ? (JSON.parse(r.updatedValue) as { reason?: string | null; refusal?: string; performedBy?: { role?: string } }) : {};
      return { id: r.id, auditId: Number(r.recordId), userId: r.userId, role: m.performedBy?.role ?? null, outcome: r.action === "audit_values_accessed" ? "accessed" : "refused", refusal: m.refusal ?? null, reason: m.reason ?? null, at: r.createdAt };
    }),
  });
});
