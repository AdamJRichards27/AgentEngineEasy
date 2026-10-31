// Owner t179u slice 2 (migration 0040): AE administration fee schedule
// versions (D9) and transaction fees (AE admin fees, settlement fees,
// adjustments, deductions).
//
// - Fee schedules: recorded from the signed AE agent/brokerage agreement by a
//   Brokerage Administrator (DRAFT) and activated by a DIFFERENT Brokerage
//   Administrator. An ACTIVE version is never edited; activating a new version
//   supersedes the old one, which is retained for historical calculation.
// - Transaction fees: a Brokerage Administrator, or assigned Pit Crew holding a
//   live TRANSACTION_FEE grant (written authority from the listing agent or a
//   Brokerage Administrator), may draft a fee or a new version of an approved
//   fee. Approval and cancellation are Brokerage Administrator only and the
//   approver is never the creator. An ADMIN_FEE's amount and GST always come
//   from the ACTIVE schedule version that applies (agent agreement first,
//   then brokerage agreement); the client cannot choose the figure.
// - Reads: Brokerage Administrator, the listing agent, assigned Pit Crew.
// Mounted inside financialRouter (no routes/index.ts change).
import { Router, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db, documents, feeScheduleVersions, transactionFees, type FeeScheduleVersion, type TransactionFee } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { logAudit } from "../lib/audit.js";
import {
  amendmentAuditInput,
  auditWriterFor,
  denyFinancialAmendment,
  isListingAgent,
  loadPropertyFinancialScope,
  lockLiveAuthority,
  resolveAmendmentAuthority,
  AMENDMENT_AUTHORITY_REQUIRED,
} from "../lib/financialAmendments.js";
import { activePitCrewAssignmentsForTransaction } from "../lib/transactionPriceAccess.js";
import { resolveTransactionScope } from "../lib/financial/queries.js";

export const financialFeesRouter = Router();
const runAccess = requireEntitlement("run.access");
const admin = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), runAccess] as const;
const adminOrPitCrew = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES, ...PIT_CREW_ROLES), runAccess] as const;
const reader = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES, "Agent", ...PIT_CREW_ROLES), runAccess] as const;

export class FeeRefusal extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
function send(res: Response, err: unknown): boolean {
  if (err instanceof FeeRefusal) {
    res.status(err.status).json({ error: err.message, reason: err.reason });
    return true;
  }
  return false;
}
const isAdmin = (u: AuthedUser) => BROKERAGE_ADMIN_ROLES.includes(u.role);
const isPitCrew = (u: AuthedUser) => PIT_CREW_ROLES.includes(u.role);
const gstOf = (cents: number, rateBps: number) => Math.round((cents * rateBps) / 10_000);

function feeValues(f: TransactionFee): Record<string, unknown> {
  return {
    id: f.id,
    kind: f.kind,
    description: f.description,
    amountCents: f.amountCents,
    gstCents: f.gstCents,
    feeScheduleVersionId: f.feeScheduleVersionId,
    status: f.status,
    version: f.version,
    supersedesId: f.supersedesId,
  };
}

// ---------------- fee schedules (D9) ----------------

const scheduleSchema = z
  .object({
    agentUserId: z.number().int().positive().optional(),
    adminFeeCents: z.number().int().nonnegative(),
    adminFeeGstApplicable: z.boolean().optional(),
    signedAgreementDocumentId: z.number().int().positive().optional(),
    signedAgreementRef: z.string().max(500).optional(),
    signedAt: z.coerce.date(),
    effectiveFrom: z.coerce.date(),
  })
  .strict();

