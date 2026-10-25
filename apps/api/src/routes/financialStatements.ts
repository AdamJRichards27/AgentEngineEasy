// Owner t179u slice 3 (migration 0041): settlement confirmations and
// settlement statements (D1/D2).
//
// D1: the assigned Pit Crew, the listing agent or a Brokerage Administrator
// prepare, finalise and issue. Issue requires: settlement complete, the
// buyer's AND the seller's representative's written confirmation (with
// evidence), lines re-derived server-side that still match the draft, no
// outstanding validation issue, and a named payer consistent with the PC
// service-fee request. Issued statements are immutable (DB trigger); a
// correction is a new version that supersedes the issued one (Brokerage
// Administrator only, with a reason). Every step is audited.
//
// This slice does NOT switch the #245 collection gate (that stays fully
// blocking until a later, separately approved slice).
import { createHash } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  commissionCalculations,
  documents,
  financialPaymentRequests,
  marketingPaymentRecords,
  pcFeeAuthorities,
  pcFeeCalculations,
  settlementConfirmations,
  settlementStatementLines,
  settlementStatements,
  transactionFees,
  transactions,
  users,
  type SettlementConfirmation,
  type SettlementStatement,
  type SettlementStatementLineKind,
} from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { logAudit } from "../lib/audit.js";
import { auditWriterFor, isListingAgent, loadPropertyFinancialScope } from "../lib/financialAmendments.js";
import { activePitCrewAssignmentsForTransaction } from "../lib/transactionPriceAccess.js";
import { resolveTransactionScope } from "../lib/financial/queries.js";
import { canReadTransactionFinancials } from "./financialFees.js";

export const financialStatementsRouter = Router();
const runAccess = requireEntitlement("run.access");
const preparer = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES, "Agent", ...PIT_CREW_ROLES), runAccess] as const;
export const SETTLEMENT_STATEMENT_POLICY = "t179u";

class StatementRefusal extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
function send(res: Response, err: unknown): boolean {
  if (err instanceof StatementRefusal) {
    res.status(err.status).json({ error: err.message, reason: err.reason });
    return true;
  }
  return false;
}
const isAdmin = (u: AuthedUser) => BROKERAGE_ADMIN_ROLES.includes(u.role);
const isPitCrew = (u: AuthedUser) => PIT_CREW_ROLES.includes(u.role);
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** D1 actors: Brokerage Administrator, the listing agent, or Pit Crew assigned to this transaction. Others 404. */
export async function resolveStatementActor(user: AuthedUser, transactionId: number): Promise<{ transactionId: number; propertyId: number; basis: "brokerage_admin" | "listing_agent" | "assigned_pit_crew" } | null> {
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) return null;
  const txnScope = await resolveTransactionScope(transactionId, user.brokerageId);
  if (!txnScope) return null;
  const scope = await loadPropertyFinancialScope(user, txnScope.propertyId);
  if (!scope) return null;
  if (isAdmin(user)) return { ...txnScope, basis: "brokerage_admin" };
  if (isListingAgent(user, scope)) return { ...txnScope, basis: "listing_agent" };
  if (isPitCrew(user) && (await activePitCrewAssignmentsForTransaction(user, { id: txnScope.transactionId, propertyId: txnScope.propertyId })).length > 0) {
    return { ...txnScope, basis: "assigned_pit_crew" };
  }
  return null;
}

