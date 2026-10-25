// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E.
//
// PC (Pit Crew) success-fee authority authoring/activation service
// (Sections 13-14). Stage C's pcFeeCalculations.ts only ever READS an
// ACTIVE pcFeeAuthorities row; this is the missing write path that gets
// one to ACTIVE in the first place.
//
// Section 33 sensitive-data protection: this module's own create input
// type has NO mandateProviderRef/mandateProvider fields at all — it is
// structurally impossible to set a mandate reference at draft time. A
// mandate reference only ever enters the system via activatePcFeeAuthority,
// modelling the real flow (financial.ts schema header, Section 13/33):
// the agent's general-account debit mandate is authorised through an
// external, already-verified process, and THIS call merely records the
// resulting provider-issued reference — it never captures raw bank
// credentials and never originates a mandate itself.
//
// Separation of duties: the same person cannot both create an authority
// and activate it — the PC success-fee mandate is exactly the kind of
// binding financial authorisation Section 32/33's "control" language is
// about, and a single actor unilaterally self-authorising their own debit
// mandate defeats the point of an authority record existing at all.
//
// Stage F: activatePcFeeAuthority/revokePcFeeAuthority additionally
// publish PC_FEE_AUTHORITY_ACTIVATED/PC_FEE_AUTHORITY_REVOKED to the
// canonical event bus (events.ts) — never the mandateProviderRef itself
// in the payload, consistent with this module's own Section 33 posture
// above.

import { eq, and } from "drizzle-orm";
import { db, pcFeeAuthorities, financialLedgerEvents, paymentMethods, type PcFeeAuthority, type PcFeeBasis } from "@aee/db";
import { FinancialControlError } from "./agreements.js";
import { emitFinancialEvent } from "./events.js";
import { noteFinancialPcFeeAuthorityIsolationRejection } from "./isolationRejection.js";

async function recordLedgerEvent(input: {
  brokerageId: number;
  eventType: string;
  sourceRecordType: string;
  sourceRecordId: string;
  actorType: "SYSTEM" | "USER";
  actorUserId?: number | null;
  reason?: string | null;
}): Promise<void> {
  await db.insert(financialLedgerEvents).values({
    brokerageId: input.brokerageId,
    eventType: input.eventType,
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    reason: input.reason ?? null,
  });
}

async function nextPcFeeAuthorityVersion(agentUserId: number): Promise<number> {
  const rows = await db.select({ version: pcFeeAuthorities.version }).from(pcFeeAuthorities).where(eq(pcFeeAuthorities.agentUserId, agentUserId));
  const maxVersion = rows.reduce((max, r) => Math.max(max, r.version), 0);
  return maxVersion + 1;
}

// Critical Blocker Remediation, Phase 10 — custody-boundary lock.
//
// docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md §16 confirmed the
// "AE must not receive, hold, transfer or disburse trust money" claim held
// in effect (no trust-account model exists anywhere in this codebase) but
// was NOT a technically enforced invariant: authorisedPaymentMethod was a
// free-text column with no validation anywhere, so nothing in code would
// have rejected a future caller (a script, a bulk-import, a future admin UI
// feature) that passed something other than "GENERAL_ACCOUNT_DEBIT_MANDATE"
// — the claim held only because no such caller happened to exist yet, per
// that audit's own closing recommendation. This is the enforced version:
// createPcFeeAuthority() below now rejects any other value outright, so the
// custody boundary is a real assertion, not an emergent property of what
// hasn't been built. The one value ever actually reachable through the
// existing POST /financial/pc-fee-authorities route was already this one —
// its Zod schema (routes/financial.ts) has never accepted
// authorisedPaymentMethod as input at all — so this closes the gap for
// every OTHER caller (scripts, future routes) without changing today's
// route's observable behaviour at all.
//
// Owner t180u(3) (slice 6, D8): STORED_CARD is added as the second, and only
// other, permitted method: one tokenised payment_methods row of the payer,
// charged through paymentProvider.chargeStoredMethod. Neither method touches
// a bank or trust account: the custody boundary above still holds (AE never
// receives, holds or disburses trust money; a card charge is AE's own
// service fee taken from the agent's or brokerage's own card).
export const ALLOWED_PC_FEE_AUTHORISED_PAYMENT_METHODS = ["GENERAL_ACCOUNT_DEBIT_MANDATE", "STORED_CARD"] as const;
export type PcFeeAuthorisedPaymentMethod = (typeof ALLOWED_PC_FEE_AUTHORISED_PAYMENT_METHODS)[number];
export type PcFeeAuthorityPayerType = "Agent" | "Brokerage";