financialFeesRouter.post("/financial/fee-schedules", ...admin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const input = parsed.data;
  const ref = input.signedAgreementRef?.trim() || null;
  if (input.signedAgreementDocumentId === undefined && ref === null) {
    return void res.status(422).json({ error: "Attach the signed AE agreement (document or reference).", reason: "SIGNED_AGREEMENT_REQUIRED" });
  }
  if (input.signedAgreementDocumentId !== undefined) {
    const [doc] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, input.signedAgreementDocumentId), sql`${documents.propertyId} in (select id from properties where brokerage_id = ${user.brokerageId})`));
    if (!doc) return void res.status(422).json({ error: "Unknown document.", reason: "SIGNED_AGREEMENT_DOCUMENT_NOT_FOUND" });
  }
  if (input.agentUserId !== undefined) {
    const rows = await db.execute(sql`select id from users where id = ${input.agentUserId} and brokerage_id = ${user.brokerageId} and role = 'Agent'`);
    if (rows.rows.length !== 1) return void res.status(422).json({ error: "The agent must be an Agent in this brokerage.", reason: "AGENT_NOT_IN_BROKERAGE" });
  }
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fee_schedule_versions'), ${user.brokerageId})`);
    const [last] = await tx
      .select({ version: feeScheduleVersions.version })
      .from(feeScheduleVersions)
      .where(
        and(
          eq(feeScheduleVersions.brokerageId, user.brokerageId),
          input.agentUserId === undefined ? isNull(feeScheduleVersions.agentUserId) : eq(feeScheduleVersions.agentUserId, input.agentUserId),
        ),
      )
      .orderBy(desc(feeScheduleVersions.version))
      .limit(1);
    const [created] = await tx
      .insert(feeScheduleVersions)
      .values({
        brokerageId: user.brokerageId,
        agentUserId: input.agentUserId ?? null,
        version: (last?.version ?? 0) + 1,
        adminFeeCents: input.adminFeeCents,
        adminFeeGstApplicable: input.adminFeeGstApplicable ?? true,
        signedAgreementDocumentId: input.signedAgreementDocumentId ?? null,
        signedAgreementRef: ref,
        signedAt: input.signedAt,
        effectiveFrom: input.effectiveFrom,
        createdByUserId: user.id,
      })
      .returning();
    await logAudit(
      { brokerageId: user.brokerageId, userId: user.id, action: "fee_schedule_version_created", recordType: "fee_schedule_version", recordId: String(created!.id), updatedValue: JSON.stringify(created) },
      { strict: true, write: auditWriterFor(tx) },
    );
    return created!;
  });
  res.status(201).json({ feeSchedule: row });
});

financialFeesRouter.post("/financial/fee-schedules/:id/activate", ...admin, async (req, res) => {
  const user = req.authedUser!;
  const id = Number(req.params.id);
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fee_schedule_versions'), ${user.brokerageId})`);
      const [row] = await tx.select().from(feeScheduleVersions).where(and(eq(feeScheduleVersions.id, id), eq(feeScheduleVersions.brokerageId, user.brokerageId)));
      if (!row) throw new FeeRefusal(404, "NOT_FOUND", "Not found");
      if (row.status !== "DRAFT") throw new FeeRefusal(409, "FEE_SCHEDULE_NOT_DRAFT", "Only a DRAFT schedule can be activated; an active schedule is never edited.");
      if (row.createdByUserId === user.id) throw new FeeRefusal(403, "SEPARATION_OF_DUTIES", "A different Brokerage Administrator must activate this schedule.");
      const now = new Date();
      const [prior] = await tx
        .select()
        .from(feeScheduleVersions)
        .where(
          and(
            eq(feeScheduleVersions.brokerageId, user.brokerageId),
            row.agentUserId === null ? isNull(feeScheduleVersions.agentUserId) : eq(feeScheduleVersions.agentUserId, row.agentUserId),
            eq(feeScheduleVersions.status, "ACTIVE"),
          ),
        );
      if (prior) {
        await tx
          .update(feeScheduleVersions)
          .set({ status: "SUPERSEDED", effectiveTo: row.effectiveFrom > prior.effectiveFrom ? row.effectiveFrom : now })
          .where(eq(feeScheduleVersions.id, prior.id));
      }
      const [activated] = await tx
        .update(feeScheduleVersions)
        .set({ status: "ACTIVE", activatedAt: now, activatedByUserId: user.id, supersedesId: prior?.id ?? null })
        .where(and(eq(feeScheduleVersions.id, row.id), eq(feeScheduleVersions.status, "DRAFT")))
        .returning();
      await logAudit(
        {
          brokerageId: user.brokerageId,
          userId: user.id,
          action: "fee_schedule_version_activated",
          recordType: "fee_schedule_version",
          recordId: String(row.id),
          previousValue: JSON.stringify(prior ?? null),
          updatedValue: JSON.stringify(activated),
        },
        { strict: true, write: auditWriterFor(tx) },
      );
      return activated!;
    });
    res.json({ feeSchedule: result });
  } catch (err) {
    if (!send(res, err)) throw err;
  }
});

