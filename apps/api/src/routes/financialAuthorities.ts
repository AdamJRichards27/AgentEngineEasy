// Owner t174u — Pit Crew financial amendment authority grants (PR #271, CC #34).
//
//   POST /financial-amendment-authorities              create (listing agent of the
//                                                     transaction's property, or a
//                                                     Brokerage Administrator)
//   GET  /financial-amendment-authorities?transactionId=N
//                                                     list (listing agent, admin;
//                                                     Pit Crew see only their own)
//   POST /financial-amendment-authorities/:id/revoke  revoke (listing agent, admin)
//
// Pit Crew can never create, extend or self-grant (403). There is no extend:
// a longer authority is a new grant. Another brokerage's transaction or grant
// is 404, as is a transaction whose property the caller (an Agent) does not
// list. Grantor id and role come from the session; the body is strict, so a
// client-sent grantedBy/role is rejected. Create and revoke write their audit
// row in the same DB transaction as the change.
import { Router, type Response } from "express";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  agencyAgreementTerms,
  campaignItems,
  db,
  documents,
  FINANCIAL_AMENDMENT_SCOPES,
  FINANCIAL_AMENDMENT_SCOPE_TARGET_TYPE,
  FINANCIAL_AMENDMENT_TRANSACTION_WIDE_SCOPES,
  financialAmendmentAuthorities,
  properties,
  transactions,
  transactionFees,
  users,
  type FinancialAmendmentAuthority,
} from "@aee/db";
import { requireAuth, BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { logAudit } from "../lib/audit.js";
import { auditWriterFor, isTransactionCompleted, maxAuthorityGrantDays } from "../lib/financialAmendments.js";

export const financialAuthoritiesRouter = Router();
const requiresRunAccess = requireEntitlement("run.access");

export const AUTHORITY_GRANTED_AUDIT_ACTION = "financial_amendment_authority_granted";
export const AUTHORITY_REVOKED_AUDIT_ACTION = "financial_amendment_authority_revoked";

const createSchema = z
  .object({
    transactionId: z.number().int().positive(),
    granteeUserId: z.number().int().positive(),
    scope: z.enum(FINANCIAL_AMENDMENT_SCOPES),
    targetRecordId: z.string().min(1).max(100).optional(),
    evidenceDocumentId: z.number().int().positive().optional(),
    evidenceNote: z.string().max(2000).optional(),
    expiresAt: z.coerce.date(),
  })
  .strict();

const revokeSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

function fail(res: Response, status: number, reason: string, error: string): void {
  res.status(status).json({ error, reason });
}

interface TxnScope {
  transactionId: number;
  propertyId: number;
  listingAgentId: number | null;
  completed: boolean;
}

async function loadTransactionScope(user: AuthedUser, transactionId: number): Promise<TxnScope | null> {
  const [row] = await db
    .select({ id: transactions.id, propertyId: transactions.propertyId, agentId: properties.agentId, status: transactions.status, closedAt: transactions.closedAt })
    .from(transactions)
    .innerJoin(properties, eq(properties.id, transactions.propertyId))
    .where(and(eq(transactions.id, transactionId), eq(properties.brokerageId, user.brokerageId)));
  return row
    ? { transactionId: row.id, propertyId: row.propertyId, listingAgentId: row.agentId ?? null, completed: isTransactionCompleted({ status: row.status, closedAt: row.closedAt }) }
    : null;
}

type GrantorCheck = "ok" | "forbidden" | "not_found";

/** Brokerage Administrator, or the listing agent of the property. Pit Crew: forbidden. Other Agent: not found. */
function grantorCheck(user: AuthedUser, listingAgentId: number | null): GrantorCheck {
  if (BROKERAGE_ADMIN_ROLES.includes(user.role)) return "ok";
  if (user.role === "Agent") return listingAgentId != null && listingAgentId === user.id ? "ok" : "not_found";
  return "forbidden";
}

function isLive(g: FinancialAmendmentAuthority, now = new Date()): boolean {
  return g.revokedAt === null && g.expiresAt > now;
}

// t181u hardening (#271): a grant on a completed (Closed) transaction is not
// live (t179u D7); enforcement already refused it, the list now says so too.
function grantView(g: FinancialAmendmentAuthority, transactionCompleted = false) {
  return { ...g, live: !transactionCompleted && isLive(g) };
}

function grantAuditValue(g: FinancialAmendmentAuthority, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authorityId: g.id,
    transactionId: g.transactionId,
    granteeUserId: g.granteeUserId,
    grantedByUserId: g.grantedByUserId,
    grantedByRole: g.grantedByRole,
    scope: g.scope,
    targetRecordType: g.targetRecordType,
    targetRecordId: g.targetRecordId,
    evidenceDocumentId: g.evidenceDocumentId,
    evidenceNote: g.evidenceNote,
    expiresAt: g.expiresAt.toISOString(),
    policy: "t174u",
    ...extra,
  });
}

