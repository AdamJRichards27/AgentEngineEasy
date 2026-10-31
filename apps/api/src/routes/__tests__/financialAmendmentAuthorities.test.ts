// Owner t174u — Pit Crew financial amendment authority grants (migration 0038).
// Grant lifecycle (create, list, expire, revoke), grantor role checks, and
// amendment enforcement: a Pit Crew amendment needs a live grant matching the
// property, scope and target AND an active assignment on the grant's
// transaction. Payment, debit, refund, release and authority routes stay 403
// even with a grant. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agencyAgreementTerms,
  auditLogs,
  campaignItems,
  db,
  documents,
  financialAmendmentAuthorities,
  pitCrewAssignments,
  riskExceptions,
  transactions,
  users,
} from "@aee/db";
import {
  cleanupBrokerages,
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";
import { AMENDMENT_AUTHORITY_REQUIRED, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION, lockLiveAuthority } from "../../lib/financialAmendments.js";
import { upsertAgencyAgreementTerms } from "../../lib/documents.js";
import { AUTHORITY_GRANTED_AUDIT_ACTION, AUTHORITY_REVOKED_AUDIT_ACTION } from "../financialAuthorities.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Fin Auth A ${suffix}`;
const nameB = `Fin Auth B ${suffix}`;

type Who = DevLoginResult;
let A: { admin: Who; agent: Who; brokerageId: number };
let B: { admin: Who; agent: Who; brokerageId: number };
let otherAgent: Who;
let crewB: Who;
const crew: Record<string, Who> = {};
let txn: { propertyId: number; transactionId: number };
let txn2: { propertyId: number; transactionId: number };
let itemX: string;
let itemY: string;
let itemOther: string;
let termsId: number;
let evidenceDocId: number;
let otherPropertyDocId: number;

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

async function call(method: "GET" | "POST" | "PUT", path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}

async function inBrokerage(name: string, brokerageName: string, role: "Agent" | "Pit Crew"): Promise<Who> {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Synthetic", brokerageName });
  await db.update(users).set({ role }).where(eq(users.id, r.user.id));
  return r;
}

async function assign(key: string, t: { propertyId: number; transactionId: number }) {
  const tag = `${key}-${t.transactionId}`;
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: A.brokerageId,
      propertyId: t.propertyId,
      transactionId: t.transactionId,
      ruleId: "fin-auth-test-rule",
      category: "SETTLEMENT_CLOSURE",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic settlement work ${tag}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `fin-auth-${tag}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `fin-auth-${tag}-${suffix}`,
      openDedupKey: `fin-auth-${tag}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db.insert(pitCrewAssignments).values({
    brokerageId: A.brokerageId,
    sourceType: "EXCEPTION",
    sourceRecordId: ex!.id,
    propertyId: t.propertyId,
    status: "IN_PROGRESS",
    assignedToUserId: crew[key]!.user.id,
    version: 1,
  });
}

async function grant(by: Who, body: Record<string, unknown>) {
  return call("POST", "/financial-amendment-authorities", by.cookie, body);
}

const terms = (rate: number) => ({ commissionType: "Percentage", commissionRateBps: rate, agreementTermDays: 90 });
const putTerms = (who: Who, rate: number, extra: Record<string, unknown> = {}) =>
  call("PUT", `/documents/agency-agreement-terms/${txn.propertyId}`, who.cookie, { ...terms(rate), ...extra });
const putCost = (who: Who, item: string, cost: number, extra: Record<string, unknown> = {}) =>
  call("POST", `/launch/campaign-items/${item}/vendor-cost`, who.cookie, { vendorName: "Synthetic Vendor", costCents: cost, ...extra });

async function currentRate() {
  const [row] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.id, termsId));
  return row!.commissionRateBps;
}

async function launchPlanFor(propertyId: number, cookie: string): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const r = await call("GET", `/properties/${propertyId}/launch`, cookie);
    if (r.json.launch?.plan?.id) return r.json.launch.plan.id;
    await new Promise((res) => setTimeout(res, 50));
  }
  const created = await call("POST", `/properties/${propertyId}/launch`, cookie, {});
  assert.ok(created.status < 300, created.raw);
  const r = await call("GET", `/properties/${propertyId}/launch`, cookie);
  return r.json.launch.plan.id;
}

