// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E.
//
// HTTP surface over the financial control-and-evidence layer (Section 32).
// EVERY route requires Brokerage Administrator — this app's existing,
// twice-established precedent for "who can see financial data at all"
// (routes/exceptions.ts's canViewFinancials, reused unchanged by
// routes/commandCentre.ts) is BROKERAGE_ADMIN_ROLES only, and this build
// follows that precedent exactly rather than inventing a second, competing
// definition of financial visibility (mandatory starting procedure,
// Section 2 item 9: reuse, don't duplicate).
//
// requireAuth/requireRole are applied PER ROUTE (as handler arguments)
// rather than once via `financialRouter.use(...)` at the top of the file.
// financialRouter is mounted unprefixed at apiRouter's root (see
// routes/index.ts's own comment on why), and Express's Router.use()
// without a path matches every request that reaches this router instance
// — not just ones a route declared below will end up matching. A blanket
// `.use(requireAuth, ...)` here would therefore 401 any request that
// merely passes through financialRouter on its way to a later-mounted
// sibling, including financialWebhooksRouter's own
// POST /financial/webhooks/mandate-payments (a provider callback that
// carries no session cookie by design — see that router's own comment).
// Gating each route individually, matching exceptions.ts/pitCrew.ts's own
// established convention, keeps financialRouter from ever intercepting a
// path it doesn't itself own.
//
// Every handler re-derives brokerageId from req.authedUser and, for any
// route taking a transactionId, re-derives propertyId from the
// transaction's own property row (see lib/financial/queries.ts's
// resolveTransactionScope) — never from a client-supplied id. A
// cross-tenant id reads as 404, never 403, so it never reveals whether
// the row exists (same convention as routes/exceptions.ts/pitCrew.ts).
//
// Section 33 sensitive-data protection: every PC fee authority response
// (create/get/list/activate/revoke) goes through redactPcFeeAuthority()
// (hasMandate boolean, never the raw mandateProviderRef). This router
// never exposes financialPaymentProviderEvents (raw provider webhook
// payloads) at all — financialLedgerEvents is the evidence surface
// external readers get.

import { Router, type Response } from "express";
import { z } from "zod";
import { currentCorrelationId, logger } from "@aee/events";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { db, users } from "@aee/db";
import { eq, and } from "drizzle-orm";
import {
  createCommissionAgreement,
  approveCommissionAgreement,
  cancelCommissionAgreement,
  FinancialControlError,
} from "../lib/financial/agreements.js";
import {
  createPcFeeAuthority,
  activatePcFeeAuthority,
  revokePcFeeAuthority,
  redactPcFeeAuthority,
} from "../lib/financial/pcFeeAuthorities.js";
import { createCommissionCalculation } from "../lib/financial/calculations.js";
import { createPcFeeCalculation } from "../lib/financial/pcFeeCalculations.js";
import { finalizeCommissionForSettlement, ensurePcSuccessFeeRequest } from "../lib/financial/settlement.js";
import {
  advancePaymentRequestToNoticeSent,
  scheduleDebitForPaymentRequest,
  cancelScheduledDebit,
  reverseDebit,
  dispatchPendingPaymentOutbox,
} from "../lib/financial/paymentOutbox.js";
import { reconcileLegacyCommission } from "../lib/financial/legacyReconciliation.js";
import {
  listCommissionAgreements,
  getCommissionAgreement,
  listCommissionCalculations,
  listPcFeeAuthorities,
  getPcFeeAuthority,
  listPcFeeCalculations,
  listPaymentRequests,
  getPaymentRequest,
  listDisputesForPaymentRequest,
  listLedgerEvents,
  listMarketingPaymentRecords,
  listFinancialDeposits,
  listFinancialReconciliations,
  listAuditReturnReminders,
  getOrCreateFinancialSettings,
  getPropertyFinancialSummary,
  resolveTransactionScope,
} from "../lib/financial/queries.js";

export const financialRouter = Router();
const requireFinancialAdmin = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES)] as const;

