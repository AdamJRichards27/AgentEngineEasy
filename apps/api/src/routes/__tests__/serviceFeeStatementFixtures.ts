// Owner t180u: shared synthetic fixtures for statement-driven Pit Crew
// service-fee collection, receipts and stored-card / brokerage payments.
// Synthetic data only; scratch databases only.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  commissionAgreements,
  documents,
  entitlementGrants,
  financialPaymentRequests,
  parties,
  pcFeeAuthorities,
  pitCrewAssignments,
  riskExceptions,
  transactions,
  users,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createCommissionAgreement } from "../../lib/financial/agreements.js";
import { createCommissionCalculation } from "../../lib/financial/calculations.js";
import { createPcFeeAuthority } from "../../lib/financial/pcFeeAuthorities.js";
import { createPcFeeCalculation } from "../../lib/financial/pcFeeCalculations.js";
import { ensurePcSuccessFeeRequest } from "../../lib/financial/settlement.js";
import { createBrokerageWithUsers, createTransactionFromListedProperty, devLogin, type DevLoginResult } from "./testSupport.js";

export type Who = DevLoginResult;
export interface World {
  baseUrl: string;
  suffix: string;
  X: { admin: Who; agent: Who; brokerageId: number };
  Y: { admin: Who; agent: Who; brokerageId: number };
  admin2: Who;
  crew: Who;
  crewUnassigned: Who;
  otherAgent: Who;
}

export async function call(baseUrl: string, method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await res.text();
  let json: Record<string, any> = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = {};
  }
  return { status: res.status, raw, json, headers: res.headers };
}

export async function grantRun(brokerageId: number) {
  const rows = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  if (rows.length === 0) {
    await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: "run.access", granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  }
  invalidateEntitlementCache(brokerageId);
}

export async function makeWorld(baseUrl: string, tag: string): Promise<World> {
  const suffix = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const nameX = `${tag} X ${suffix}`;
  const X = await createBrokerageWithUsers(baseUrl, nameX);
  const Y = await createBrokerageWithUsers(baseUrl, `${tag} Y ${suffix}`);
  await grantRun(X.brokerageId);
  await grantRun(Y.brokerageId);
  const inX = async (n: string, role: string) => {
    const r = await devLogin(baseUrl, { email: `${n}-${suffix}@example.com`, firstName: n, lastName: "Synthetic", brokerageName: nameX });
    await db.update(users).set({ role }).where(eq(users.id, r.user.id));
    return r;
  };
  return {
    baseUrl,
    suffix,
    X,
    Y,
    admin2: await inX("admin2", "Brokerage Administrator"),
    crew: await inX("crew", "Pit Crew"),
    crewUnassigned: await inX("crew2", "Pit Crew"),
    otherAgent: await inX("agent2", "Agent"),
  };
}

export const MANDATE_REF_PREFIX = "sandbox-mandate-t180u";

/** An ACTIVE direct-debit authority for X.agent (activated by a second BA). */
export async function activeDebitAuthority(w: World, overrides: Partial<typeof pcFeeAuthorities.$inferInsert> = {}) {
  const a = await createPcFeeAuthority({
    brokerageId: w.X.brokerageId,
    agentUserId: w.X.agent.user.id,
    feeBasis: "PERCENTAGE_OF_GCI",
    rateBps: 690,
    gstApplicable: true,
    maximumAmountCents: 1_000_000,
    noticeRequiredDays: 7,
    signedEvidenceRef: "synthetic-signed-authority",
    createdByUserId: w.X.admin.user.id,
  });
  const [row] = await db
    .update(pcFeeAuthorities)
    .set({ status: "ACTIVE", mandateProviderRef: `${MANDATE_REF_PREFIX}-${a.id}`, mandateProvider: "sandbox", effectiveDate: new Date(Date.now() - 86_400_000), ...overrides })
    .where(eq(pcFeeAuthorities.id, a.id))
    .returning();
  return row!;
}

export interface Chain {
  propertyId: number;
  transactionId: number;
  requestId: number;
  amountCents: number;
  buyerRep: number;
  sellerRep: number;
  docId: number;
}