financialAuthoritiesRouter.post("/", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  if (PIT_CREW_ROLES.includes(user.role)) {
    fail(res, 403, "FINANCIAL_AUTHORITY_GRANT_FORBIDDEN", "Pit Crew cannot grant financial amendment authority.");
    return;
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  const txn = await loadTransactionScope(user, input.transactionId);
  if (!txn) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const who = grantorCheck(user, txn.listingAgentId);
  if (who === "not_found") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (who === "forbidden") {
    fail(res, 403, "FINANCIAL_AUTHORITY_GRANT_FORBIDDEN", "Only the listing agent or a Brokerage Administrator can grant financial amendment authority.");
    return;
  }

  if (txn.completed) {
    fail(res, 422, "TRANSACTION_COMPLETED", "This transaction is completed; amendment authority ends on completion (t179u D7).");
    return;
  }

  const [grantee] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, input.granteeUserId), eq(users.brokerageId, user.brokerageId), eq(users.role, "Pit Crew")));
  if (!grantee || grantee.id === user.id) {
    fail(res, 422, "GRANTEE_NOT_PIT_CREW", "The grantee must be a Pit Crew member in this brokerage.");
    return;
  }

  const note = input.evidenceNote?.trim() ? input.evidenceNote.trim() : null;
  if (input.evidenceDocumentId === undefined && note === null) {
    fail(res, 422, "EVIDENCE_REQUIRED", "Attach the documented authority: an evidence document, a note, or both.");
    return;
  }
  if (input.evidenceDocumentId !== undefined) {
    const [doc] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, input.evidenceDocumentId), eq(documents.propertyId, txn.propertyId)));
    if (!doc) {
      fail(res, 422, "EVIDENCE_DOCUMENT_NOT_ON_PROPERTY", "The evidence document must belong to this transaction's property.");
      return;
    }
  }

  const now = Date.now();
  const maxDays = maxAuthorityGrantDays();
  if (input.expiresAt.getTime() <= now + 60_000 || input.expiresAt.getTime() > now + maxDays * 86_400_000) {
    fail(res, 422, "EXPIRY_OUT_OF_RANGE", `expiresAt must be in the future and at most ${maxDays} days away.`);
    return;
  }

  let targetRecordType: string | null = null;
  let targetRecordId: string | null = null;
  if (input.targetRecordId !== undefined && FINANCIAL_AMENDMENT_TRANSACTION_WIDE_SCOPES.includes(input.scope)) {
    fail(res, 422, "TARGET_NOT_SUPPORTED_FOR_SCOPE", "Commission agreement and calculation grants cover the whole transaction; omit targetRecordId.");
    return;
  }
  if (input.targetRecordId !== undefined) {
    targetRecordType = FINANCIAL_AMENDMENT_SCOPE_TARGET_TYPE[input.scope];
    let found = false;
    if (input.scope === "AGENCY_TERMS") {
      const id = Number(input.targetRecordId);
      if (Number.isInteger(id) && id > 0) {
        const [row] = await db
          .select({ id: agencyAgreementTerms.id })
          .from(agencyAgreementTerms)
          .where(and(eq(agencyAgreementTerms.id, id), eq(agencyAgreementTerms.propertyId, txn.propertyId)));
        found = !!row;
        targetRecordId = String(id);
      }
    } else if (input.scope === "TRANSACTION_FEE") {
      // t179u slice 2: a fee on THIS transaction (any version).
      const id = Number(input.targetRecordId);
      if (Number.isInteger(id) && id > 0) {
        const [row] = await db
          .select({ id: transactionFees.id })
          .from(transactionFees)
          .where(and(eq(transactionFees.id, id), eq(transactionFees.transactionId, txn.transactionId), eq(transactionFees.brokerageId, user.brokerageId)));
        found = !!row;
        targetRecordId = String(id);
      }
    } else if (z.string().uuid().safeParse(input.targetRecordId).success) {
      const [row] = await db
        .select({ id: campaignItems.id })
        .from(campaignItems)
        .where(
          and(
            eq(campaignItems.id, input.targetRecordId),
            eq(campaignItems.propertyId, txn.propertyId),
            eq(campaignItems.brokerageId, user.brokerageId),
          ),
        );
      found = !!row;
      targetRecordId = input.targetRecordId;
    }
    if (!found) {
      fail(res, 422, "TARGET_NOT_ON_TRANSACTION", "The target record must belong to this transaction's property and match the scope.");
      return;
    }
  }

  const authority = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(financialAmendmentAuthorities)
      .values({
        brokerageId: user.brokerageId,
        propertyId: txn.propertyId,
        transactionId: txn.transactionId,
        granteeUserId: grantee.id,
        grantedByUserId: user.id,
        grantedByRole: user.role,
        scope: input.scope,
        targetRecordType,
        targetRecordId,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
        evidenceNote: note,
        expiresAt: input.expiresAt,
      })
      .returning();
    await logAudit(
      {
        brokerageId: user.brokerageId,
        userId: user.id,
        action: AUTHORITY_GRANTED_AUDIT_ACTION,
        recordType: "financial_amendment_authority",
        recordId: String(row!.id),
        propertyId: txn.propertyId,
        updatedValue: grantAuditValue(row!),
      },
      { strict: true, write: auditWriterFor(tx) },
    );
    return row!;
  });
  res.status(201).json({ authority: grantView(authority) });
});

