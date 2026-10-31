// Owner t181u hardening (#271): negative and security tests for the
// written-authority amendment routes. No authority -> blocked; expiry at use
// time and early end on completion (t179u D7); wrong scope; cross-brokerage;
// self-approval; before/after audit values match the database. Synthetic data only.
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
import { AMENDMENT_AUTHORITY_REQUIRED, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION } from "../../lib/financialAmendments.js";


process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Fin AuthNeg A ${suffix}`;
const nameB = `Fin AuthNeg B ${suffix}`;

type Who = DevLoginResult;
let A: { admin: Who; agent: Who; brokerageId: number };
let B: { admin: Who; agent: Who; brokerageId: number };
let otherAgent: Who;
let crewB: Who;
const crew: Record<string, Who> = {};
let txn: { propertyId: number; transactionId: number };
let txn2: { propertyId: number; transactionId: number };
let itemX: string;
let termsId: number;
let evidenceDocId: number;

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

let txnB: { propertyId: number; transactionId: number };
let termsBId: number;
const amendRows = (userId: number) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.action, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), eq(auditLogs.userId, userId)));
const list = (who: Who, t = txn.transactionId) => call("GET", `/financial-amendment-authorities?transactionId=${t}`, who.cookie);
async function rawGrant(key: string, scope: string, expiresAt: Date, t = txn) {
  const [g] = await db
    .insert(financialAmendmentAuthorities)
    .values({ brokerageId: A.brokerageId, propertyId: t.propertyId, transactionId: t.transactionId, granteeUserId: crew[key]!.user.id, grantedByUserId: A.agent.user.id, grantedByRole: "Agent", scope: scope as never, evidenceNote: "Synthetic written instruction", expiresAt })
    .returning();
  return g!;
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
  otherAgent = await inBrokerage("an-other-agent", nameA, "Agent");
  crewB = await inBrokerage("an-crew-b", nameB, "Pit Crew");
  txn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Neg Grant St, Testville`, sellerEmail: `seller-an-${suffix}@example.com`, offerPriceCents: 81_234_500 });
  txn2 = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Neg Closed St, Testville`, sellerEmail: `seller-an2-${suffix}@example.com`, offerPriceCents: 61_234_500 });
  txnB = await createTransactionFromListedProperty(baseUrl, B.agent.cookie, { address: `${suffix} Other Brokerage St, Testville`, sellerEmail: `seller-anb-${suffix}@example.com`, offerPriceCents: 51_234_500 });
  const [t] = await db.select({ id: agencyAgreementTerms.id }).from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, txn.propertyId));
  termsId = t!.id;
  const [tb] = await db.select({ id: agencyAgreementTerms.id }).from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, txnB.propertyId));
  termsBId = tb!.id;
  itemX = await newItem(txn.propertyId, "Photography X");
  const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.propertyId, txn.propertyId)).limit(1);
  evidenceDocId = doc!.id;
  for (const key of ["none", "soon", "closed", "costOnly", "commission", "granted"]) crew[key] = await inBrokerage(`an-crew-${key}`, nameA, "Pit Crew");
  for (const key of ["none", "soon", "costOnly", "commission", "granted"]) await assign(key, txn);
  await assign("closed", txn2);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("no authority: an assigned Pit Crew member without a grant is blocked on every amendable record, nothing changes, no amendment audit row", async () => {
  const rate = await currentRate();
  for (const r of [await putTerms(crew.none!, 301), await putTerms(crew.none!, 302, { authorityId: 999999 }), await putCost(crew.none!, itemX, 7)]) {
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.json.reason, AMENDMENT_AUTHORITY_REQUIRED);
  }
  assert.equal(await currentRate(), rate);
  const [item] = await db.select().from(campaignItems).where(eq(campaignItems.id, itemX));
  assert.notEqual(item!.costCents, 7);
  assert.equal((await amendRows(crew.none!.user.id)).length, 0);
});

test("expiry (t179u D7) at use time: a grant works until its expiry instant and is refused straight after; listed as not live", async () => {
  await rawGrant("soon", "AGENCY_TERMS", new Date(Date.now() + 2500));
  assert.equal((await putTerms(crew.soon!, 311)).status, 200, "live before expiry");
  await new Promise((r) => setTimeout(r, 3000));
  const r = await putTerms(crew.soon!, 312);
  assert.equal(r.status, 403, r.raw);
  assert.equal(r.json.reason, AMENDMENT_AUTHORITY_REQUIRED);
  assert.equal(await currentRate(), 311);
  const l = await list(crew.soon!);
  assert.equal(l.json.authorities.length, 1);
  assert.equal(l.json.authorities[0].live, false);
});

test("D7 completion: a grant on a Closed transaction is refused at use time AND is reported as not live in the list", async () => {
  await rawGrant("closed", "AGENCY_TERMS", new Date(Date.now() + 5 * DAY), txn2);
  const put2 = (rate: number) => call("PUT", `/documents/agency-agreement-terms/${txn2.propertyId}`, crew.closed!.cookie, terms(rate));
  assert.equal((await put2(321)).status, 200, "precondition: works while open");
  await db.update(transactions).set({ status: "Closed", closedAt: new Date() }).where(eq(transactions.id, txn2.transactionId));
  const r = await put2(322);
  assert.equal(r.status, 403, r.raw);
  for (const who of [crew.closed!, A.agent, A.admin]) {
    const l = await list(who, txn2.transactionId);
    assert.equal(l.status, 200, l.raw);
    const mine = l.json.authorities.filter((g: { granteeUserId: number }) => g.granteeUserId === crew.closed!.user.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].live, false, "a grant on a completed transaction must not be shown as live");
  }
});

test("wrong scope: CAMPAIGN_ITEM_COST cannot amend agency terms; COMMISSION_AGREEMENT cannot amend terms or vendor costs", async () => {
  await rawGrant("costOnly", "CAMPAIGN_ITEM_COST", new Date(Date.now() + 2 * DAY));
  await rawGrant("commission", "COMMISSION_AGREEMENT", new Date(Date.now() + 2 * DAY));
  const rate = await currentRate();
  for (const r of [await putTerms(crew.costOnly!, 331), await putTerms(crew.commission!, 332), await putCost(crew.commission!, itemX, 333)]) {
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.json.reason, AMENDMENT_AUTHORITY_REQUIRED);
  }
  assert.equal(await currentRate(), rate);
  assert.equal((await putCost(crew.costOnly!, itemX, 334)).status, 200, "the in-scope amendment works");
});

test("cross-brokerage: another brokerage cannot create, list or revoke; an A grant never reaches a B property; B records unchanged", async () => {
  const g = await grant(A.agent, { transactionId: txn.transactionId, granteeUserId: crew.granted!.user.id, scope: "AGENCY_TERMS", evidenceNote: "Signed instruction", expiresAt: inDays(3) });
  assert.equal(g.status, 201, g.raw);
  const id = g.json.authority.id;
  assert.equal((await grant(B.admin, { transactionId: txn.transactionId, granteeUserId: crewB.user.id, scope: "AGENCY_TERMS", evidenceNote: "x", expiresAt: inDays(1) })).status, 404);
  assert.equal((await grant(A.admin, { transactionId: txnB.transactionId, granteeUserId: crew.granted!.user.id, scope: "AGENCY_TERMS", evidenceNote: "x", expiresAt: inDays(1) })).status, 404);
  for (const who of [B.admin, B.agent]) {
    assert.equal((await list(who)).status, 404);
    assert.equal((await call("POST", `/financial-amendment-authorities/${id}/revoke`, who.cookie, { reason: "x" })).status, 404);
  }
  assert.equal((await call("POST", `/financial-amendment-authorities/${id}/revoke`, crewB.cookie, { reason: "x" })).status, 404);
  const [before] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.id, termsBId));
  const r = await call("PUT", `/documents/agency-agreement-terms/${txnB.propertyId}`, crew.granted!.cookie, terms(341));
  assert.ok(r.status === 403 || r.status === 404, r.raw);
  const [afterRow] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.id, termsBId));
  assert.equal(afterRow!.commissionRateBps, before!.commissionRateBps);
  const [still] = await db.select().from(financialAmendmentAuthorities).where(eq(financialAmendmentAuthorities.id, id));
  assert.equal(still!.revokedAt, null, "not revoked by another brokerage");
});

test("self-approval: Pit Crew cannot grant (incl. to themselves) or revoke their own grant; grantors cannot name themselves as grantee", async () => {
  const body = (grantee: number) => ({ transactionId: txn.transactionId, granteeUserId: grantee, scope: "AGENCY_TERMS", evidenceNote: "x", expiresAt: inDays(2) });
  const self = await grant(crew.granted!, body(crew.granted!.user.id));
  assert.equal(self.status, 403);
  assert.equal(self.json.reason, "FINANCIAL_AUTHORITY_GRANT_FORBIDDEN");
  assert.equal((await grant(crew.granted!, body(crew.none!.user.id))).status, 403, "nor to a colleague");
  for (const grantor of [A.agent, A.admin]) {
    const r = await grant(grantor, body(grantor.user.id));
    assert.equal(r.status, 422, r.raw);
    assert.equal(r.json.reason, "GRANTEE_NOT_PIT_CREW");
  }
  const own = (await list(crew.granted!)).json.authorities.find((g: { live: boolean }) => g.live);
  assert.ok(own, "precondition: own live grant");
  const rv = await call("POST", `/financial-amendment-authorities/${own.id}/revoke`, crew.granted!.cookie, { reason: "self" });
  assert.equal(rv.status, 403);
});

test("audit: before/after values equal the database before and after; refusals write no amendment row", async () => {
  const [beforeRow] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.id, termsId));
  const n0 = (await amendRows(crew.granted!.user.id)).length;
  const r = await putTerms(crew.granted!, 351);
  assert.equal(r.status, 200, r.raw);
  const [afterRow] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.id, termsId));
  const rows = await amendRows(crew.granted!.user.id);
  assert.equal(rows.length, n0 + 1, "exactly one amendment row");
  const row = rows.find((x) => x.recordType === "agency_agreement_terms" && JSON.parse(x.updatedValue!).after?.commissionRateBps === 351)!;
  assert.ok(row);
  const prev = JSON.parse(row.previousValue!);
  const upd = JSON.parse(row.updatedValue!);
  assert.equal(prev.commissionRateBps, beforeRow!.commissionRateBps);
  assert.equal(upd.after.commissionRateBps, afterRow!.commissionRateBps);
  assert.equal(upd.performedByUserId, crew.granted!.user.id);
  assert.equal(upd.authorisedByUserId, A.agent.user.id);
  assert.ok(row.brokerageId === A.brokerageId);
  // Refused: out-of-scope and on a B property.
  await putCost(crew.granted!, itemX, 1);
  await call("PUT", `/documents/agency-agreement-terms/${txnB.propertyId}`, crew.granted!.cookie, terms(352));
  assert.equal((await amendRows(crew.granted!.user.id)).length, n0 + 1, "no row for refused amendments");
});