type LegalReps = { sellerSolicitorPartyId?: number | null; buyerSolicitorPartyId?: number | null } | null;
function representativeFor(reps: unknown, side: "BUYER" | "SELLER"): number | null {
  const r = (reps ?? null) as LegalReps;
  const id = side === "BUYER" ? r?.buyerSolicitorPartyId : r?.sellerSolicitorPartyId;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

// ---------------------------------------------------------------------
// Settlement confirmations (N4/N5)
// ---------------------------------------------------------------------
const confirmationSchema = z
  .object({
    transactionId: z.number().int().positive(),
    side: z.enum(["BUYER", "SELLER"]),
    representativePartyId: z.number().int().positive(),
    evidenceDocumentId: z.number().int().positive().optional(),
    evidenceNote: z.string().max(2000).optional(),
    confirmedAt: z.string().datetime(),
    supersedesId: z.number().int().positive().optional(),
  })
  .strict();

financialStatementsRouter.post("/financial/settlement-confirmations", ...preparer, async (req, res) => {
  const user = req.authedUser!;
  const parsed = confirmationSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid settlement confirmation", issues: parsed.error.issues });
  const body = parsed.data;
  const actor = await resolveStatementActor(user, body.transactionId);
  if (!actor) return void res.status(isPitCrew(user) ? 403 : 404).json({ error: isPitCrew(user) ? "Not assigned to this transaction" : "Not found" });
  try {
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settlement_statements'), ${actor.transactionId})`);
      const [txn] = await tx.select().from(transactions).where(eq(transactions.id, actor.transactionId));
      const expected = representativeFor(txn!.legalRepresentatives, body.side);
      if (expected == null) throw new StatementRefusal(409, "REPRESENTATIVE_NOT_RECORDED", `No ${body.side.toLowerCase()} representative is recorded on this transaction`);
      if (expected !== body.representativePartyId) throw new StatementRefusal(422, "REPRESENTATIVE_MISMATCH", "The confirming party is not the recorded representative for that side");
      const note = body.evidenceNote?.trim() ?? "";
      if (!body.evidenceDocumentId && !note) throw new StatementRefusal(422, "CONFIRMATION_EVIDENCE_REQUIRED", "Attach the written confirmation or describe it");
      if (body.evidenceDocumentId) {
        const [doc] = await tx.select({ id: documents.id }).from(documents).where(and(eq(documents.id, body.evidenceDocumentId), eq(documents.propertyId, actor.propertyId)));
        if (!doc) throw new StatementRefusal(422, "EVIDENCE_DOCUMENT_INVALID", "Evidence document must belong to this property");
      }
      const confirmedAt = new Date(body.confirmedAt);
      if (confirmedAt.getTime() > Date.now() + 60_000) throw new StatementRefusal(422, "CONFIRMED_AT_IN_FUTURE", "Confirmation date cannot be in the future");
      const [active] = await tx
        .select()
        .from(settlementConfirmations)
        .where(and(eq(settlementConfirmations.transactionId, actor.transactionId), eq(settlementConfirmations.side, body.side), eq(settlementConfirmations.status, "ACTIVE")))
        .for("update");
      if (active && body.supersedesId !== active.id) throw new StatementRefusal(409, "CONFIRMATION_EXISTS", "A confirmation for this side is already on file; supersede it explicitly");
      if (!active && body.supersedesId) throw new StatementRefusal(409, "CONFIRMATION_NOT_SUPERSEDABLE", "Only the active confirmation can be superseded");
      if (active) {
        await tx.update(settlementConfirmations).set({ status: "SUPERSEDED", supersededAt: new Date() }).where(eq(settlementConfirmations.id, active.id));
      }
      const [created] = await tx
        .insert(settlementConfirmations)
        .values({
          brokerageId: user.brokerageId,
          propertyId: actor.propertyId,
          transactionId: actor.transactionId,
          side: body.side,
          representativePartyId: body.representativePartyId,
          evidenceDocumentId: body.evidenceDocumentId ?? null,
          evidenceNote: note || null,
          confirmedAt,
          supersedesId: active?.id ?? null,
          recordedByUserId: user.id,
        })
        .returning();
      await logAudit(
        {
          brokerageId: user.brokerageId,
          userId: user.id,
          action: active ? "settlement_confirmation_superseded" : "settlement_confirmation_recorded",
          recordType: "settlement_confirmation",
          recordId: String(created!.id),
          previousValue: active ? JSON.stringify(active) : undefined,
          updatedValue: JSON.stringify({ policy: SETTLEMENT_STATEMENT_POLICY, basis: actor.basis, after: created }),
        },
        { strict: true, write: auditWriterFor(tx) },
      );
      return created!;
    });
    res.status(201).json({ confirmation: row });
  } catch (err) {
    if (!send(res, err)) throw err;
  }
});