async function newItem(propertyId: number, title: string) {
  const plan = await launchPlanFor(propertyId, A.agent.cookie);
  const r = await call("POST", `/launch/${plan}/campaign-items`, A.agent.cookie, { itemType: "PHOTOGRAPHY", title });
  assert.equal(r.status, 201, r.raw);
  return r.json.item.id as string;
}

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
  B = await createBrokerageWithUsers(baseUrl, nameB);
  otherAgent = await inBrokerage("fz-other-agent", nameA, "Agent");
  crewB = await inBrokerage("fz-crew-b", nameB, "Pit Crew");
  txn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Grant St, Testville`,
    sellerEmail: `seller-fz-${suffix}@example.com`,
    offerPriceCents: 81_234_500,
  });
  txn2 = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Second Grant St, Testville`,
    sellerEmail: `seller-fz2-${suffix}@example.com`,
    offerPriceCents: 71_234_500,
  });
  const [t] = await db.select({ id: agencyAgreementTerms.id }).from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, txn.propertyId));
  termsId = t!.id;
  itemX = await newItem(txn.propertyId, "Photography X");
  itemY = await newItem(txn.propertyId, "Photography Y");
  itemOther = await newItem(txn2.propertyId, "Other property photography");
  const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.propertyId, txn.propertyId)).limit(1);
  const [doc2] = await db.select({ id: documents.id }).from(documents).where(eq(documents.propertyId, txn2.propertyId)).limit(1);
  evidenceDocId = doc!.id;
  otherPropertyDocId = doc2!.id;
  for (const key of ["granted", "noAssign", "assignedNoGrant", "wrongTxn", "targeted", "revoked", "expired", "agencyOnly"]) {
    crew[key] = await inBrokerage(`fz-crew-${key}`, nameA, "Pit Crew");
  }
  for (const key of ["granted", "assignedNoGrant", "wrongTxn", "targeted", "revoked", "expired", "agencyOnly"]) await assign(key, txn);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---- grant creation: who may grant, and what a grant must carry ----

test("grantor checks: Pit Crew 403 (incl. self-grant), other agent 404, other brokerage 404; listing agent and admin 201", async () => {
  const body = (grantee: Who, extra: Record<string, unknown> = {}) => ({
    transactionId: txn.transactionId,
    granteeUserId: grantee.user.id,
    scope: "AGENCY_TERMS",
    evidenceNote: "Signed instruction from the listing agent, 25 Oct",
    expiresAt: inDays(7),
    ...extra,
  });
  for (const who of [crew.granted!, crew.assignedNoGrant!]) {
    const self = await grant(who, body(who));
    assert.equal(self.status, 403, self.raw);
    assert.equal(self.json.reason, "FINANCIAL_AUTHORITY_GRANT_FORBIDDEN");
  }
  assert.equal((await grant(otherAgent, body(crew.granted!))).status, 404);
  assert.equal((await grant(B.admin, body(crew.granted!))).status, 404);
  assert.equal((await grant(crewB, body(crew.granted!))).status, 403);
  const byAgent = await grant(A.agent, body(crew.granted!));
  assert.equal(byAgent.status, 201, byAgent.raw);
  assert.equal(byAgent.json.authority.grantedByUserId, A.agent.user.id);
  assert.equal(byAgent.json.authority.grantedByRole, "Agent");
  assert.equal(byAgent.json.authority.propertyId, txn.propertyId, "property derived from the transaction");
  assert.equal(byAgent.json.authority.live, true);
  const byAdmin = await grant(A.admin, body(crew.granted!, { scope: "CAMPAIGN_ITEM_COST", evidenceDocumentId: evidenceDocId, evidenceNote: undefined }));
  assert.equal(byAdmin.status, 201, byAdmin.raw);
  assert.equal(byAdmin.json.authority.grantedByRole, "Brokerage Administrator");
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, AUTHORITY_GRANTED_AUDIT_ACTION), eq(auditLogs.recordId, String(byAgent.json.authority.id))));
  assert.equal(rows.length, 1);
  const v = JSON.parse(rows[0]!.updatedValue!);
  assert.equal(v.grantedByUserId, A.agent.user.id);
  assert.equal(v.granteeUserId, crew.granted!.user.id);
  assert.equal(v.transactionId, txn.transactionId);
  assert.equal(v.scope, "AGENCY_TERMS");
  assert.match(v.evidenceNote, /Signed instruction/);
});