/**
 * D8/D3: the nominated card must be an ACTIVE tokenised method belonging to
 * the authority's payer: the agent's own card for an Agent authority, the
 * brokerage's card for a Brokerage authority. Returns the row or null.
 */
export async function nominatedPaymentMethodFor(authority: Pick<PcFeeAuthority, "paymentMethodId" | "payerType" | "agentUserId" | "brokerageId">) {
  if (authority.paymentMethodId == null) return null;
  const [pm] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, authority.paymentMethodId));
  if (!pm || !pm.isActive) return null;
  const expectedPayerId = authority.payerType === "Brokerage" ? authority.brokerageId : authority.agentUserId;
  if (pm.payerType !== authority.payerType || pm.payerId !== expectedPayerId) return null;
  return pm;
}

export interface CreatePcFeeAuthorityInput {
  brokerageId: number;
  agentUserId: number;
  feeBasis?: PcFeeBasis;
  rateBps?: number | null;
  fixedAmountCents?: number | null;
  gciDefinition?: "COMMISSION_EX_GST" | "COMMISSION_INC_GST";
  gstApplicable?: boolean;
  paymentTrigger?: string;
  authorisedPaymentMethod?: string;
  /** t180u(3): whose authority covers the charge. Brokerage requires STORED_CARD (D3). */
  payerType?: PcFeeAuthorityPayerType;
  /** t180u(3): the single nominated card (STORED_CARD only). */
  paymentMethodId?: number | null;
  maximumAmountCents?: number | null;
  noticeRequiredDays?: number;
  signedEvidenceRef?: string | null;
  effectiveDate?: Date | null;
  createdByUserId: number;
}

