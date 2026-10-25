// Owner t177u(2): assigned Pit Crew may amend commission agreements and
// (non-final) commission calculations only with documented written authority:
// a live COMMISSION_AGREEMENT / COMMISSION_CALCULATION grant for THAT
// transaction plus an active assignment on it. The audit row records the
// authoriser, evidence, transaction, scope, operator, time and before/after
// values, in the same DB transaction. Approval, CONFIRMED/FINALISED
// calculations, supersede and settlement stay Brokerage Administrator.
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { auditLogs, commissionAgreements, commissionCalculations, db, financialAmendmentAuthorities, pitCrewAssignments, riskExceptions, users } from "@aee/db";
import { cleanupBrokerages, createBrokerageWithUsers, createTransactionFromListedProperty, devLogin, type DevLoginResult } from "./testSupport.js";
import { AMENDMENT_AUTHORITY_REQUIRED, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION } from "../../lib/financialAmendments.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Comm Auth A ${suffix}`;
type Who = DevLoginResult;
let A: { admin: Who; agent: Who; brokerageId: number };
let B: { admin: Who; agent: Who; brokerageId: number };
let crew: Who; // assigned on txn1, gets grants
let crewNoAssign: Who; // grants, no assignment
let txn1: { propertyId: number; transactionId: number };
let txn2: { propertyId: number; transactionId: number };
let approvedV1: number;
let approvedCurrent: number;
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
async function pitCrew(name: string): Promise<Who> {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Synthetic", brokerageName: nameA });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, r.user.id));
  return r;
}
async function assign(who: Who, t: { propertyId: number; transactionId: number }) {
  const tag = `${who.user.id}-${t.transactionId}`;
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: A.brokerageId,
      propertyId: t.propertyId,
      transactionId: t.transactionId,
      ruleId: "comm-auth-test-rule",
      category: "FINANCIAL",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic commission work ${tag}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `comm-auth-${tag}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `comm-auth-${tag}-${suffix}`,
      openDedupKey: `comm-auth-${tag}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db.insert(pitCrewAssignments).values({ brokerageId: A.brokerageId, sourceType: "EXCEPTION", sourceRecordId: ex!.id, propertyId: t.propertyId, status: "IN_PROGRESS", assignedToUserId: who.user.id, version: 1 });
}
const grant = (by: Who, body: Record<string, unknown>) => call("POST", "/financial-amendment-authorities", by.cookie, body);
const draft = (who: Who, transactionId: number, rateBps = 230) =>
  call("POST", "/financial/commission-agreements", who.cookie, { transactionId, method: "PERCENTAGE", rateBps, sourceDocumentRef: "synthetic-signed-variation" });
const calc = (who: Who, transactionId: number, extra: Record<string, unknown> = {}) =>
  call("POST", "/financial/commission-calculations", who.cookie, { transactionId, commissionAgreementId: approvedCurrent, salePriceCentsInput: 80_000_000, ...extra });

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
  B = await createBrokerageWithUsers(baseUrl, `Comm Auth B ${suffix}`);
  crew = await pitCrew("crew");
  crewNoAssign = await pitCrew("crew-noassign");
  txn1 = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} One Commission St` });
  txn2 = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Two Commission St` });
  await assign(crew, txn1);
  await assign(crew, txn2);
  // Approved v1 on txn1 (fixture: created by the admin, approved directly).
  const v1 = await call("POST", "/financial/commission-agreements", A.admin.cookie, { transactionId: txn1.transactionId, method: "PERCENTAGE", rateBps: 200 });
  assert.equal(v1.status, 201, v1.raw);
  approvedV1 = v1.json.agreement.id;
  await db.update(commissionAgreements).set({ status: "APPROVED", approvedAt: new Date() }).where(eq(commissionAgreements.id, approvedV1));
  approvedCurrent = approvedV1;
});