test("grant validation: forged grantor fields, non-Pit-Crew or cross-brokerage grantee, missing or foreign evidence, expiry range, unknown scope, foreign target", async () => {
  const ok = { transactionId: txn.transactionId, granteeUserId: crew.noAssign!.user.id, scope: "AGENCY_TERMS", evidenceNote: "Email instruction", expiresAt: inDays(5) };
  const cases: Array<[string, Record<string, unknown>, number, string?]> = [
    ["forged grantedByUserId", { ...ok, grantedByUserId: A.admin.user.id }, 400],
    ["forged grantedByRole", { ...ok, grantedByRole: "Brokerage Administrator" }, 400],
    ["grantee is an Agent", { ...ok, granteeUserId: otherAgent.user.id }, 422, "GRANTEE_NOT_PIT_CREW"],
    ["grantee in another brokerage", { ...ok, granteeUserId: crewB.user.id }, 422, "GRANTEE_NOT_PIT_CREW"],
    ["no evidence", { ...ok, evidenceNote: "   " }, 422, "EVIDENCE_REQUIRED"],
    ["evidence document from another property", { ...ok, evidenceDocumentId: otherPropertyDocId }, 422, "EVIDENCE_DOCUMENT_NOT_ON_PROPERTY"],
    ["expiry beyond 30 days", { ...ok, expiresAt: inDays(31) }, 422, "EXPIRY_OUT_OF_RANGE"],
    ["expiry in the past", { ...ok, expiresAt: inDays(-1) }, 422, "EXPIRY_OUT_OF_RANGE"],
    ["missing expiry", { ...ok, expiresAt: undefined }, 400],
    ["invoice scope", { ...ok, scope: "INVOICE_DETAILS" }, 400],
    ["target on another property", { ...ok, scope: "CAMPAIGN_ITEM_COST", targetRecordId: itemOther }, 422, "TARGET_NOT_ON_TRANSACTION"],
    ["target of the wrong type", { ...ok, scope: "AGENCY_TERMS", targetRecordId: itemX }, 422, "TARGET_NOT_ON_TRANSACTION"],
  ];
  for (const [label, body, status, reason] of cases) {
    const r = await grant(A.agent, body);
    assert.equal(r.status, status, `${label}: ${r.raw}`);
    if (reason) assert.equal(r.json.reason, reason, label);
  }
  const none = await db.select().from(financialAmendmentAuthorities).where(eq(financialAmendmentAuthorities.granteeUserId, crew.noAssign!.user.id));
  assert.equal(none.length, 0, "no invalid grant was stored");
});

// ---- amendments with a grant ----

test("live grant + active assignment: Pit Crew may amend, and the audit row names the authority, grantor, evidence, performer and before/after", async () => {
  const before = await currentRate();
  const r = await putTerms(crew.granted!, 233);
  assert.equal(r.status, 200, r.raw);
  assert.equal(await currentRate(), 233);
  const [row] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), eq(auditLogs.userId, crew.granted!.user.id), eq(auditLogs.recordType, "agency_agreement_terms")));
  assert.ok(row, "amendment row");
  assert.equal(JSON.parse(row!.previousValue!).commissionRateBps, before);
  const v = JSON.parse(row!.updatedValue!);
  assert.equal(v.after.commissionRateBps, 233);
  assert.equal(v.authorityBasis, "documented_authority");
  assert.equal(typeof v.authorityId, "number");
  assert.equal(v.authorityTransactionId, txn.transactionId);
  assert.equal(v.authorisedByUserId, A.agent.user.id, "grantor, not performer");
  assert.equal(v.authorisedByRole, "Agent");
  assert.match(v.evidenceNote, /Signed instruction/);
  assert.equal(v.performedByUserId, crew.granted!.user.id);
  assert.equal(v.performedByRole, "Pit Crew");
  assert.ok(Array.isArray(v.pitCrewAssignmentIds) && v.pitCrewAssignmentIds.length >= 1);
  const c = await putCost(crew.granted!, itemX, 455_001);
  assert.equal(c.status, 200, c.raw);
  const [costRow] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), eq(auditLogs.userId, crew.granted!.user.id), eq(auditLogs.recordType, "campaign_item")));
  const cv = JSON.parse(costRow!.updatedValue!);
  assert.equal(cv.authorisedByUserId, A.admin.user.id);
  assert.equal(cv.evidenceDocumentId, evidenceDocId);
  assert.equal(cv.after.costCents, 455_001);
});