financialStatementsRouter.get("/financial/settlement-confirmations", ...preparer, async (req, res) => {
  const access = await canReadTransactionFinancials(req.authedUser!, Number(req.query.transactionId));
  if (!access) return void res.status(404).json({ error: "Not found" });
  const rows = await db.select().from(settlementConfirmations).where(eq(settlementConfirmations.transactionId, access.transactionId)).orderBy(settlementConfirmations.id);
  res.json({ confirmations: rows });
});

// ---------------------------------------------------------------------
// Line derivation (server-side only; the client never supplies figures)
// ---------------------------------------------------------------------
export interface DerivedLine {
  kind: SettlementStatementLineKind;
  effect: "CREDIT" | "DEBIT";
  description: string;
  amountCents: number;
  gstCents: number;
  sourceType: string;
  sourceId: string;
  commissionCalculationId: number | null;
  transactionFeeId: number | null;
  paymentRequestId: number | null;
}
export interface DerivedStatement {
  lines: DerivedLine[];
  issues: string[];
  creditsCents: number;
  debitsCents: number;
  netCents: number;
  pcServiceFeeCents: number | null;
  pcFeePayerUserId: number | null;
  /** t180u(3): who the service fee is charged to under its authority (Agent, or Brokerage for a brokerage-card authority). */
  pcFeePayer: { payerType: "Agent"; payerUserId: number | null } | { payerType: "Brokerage"; payerBrokerageId: number } | null;
}
const PC_FEE_UNCALCULATED = ["NOT_CALCULATED", "ESTIMATED"];
const PC_FEE_EXCLUDED = ["WAIVED", "REVERSED", "WRITTEN_OFF"];
const FEE_KIND_TO_LINE: Record<string, SettlementStatementLineKind> = { ADMIN_FEE: "AE_ADMIN_FEE", SETTLEMENT_FEE: "SETTLEMENT_FEE", ADJUSTMENT: "ADJUSTMENT", DEDUCTION: "DEDUCTION" };

