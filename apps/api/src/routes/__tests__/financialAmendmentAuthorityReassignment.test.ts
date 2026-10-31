// Owner decision 28 Oct 2026 (09:17 AEST): reassigning a property does NOT end
// a written-authority grant. A grant from the original listing agent stays
// valid until expiry, revocation or close (t179u D7). Regression test for #271's
// existing behaviour; no code change. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agencyAgreementTerms,
  auditLogs,
  db,
  financialAmendmentAuthorities,
  pitCrewAssignments,
  properties,
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

type Who = DevLoginResult;
type Txn = { propertyId: number; transactionId: number };
let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Fin AuthReassign A ${suffix}`;
let A: { admin: Who; agent: Who; brokerageId: number };
let newAgent: Who;
const crew: Record<string, Who> = {};
let txnOpen: Txn;
let txnClose: Txn;
const DAY = 86_400_000;

async function call(method: "GET" | "POST" | "PUT", path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}

async function inBrokerage(name: string, role: "Agent" | "Pit Crew"): Promise<Who> {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Synthetic", brokerageName: nameA });
  await db.update(users).set({ role }).where(eq(users.id, r.user.id));
  return r;
}

async function assign(key: string, t: Txn) {
  const tag = `${key}-${t.transactionId}`;
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: A.brokerageId, propertyId: t.propertyId, transactionId: t.transactionId,
      ruleId: "fin-auth-reassign-rule", category: "SETTLEMENT_CLOSURE", severity: "MEDIUM", status: "OPEN",
      title: `Synthetic settlement work ${tag}`, problemDescription: "Synthetic fixture.", businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.", recommendedAction: "Synthetic fixture.", resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE", sourceRecordId: `fin-reassign-${tag}-${suffix}`, correlationId: randomUUID(),
      dedupKey: `fin-reassign-${tag}-${suffix}`, openDedupKey: `fin-reassign-${tag}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db.insert(pitCrewAssignments).values({
    brokerageId: A.brokerageId, sourceType: "EXCEPTION", sourceRecordId: ex!.id, propertyId: t.propertyId,
    status: "IN_PROGRESS", assignedToUserId: crew[key]!.user.id, version: 1,
  });
}

const terms = (rate: number) => ({ commissionType: "Percentage", commissionRateBps: rate, agreementTermDays: 90 });
const putTerms = (who: Who, t: Txn, rate: number) => call("PUT", `/documents/agency-agreement-terms/${t.propertyId}`, who.cookie, terms(rate));
const grantBy = (by: Who, t: Txn, grantee: Who, expiresAt: string) =>
  call("POST", "/financial-amendment-authorities", by.cookie, {
    transactionId: t.transactionId, granteeUserId: grantee.user.id, scope: "AGENCY_TERMS",
    evidenceNote: "Synthetic signed written instruction", expiresAt,
  });
const reassign = (t: Txn, to: Who) => db.update(properties).set({ agentId: to.user.id }).where(eq(properties.id, t.propertyId));
const rateOf = async (t: Txn) => (await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, t.propertyId)))[0]!.commissionRateBps;

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
  newAgent = await inBrokerage("ra-new-agent", "Agent");
  txnOpen = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Reassign Open St, Testville`, sellerEmail: `seller-ra1-${suffix}@example.com`, offerPriceCents: 71_234_500 });
  txnClose = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Reassign Close St, Testville`, sellerEmail: `seller-ra2-${suffix}@example.com`, offerPriceCents: 72_234_500 });
  for (const key of ["revoke", "expire", "close"]) crew[key] = await inBrokerage(`ra-crew-${key}`, "Pit Crew");
  await assign("revoke", txnOpen);
  await assign("expire", txnOpen);
  await assign("close", txnClose);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("Owner 28 Oct: after the property is reassigned, the original listing agent's grant still allows its amendment until expiry, revocation or close", async () => {
  // Grants issued by the ORIGINAL listing agent while they hold the listing.
  const gRevoke = await grantBy(A.agent, txnOpen, crew.revoke!, new Date(Date.now() + 3 * DAY).toISOString());
  assert.equal(gRevoke.status, 201, gRevoke.raw);
  const gClose = await grantBy(A.agent, txnClose, crew.close!, new Date(Date.now() + 3 * DAY).toISOString());
  assert.equal(gClose.status, 201, gClose.raw);
  const [gExpire] = await db
    .insert(financialAmendmentAuthorities)
    .values({ brokerageId: A.brokerageId, propertyId: txnOpen.propertyId, transactionId: txnOpen.transactionId, granteeUserId: crew.expire!.user.id, grantedByUserId: A.agent.user.id, grantedByRole: "Agent", scope: "AGENCY_TERMS", evidenceNote: "Synthetic written instruction", expiresAt: new Date(Date.now() + 4000) })
    .returning();

  // Reassign both properties to another agent.
  await reassign(txnOpen, newAgent);
  await reassign(txnClose, newAgent);

  // 1. Still valid after reassignment: every grantee can make the permitted amendment.
  assert.equal((await putTerms(crew.revoke!, txnOpen, 401)).status, 200, "revoke-case grant still live after reassignment");
  assert.equal(await rateOf(txnOpen), 401);
  assert.equal((await putTerms(crew.expire!, txnOpen, 402)).status, 200, "expire-case grant still live after reassignment");
  assert.equal((await putTerms(crew.close!, txnClose, 403)).status, 200, "close-case grant still live after reassignment");
  assert.equal(await rateOf(txnClose), 403);
  const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.action, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), eq(auditLogs.userId, crew.revoke!.user.id)));
  const row = rows.find((x) => JSON.parse(x.updatedValue!).after?.commissionRateBps === 401);
  assert.ok(row, "amendment audited");
  assert.equal(JSON.parse(row!.updatedValue!).authorisedByUserId, A.agent.user.id, "audit still names the original grantor");
  const listed = await call("GET", `/financial-amendment-authorities?transactionId=${txnOpen.transactionId}`, A.admin.cookie);
  assert.equal(listed.status, 200, listed.raw);
  const live = listed.json.authorities.find((g: { id: number }) => g.id === gRevoke.json.authority.id);
  assert.equal(live.live, true, "listed as live after reassignment");

  // 2. Expiry still ends it.
  await new Promise((r) => setTimeout(r, Math.max(0, gExpire!.expiresAt.getTime() - Date.now()) + 500));
  const exp = await putTerms(crew.expire!, txnOpen, 404);
  assert.equal(exp.status, 403, exp.raw);
  assert.equal(exp.json.reason, AMENDMENT_AUTHORITY_REQUIRED);

  // 3. Revocation still ends it (by a Brokerage Administrator).
  const rv = await call("POST", `/financial-amendment-authorities/${gRevoke.json.authority.id}/revoke`, A.admin.cookie, { reason: "Synthetic revocation" });
  assert.equal(rv.status, 200, rv.raw);
  const afterRevoke = await putTerms(crew.revoke!, txnOpen, 405);
  assert.equal(afterRevoke.status, 403, afterRevoke.raw);
  assert.equal(await rateOf(txnOpen), 402, "refused amendments change nothing");

  // 4. Close still ends it (t179u D7).
  await db.update(transactions).set({ status: "Closed", closedAt: new Date() }).where(eq(transactions.id, txnClose.transactionId));
  const closed = await putTerms(crew.close!, txnClose, 406);
  assert.equal(closed.status, 403, closed.raw);
  assert.equal(await rateOf(txnClose), 403);
});