test("denials: grant without assignment, assignment without grant, scope mismatch, grant on another transaction, forged client authority", async () => {
  // grant without assignment
  assert.equal((await grant(A.agent, { transactionId: txn.transactionId, granteeUserId: crew.noAssign!.user.id, scope: "AGENCY_TERMS", evidenceNote: "x", expiresAt: inDays(3) })).status, 201);
  // scope mismatch: AGENCY_TERMS only
  assert.equal((await grant(A.agent, { transactionId: txn.transactionId, granteeUserId: crew.agencyOnly!.user.id, scope: "AGENCY_TERMS", evidenceNote: "x", expiresAt: inDays(3) })).status, 201);
  // grant on another transaction (other property); the crew member is assigned on txn only
  assert.equal((await grant(A.agent, { transactionId: txn2.transactionId, granteeUserId: crew.wrongTxn!.user.id, scope: "AGENCY_TERMS", evidenceNote: "x", expiresAt: inDays(3) })).status, 201);
  const rate = await currentRate();
  const cases: Array<[string, () => Promise<{ status: number; json: Record<string, any>; raw: string }>]> = [
    ["grant without assignment", () => putTerms(crew.noAssign!, 301)],
    ["assignment without grant", () => putTerms(crew.assignedNoGrant!, 302)],
    ["scope mismatch (AGENCY_TERMS grant, vendor cost)", () => putCost(crew.agencyOnly!, itemX, 3)],
    ["grant on another transaction", () => putTerms(crew.wrongTxn!, 303)],
    ["forged client authority", () => putTerms(crew.assignedNoGrant!, 304, { authorityId: 1, authorisedByUserId: A.agent.user.id, documentedAuthority: true })],
  ];
  for (const [label, run] of cases) {
    const r = await run();
    assert.equal(r.status, 403, `${label}: ${r.raw}`);
    assert.equal(r.json.reason, AMENDMENT_AUTHORITY_REQUIRED, label);
  }
  assert.equal(await currentRate(), rate, "terms unchanged");
  assert.equal((await putTerms(crew.agencyOnly!, rate ?? 220)).status, 200, "the in-scope amendment still works");
});

test("single-record target: a grant for item X does not reach item Y", async () => {
  const g = await grant(A.agent, { transactionId: txn.transactionId, granteeUserId: crew.targeted!.user.id, scope: "CAMPAIGN_ITEM_COST", targetRecordId: itemX, evidenceNote: "Quote for X", expiresAt: inDays(2) });
  assert.equal(g.status, 201, g.raw);
  assert.equal(g.json.authority.targetRecordType, "campaign_item");
  assert.equal((await putCost(crew.targeted!, itemY, 11)).status, 403);
  assert.equal((await putCost(crew.targeted!, itemX, 12)).status, 200);
  const [y] = await db.select().from(campaignItems).where(eq(campaignItems.id, itemY));
  assert.notEqual(y!.costCents, 11);
});