financialFeesRouter.get("/financial/fee-schedules", ...admin, async (req, res) => {
  const user = req.authedUser!;
  const rows = await db.select().from(feeScheduleVersions).where(eq(feeScheduleVersions.brokerageId, user.brokerageId)).orderBy(desc(feeScheduleVersions.id));
  res.json({ feeSchedules: rows });
});

/** The ACTIVE schedule that applies to a transaction: the listing agent's AE agreement first, then the brokerage's. */
export async function applicableFeeSchedule(
  executor: Pick<typeof db, "select">,
  brokerageId: number,
  listingAgentId: number | null,
  at = new Date(),
): Promise<FeeScheduleVersion | null> {
  const rows = await executor
    .select()
    .from(feeScheduleVersions)
    .where(
      and(
        eq(feeScheduleVersions.brokerageId, brokerageId),
        eq(feeScheduleVersions.status, "ACTIVE"),
        lte(feeScheduleVersions.effectiveFrom, at),
        listingAgentId == null ? isNull(feeScheduleVersions.agentUserId) : or(isNull(feeScheduleVersions.agentUserId), eq(feeScheduleVersions.agentUserId, listingAgentId)),
      ),
    );
  return rows.find((r) => r.agentUserId != null) ?? rows.find((r) => r.agentUserId == null) ?? null;
}

// ---------------- transaction fees ----------------

const feeSchema = z
  .object({
    transactionId: z.coerce.number().int().positive(),
    kind: z.enum(["ADMIN_FEE", "SETTLEMENT_FEE", "ADJUSTMENT", "DEDUCTION"]),
    description: z.string().trim().min(1).max(500),
    amountCents: z.number().int().optional(),
    gstCents: z.number().int().nonnegative().optional(),
    supersedesId: z.number().int().positive().optional(),
  })
  .strict();

