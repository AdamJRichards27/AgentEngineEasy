// Owner t277u item 3: in-app notification when a contact export is ready for its owner,
// showing its expiry. Derived from audit_logs (no notifications table): an export the
// caller owns, prepared within the 7-day window, not yet expired, downloaded by the owner
// or dismissed. Never carries contact data — counts and dates only. No email is sent.
import { Router } from "express";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { auditLogs, db, users } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { EXPORT_TTL_DAYS } from "../lib/retentionSweep.js";

export const notificationsRouter = Router();

notificationsRouter.get("/notifications", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const since = new Date(Date.now() - EXPORT_TTL_DAYS * 86_400_000);
  const prepared = await db
    .select({ id: auditLogs.id, updatedValue: auditLogs.updatedValue, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.brokerageId, user.brokerageId), eq(auditLogs.action, "contact_export_prepared"), eq(auditLogs.providerReference, `owner:${user.id}`), gt(auditLogs.createdAt, since)))
    .orderBy(desc(auditLogs.id))
    .limit(20);
  if (prepared.length === 0) {
    res.json({ notifications: [] });
    return;
  }
  const ids = prepared.map((p) => String(p.id));
  const closed = new Set(
    (
      await db
        .select({ recordId: auditLogs.recordId })
        .from(auditLogs)
        .where(and(eq(auditLogs.brokerageId, user.brokerageId), eq(auditLogs.userId, user.id), eq(auditLogs.recordType, "contact_export"), inArray(auditLogs.action, ["contacts_exported", "notification_dismissed"]), inArray(auditLogs.recordId, ids)))
    ).map((r) => r.recordId),
  );
  const initiatorIds = [...new Set(prepared.map((p) => Number(JSON.parse(p.updatedValue ?? "{}").initiatedBy)).filter(Boolean))];
  const names = new Map(
    (initiatorIds.length ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, initiatorIds)) : []).map((u) => [u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()]),
  );
  const notifications = prepared
    .filter((p) => !closed.has(String(p.id)))
    .map((p) => {
      const m = JSON.parse(p.updatedValue ?? "{}") as { initiatedBy?: number; scope?: { partyIds?: number[] }; expiredAt?: string };
      return { m, p };
    })
    .filter(({ m }) => !m.expiredAt)
    .map(({ m, p }) => ({
      id: `export:${p.id}`,
      kind: "export_ready" as const,
      exportId: p.id,
      rows: m.scope?.partyIds?.length ?? 0,
      preparedAt: p.createdAt.toISOString(),
      expiresAt: new Date(p.createdAt.getTime() + EXPORT_TTL_DAYS * 86_400_000).toISOString(),
      preparedBy: m.initiatedBy === user.id ? "you" : (names.get(m.initiatedBy ?? 0) || "a colleague"),
      downloadPath: `/grow/contacts/exports/${p.id}/download`,
    }));
  res.setHeader("Cache-Control", "no-store");
  res.json({ notifications });
});

notificationsRouter.post("/notifications/:id/dismiss", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const m = /^export:(\d+)$/.exec(String(req.params.id));
  if (!m) {
    res.status(400).json({ error: "Unknown notification" });
    return;
  }
  const [row] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.id, Number(m[1])), eq(auditLogs.brokerageId, user.brokerageId), eq(auditLogs.action, "contact_export_prepared"), eq(auditLogs.providerReference, `owner:${user.id}`))).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await logAudit({ brokerageId: user.brokerageId, userId: user.id, action: "notification_dismissed", recordType: "contact_export", recordId: String(row.id) });
  res.json({ dismissed: true });
});