export async function deriveStatement(q: Tx | typeof db, transactionId: number, propertyId: number): Promise<DerivedStatement> {
  const lines: DerivedLine[] = [];
  const issues: string[] = [];
  const base = { commissionCalculationId: null, transactionFeeId: null, paymentRequestId: null } as const;

  const [calc] = await q
    .select()
    .from(commissionCalculations)
    .where(and(eq(commissionCalculations.transactionId, transactionId), eq(commissionCalculations.state, "FINALISED")))
    .orderBy(desc(commissionCalculations.calculationVersion))
    .limit(1);
  if (!calc) issues.push("COMMISSION_NOT_FINALISED");
  else {
    lines.push({ ...base, kind: "COMMISSION", effect: "CREDIT", description: `Commission (calculation v${calc.calculationVersion}, ex GST)`, amountCents: calc.commissionExGstCents, gstCents: 0, sourceType: "commission_calculation", sourceId: String(calc.id), commissionCalculationId: calc.id });
    if (calc.gstCents > 0) lines.push({ ...base, kind: "COMMISSION_GST", effect: "CREDIT", description: "GST on commission", amountCents: calc.gstCents, gstCents: 0, sourceType: "commission_calculation", sourceId: String(calc.id), commissionCalculationId: calc.id });
  }

  const marketing = await q.select().from(marketingPaymentRecords).where(eq(marketingPaymentRecords.propertyId, propertyId)).orderBy(marketingPaymentRecords.id);
  for (const m of marketing) {
    if (m.status === "DISPUTED") issues.push("MARKETING_DISPUTED");
    if (!["INVOICED", "REPORTED_PAID", "RECONCILED"].includes(m.status)) continue;
    const amount = m.reportedPaidAmountCents ?? m.invoicedAmountCents;
    if (amount == null || amount <= 0) continue;
    lines.push({ ...base, kind: "MARKETING", effect: "DEBIT", description: `Marketing: ${m.supplierName ?? "supplier"}${m.invoiceReference ? ` (${m.invoiceReference})` : ""}`, amountCents: amount, gstCents: 0, sourceType: "marketing_payment_record", sourceId: String(m.id) });
  }

  const fees = await q.select().from(transactionFees).where(eq(transactionFees.transactionId, transactionId)).orderBy(transactionFees.id);
  if (fees.some((f) => f.status === "DRAFT")) issues.push("FEES_PENDING_APPROVAL");
  for (const f of fees.filter((x) => x.status === "APPROVED")) {
    const negative = f.amountCents < 0;
    lines.push({ ...base, kind: FEE_KIND_TO_LINE[f.kind]!, effect: negative ? "CREDIT" : "DEBIT", description: f.description, amountCents: Math.abs(f.amountCents), gstCents: f.gstCents, sourceType: "transaction_fee", sourceId: String(f.id), transactionFeeId: f.id });
  }

  let pcServiceFeeCents: number | null = null;
  let pcFeePayerUserId: number | null = null;
  let pcFeePayer: DerivedStatement["pcFeePayer"] = null;
  const [pr] = await q.select().from(financialPaymentRequests).where(and(eq(financialPaymentRequests.transactionId, transactionId), eq(financialPaymentRequests.kind, "PC_SUCCESS_FEE")));
  if (pr && !PC_FEE_EXCLUDED.includes(pr.status)) {
    if (PC_FEE_UNCALCULATED.includes(pr.status)) issues.push("PC_FEE_NOT_CALCULATED");
    else if (pr.status === "DISPUTED") issues.push("PC_FEE_DISPUTED");
    let gst = 0;
    if (pr.pcFeeCalculationId) {
      const [pc] = await q.select({ gstCents: pcFeeCalculations.gstCents }).from(pcFeeCalculations).where(eq(pcFeeCalculations.id, pr.pcFeeCalculationId));
      gst = Math.min(pc?.gstCents ?? 0, pr.amountCents);
    }
    pcServiceFeeCents = pr.amountCents;
    pcFeePayerUserId = pr.payerUserId;
    const [auth] = pr.pcFeeAuthorityId
      ? await q.select({ payerType: pcFeeAuthorities.payerType, brokerageId: pcFeeAuthorities.brokerageId }).from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, pr.pcFeeAuthorityId))
      : [];
    pcFeePayer = auth?.payerType === "Brokerage" ? { payerType: "Brokerage", payerBrokerageId: auth.brokerageId } : { payerType: "Agent", payerUserId: pr.payerUserId };
    lines.push({ ...base, kind: "PC_SERVICE_FEE", effect: "DEBIT", description: "Pit Crew service fee", amountCents: pr.amountCents - gst, gstCents: gst, sourceType: "financial_payment_request", sourceId: String(pr.id), paymentRequestId: pr.id });
  }
  // PAYMENT / REFUND lines are reserved kinds: their sources (payments and
  // the 0039 refund ledger) are not derived in slice 3 (N10).

  const value = (l: DerivedLine) => l.amountCents + l.gstCents;
  const creditsCents = lines.filter((l) => l.effect === "CREDIT").reduce((s, l) => s + value(l), 0);
  const debitsCents = lines.filter((l) => l.effect === "DEBIT").reduce((s, l) => s + value(l), 0);
  return { lines, issues: [...new Set(issues)], creditsCents, debitsCents, netCents: creditsCents - debitsCents, pcServiceFeeCents, pcFeePayerUserId, pcFeePayer };
}

export function fingerprint(lines: DerivedLine[], payer: { payerType: string; payerUserId: number | null; payerBrokerageId: number | null }): string {
  const canon = lines.map((l) => [l.kind, l.effect, l.description, l.amountCents, l.gstCents, l.sourceType, l.sourceId]);
  return createHash("sha256").update(JSON.stringify({ canon, payer })).digest("hex");
}

// ---------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------
const prepareSchema = z
  .object({
    transactionId: z.number().int().positive(),
    payerType: z.enum(["Agent", "Brokerage"]),
    payerUserId: z.number().int().positive().optional(),
    supersedeReason: z.string().max(2000).optional(),
  })
  .strict();

