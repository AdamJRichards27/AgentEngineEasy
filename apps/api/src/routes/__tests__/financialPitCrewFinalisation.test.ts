// Owner t179u D6 + D7.
// D6: assigned Pit Crew with a live COMMISSION_CALCULATION grant may CONFIRM /
// FINALISE a commission calculation once evidence and written authorisations
// are complete and the figures are verified (approved contractual agreement
// with a signed source document, sale price = recorded purchase price, firm
// contract for FINALISED). Supersede stays Brokerage Administrator.
// D7: grants last at most 30 days and end early when the transaction is
// completed (Closed), checked at use time. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, commissionAgreements, commissionCalculations, db, financialAmendmentAuthorities, pitCrewAssignments, riskExceptions, transactions, users } from "@aee/db";
import { cleanupBrokerages, createBrokerageWithUsers, createTransactionFromListedProperty, devLogin, type DevLoginResult } from "./testSupport.js";
import { FINANCIAL_RECORD_AMENDED_AUDIT_ACTION, lockLiveAuthority, maxAuthorityGrantDays, resolveAmendmentAuthority, loadPropertyFinancialScope } from "../../lib/financialAmendments.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `PC Final A ${suffix}`;
type Who = DevLoginResult;
let A: { admin: Who; agent: Who; brokerageId: number };
let crew: Who;
const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}
async function assign(t: { propertyId: number; transactionId: number }) {
  const tag = `${t.transactionId}`;
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: A.brokerageId,
      propertyId: t.propertyId,
      transactionId: t.transactionId,
      ruleId: "pc-final-test-rule",
      category: "FINANCIAL",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic finalisation work ${tag}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `pc-final-${tag}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `pc-final-${tag}-${suffix}`,
      openDedupKey: `pc-final-${tag}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db.insert(pitCrewAssignments).values({ brokerageId: A.brokerageId, sourceType: "EXCEPTION", sourceRecordId: ex!.id, propertyId: t.propertyId, status: "IN_PROGRESS", assignedToUserId: crew.user.id, version: 1 });
}
const grant = (by: Who, body: Record<string, unknown>) => call("POST", "/financial-amendment-authorities", by.cookie, body);