after(async () => {
  await cleanupBrokerages([A, B].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("without a commission grant, assigned Pit Crew stay 403 (including an empty body), and nothing is written", async () => {
  const before = await db.select().from(commissionAgreements).where(eq(commissionAgreements.transactionId, txn1.transactionId));
  for (const r of [await draft(crew, txn1.transactionId), await call("POST", "/financial/commission-agreements", crew.cookie, {}), await calc(crew, txn1.transactionId)]) {
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.json.reason, AMENDMENT_AUTHORITY_REQUIRED);
  }
  // An AGENCY_TERMS grant is not a commission grant.
  const g = await grant(A.agent, { transactionId: txn1.transactionId, granteeUserId: crew.user.id, scope: "AGENCY_TERMS", evidenceNote: "Signed terms instruction", expiresAt: inDays(5) });
  assert.equal(g.status, 201, g.raw);
  assert.equal((await draft(crew, txn1.transactionId)).status, 403);
  assert.deepEqual(await db.select().from(commissionAgreements).where(eq(commissionAgreements.transactionId, txn1.transactionId)), before);
});

test("grant validation: commission scopes are transaction-wide (no single-record target)", async () => {
  const r = await grant(A.agent, {
    transactionId: txn1.transactionId,
    granteeUserId: crew.user.id,
    scope: "COMMISSION_AGREEMENT",
    targetRecordId: String(approvedV1),
    evidenceNote: "x",
    expiresAt: inDays(5),
  });
  assert.equal(r.status, 422, r.raw);
  assert.equal(r.json.reason, "TARGET_NOT_SUPPORTED_FOR_SCOPE");
  const pc = await grant(crew, { transactionId: txn1.transactionId, granteeUserId: crewNoAssign.user.id, scope: "COMMISSION_AGREEMENT", evidenceNote: "x", expiresAt: inDays(5) });
  assert.equal(pc.status, 403, "Pit Crew can never grant");
});

test("COMMISSION_AGREEMENT grant + assignment: Pit Crew drafts a new version (DRAFT), audited with authoriser, evidence and before/after; approval stays with administrators", async () => {
  const g = await grant(A.agent, {
    transactionId: txn1.transactionId,
    granteeUserId: crew.user.id,
    scope: "COMMISSION_AGREEMENT",
    evidenceNote: "Listing agent's signed variation 25 Oct: 2.30%",
    expiresAt: inDays(5),
  });
  assert.equal(g.status, 201, g.raw);
  const r = await draft(crew, txn1.transactionId, 230);
  assert.equal(r.status, 201, r.raw);
  const a = r.json.agreement;
  assert.equal(a.status, "DRAFT");
  assert.equal(a.rateBps, 230);
  assert.equal(a.version, 2);
  assert.equal(a.createdByUserId, crew.user.id);

  const [row] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), eq(auditLogs.recordType, "commission_agreement"), eq(auditLogs.recordId, String(a.id))));
  assert.ok(row, "amendment audited");
  const before = JSON.parse(row.previousValue!);
  const v = JSON.parse(row.updatedValue!);
  assert.equal(before.rateBps, 200);
  assert.equal(before.status, "APPROVED");
  assert.equal(v.after.rateBps, 230);
  assert.equal(v.after.transactionId, txn1.transactionId);
  assert.equal(v.authorityBasis, "documented_authority");
  assert.equal(v.authorityId, g.json.authority.id);
  assert.equal(v.authorisedByUserId, A.agent.user.id);
  assert.equal(v.authorisedByRole, "Agent");
  assert.equal(v.evidenceNote, "Listing agent's signed variation 25 Oct: 2.30%");
  assert.equal(v.performedByUserId, crew.user.id);
  assert.equal(v.performedByRole, "Pit Crew");
  assert.equal(v.policy, "t177u");
  assert.ok(v.pitCrewAssignmentIds.length >= 1);
  assert.ok(typeof v.performedAt === "string");

  // Pit Crew cannot approve or cancel; the administrator can approve the Pit Crew draft.
  assert.equal((await call("POST", `/financial/commission-agreements/${a.id}/approve`, crew.cookie, {})).status, 403);
  assert.equal((await call("POST", `/financial/commission-agreements/${a.id}/cancel`, crew.cookie, { reason: "x" })).status, 403);
  const ok = await call("POST", `/financial/commission-agreements/${a.id}/approve`, A.admin.cookie, {});
  assert.equal(ok.status, 200, ok.raw);
  approvedCurrent = a.id;
  // The superseded v1 can no longer seed a calculation (checked in the calculation test).
});