financialAuthoritiesRouter.get("/", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = Number(req.query.transactionId);
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    res.status(400).json({ error: "transactionId is required" });
    return;
  }
  const txn = await loadTransactionScope(user, transactionId);
  if (!txn) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const who = grantorCheck(user, txn.listingAgentId);
  if (who === "not_found") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const own = who === "forbidden";
  if (own && !PIT_CREW_ROLES.includes(user.role)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db
    .select()
    .from(financialAmendmentAuthorities)
    .where(
      and(
        eq(financialAmendmentAuthorities.brokerageId, user.brokerageId),
        eq(financialAmendmentAuthorities.transactionId, transactionId),
        own ? eq(financialAmendmentAuthorities.granteeUserId, user.id) : undefined,
      ),
    )
    .orderBy(asc(financialAmendmentAuthorities.id));
  res.json({ authorities: rows.map((g) => grantView(g, txn.completed)), maxGrantDays: maxAuthorityGrantDays(), transactionCompleted: txn.completed });
});

financialAuthoritiesRouter.post("/:id/revoke", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [grant] = await db
    .select({ g: financialAmendmentAuthorities, agentId: properties.agentId })
    .from(financialAmendmentAuthorities)
    .innerJoin(properties, eq(properties.id, financialAmendmentAuthorities.propertyId))
    .where(and(eq(financialAmendmentAuthorities.id, id), eq(financialAmendmentAuthorities.brokerageId, user.brokerageId)));
  if (!grant) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const who = grantorCheck(user, grant.agentId ?? null);
  if (who === "not_found") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (who === "forbidden") {
    fail(res, 403, "FINANCIAL_AUTHORITY_GRANT_FORBIDDEN", "Only the listing agent or a Brokerage Administrator can revoke financial amendment authority.");
    return;
  }
  const parsed = revokeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select id from financial_amendment_authorities where id = ${id} and revoked_at is null for update`);
    if (locked.rows.length !== 1) return null;
    const [row] = await tx
      .update(financialAmendmentAuthorities)
      .set({ revokedAt: new Date(), revokedByUserId: user.id, revokeReason: parsed.data.reason })
      .where(eq(financialAmendmentAuthorities.id, id))
      .returning();
    await logAudit(
      {
        brokerageId: user.brokerageId,
        userId: user.id,
        action: AUTHORITY_REVOKED_AUDIT_ACTION,
        recordType: "financial_amendment_authority",
        recordId: String(id),
        propertyId: row!.propertyId,
        updatedValue: grantAuditValue(row!, { revokedByUserId: user.id, revokedByRole: user.role, revokeReason: parsed.data.reason }),
      },
      { strict: true, write: auditWriterFor(tx) },
    );
    return row!;
  });
  if (!result) {
    fail(res, 409, "ALREADY_REVOKED", "This authority is already revoked.");
    return;
  }
  res.json({ authority: grantView(result) });
});