function handleFinancialControlError(err: unknown, res: Response): boolean {
  if (err instanceof FinancialControlError) {
    // CUSTODY_BOUNDARY_VIOLATION (Critical Blocker Remediation, Phase 10) is a caller-input
    // rejection, not a state conflict — 400, not the 409 every other non-NOT_FOUND/
    // non-SEPARATION_OF_DUTIES reason falls back to.
    const status =
      err.reason === "NOT_FOUND" ? 404 : err.reason === "SEPARATION_OF_DUTIES" ? 403 : err.reason === "CUSTODY_BOUNDARY_VIOLATION" ? 400 : 409;
    res.status(status).json({ error: err.message, reason: err.reason });
    return true;
  }
  return false;
}

// Existing Stage C/D service functions throw plain Error for precondition
// failures (wrong state, missing prerequisite row, etc.) — never a raw
// 500 for a caller mistake, but honest that this isn't a schema-validation
// 400 either.
//
// AE Step 2 closure — Part C (typed-error-handling audit): this function
// trusts every `Error` reaching it to be one of those deliberate,
// safe-to-disclose precondition messages — a real assumption, not
// something this bounded pass re-verified against every "Stage C/D
// service function" call site (that would mean re-auditing this file's
// entire dependency graph, out of this pass's scope). What WAS a genuine,
// fixable gap: unlike the equivalent fallback in routes/pitCrew.ts,
// routes/import.ts, and routes/automationOps.ts (each of which logs the
// full error before responding), this one previously logged nothing at
// all — so if that assumption is ever wrong (a genuine bug or
// infrastructure error surfaces here instead of a deliberate precondition
// message), there would be zero server-side diagnostic trail. Fixed here,
// without changing the response contract any caller already depends on
// (still 409 with err.message, exactly as before).
function handlePlainError(err: unknown, res: Response): boolean {
  if (err instanceof Error) {
    logger.warn("financial_route_plain_error", { error: err });
    res.status(409).json({ error: err.message });
    return true;
  }
  return false;
}

async function agentBelongsToBrokerage(agentUserId: number, brokerageId: number): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, agentUserId), eq(users.brokerageId, brokerageId)));
  return Boolean(row);
}

// ---------------------------------------------------------------------
// Property Financial Summary (Section 28 preview) — nested under
// /properties/:propertyId, same reasoning as exceptions.ts's own
// per-property route living alongside its top-level ones.
// ---------------------------------------------------------------------

financialRouter.get("/properties/:propertyId/financial/summary", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = Number(req.params.propertyId);
  const summary = await getPropertyFinancialSummary(propertyId, user.brokerageId);
  if (!summary) return void res.status(404).json({ error: "Not found" });
  res.json(summary);
});

// ---------------------------------------------------------------------
// Commission agreements (Section 9).
// ---------------------------------------------------------------------

const commissionTierSchema = z.object({ upToCents: z.number().int().nullable(), rateBps: z.number().int() });

const createAgreementSchema = z.object({
  transactionId: z.coerce.number().int(),
  method: z.enum(["FIXED_AMOUNT", "PERCENTAGE", "TIERED", "MANUAL_WITH_REASON"]),
  rateBps: z.number().int().optional(),
  fixedAmountCents: z.number().int().optional(),
  tiers: z.array(commissionTierSchema).optional(),
  minimumAmountCents: z.number().int().optional(),
  manualReason: z.string().max(2000).optional(),
  gstApplicable: z.boolean().optional(),
  gstRateBps: z.number().int().optional(),
  referralFeeCents: z.number().int().optional(),
  brokerageSplitBps: z.number().int().optional(),
  agentSplitBps: z.number().int().optional(),
  sourceDocumentRef: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

financialRouter.get("/financial/commission-agreements", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = req.query.transactionId ? Number(req.query.transactionId) : undefined;
  res.json({ agreements: await listCommissionAgreements(user.brokerageId, transactionId) });
});

financialRouter.get("/financial/commission-agreements/:id", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const row = await getCommissionAgreement(Number(req.params.id), user.brokerageId);
  if (!row) return void res.status(404).json({ error: "Not found" });
  res.json({ agreement: row });
});