async function lockTxn(tx: Tx, transactionId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settlement_statements'), ${transactionId})`);
}

financialStatementsRouter.post("/financial/settlement-statements/prepare", ...preparer, async (req, res) => {
  const user = req.authedUser!;
  const parsed = prepareSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid statement request", issues: parsed.error.issues });
  const body = parsed.data;
  const actor = await resolveStatementActor(user, body.transactionId);
  if (!actor) return void res.status(isPitCrew(user) ? 403 : 404).json({ error: isPitCrew(user) ? "Not assigned to this transaction" : "Not found" });
  try {
    const result = await db.transaction(async (tx) => {
      await lockTxn(tx, actor.transactionId);
      let payerUserId: number | null = null;
      let payerBrokerageId: number | null = null;
      if (body.payerType === "Agent") {
        if (!body.payerUserId) throw new StatementRefusal(422, "PAYER_REQUIRED", "Name the paying agent");
        const [agent] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, body.payerUserId), eq(users.brokerageId, user.brokerageId), eq(users.role, "Agent")));
        if (!agent) throw new StatementRefusal(422, "PAYER_INVALID", "Payer must be an agent in this brokerage");
        payerUserId = agent.id;
      } else {
        if (body.payerUserId) throw new StatementRefusal(422, "PAYER_INVALID", "A brokerage payer does not take a payerUserId");
        payerBrokerageId = user.brokerageId;
      }
      const existing = await tx.select().from(settlementStatements).where(eq(settlementStatements.transactionId, actor.transactionId)).orderBy(desc(settlementStatements.version));
      const draft = existing.find((s) => s.status === "DRAFT");
      const issued = existing.find((s) => s.status === "ISSUED");
      const reason = body.supersedeReason?.trim() ?? "";
      if (issued && !draft) {
        // N9: correcting an issued statement is a Brokerage Administrator decision, with a reason.
        if (!isAdmin(user)) throw new StatementRefusal(403, "STATEMENT_SUPERSEDE_FORBIDDEN", "Only a Brokerage Administrator can supersede an issued statement");
        if (!reason) throw new StatementRefusal(422, "SUPERSEDE_REASON_REQUIRED", "Give the reason the issued statement is being corrected");
      }
      if (draft && draft.supersedesId && !isAdmin(user)) throw new StatementRefusal(403, "STATEMENT_SUPERSEDE_FORBIDDEN", "Only a Brokerage Administrator can revise a superseding draft");
      const derived = await deriveStatement(tx, actor.transactionId, actor.propertyId);
      const payer = { payerType: body.payerType, payerUserId, payerBrokerageId };
      const fp = fingerprint(derived.lines, payer);
      const values = {
        payerType: body.payerType,
        payerUserId,
        payerBrokerageId,
        creditsCents: derived.creditsCents,
        debitsCents: derived.debitsCents,
        netCents: derived.netCents,
        pcServiceFeeCents: derived.pcServiceFeeCents,
        linesFingerprint: fp,
        preparedByUserId: user.id,
        preparedAt: new Date(),
        updatedAt: new Date(),
      };
      let statement: SettlementStatement;
      if (draft) {
        await tx.delete(settlementStatementLines).where(eq(settlementStatementLines.statementId, draft.id));
        [statement] = (await tx
          .update(settlementStatements)
          .set({ ...values, supersedeReason: draft.supersedesId ? reason || draft.supersedeReason : null })
          .where(and(eq(settlementStatements.id, draft.id), eq(settlementStatements.status, "DRAFT")))
          .returning()) as [SettlementStatement];
      } else {
        [statement] = (await tx
          .insert(settlementStatements)
          .values({
            ...values,
            brokerageId: user.brokerageId,
            propertyId: actor.propertyId,
            transactionId: actor.transactionId,
            version: (existing[0]?.version ?? 0) + 1,
            supersedesId: issued?.id ?? null,
            supersedeReason: issued ? reason : null,
          })
          .returning()) as [SettlementStatement];
      }
      if (derived.lines.length > 0) {
        await tx.insert(settlementStatementLines).values(derived.lines.map((l, i) => ({ ...l, statementId: statement.id, lineNo: i + 1 })));
      }
      await logAudit(
        {
          brokerageId: user.brokerageId,
          userId: user.id,
          action: "settlement_statement_prepared",
          recordType: "settlement_statement",
          recordId: String(statement.id),
          previousValue: draft ? JSON.stringify(draft) : undefined,
          updatedValue: JSON.stringify({ policy: SETTLEMENT_STATEMENT_POLICY, basis: actor.basis, after: statement, lines: derived.lines, issues: derived.issues }),
        },
        { strict: true, write: auditWriterFor(tx) },
      );
      return { statement, lines: derived.lines, issues: derived.issues };
    });
    res.status(201).json(result);
  } catch (err) {
    if (!send(res, err)) throw err;
  }
});