/** Settled transaction with solicitors, FINALISED commission + PC fee calc, CALCULATED request, Pit Crew assigned. */
export async function feeChain(w: World, authorityId: number, tag: string, opts: { settled?: boolean } = {}): Promise<Chain> {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(w.baseUrl, w.X.agent.cookie, { address: `${w.suffix} ${tag} St` });
  const [buyerRep, sellerRep] = await db
    .insert(parties)
    .values([
      { brokerageId: w.X.brokerageId, partyType: "Organisation", organisationName: `Buyer Solicitors ${tag} (synthetic)` },
      { brokerageId: w.X.brokerageId, partyType: "Organisation", organisationName: `Seller Solicitors ${tag} (synthetic)` },
    ])
    .returning({ id: parties.id });
  await db
    .update(transactions)
    .set({
      legalRepresentatives: { buyerSolicitorPartyId: buyerRep!.id, sellerSolicitorPartyId: sellerRep!.id },
      unconditionalAt: new Date(Date.now() - 20 * 86_400_000),
      ...(opts.settled === false ? {} : { status: "Settled", settlementCompletedAt: new Date(Date.now() - 86_400_000) }),
    })
    .where(eq(transactions.id, transactionId));
  const [doc] = await db.insert(documents).values({ propertyId, documentType: "SettlementConfirmation", title: "Synthetic settlement confirmation" }).returning({ id: documents.id });
  const agreement = await createCommissionAgreement({ brokerageId: w.X.brokerageId, propertyId, transactionId, method: "PERCENTAGE", rateBps: 200, createdByUserId: w.X.admin.user.id });
  await db.update(commissionAgreements).set({ status: "APPROVED", approvedAt: new Date() }).where(eq(commissionAgreements.id, agreement.id));
  const commission = await createCommissionCalculation({ brokerageId: w.X.brokerageId, propertyId, transactionId, commissionAgreementId: agreement.id, salePriceCentsInput: 80_000_000, state: "FINALISED" });
  const pcCalc = await createPcFeeCalculation({ brokerageId: w.X.brokerageId, propertyId, transactionId, pcFeeAuthorityId: authorityId, commissionCalculationId: commission.id, state: "FINALISED" });
  const { paymentRequest } = await ensurePcSuccessFeeRequest({ transactionId, brokerageId: w.X.brokerageId, propertyId, pcFeeCalculationId: pcCalc.id, payerUserId: w.X.agent.user.id });
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: w.X.brokerageId,
      propertyId,
      transactionId,
      ruleId: "t180u-test-rule",
      category: "FINANCIAL",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic settlement work ${tag}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `t180u-${tag}-${w.suffix}`,
      correlationId: randomUUID(),
      dedupKey: `t180u-${tag}-${w.suffix}`,
      openDedupKey: `t180u-${tag}-${w.suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db.insert(pitCrewAssignments).values({ brokerageId: w.X.brokerageId, sourceType: "EXCEPTION", sourceRecordId: String(ex!.id), propertyId, status: "IN_PROGRESS", assignedToUserId: w.crew.user.id, version: 1 });
  return { propertyId, transactionId, requestId: paymentRequest.id, amountCents: paymentRequest.amountCents, buyerRep: buyerRep!.id, sellerRep: sellerRep!.id, docId: doc!.id };
}

export const confirm = (w: World, who: Who, c: Chain, side: "BUYER" | "SELLER") =>
  call(w.baseUrl, "POST", "/financial/settlement-confirmations", who.cookie, {
    transactionId: c.transactionId,
    side,
    representativePartyId: side === "BUYER" ? c.buyerRep : c.sellerRep,
    evidenceDocumentId: c.docId,
    confirmedAt: new Date(Date.now() - 3_600_000).toISOString(),
  });

export async function confirmBoth(w: World, c: Chain, who: Who = w.crew) {
  await confirm(w, who, c, "BUYER");
  await confirm(w, who, c, "SELLER");
}

export const prepare = (w: World, who: Who, c: Chain, extra: Record<string, unknown> = {}) =>
  call(w.baseUrl, "POST", "/financial/settlement-statements/prepare", who.cookie, { transactionId: c.transactionId, payerType: "Agent", payerUserId: w.X.agent.user.id, ...extra });

export const issue = (w: World, who: Who, statementId: number) => call(w.baseUrl, "POST", `/financial/settlement-statements/${statementId}/issue`, who.cookie, {});

export async function prepareAndIssue(w: World, who: Who, c: Chain, extra: Record<string, unknown> = {}) {
  const d = await prepare(w, who, c, extra);
  if (d.status !== 201) throw new Error(`prepare failed ${d.status} ${d.raw}`);
  return issue(w, who, d.json.statement.id);
}

export const collect = (w: World, who: Who, c: Chain) => call(w.baseUrl, "POST", `/payments/pit-crew-service-fee/${c.transactionId}/collect`, who.cookie);

export async function request(id: number) {
  const [row] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, id));
  return row!;
}

export async function elapseNotice(c: Chain) {
  await db.update(financialPaymentRequests).set({ noticeSentAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(financialPaymentRequests.id, c.requestId));
}