financialRouter.post("/financial/commission-agreements", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = createAgreementSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const scope = await resolveTransactionScope(parsed.data.transactionId, user.brokerageId);
  if (!scope) return void res.status(404).json({ error: "Transaction not found" });
  const agreement = await createCommissionAgreement({
    brokerageId: user.brokerageId,
    propertyId: scope.propertyId,
    transactionId: scope.transactionId,
    method: parsed.data.method,
    rateBps: parsed.data.rateBps,
    fixedAmountCents: parsed.data.fixedAmountCents,
    tiers: parsed.data.tiers,
    minimumAmountCents: parsed.data.minimumAmountCents,
    manualReason: parsed.data.manualReason,
    gstApplicable: parsed.data.gstApplicable,
    gstRateBps: parsed.data.gstRateBps,
    referralFeeCents: parsed.data.referralFeeCents,
    brokerageSplitBps: parsed.data.brokerageSplitBps,
    agentSplitBps: parsed.data.agentSplitBps,
    sourceDocumentRef: parsed.data.sourceDocumentRef,
    notes: parsed.data.notes,
    createdByUserId: user.id,
  });
  res.status(201).json({ agreement });
});

financialRouter.post("/financial/commission-agreements/:id/approve", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  try {
    const agreement = await approveCommissionAgreement(Number(req.params.id), user.brokerageId, user.id);
    res.json({ agreement });
  } catch (err) {
    if (!handleFinancialControlError(err, res)) throw err;
  }
});

const cancelAgreementSchema = z.object({ reason: z.string().min(1).max(2000) });