financialStatementsRouter.post("/financial/settlement-statements/:id/issue", ...preparer, async (req, res) => {
  const user = req.authedUser!;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return void res.status(404).json({ error: "Not found" });
  const [peek] = await db.select().from(settlementStatements).where(and(eq(settlementStatements.id, id), eq(settlementStatements.brokerageId, user.brokerageId)));
  if (!peek) return void res.status(404).json({ error: "Not found" });
  const actor = await resolveStatementActor(user, peek.transactionId);
  if (!actor) return void res.status(isPitCrew(user) ? 403 : 404).json({ error: isPitCrew(user) ? "Not assigned to this transaction" : "Not found" });
  try {
    const result = await db.transaction(async (tx) => {
      await lockTxn(tx, actor.transactionId);
      const [st] = await tx.select().from(settlementStatements).where(eq(settlementStatements.id, id)).for("update");
      if (!st || st.status !== "DRAFT") throw new StatementRefusal(409, "STATEMENT_NOT_DRAFT", "Only a draft statement can be issued; issued statements are immutable");
      if (st.supersedesId && !isAdmin(user)) throw new StatementRefusal(403, "STATEMENT_SUPERSEDE_FORBIDDEN", "Only a Brokerage Administrator can issue a superseding statement");
      const [txn] = await tx.select().from(transactions).where(eq(transactions.id, actor.transactionId));
      if (!txn!.settlementCompletedAt) throw new StatementRefusal(409, "SETTLEMENT_NOT_COMPLETE", "Settlement has not been recorded as complete");
      const confirmations = await tx
        .select()
        .from(settlementConfirmations)
        .where(and(eq(settlementConfirmations.transactionId, actor.transactionId), eq(settlementConfirmations.status, "ACTIVE")));
      const bySide = (side: "BUYER" | "SELLER"): SettlementConfirmation | undefined => confirmations.find((c) => c.side === side);
      const missing = (["BUYER", "SELLER"] as const).filter((side) => {
        const c = bySide(side);
        return !c || c.representativePartyId !== representativeFor(txn!.legalRepresentatives, side);
      });
      if (missing.length > 0) throw new StatementRefusal(409, "SETTLEMENT_CONFIRMATIONS_INCOMPLETE", `Written settlement confirmation outstanding: ${missing.join(", ")}`);
      const derived = await deriveStatement(tx, actor.transactionId, actor.propertyId);
      if (derived.issues.length > 0) throw new StatementRefusal(409, "STATEMENT_VALIDATION_FAILED", `Statement cannot be issued: ${derived.issues.join(", ")}`);
      if (derived.lines.length === 0) throw new StatementRefusal(409, "STATEMENT_VALIDATION_FAILED", "Statement has no lines");
      const payer = { payerType: st.payerType, payerUserId: st.payerUserId, payerBrokerageId: st.payerBrokerageId };
      if (fingerprint(derived.lines, payer) !== st.linesFingerprint) throw new StatementRefusal(409, "STATEMENT_LINES_STALE", "Source figures changed since the draft was prepared; prepare it again");
      const fp = derived.pcFeePayer;
      const payerMatches =
        fp == null ||
        (fp.payerType === "Agent" ? st.payerType === "Agent" && st.payerUserId === fp.payerUserId : st.payerType === "Brokerage" && st.payerBrokerageId === fp.payerBrokerageId);
      if (derived.pcServiceFeeCents != null && !payerMatches) {
        throw new StatementRefusal(409, "STATEMENT_PAYER_MISMATCH", "The statement payer must be the payer on the Pit Crew service-fee request");
      }
      const now = new Date();
      let superseded: SettlementStatement | null = null;
      if (st.supersedesId) {
        const [prev] = await tx
          .update(settlementStatements)
          .set({ status: "SUPERSEDED", supersededAt: now, supersededByUserId: user.id, updatedAt: now })
          .where(and(eq(settlementStatements.id, st.supersedesId), eq(settlementStatements.status, "ISSUED")))
          .returning();
        if (!prev) throw new StatementRefusal(409, "STATEMENT_NOT_SUPERSEDABLE", "The statement being corrected is no longer the issued version");
        superseded = prev;
      }
      const [issued] = await tx
        .update(settlementStatements)
        .set({ status: "ISSUED", issuedAt: now, issuedByUserId: user.id, buyerConfirmationId: bySide("BUYER")!.id, sellerConfirmationId: bySide("SELLER")!.id, updatedAt: now })
        .where(and(eq(settlementStatements.id, st.id), eq(settlementStatements.status, "DRAFT")))
        .returning();
      const write = auditWriterFor(tx);
      if (superseded) {
        await logAudit(
          { brokerageId: user.brokerageId, userId: user.id, action: "settlement_statement_superseded", recordType: "settlement_statement", recordId: String(superseded.id), previousValue: JSON.stringify({ status: "ISSUED" }), updatedValue: JSON.stringify({ policy: SETTLEMENT_STATEMENT_POLICY, supersededById: issued!.id, reason: st.supersedeReason }) },
          { strict: true, write },
        );
      }
      await logAudit(
        {
          brokerageId: user.brokerageId,
          userId: user.id,
          action: "settlement_statement_issued",
          recordType: "settlement_statement",
          recordId: String(issued!.id),
          previousValue: JSON.stringify(st),
          updatedValue: JSON.stringify({ policy: SETTLEMENT_STATEMENT_POLICY, basis: actor.basis, after: issued, confirmationIds: [bySide("BUYER")!.id, bySide("SELLER")!.id] }),
        },
        { strict: true, write },
      );
      return { statement: issued!, superseded, hasServiceFeeLine: derived.pcServiceFeeCents != null };
    });
    // Owner t180u(1) / D2: issue starts the gated service-fee collection automatically (after commit).
    const { autoCollectOnStatementIssue } = await import("../lib/pitCrewServiceFee.js");
    const collection = await autoCollectOnStatementIssue({
      brokerageId: user.brokerageId,
      transactionId: result.statement.transactionId,
      statementId: result.statement.id,
      issuerUserId: user.id,
      issuerRole: user.role,
      hasServiceFeeLine: result.hasServiceFeeLine,
    });
    res.json({ statement: result.statement, superseded: result.superseded, collection });
  } catch (err) {
    if (!send(res, err)) throw err;
  }
});

financialStatementsRouter.get("/financial/settlement-statements", ...preparer, async (req, res) => {
  const access = await canReadTransactionFinancials(req.authedUser!, Number(req.query.transactionId));
  if (!access) return void res.status(404).json({ error: "Not found" });
  const statements = await db.select().from(settlementStatements).where(eq(settlementStatements.transactionId, access.transactionId)).orderBy(settlementStatements.version);
  const lines = statements.length
    ? await db.select().from(settlementStatementLines).where(inArray(settlementStatementLines.statementId, statements.map((s) => s.id))).orderBy(settlementStatementLines.statementId, settlementStatementLines.lineNo)
    : [];
  res.json({ statements: statements.map((s) => ({ ...s, lines: lines.filter((l) => l.statementId === s.id) })) });
});