financialFeesRouter.post("/financial/transaction-fees", ...adminOrPitCrew, async (req, res) => {
  const user = req.authedUser!;
  const surface = "POST /financial/transaction-fees";
  const rawTxn = Number((req.body as { transactionId?: unknown } | null)?.transactionId);
  if (isPitCrew(user) && !(Number.isSafeInteger(rawTxn) && rawTxn > 0)) {
    return void res.status(403).json({ error: "A documented TRANSACTION_FEE authority is required.", reason: AMENDMENT_AUTHORITY_REQUIRED });
  }
  const parsed = feeSchema.safeParse(req.body);
  if (!parsed.success && !isPitCrew(user)) return void res.status(400).json({ error: parsed.error.flatten() });
  const txnScope = await resolveTransactionScope(rawTxn, user.brokerageId);
  if (!txnScope) return void res.status(404).json({ error: "Transaction not found" });
  const propertyScope = await loadPropertyFinancialScope(user, txnScope.propertyId);
  if (!propertyScope) return void res.status(404).json({ error: "Transaction not found" });
  const supersedesId = parsed.success ? parsed.data.supersedesId : undefined;
  const authority = await resolveAmendmentAuthority(user, propertyScope, {
    scope: "TRANSACTION_FEE",
    recordId: supersedesId !== undefined ? String(supersedesId) : null,
    transactionId: txnScope.transactionId,
  });
  // Brokerage Administrators: own authority. Pit Crew: a live grant + assignment. Listing agents are not admitted by the role gate.
  if (!authority.allowed) return denyFinancialAmendment(res, user, propertyScope, "transaction_fee", `transaction:${txnScope.transactionId}`, surface);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const input = parsed.data;
  try {
    const fee = await db.transaction(async (tx) => {
      await lockLiveAuthority(tx, authority);
      await tx.execute(sql`select id from transactions where id = ${txnScope.transactionId} for update`);
      let prior: TransactionFee | undefined;
      if (input.supersedesId !== undefined) {
        [prior] = await tx.select().from(transactionFees).where(eq(transactionFees.id, input.supersedesId));
        if (!prior || prior.transactionId !== txnScope.transactionId || prior.status !== "APPROVED" || prior.kind !== input.kind) {
          throw new FeeRefusal(409, "FEE_NOT_SUPERSEDABLE", "Only an APPROVED fee of the same kind on this transaction can be superseded.");
        }
      }
      let amountCents: number;
      let gstCents: number;
      let feeScheduleVersionId: number | null = null;
      if (input.kind === "ADMIN_FEE") {
        const schedule = await applicableFeeSchedule(tx, user.brokerageId, propertyScope.listingAgentId);
        if (!schedule) throw new FeeRefusal(409, "NO_ACTIVE_FEE_SCHEDULE", "No active AE fee schedule from a signed agreement applies to this transaction.");
        amountCents = schedule.adminFeeCents;
        gstCents = schedule.adminFeeGstApplicable ? gstOf(amountCents, schedule.gstRateBps) : 0;
        if ((input.amountCents !== undefined && input.amountCents !== amountCents) || (input.gstCents !== undefined && input.gstCents !== gstCents)) {
          throw new FeeRefusal(409, "ADMIN_FEE_SCHEDULE_MISMATCH", "AE administration fees come from the signed fee schedule; the amount cannot be changed here.");
        }
        feeScheduleVersionId = schedule.id;
      } else {
        if (input.amountCents === undefined) throw new FeeRefusal(400, "AMOUNT_REQUIRED", "amountCents is required.");
        if (input.kind !== "ADJUSTMENT" && input.amountCents < 0) throw new FeeRefusal(400, "AMOUNT_NEGATIVE", "Only an ADJUSTMENT may be negative.");
        amountCents = input.amountCents;
        gstCents = input.gstCents ?? 0;
      }
      const [row] = await tx
        .insert(transactionFees)
        .values({
          brokerageId: user.brokerageId,
          propertyId: txnScope.propertyId,
          transactionId: txnScope.transactionId,
          kind: input.kind,
          description: input.description,
          amountCents,
          gstCents,
          feeScheduleVersionId,
          version: prior ? prior.version + 1 : 1,
          supersedesId: prior?.id ?? null,
          createdByUserId: user.id,
        })
        .returning();
      await logAudit(
        amendmentAuditInput({
          user,
          authority,
          scope: propertyScope,
          recordType: "transaction_fee",
          recordId: String(row!.id),
          before: prior ? feeValues(prior) : null,
          after: { ...feeValues(row!), transactionId: txnScope.transactionId },
          surface,
          policy: "t179u",
        }),
        { strict: true, write: auditWriterFor(tx) },
      );
      return row!;
    });
    res.status(201).json({ fee });
  } catch (err) {
    if (err instanceof Error && /no longer live/.test(err.message)) {
      return denyFinancialAmendment(res, user, propertyScope, "transaction_fee", `transaction:${txnScope.transactionId}`, surface);
    }
    if (!send(res, err)) throw err;
  }
});

financialFeesRouter.post("/financial/transaction-fees/:id/approve", ...admin, async (req, res) => {
  const user = req.authedUser!;
  const id = Number(req.params.id);
  try {
    const fee = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(transactionFees).where(and(eq(transactionFees.id, id), eq(transactionFees.brokerageId, user.brokerageId))).for("update");
      if (!row) throw new FeeRefusal(404, "NOT_FOUND", "Not found");
      if (row.status !== "DRAFT") throw new FeeRefusal(409, "FEE_NOT_DRAFT", "Only a DRAFT fee can be approved.");
      if (row.createdByUserId === user.id) throw new FeeRefusal(403, "SEPARATION_OF_DUTIES", "A fee is approved by someone other than its creator.");
      if (row.kind === "ADMIN_FEE") {
        const [schedule] = await tx.select().from(feeScheduleVersions).where(eq(feeScheduleVersions.id, row.feeScheduleVersionId!));
        const expectedGst = schedule && schedule.adminFeeGstApplicable ? gstOf(schedule.adminFeeCents, schedule.gstRateBps) : 0;
        if (!schedule || schedule.status !== "ACTIVE" || schedule.adminFeeCents !== row.amountCents || expectedGst !== row.gstCents) {
          throw new FeeRefusal(409, "ADMIN_FEE_SCHEDULE_MISMATCH", "The fee no longer matches the active signed fee schedule; draft it again.");
        }
      }
      let prior: TransactionFee | undefined;
      if (row.supersedesId != null) {
        [prior] = await tx.select().from(transactionFees).where(eq(transactionFees.id, row.supersedesId)).for("update");
        if (!prior || prior.status !== "APPROVED") throw new FeeRefusal(409, "FEE_NOT_SUPERSEDABLE", "The fee this version replaces is no longer APPROVED.");
        await tx.update(transactionFees).set({ status: "SUPERSEDED", updatedAt: new Date() }).where(eq(transactionFees.id, prior.id));
      }
      const [approved] = await tx
        .update(transactionFees)
        .set({ status: "APPROVED", approvedByUserId: user.id, approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(transactionFees.id, row.id), eq(transactionFees.status, "DRAFT")))
        .returning();
      await logAudit(
        {
          brokerageId: user.brokerageId,
          userId: user.id,
          action: "transaction_fee_approved",
          recordType: "transaction_fee",
          recordId: String(row.id),
          propertyId: row.propertyId,
          previousValue: JSON.stringify(prior ? feeValues(prior) : null),
          updatedValue: JSON.stringify(feeValues(approved!)),
        },
        { strict: true, write: auditWriterFor(tx) },
      );
      return approved!;
    });
    res.json({ fee });
  } catch (err) {
    if (!send(res, err)) throw err;
  }
});