/** Drafts a new, not-yet-active PC fee authority version for an agent. Never edits a prior version. */
export async function createPcFeeAuthority(input: CreatePcFeeAuthorityInput): Promise<PcFeeAuthority> {
  if (
    input.authorisedPaymentMethod !== undefined &&
    !(ALLOWED_PC_FEE_AUTHORISED_PAYMENT_METHODS as readonly string[]).includes(input.authorisedPaymentMethod)
  ) {
    throw new FinancialControlError(
      "CUSTODY_BOUNDARY_VIOLATION",
      `authorisedPaymentMethod "${input.authorisedPaymentMethod}" is not permitted — a PC fee authority may only ever be scoped to ${ALLOWED_PC_FEE_AUTHORISED_PAYMENT_METHODS.join(", ")}. AE does not receive, hold, transfer, or disburse trust money (see docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md §16).`,
    );
  }

  const method = (input.authorisedPaymentMethod ?? "GENERAL_ACCOUNT_DEBIT_MANDATE") as PcFeeAuthorisedPaymentMethod;
  const payerType: PcFeeAuthorityPayerType = input.payerType ?? "Agent";
  if (payerType !== "Agent" && payerType !== "Brokerage") throw new FinancialControlError("INVALID_PAYMENT_METHOD", "payerType must be Agent or Brokerage.");
  if (method === "STORED_CARD") {
    if (input.paymentMethodId == null) throw new FinancialControlError("INVALID_PAYMENT_METHOD", "A stored-card authority must nominate exactly one payment method.");
    const pm = await nominatedPaymentMethodFor({ paymentMethodId: input.paymentMethodId, payerType, agentUserId: input.agentUserId, brokerageId: input.brokerageId });
    if (!pm) throw new FinancialControlError("INVALID_PAYMENT_METHOD", "The nominated card is not an active saved card of the authority's payer.");
  } else {
    if (input.paymentMethodId != null) throw new FinancialControlError("INVALID_PAYMENT_METHOD", "A direct-debit authority cannot also nominate a card (single nominated method, no fallback).");
    if (payerType === "Brokerage") throw new FinancialControlError("INVALID_PAYMENT_METHOD", "A brokerage-paid authority must use a stored brokerage card.");
  }

  const version = await nextPcFeeAuthorityVersion(input.agentUserId);
  const [row] = await db
    .insert(pcFeeAuthorities)
    .values({
      brokerageId: input.brokerageId,
      agentUserId: input.agentUserId,
      version,
      status: "PENDING",
      feeBasis: input.feeBasis ?? "PERCENTAGE_OF_GCI",
      rateBps: input.rateBps ?? null,
      fixedAmountCents: input.fixedAmountCents ?? null,
      gciDefinition: input.gciDefinition ?? "COMMISSION_EX_GST",
      gstApplicable: input.gstApplicable ?? true,
      paymentTrigger: input.paymentTrigger ?? "SETTLEMENT_COMPLETED",
      authorisedPaymentMethod: method,
      payerType,
      paymentMethodId: method === "STORED_CARD" ? input.paymentMethodId! : null,
      maximumAmountCents: input.maximumAmountCents ?? null,
      noticeRequiredDays: input.noticeRequiredDays ?? 7,
      signedEvidenceRef: input.signedEvidenceRef ?? null,
      effectiveDate: input.effectiveDate ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  return row;
}

/**
 * Activates a PENDING authority once its mandate has been authorised
 * externally, recording the provider's own reference. Any existing ACTIVE
 * authority for the same agent is superseded (REPLACED), never edited.
 */
export async function activatePcFeeAuthority(
  id: number,
  brokerageId: number,
  actorUserId: number,
  mandateProviderRef: string | null | undefined,
  mandateProvider: string | null | undefined,
): Promise<PcFeeAuthority> {
  const [authority] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, id));
  if (!authority || authority.brokerageId !== brokerageId) {
    await noteFinancialPcFeeAuthorityIsolationRejection(id, brokerageId);
    throw new FinancialControlError("NOT_FOUND", `PC fee authority ${id} not found.`);
  }
  if (authority.status !== "PENDING") {
    throw new FinancialControlError("INVALID_STATUS", `PC fee authority ${id} is ${authority.status}, not PENDING.`);
  }
  if (authority.createdByUserId != null && authority.createdByUserId === actorUserId) {
    throw new FinancialControlError("SEPARATION_OF_DUTIES", "The user who drafted a PC fee authority cannot also activate it.");
  }
  const isCard = authority.authorisedPaymentMethod === "STORED_CARD";
  let cardProvider: string | null = null;
  if (isCard) {
    // t180u(3) D8: a card authority has exactly one method: its nominated card. No mandate alongside it.
    if (mandateProviderRef) throw new FinancialControlError("INVALID_PAYMENT_METHOD", "A stored-card authority does not take a mandate reference (single nominated method).");
    const pm = await nominatedPaymentMethodFor(authority);
    if (!pm) throw new FinancialControlError("INVALID_PAYMENT_METHOD", "The nominated card is no longer an active saved card of the authority's payer.");
    if (!authority.signedEvidenceRef) throw new FinancialControlError("INVALID_STATUS", "A signed authority (signedEvidenceRef) is required to activate a stored-card authority.");
    cardProvider = pm.provider;
  } else if (!mandateProviderRef || mandateProviderRef.trim().length === 0) {
    throw new FinancialControlError("INVALID_STATUS", "A mandateProviderRef is required to activate a PC fee authority.");
  }
  // D3: activating a brokerage-card authority IS the Brokerage Administrator approval (route is BA-only; drafter excluded above).
  const brokerageApproval = authority.payerType === "Brokerage" ? { brokerageCardApprovedByUserId: actorUserId, brokerageCardApprovedAt: new Date() } : {};

  const priorActiveRows = await db
    .select()
    .from(pcFeeAuthorities)
    .where(and(eq(pcFeeAuthorities.agentUserId, authority.agentUserId), eq(pcFeeAuthorities.status, "ACTIVE")));
  const priorActive = priorActiveRows[0];
  if (priorActive) {
    await db.update(pcFeeAuthorities).set({ status: "REPLACED", updatedAt: new Date() }).where(eq(pcFeeAuthorities.id, priorActive.id));
  }

  const [updated] = await db
    .update(pcFeeAuthorities)
    .set({
      status: "ACTIVE",
      supersedesId: priorActive?.id ?? authority.supersedesId,
      mandateProviderRef: isCard ? null : mandateProviderRef!,
      mandateProvider: isCard ? cardProvider : (mandateProvider ?? null),
      ...brokerageApproval,
      effectiveDate: authority.effectiveDate ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pcFeeAuthorities.id, id))
    .returning();

  await recordLedgerEvent({
    brokerageId: updated.brokerageId,
    eventType: "PC_FEE_AUTHORITY_ACTIVATED",
    sourceRecordType: "PC_FEE_AUTHORITY",
    sourceRecordId: String(updated.id),
    actorType: "USER",
    actorUserId,
  });

  await emitFinancialEvent({
    eventType: "PC_FEE_AUTHORITY_ACTIVATED",
    brokerageId: updated.brokerageId,
    propertyId: null,
    agentId: updated.agentUserId,
    actorType: "USER",
    actorId: actorUserId,
    source: "api:financial:activatePcFeeAuthority",
    payload: { pcFeeAuthorityId: updated.id, agentUserId: updated.agentUserId, feeBasis: updated.feeBasis, authorisedPaymentMethod: updated.authorisedPaymentMethod, payerType: updated.payerType },
  });

  return updated;
}

