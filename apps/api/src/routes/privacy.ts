import { Router } from "express";
import { eq, and, desc, count } from "drizzle-orm";
import { z } from "zod";
import { db, privacyRequests, users, PRIVACY_REQUEST_TYPES } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from "../lib/auth/legalVersions.js";

// Critical Blocker Remediation, Phase 8 — application privacy controls.
// See docs/legal/DATA_ACCESS_CORRECTION_DELETION_PROCESS.md for the
// participant-facing process this implements, and
// docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md / users/authTokens
// schema for the related consent-capture-at-invitation-acceptance flow
// (routes/auth.ts's POST /invitations/:token/accept).

export const privacyRouter = Router();

// Public — lets the frontend always link to/display the version it should
// ask the user to accept, without hardcoding it twice. Contains no PII.
privacyRouter.get("/legal/versions", (_req, res) => {
  res.json({ termsVersion: CURRENT_TERMS_VERSION, privacyVersion: CURRENT_PRIVACY_VERSION });
});

const createRequestSchema = z.object({
  type: z.enum(PRIVACY_REQUEST_TYPES),
  notes: z.string().max(2000).optional(),
});

// A signed-in user requesting export or deletion of their own data. This
// only ever CREATES A TRACKED REQUEST — it never itself exports or deletes
// anything. An admin reviews and resolves it manually (see below), through
// whatever process is appropriate for the data actually involved —
// deliberately not automated, per the Owner's instruction that regulated/
// AML records must never be auto-deleted.
privacyRouter.post("/privacy/requests", requireAuth, async (req, res) => {
  const parsed = createRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid request type." });
    return;
  }
  const authed = req.authedUser!;
  const [created] = await db
    .insert(privacyRequests)
    .values({
      userId: authed.id,
      brokerageId: authed.brokerageId,
      type: parsed.data.type,
      notes: parsed.data.notes,
    })
    .returning();

  await logAudit({
    userId: authed.id,
    action: "privacy_request_created",
    recordType: "privacy_request",
    recordId: String(created.id),
    updatedValue: parsed.data.type,
  });

  res.status(201).json({ request: { id: created.id, type: created.type, status: created.status, requestedAt: created.requestedAt } });
});

// A user's own request history — lets them see what they've asked for and
// its status without needing to contact an admin to check.
privacyRouter.get("/privacy/requests/mine", requireAuth, async (req, res) => {
  const authed = req.authedUser!;
  const rows = await db.select().from(privacyRequests).where(eq(privacyRequests.userId, authed.id)).orderBy(desc(privacyRequests.requestedAt));
  res.json({ requests: rows });
});

// Tenant-scoped, paginated, admin-only queue of privacy requests for the
// admin's own brokerage's users. Joined against users purely so the admin's
// queue can show WHO is asking (email/name) without a second lookup — the
// resolve action below stays scoped by privacyRequests.brokerageId exactly
// as before, so this join changes only what's displayed, not the tenant
// boundary itself.
privacyRouter.get("/admin/privacy-requests", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const admin = req.authedUser!;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const rows = await db
    .select({
      id: privacyRequests.id,
      userId: privacyRequests.userId,
      userEmail: users.email,
      userFirstName: users.firstName,
      userLastName: users.lastName,
      type: privacyRequests.type,
      status: privacyRequests.status,
      notes: privacyRequests.notes,
      requestedAt: privacyRequests.requestedAt,
      handledAt: privacyRequests.handledAt,
      handledByUserId: privacyRequests.handledByUserId,
    })
    .from(privacyRequests)
    .innerJoin(users, eq(privacyRequests.userId, users.id))
    .where(eq(privacyRequests.brokerageId, admin.brokerageId))
    .orderBy(desc(privacyRequests.requestedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ value: total }] = await db.select({ value: count() }).from(privacyRequests).where(eq(privacyRequests.brokerageId, admin.brokerageId));

  res.json({ requests: rows, page, pageSize, total });
});

const resolveRequestSchema = z.object({
  status: z.enum(["completed", "declined"]),
  notes: z.string().max(2000).optional(),
});

// Marks a request resolved. Deliberately does not perform any export or
// deletion itself — this is a record that a human has actioned the
// request through whatever channel/process was appropriate (e.g. a manual
// data export sent to the participant, or a documented reason for
// declining), never an automated data-destructive operation. Tenant-scoped
// so an admin can only resolve their own brokerage's requests.
privacyRouter.post("/admin/privacy-requests/:id/resolve", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const admin = req.authedUser!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid request id." });
    return;
  }
  const parsed = resolveRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "status must be 'completed' or 'declined'." });
    return;
  }
  const [updated] = await db
    .update(privacyRequests)
    .set({ status: parsed.data.status, notes: parsed.data.notes, handledAt: new Date(), handledByUserId: admin.id })
    .where(and(eq(privacyRequests.id, id), eq(privacyRequests.brokerageId, admin.brokerageId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Request not found." });
    return;
  }
  await logAudit({
    userId: admin.id,
    action: "privacy_request_resolved",
    recordType: "privacy_request",
    recordId: String(id),
    updatedValue: parsed.data.status,
  });
  res.json({ request: updated });
});