financialFeesRouter.post("/financial/transaction-fees/:id/cancel", ...admin, async (req, res) => {
  const user = req.authedUser!;
  const id = Number(req.params.id);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) return void res.status(400).json({ error: "reason is required", reason: "REASON_REQUIRED" });
  try {
    const fee = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(transactionFees).where(and(eq(transactionFees.id, id), eq(transactionFees.brokerageId, user.brokerageId))).for("update");
      if (!row) throw new FeeRefusal(404, "NOT_FOUND", "Not found");
      if (row.status !== "DRAFT" && row.status !== "APPROVED") throw new FeeRefusal(409, "FEE_NOT_CANCELLABLE", `A ${row.status} fee cannot be cancelled.`);
      const [cancelled] = await tx
        .update(transactionFees)
        .set({ status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: user.id, cancelReason: reason, updatedAt: new Date() })
        .where(eq(transactionFees.id, row.id))
        .returning();
      await logAudit(
        {
          brokerageId: user.brokerageId,
          userId: user.id,
          action: "transaction_fee_cancelled",
          recordType: "transaction_fee",
          recordId: String(row.id),
          propertyId: row.propertyId,
          previousValue: JSON.stringify(feeValues(row)),
          updatedValue: JSON.stringify({ ...feeValues(cancelled!), cancelReason: reason }),
        },
        { strict: true, write: auditWriterFor(tx) },
      );
      return cancelled!;
    });
    res.json({ fee });
  } catch (err) {
    if (!send(res, err)) throw err;
  }
});

/** Financial visibility (t177u(3)): Brokerage Administrator, listing agent, assigned Pit Crew. Others 404. */
export async function canReadTransactionFinancials(user: AuthedUser, transactionId: number): Promise<{ propertyId: number; transactionId: number; listingAgentId: number | null } | null> {
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) return null;
  const txnScope = await resolveTransactionScope(transactionId, user.brokerageId);
  if (!txnScope) return null;
  const scope = await loadPropertyFinancialScope(user, txnScope.propertyId);
  if (!scope) return null;
  const ok =
    isAdmin(user) ||
    isListingAgent(user, scope) ||
    (isPitCrew(user) && (await activePitCrewAssignmentsForTransaction(user, { id: txnScope.transactionId, propertyId: txnScope.propertyId })).length > 0);
  return ok ? { ...txnScope, listingAgentId: scope.listingAgentId } : null;
}

financialFeesRouter.get("/financial/transaction-fees", ...reader, async (req, res) => {
  const user = req.authedUser!;
  const access = await canReadTransactionFinancials(user, Number(req.query.transactionId));
  if (!access) return void res.status(404).json({ error: "Not found" });
  const rows = await db.select().from(transactionFees).where(eq(transactionFees.transactionId, access.transactionId)).orderBy(transactionFees.id);
  res.json({ fees: rows });
});