/** Transaction + crew assignment + admin-approved agreement (with or without a signed source document). */
async function setup(tag: string, opts: { sourceDocumentRef?: string | null; approvedByAdmin?: boolean; grantCalc?: boolean } = {}) {
  const t = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} ${tag} Finalise St` });
  await assign(t);
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, t.transactionId));
  const created = await call("POST", "/financial/commission-agreements", A.admin.cookie, {
    transactionId: t.transactionId,
    method: "PERCENTAGE",
    rateBps: 200,
    ...(opts.sourceDocumentRef === null ? {} : { sourceDocumentRef: opts.sourceDocumentRef ?? "synthetic-signed-agency-agreement" }),
  });
  assert.equal(created.status, 201, created.raw);
  const agreementId = created.json.agreement.id as number;
  await db
    .update(commissionAgreements)
    .set({ status: "APPROVED", approvedAt: new Date(), approvedByUserId: opts.approvedByAdmin === false ? null : A.admin.user.id })
    .where(eq(commissionAgreements.id, agreementId));
  let grantId: number | null = null;
  if (opts.grantCalc !== false) {
    const g = await grant(A.agent, {
      transactionId: t.transactionId,
      granteeUserId: crew.user.id,
      scope: "COMMISSION_CALCULATION",
      evidenceNote: "Listing agent's signed instruction: finalise commission per agreement",
      expiresAt: inDays(10),
    });
    assert.equal(g.status, 201, g.raw);
    grantId = g.json.authority.id;
  }
  return { ...t, agreementId, price: txn!.purchasePriceCents, grantId };
}
const calc = (t: { transactionId: number; agreementId: number; price: number }, extra: Record<string, unknown> = {}) =>
  call("POST", "/financial/commission-calculations", crew.cookie, { transactionId: t.transactionId, commissionAgreementId: t.agreementId, salePriceCentsInput: t.price, ...extra });

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, nameA);
  crew = await devLogin(baseUrl, { email: `crew-final-${suffix}@example.com`, firstName: "Crew", lastName: "Synthetic", brokerageName: nameA });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, crew.user.id));
});

after(async () => {
  delete process.env.FINANCIAL_AMENDMENT_AUTHORITY_MAX_DAYS;
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("D6: verified Pit Crew CONFIRM then FINALISE, audited with the authoriser, evidence and checks; one FINALISED only; supersede stays administrator", async () => {
  const t = await setup("happy");
  const confirmed = await calc(t, { state: "CONFIRMED" });
  assert.equal(confirmed.status, 201, confirmed.raw);
  assert.equal(confirmed.json.calculation.state, "CONFIRMED");

  // FINALISED needs a firm contract.
  const early = await calc(t, { state: "FINALISED" });
  assert.equal(early.status, 409, early.raw);
  assert.equal(early.json.reason, "PIT_CREW_FINALISATION_CONTRACT_NOT_FIRM");
  await db.update(transactions).set({ unconditionalAt: new Date() }).where(eq(transactions.id, t.transactionId));
  const fin = await calc(t, { state: "FINALISED" });
  assert.equal(fin.status, 201, fin.raw);
  const row = fin.json.calculation;
  assert.equal(row.state, "FINALISED");
  assert.equal(row.calculatedByUserId, crew.user.id);
  assert.ok(row.finalisedAt);

  const [audit] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), eq(auditLogs.recordType, "commission_calculation"), eq(auditLogs.recordId, String(row.id))));
  assert.ok(audit);
  const v = JSON.parse(audit.updatedValue!);
  assert.equal(v.policy, "t179u");
  assert.equal(v.authorityId, t.grantId);
  assert.equal(v.authorisedByUserId, A.agent.user.id);
  assert.equal(v.evidenceNote, "Listing agent's signed instruction: finalise commission per agreement");
  assert.equal(v.performedByRole, "Pit Crew");
  assert.deepEqual(v.after.finalisationChecks, {
    state: "FINALISED",
    grantEvidence: true,
    agreementApprovedByUserId: A.admin.user.id,
    agreementSourceDocumentRef: "synthetic-signed-agency-agreement",
    salePriceMatchesPurchasePrice: true,
    contractFirm: true,
  });
  assert.equal(JSON.parse(audit.previousValue!).state, "CONFIRMED", "before = the prior calculation");

  const again = await calc(t, { state: "FINALISED" });
  assert.equal(again.status, 409);
  assert.equal(again.json.reason, "FINALISED_CALCULATION_EXISTS");
  const sup = await calc(t, { state: "FINALISED", supersede: true });
  assert.equal(sup.status, 403);
  assert.equal(sup.json.reason, "PIT_CREW_CALCULATION_SUPERSEDE_FORBIDDEN");
  const finals = await db
    .select()
    .from(commissionCalculations)
    .where(and(eq(commissionCalculations.transactionId, t.transactionId), eq(commissionCalculations.state, "FINALISED")));
  assert.equal(finals.length, 1);
});

test("D6: incomplete evidence or unverified figures fail closed; nothing is written", async () => {
  const noDoc = await setup("nodoc", { sourceDocumentRef: null });
  const r1 = await calc(noDoc, { state: "CONFIRMED" });
  assert.equal(r1.status, 409, r1.raw);
  assert.equal(r1.json.reason, "PIT_CREW_FINALISATION_EVIDENCE_INCOMPLETE");

  const noApprover = await setup("noapprover", { approvedByAdmin: false });
  const r2 = await calc(noApprover, { state: "CONFIRMED" });
  assert.equal(r2.json.reason, "PIT_CREW_FINALISATION_EVIDENCE_INCOMPLETE");

  const price = await setup("price");
  await db.update(transactions).set({ unconditionalAt: new Date() }).where(eq(transactions.id, price.transactionId));
  for (const delta of [1, -1]) {
    const r = await calc(price, { state: "FINALISED", salePriceCentsInput: price.price + delta });
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, "PIT_CREW_FINALISATION_FINANCIALS_UNVERIFIED");
  }
  for (const t of [noDoc, noApprover, price]) {
    assert.equal((await db.select().from(commissionCalculations).where(eq(commissionCalculations.transactionId, t.transactionId))).length, 0);
  }
  // Provisional states do not need the finalisation evidence.
  assert.equal((await calc(noDoc, { state: "PROVISIONAL" })).status, 201);
});

test("D6: without a written-authority grant, Pit Crew cannot finalise even when every figure is verified", async () => {
  const t = await setup("nogrant", { grantCalc: false });
  await db.update(transactions).set({ unconditionalAt: new Date() }).where(eq(transactions.id, t.transactionId));
  for (const state of ["CONFIRMED", "FINALISED"]) {
    const r = await calc(t, { state });
    assert.equal(r.status, 403, state);
  }
  // A COMMISSION_AGREEMENT grant is not a calculation grant.
  await grant(A.admin, { transactionId: t.transactionId, granteeUserId: crew.user.id, scope: "COMMISSION_AGREEMENT", evidenceNote: "x", expiresAt: inDays(3) });
  assert.equal((await calc(t, { state: "FINALISED" })).status, 403);
});

test("D7: a grant ends early when the transaction is completed (Closed), at use time and inside the write transaction; no new grant on a completed transaction", async () => {
  const t = await setup("closed");
  // Settled is NOT completion: statement and fee work continues after settlement.
  await db.update(transactions).set({ status: "Settled", settlementCompletedAt: new Date() }).where(eq(transactions.id, t.transactionId));
  assert.equal((await calc(t, { state: "PROVISIONAL" })).status, 201);

  const pc = { ...crew.user, role: "Pit Crew", brokerageId: A.brokerageId } as never;
  const scope = (await loadPropertyFinancialScope(pc, t.propertyId))!;
  const live = await resolveAmendmentAuthority(pc, scope, { scope: "COMMISSION_CALCULATION", recordId: null, transactionId: t.transactionId });
  assert.equal(live.allowed, true);

  await db.update(transactions).set({ status: "Closed", closedAt: new Date() }).where(eq(transactions.id, t.transactionId));
  const r = await calc(t, { state: "PROVISIONAL" });
  assert.equal(r.status, 403, r.raw);
  // The in-transaction re-check also refuses (a completion racing an amendment rolls it back).
  await assert.rejects(
    db.transaction(async (tx) => {
      await lockLiveAuthority(tx, live as Extract<typeof live, { allowed: true }>);
    }),
    /no longer live/,
  );
  // closed_at alone also counts.
  await db.update(transactions).set({ status: "Settled" }).where(eq(transactions.id, t.transactionId));
  assert.equal((await calc(t, { state: "PROVISIONAL" })).status, 403);

  const g = await grant(A.admin, { transactionId: t.transactionId, granteeUserId: crew.user.id, scope: "COMMISSION_AGREEMENT", evidenceNote: "x", expiresAt: inDays(3) });
  assert.equal(g.status, 422, g.raw);
  assert.equal(g.json.reason, "TRANSACTION_COMPLETED");
  // The grant row itself is untouched (history kept).
  const [row] = await db.select().from(financialAmendmentAuthorities).where(eq(financialAmendmentAuthorities.id, t.grantId!));
  assert.equal(row!.revokedAt, null);
});

test("D7: the 30-day ceiling cannot be raised by configuration; it can be shortened", async () => {
  const t = await setup("ceiling", { grantCalc: false });
  const body = (days: number) => ({ transactionId: t.transactionId, granteeUserId: crew.user.id, scope: "COMMISSION_AGREEMENT", evidenceNote: "x", expiresAt: inDays(days) });
  process.env.FINANCIAL_AMENDMENT_AUTHORITY_MAX_DAYS = "90";
  try {
    assert.equal(maxAuthorityGrantDays(), 30);
    const r = await grant(A.admin, body(31));
    assert.equal(r.status, 422);
    assert.equal(r.json.reason, "EXPIRY_OUT_OF_RANGE");
    process.env.FINANCIAL_AMENDMENT_AUTHORITY_MAX_DAYS = "7";
    assert.equal(maxAuthorityGrantDays(), 7);
    assert.equal((await grant(A.admin, body(8))).status, 422);
    assert.equal((await grant(A.admin, body(6))).status, 201);
  } finally {
    delete process.env.FINANCIAL_AMENDMENT_AUTHORITY_MAX_DAYS;
  }
});