financialRouter.post("/financial/commission-agreements/:id/cancel", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = cancelAgreementSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const agreement = await cancelCommissionAgreement(Number(req.params.id), user.brokerageId, user.id, parsed.data.reason);
    res.json({ agreement });
  } catch (err) {
    if (!handleFinancialControlError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// Commission calculations (Sections 10-11) + settlement finalisation
// (Section 21) — a manual trigger, ahead of Stage F's automatic
// SETTLEMENT_COMPLETED subscriber.
// ---------------------------------------------------------------------

const createCalculationSchema = z.object({
  transactionId: z.coerce.number().int(),
  commissionAgreementId: z.number().int(),
  salePriceCentsInput: z.number().int().nonnegative(),
  state: z.enum(["ESTIMATE", "PROVISIONAL", "CONFIRMED", "FINALISED"]).optional(),
  supersede: z.boolean().optional(),
  supersededReason: z.string().max(2000).optional(),
});

financialRouter.get("/financial/commission-calculations", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = req.query.transactionId ? Number(req.query.transactionId) : undefined;
  res.json({ calculations: await listCommissionCalculations(user.brokerageId, transactionId) });
});

financialRouter.post("/financial/commission-calculations", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = createCalculationSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const scope = await resolveTransactionScope(parsed.data.transactionId, user.brokerageId);
  if (!scope) return void res.status(404).json({ error: "Transaction not found" });
  try {
    const calculation = await createCommissionCalculation({
      brokerageId: user.brokerageId,
      propertyId: scope.propertyId,
      transactionId: scope.transactionId,
      commissionAgreementId: parsed.data.commissionAgreementId,
      salePriceCentsInput: parsed.data.salePriceCentsInput,
      state: parsed.data.state,
      calculatedByUserId: user.id,
      supersede: parsed.data.supersede,
      supersededReason: parsed.data.supersededReason,
    });
    res.status(201).json({ calculation });
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

const finalizeSettlementSchema = z.object({ transactionId: z.coerce.number().int(), salePriceCentsOverride: z.number().int().nonnegative().optional() });

financialRouter.post("/financial/settlement/finalize-commission", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = finalizeSettlementSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const scope = await resolveTransactionScope(parsed.data.transactionId, user.brokerageId);
  if (!scope) return void res.status(404).json({ error: "Transaction not found" });
  try {
    const result = await finalizeCommissionForSettlement({
      transactionId: scope.transactionId,
      brokerageId: user.brokerageId,
      propertyId: scope.propertyId,
      salePriceCentsOverride: parsed.data.salePriceCentsOverride,
    });
    res.json(result);
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// Legacy commission reconciliation (Financial Transaction Engine
// Verification, Step 2, COHERENCE-001 remediation). Never writes to
// commissionAgreements/commissionCalculations — see lib/financial/
// legacyReconciliation.ts's module header for the full rationale. This is
// the "authorised reconciliation action" behind FinancialSummarySection.
// tsx's "Flag for reconciliation" button.
// ---------------------------------------------------------------------

financialRouter.post("/financial/transactions/:transactionId/legacy-commission/reconcile", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = Number(req.params.transactionId);
  const scope = await resolveTransactionScope(transactionId, user.brokerageId);
  if (!scope) return void res.status(404).json({ error: "Transaction not found" });
  try {
    const result = await reconcileLegacyCommission({
      transactionId: scope.transactionId,
      brokerageId: user.brokerageId,
      propertyId: scope.propertyId,
      actorUserId: user.id,
    });
    if (!result.reconciliation) return void res.status(409).json({ error: result.skippedReason ?? "Nothing to reconcile." });
    res.status(result.created ? 201 : 200).json({ reconciliation: result.reconciliation, created: result.created });
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// PC fee authorities (Sections 13-14).
// ---------------------------------------------------------------------

const createAuthoritySchema = z.object({
  agentUserId: z.number().int(),
  feeBasis: z.enum(["PERCENTAGE_OF_GCI", "FIXED_AMOUNT", "NONE", "MANUAL_WITH_REASON"]).optional(),
  rateBps: z.number().int().optional(),
  fixedAmountCents: z.number().int().optional(),
  gciDefinition: z.enum(["COMMISSION_EX_GST", "COMMISSION_INC_GST"]).optional(),
  gstApplicable: z.boolean().optional(),
  maximumAmountCents: z.number().int().optional(),
  noticeRequiredDays: z.number().int().min(0).optional(),
  signedEvidenceRef: z.string().max(500).optional(),
});

financialRouter.get("/financial/pc-fee-authorities", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const agentUserId = req.query.agentUserId ? Number(req.query.agentUserId) : undefined;
  res.json({ authorities: await listPcFeeAuthorities(user.brokerageId, agentUserId) });
});

financialRouter.get("/financial/pc-fee-authorities/:id", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const row = await getPcFeeAuthority(Number(req.params.id), user.brokerageId);
  if (!row) return void res.status(404).json({ error: "Not found" });
  res.json({ authority: row });
});

financialRouter.post("/financial/pc-fee-authorities", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = createAuthoritySchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  if (!(await agentBelongsToBrokerage(parsed.data.agentUserId, user.brokerageId))) {
    return void res.status(404).json({ error: "Agent not found" });
  }
  const authority = await createPcFeeAuthority({ ...parsed.data, brokerageId: user.brokerageId, createdByUserId: user.id });
  res.status(201).json({ authority: redactPcFeeAuthority(authority) });
});

const activateAuthoritySchema = z.object({ mandateProviderRef: z.string().min(1).max(500), mandateProvider: z.string().min(1).max(200) });

financialRouter.post("/financial/pc-fee-authorities/:id/activate", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = activateAuthoritySchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const authority = await activatePcFeeAuthority(Number(req.params.id), user.brokerageId, user.id, parsed.data.mandateProviderRef, parsed.data.mandateProvider);
    res.json({ authority: redactPcFeeAuthority(authority) });
  } catch (err) {
    if (!handleFinancialControlError(err, res)) throw err;
  }
});

const revokeAuthoritySchema = z.object({ reason: z.string().min(1).max(2000) });

financialRouter.post("/financial/pc-fee-authorities/:id/revoke", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = revokeAuthoritySchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const authority = await revokePcFeeAuthority(Number(req.params.id), user.brokerageId, user.id, parsed.data.reason);
    res.json({ authority: redactPcFeeAuthority(authority) });
  } catch (err) {
    if (!handleFinancialControlError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// PC fee calculations (Section 12) + settlement PC-success-fee request
// (Section 21) — a manual trigger, ahead of Stage F's automatic
// SETTLEMENT_COMPLETED subscriber.
// ---------------------------------------------------------------------

const createPcCalculationSchema = z.object({
  transactionId: z.coerce.number().int(),
  pcFeeAuthorityId: z.number().int(),
  commissionCalculationId: z.number().int(),
  state: z.enum(["ESTIMATE", "PROVISIONAL", "CONFIRMED", "FINALISED"]).optional(),
});

financialRouter.get("/financial/pc-fee-calculations", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = req.query.transactionId ? Number(req.query.transactionId) : undefined;
  res.json({ calculations: await listPcFeeCalculations(user.brokerageId, transactionId) });
});

financialRouter.post("/financial/pc-fee-calculations", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = createPcCalculationSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const scope = await resolveTransactionScope(parsed.data.transactionId, user.brokerageId);
  if (!scope) return void res.status(404).json({ error: "Transaction not found" });
  try {
    const calculation = await createPcFeeCalculation({
      brokerageId: user.brokerageId,
      propertyId: scope.propertyId,
      transactionId: scope.transactionId,
      pcFeeAuthorityId: parsed.data.pcFeeAuthorityId,
      commissionCalculationId: parsed.data.commissionCalculationId,
      state: parsed.data.state,
      calculatedByUserId: user.id,
    });
    res.status(201).json({ calculation });
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

const ensurePcRequestSchema = z.object({ transactionId: z.coerce.number().int(), pcFeeCalculationId: z.number().int(), payeeUserId: z.number().int().optional(), payerUserId: z.number().int().optional() });

financialRouter.post("/financial/settlement/ensure-pc-success-fee", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = ensurePcRequestSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const scope = await resolveTransactionScope(parsed.data.transactionId, user.brokerageId);
  if (!scope) return void res.status(404).json({ error: "Transaction not found" });
  try {
    const result = await ensurePcSuccessFeeRequest({
      transactionId: scope.transactionId,
      brokerageId: user.brokerageId,
      propertyId: scope.propertyId,
      pcFeeCalculationId: parsed.data.pcFeeCalculationId,
      payeeUserId: parsed.data.payeeUserId,
      payerUserId: parsed.data.payerUserId,
    });
    res.status(201).json(result);
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// Payment requests — the PC success-fee debit lifecycle (Sections 14-16,
// 31). Every action route loads the row scoped to the caller's brokerage
// FIRST (404 on a cross-tenant id) before calling into the Stage D
// service function, since those functions take only a bare id and do not
// re-check tenancy themselves.
// ---------------------------------------------------------------------

financialRouter.get("/financial/payment-requests", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = req.query.transactionId ? Number(req.query.transactionId) : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ paymentRequests: await listPaymentRequests(user.brokerageId, { transactionId, status }) });
});

financialRouter.get("/financial/payment-requests/:id", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const row = await getPaymentRequest(Number(req.params.id), user.brokerageId);
  if (!row) return void res.status(404).json({ error: "Not found" });
  const disputes = await listDisputesForPaymentRequest(row.id, user.brokerageId);
  res.json({ paymentRequest: row, disputes });
});

financialRouter.post("/financial/payment-requests/:id/notice-sent", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const existing = await getPaymentRequest(Number(req.params.id), user.brokerageId);
  if (!existing) return void res.status(404).json({ error: "Not found" });
  try {
    const paymentRequest = await advancePaymentRequestToNoticeSent(existing.id);
    res.json({ paymentRequest });
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

financialRouter.post("/financial/payment-requests/:id/schedule-debit", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const existing = await getPaymentRequest(Number(req.params.id), user.brokerageId);
  if (!existing) return void res.status(404).json({ error: "Not found" });
  try {
    // Step 2 hardening: without this, paymentOutbox.ts's stored
    // correlationId was always null (nothing upstream ever passed one),
    // so dispatchOutboxEntry's later background sweep re-established a
    // fresh, disconnected id per attempt instead of continuing this
    // request's chain — same bug class as communications/outbox.ts's
    // dispatch gap, fixed the same way: capture it once, at the point the
    // outbox row is created, and store it on the row.
    const result = await scheduleDebitForPaymentRequest({ paymentRequestId: existing.id, correlationId: currentCorrelationId() });
    res.json(result);
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

const cancelDebitSchema = z.object({ reason: z.string().min(1).max(2000) });

financialRouter.post("/financial/payment-requests/:id/cancel-debit", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = cancelDebitSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const existing = await getPaymentRequest(Number(req.params.id), user.brokerageId);
  if (!existing) return void res.status(404).json({ error: "Not found" });
  try {
    const paymentRequest = await cancelScheduledDebit({ paymentRequestId: existing.id, reason: parsed.data.reason, actorUserId: user.id });
    res.json({ paymentRequest });
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

const reverseDebitSchema = z.object({ reason: z.string().min(1).max(2000) });

financialRouter.post("/financial/payment-requests/:id/reverse", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const parsed = reverseDebitSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const existing = await getPaymentRequest(Number(req.params.id), user.brokerageId);
  if (!existing) return void res.status(404).json({ error: "Not found" });
  try {
    const paymentRequest = await reverseDebit({ paymentRequestId: existing.id, reason: parsed.data.reason, actorUserId: user.id });
    res.json({ paymentRequest });
  } catch (err) {
    if (!handlePlainError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// Evidence + reporting reads (Sections 17-20, 23) and settings.
// ---------------------------------------------------------------------

financialRouter.get("/financial/ledger-events", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = req.query.transactionId ? Number(req.query.transactionId) : undefined;
  const propertyId = req.query.propertyId ? Number(req.query.propertyId) : undefined;
  res.json({ events: await listLedgerEvents(user.brokerageId, { transactionId, propertyId }) });
});

financialRouter.get("/financial/marketing-payment-records", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = req.query.propertyId ? Number(req.query.propertyId) : undefined;
  res.json({ records: await listMarketingPaymentRecords(user.brokerageId, propertyId) });
});

financialRouter.get("/financial/deposits", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const transactionId = req.query.transactionId ? Number(req.query.transactionId) : undefined;
  res.json({ deposits: await listFinancialDeposits(user.brokerageId, transactionId) });
});

financialRouter.get("/financial/reconciliations", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  const recordType = typeof req.query.recordType === "string" ? req.query.recordType : undefined;
  const recordId = typeof req.query.recordId === "string" ? req.query.recordId : undefined;
  res.json({ reconciliations: await listFinancialReconciliations(user.brokerageId, recordType, recordId) });
});

financialRouter.get("/financial/audit-return-reminders", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  res.json({ reminders: await listAuditReturnReminders(user.brokerageId) });
});

financialRouter.get("/financial/settings", ...requireFinancialAdmin, async (req, res) => {
  const user = req.authedUser!;
  res.json({ settings: await getOrCreateFinancialSettings(user.brokerageId) });
});

// ---------------------------------------------------------------------
// Ops — manual outbox sweep trigger, mirroring routes/exceptions.ts's own
// admin-gated /exceptions/ops/scan pattern. Stage F wires the recurring
// schedule; this is the same operational escape hatch exceptions.ts's
// scan endpoint provides ahead of/alongside its own scheduler.
// ---------------------------------------------------------------------

financialRouter.post("/financial/ops/dispatch-outbox", ...requireFinancialAdmin, async (_req, res) => {
  const result = await dispatchPendingPaymentOutbox();
  res.json({ result });
});