/** Revokes a PENDING or ACTIVE authority. */
export async function revokePcFeeAuthority(id: number, brokerageId: number, actorUserId: number, reason: string): Promise<PcFeeAuthority> {
  const [authority] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, id));
  if (!authority || authority.brokerageId !== brokerageId) {
    await noteFinancialPcFeeAuthorityIsolationRejection(id, brokerageId);
    throw new FinancialControlError("NOT_FOUND", `PC fee authority ${id} not found.`);
  }
  if (authority.status !== "PENDING" && authority.status !== "ACTIVE") {
    throw new FinancialControlError("INVALID_STATUS", `PC fee authority ${id} is ${authority.status}, not PENDING/ACTIVE.`);
  }

  const [updated] = await db
    .update(pcFeeAuthorities)
    .set({ status: "REVOKED", revokedByUserId: actorUserId, revokedAt: new Date(), revokeReason: reason, updatedAt: new Date() })
    .where(eq(pcFeeAuthorities.id, id))
    .returning();

  await recordLedgerEvent({
    brokerageId: updated.brokerageId,
    eventType: "PC_FEE_AUTHORITY_REVOKED",
    sourceRecordType: "PC_FEE_AUTHORITY",
    sourceRecordId: String(updated.id),
    actorType: "USER",
    actorUserId,
    reason,
  });

  await emitFinancialEvent({
    eventType: "PC_FEE_AUTHORITY_REVOKED",
    brokerageId: updated.brokerageId,
    propertyId: null,
    agentId: updated.agentUserId,
    actorType: "USER",
    actorId: actorUserId,
    source: "api:financial:revokePcFeeAuthority",
    payload: { pcFeeAuthorityId: updated.id, agentUserId: updated.agentUserId, reason },
  });

  return updated;
}

/**
 * Section 33: the shape every API response uses for a PC fee authority —
 * never the raw mandateProviderRef, only whether one is on file.
 */
export interface RedactedPcFeeAuthority extends Omit<PcFeeAuthority, "mandateProviderRef"> {
  hasMandate: boolean;
}

export function redactPcFeeAuthority(row: PcFeeAuthority): RedactedPcFeeAuthority {
  const { mandateProviderRef, ...rest } = row;
  return { ...rest, hasMandate: mandateProviderRef != null && mandateProviderRef.length > 0 };
}