test("the grant is transaction-specific, needs an assignment, and stops working when revoked or expired", async () => {
  // txn1 grant does not reach txn2 (crew is assigned on both).
  assert.equal((await draft(crew, txn2.transactionId)).status, 403);
  // Grant without assignment.
  await grant(A.admin, { transactionId: txn1.transactionId, granteeUserId: crewNoAssign.user.id, scope: "COMMISSION_AGREEMENT", evidenceNote: "x", expiresAt: inDays(5) });
  assert.equal((await draft(crewNoAssign, txn1.transactionId)).status, 403);
  // Revoke crew's txn1 grant -> blocked again.
  const live = await db
    .select()
    .from(financialAmendmentAuthorities)
    .where(and(eq(financialAmendmentAuthorities.granteeUserId, crew.user.id), eq(financialAmendmentAuthorities.scope, "COMMISSION_AGREEMENT")));
  for (const gr of live) {
    const rv = await call("POST", `/financial-amendment-authorities/${gr.id}/revoke`, A.agent.cookie, { reason: "variation done" });
    assert.equal(rv.status, 200, rv.raw);
  }
  assert.equal((await draft(crew, txn1.transactionId)).status, 403);
  // Expired grant (inserted directly; the API refuses past expiries).
  const [g] = await db
    .insert(financialAmendmentAuthorities)
    .values({
      brokerageId: A.brokerageId,
      propertyId: txn1.propertyId,
      transactionId: txn1.transactionId,
      granteeUserId: crew.user.id,
      grantedByUserId: A.agent.user.id,
      grantedByRole: "Agent",
      scope: "COMMISSION_AGREEMENT",
      evidenceNote: "expired",
      expiresAt: new Date(Date.now() + 1500),
    })
    .returning();
  await new Promise((r) => setTimeout(r, 1700));
  assert.ok(g);
  assert.equal((await draft(crew, txn1.transactionId)).status, 403);
  // Other roles unchanged: listing agent still 403; other brokerage 403 (role gate) / 404.
  assert.equal((await draft(A.agent, txn1.transactionId)).status, 403);
  assert.ok([403, 404].includes((await draft(B.admin, txn1.transactionId)).status));
});

test("COMMISSION_CALCULATION grant: ESTIMATE/PROVISIONAL from an APPROVED agreement, audited; supersede stays administrator (t179u D6: verified finalisation elsewhere)", async () => {
  // A COMMISSION_AGREEMENT grant does not allow calculations.
  await grant(A.agent, { transactionId: txn1.transactionId, granteeUserId: crew.user.id, scope: "COMMISSION_AGREEMENT", evidenceNote: "x", expiresAt: inDays(5) });
  assert.equal((await calc(crew, txn1.transactionId)).status, 403);
  const g = await grant(A.admin, {
    transactionId: txn1.transactionId,
    granteeUserId: crew.user.id,
    scope: "COMMISSION_CALCULATION",
    evidenceNote: "Administrator's written instruction: re-run estimate",
    expiresAt: inDays(3),
  });
  assert.equal(g.status, 201, g.raw);
  // t179u D6 supersedes the t177u limit: CONFIRMED/FINALISED are allowed once
  // verified (see financialPitCrewFinalisation.test.ts); supersede stays BA.
  const sup = await calc(crew, txn1.transactionId, { supersede: true });
  assert.equal(sup.status, 403);
  assert.equal(sup.json.reason, "PIT_CREW_CALCULATION_SUPERSEDE_FORBIDDEN");
  const wrongPrice = await calc(crew, txn1.transactionId, { state: "CONFIRMED", salePriceCentsInput: 1 });
  assert.equal(wrongPrice.status, 409, wrongPrice.raw);
  assert.equal(wrongPrice.json.reason, "PIT_CREW_FINALISATION_FINANCIALS_UNVERIFIED");
  // Draft (unapproved) agreement -> 409.
  const [draftRow] = await db
    .select()
    .from(commissionAgreements)
    .where(and(eq(commissionAgreements.transactionId, txn1.transactionId), eq(commissionAgreements.status, "DRAFT")))
    .orderBy(desc(commissionAgreements.version));
  assert.equal((await calc(crew, txn1.transactionId, { commissionAgreementId: approvedV1 })).status, 409, "superseded v1");
  if (draftRow) assert.equal((await calc(crew, txn1.transactionId, { commissionAgreementId: draftRow.id })).status, 409);

  const before = await db.select().from(commissionCalculations).where(eq(commissionCalculations.transactionId, txn1.transactionId));
  const r = await calc(crew, txn1.transactionId, { state: "PROVISIONAL" });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.json.calculation.state, "PROVISIONAL");
  assert.equal(r.json.calculation.calculatedByUserId, crew.user.id);
  const [row] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), eq(auditLogs.recordType, "commission_calculation"), eq(auditLogs.recordId, String(r.json.calculation.id))));
  assert.ok(row);
  const v = JSON.parse(row.updatedValue!);
  assert.equal(v.authorityId, g.json.authority.id);
  assert.equal(v.authorisedByRole, "Brokerage Administrator");
  assert.equal(v.after.grossCommissionCents, r.json.calculation.grossCommissionCents);
  assert.equal(before.length, 0, "first calculation on this transaction");
  assert.ok(row.previousValue === null || JSON.parse(row.previousValue) === null, "before = none");
  // Wrong transaction still 403.
  assert.equal((await calc(crew, txn2.transactionId)).status, 403);
});