test("expired grant: denied", async () => {
  await db.insert(financialAmendmentAuthorities).values({
    brokerageId: A.brokerageId,
    propertyId: txn.propertyId,
    transactionId: txn.transactionId,
    granteeUserId: crew.expired!.user.id,
    grantedByUserId: A.agent.user.id,
    grantedByRole: "Agent",
    scope: "AGENCY_TERMS",
    evidenceNote: "Expired synthetic grant",
    createdAt: new Date(Date.now() - 3 * DAY),
    expiresAt: new Date(Date.now() - DAY),
  });
  const r = await putTerms(crew.expired!, 399);
  assert.equal(r.status, 403, r.raw);
  const list = await call("GET", `/financial-amendment-authorities?transactionId=${txn.transactionId}`, crew.expired!.cookie);
  assert.equal(list.status, 200);
  assert.equal(list.json.authorities.length, 1);
  assert.equal(list.json.authorities[0].live, false);
});

test("revoke: listing agent revokes; Pit Crew 403, other agent 404, other brokerage 404, repeat 409; amendment denied afterwards; audited", async () => {
  const g = await grant(A.agent, { transactionId: txn.transactionId, granteeUserId: crew.revoked!.user.id, scope: "AGENCY_TERMS", evidenceNote: "x", expiresAt: inDays(4) });
  const id = g.json.authority.id;
  assert.equal((await putTerms(crew.revoked!, 271)).status, 200, "works before revocation");
  assert.equal((await call("POST", `/financial-amendment-authorities/${id}/revoke`, crew.revoked!.cookie, { reason: "self" })).status, 403);
  assert.equal((await call("POST", `/financial-amendment-authorities/${id}/revoke`, crew.granted!.cookie, { reason: "peer" })).status, 403);
  assert.equal((await call("POST", `/financial-amendment-authorities/${id}/revoke`, otherAgent.cookie, { reason: "x" })).status, 404);
  assert.equal((await call("POST", `/financial-amendment-authorities/${id}/revoke`, B.admin.cookie, { reason: "x" })).status, 404);
  assert.equal((await call("POST", `/financial-amendment-authorities/${id}/revoke`, A.agent.cookie, {})).status, 400, "reason required");
  const rv = await call("POST", `/financial-amendment-authorities/${id}/revoke`, A.agent.cookie, { reason: "Instruction withdrawn" });
  assert.equal(rv.status, 200, rv.raw);
  assert.equal(rv.json.authority.live, false);
  assert.equal(rv.json.authority.revokedByUserId, A.agent.user.id);
  assert.equal((await call("POST", `/financial-amendment-authorities/${id}/revoke`, A.admin.cookie, { reason: "again" })).status, 409);
  const r = await putTerms(crew.revoked!, 272);
  assert.equal(r.status, 403, r.raw);
  const [row] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, AUTHORITY_REVOKED_AUDIT_ACTION), eq(auditLogs.recordId, String(id))));
  const v = JSON.parse(row!.updatedValue!);
  assert.equal(v.revokedByUserId, A.agent.user.id);
  assert.equal(v.revokeReason, "Instruction withdrawn");
});

test("list: listing agent and admin see every grant on the transaction; Pit Crew only their own; other agent and other brokerage 404", async () => {
  const agentList = await call("GET", `/financial-amendment-authorities?transactionId=${txn.transactionId}`, A.agent.cookie);
  assert.equal(agentList.status, 200, agentList.raw);
  assert.ok(agentList.json.authorities.length >= 6);
  assert.equal(agentList.json.maxGrantDays, 30);
  const adminList = await call("GET", `/financial-amendment-authorities?transactionId=${txn.transactionId}`, A.admin.cookie);
  assert.equal(adminList.json.authorities.length, agentList.json.authorities.length);
  const own = await call("GET", `/financial-amendment-authorities?transactionId=${txn.transactionId}`, crew.granted!.cookie);
  assert.equal(own.status, 200);
  assert.ok(own.json.authorities.length >= 2);
  assert.ok(own.json.authorities.every((g: { granteeUserId: number }) => g.granteeUserId === crew.granted!.user.id));
  assert.equal((await call("GET", `/financial-amendment-authorities?transactionId=${txn.transactionId}`, otherAgent.cookie)).status, 404);
  assert.equal((await call("GET", `/financial-amendment-authorities?transactionId=${txn.transactionId}`, B.admin.cookie)).status, 404);
  assert.equal((await call("GET", `/financial-amendment-authorities?transactionId=${txn.transactionId}`, crewB.cookie)).status, 404);
});

test("a grant never reaches payment, debit, refund, release, settlement, funds, commission or authority routes: all 403, nothing changes", async () => {
  const t = txn.transactionId;
  const before = await db.select().from(transactions).where(eq(transactions.id, t));
  const routes: Array<[string, unknown]> = [
    [`/transactions/${t}/calculate-commission`, {}],
    [`/transactions/${t}/funds-received`, { amountCents: 1 }],
    [`/transactions/${t}/settlement-complete`, {}],
    [`/transactions/${t}/agent-paid`, {}],
    [`/transactions/${t}/close`, {}],
    ["/financial/commission-agreements", {}],
    ["/financial/commission-agreements/1/approve", {}],
    ["/financial/commission-agreements/1/cancel", {}],
    ["/financial/commission-calculations", {}],
    ["/financial/settlement/finalize-commission", { transactionId: t }],
    [`/financial/transactions/${t}/legacy-commission/reconcile`, {}],
    ["/financial/pc-fee-authorities", {}],
    ["/financial/pc-fee-authorities/1/activate", {}],
    ["/financial/pc-fee-authorities/1/revoke", {}],
    ["/financial/pc-fee-calculations", {}],
    ["/financial/settlement/ensure-pc-success-fee", { transactionId: t }],
    ["/financial/payment-requests/1/notice-sent", {}],
    ["/financial/payment-requests/1/schedule-debit", {}],
    ["/financial/payment-requests/1/cancel-debit", {}],
    ["/financial/payment-requests/1/reverse", {}],
    ["/financial/ops/dispatch-outbox", {}],
    ["/payments/1/refund", {}],
    ["/integrations/connections/1/actions/link-payment-reference", { paymentRequestId: 1, externalReference: "synthetic" }],
    ["/launch/vendor-approvals/1/decide", { decision: "APPROVED" }],
    ["/launch/1/budget", { budgetCents: 1 }],
    ["/financial-amendment-authorities", { transactionId: t, granteeUserId: crew.assignedNoGrant!.user.id, scope: "AGENCY_TERMS", evidenceNote: "x", expiresAt: inDays(1) }],
  ];
  const who = crew.granted!; // holds live AGENCY_TERMS and CAMPAIGN_ITEM_COST grants + an active assignment
  const live = await call("GET", `/financial-amendment-authorities?transactionId=${t}`, who.cookie);
  assert.ok(live.json.authorities.filter((g: { live: boolean }) => g.live).length >= 2, "precondition: live grants");
  for (const [path, body] of routes) {
    const r = await call("POST", path, who.cookie, body);
    assert.equal(r.status, 403, `POST ${path}: ${r.status} ${r.raw}`);
  }
  assert.deepEqual(await db.select().from(transactions).where(eq(transactions.id, t)), before, "transaction unchanged");
});

test("fail closed: a grant revoked between the check and the write rolls the amendment back", async () => {
  const g = await grant(A.admin, { transactionId: txn.transactionId, granteeUserId: crew.noAssign!.user.id, scope: "AGENCY_TERMS", evidenceNote: "race", expiresAt: inDays(1) });
  const id = g.json.authority.id;
  await call("POST", `/financial-amendment-authorities/${id}/revoke`, A.admin.cookie, { reason: "race" });
  const rate = await currentRate();
  await assert.rejects(
    upsertAgencyAgreementTerms(
      { propertyId: txn.propertyId, brokerageId: A.brokerageId, userId: crew.noAssign!.user.id, commissionType: "Percentage", commissionRateBps: 555, agreementTermDays: 90 },
      async (_b, _a, tx) => {
        await lockLiveAuthority(tx, { allowed: true, basis: "documented_authority", authorisedByUserId: A.admin.user.id, authorisedByRole: "Brokerage Administrator", authorityId: id });
      },
    ),
  );
  assert.equal(await currentRate(), rate, "rolled back");
});
