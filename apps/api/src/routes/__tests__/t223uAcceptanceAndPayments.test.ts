// Owner t223u (31 Oct 2026): (A) service orders and payments are Run-only at the server
// (run.access + role; Pit Crew never executes a charge); (B) proposal acceptance is recorded with
// acceptor capacity, evidence and timestamp, creates no agreement, and Pit Crew activation needs
// an accepted proposal AND a fully signed agreement, in either order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, users, launchPlans, documentPackages, agencyAgreementTerms, proposalAcceptances, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createListedProperty, devLogin, cleanupBrokerages, signedSandboxEsignWebhookHeaders, type DevLoginResult } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const RUN = ["run.access", ...GROW];
const tag = `t223u-${process.pid}-${Date.now()}`;
let server: Server; let baseUrl = ""; const created: number[] = [];

before(async () => {
  const { configureEvents } = await import("../../lib/events.js"); configureEvents();
  const { registerLaunchEngine } = await import("../../lib/launch/bootstrap.js"); registerLaunchEngine();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const a = server.address(); if (!a || typeof a === "string") throw new Error("addr");
  baseUrl = `http://127.0.0.1:${a.port}`;
});
after(async () => {
  try { await cleanupBrokerages(created); } catch { /* throwaway DB */ }
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function setGrants(brokerageId: number, keys: readonly string[]) {
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  for (const k of keys) await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: k, granteeType: "brokerage", granteeId: brokerageId, sourceType: "admin_override", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}
async function tenant(label: string) {
  const name = `${tag} ${label}`;
  const b = await createBrokerageWithUsers(baseUrl, name);
  created.push(b.brokerageId);
  const email = `pc-${label}-${tag}@example.com`;
  const first = await devLogin(baseUrl, { email, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, first.user.id));
  const pitCrew: DevLoginResult = await devLogin(baseUrl, { email, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await setGrants(b.brokerageId, RUN);
  return { ...b, pitCrew };
}
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${baseUrl}/api${path}`, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};

// ------------------------------------------------------------- (A) payments
test("service orders and payments: Grow-only and unsubscribed are 403 on every route for BA, Agent and Pit Crew; Pit Crew cannot charge under Run", async () => {
  const t = await tenant("pay");
  const { propertyId } = await createListedProperty(baseUrl, t.admin.cookie);
  const so = await call(t.admin.cookie, "GET", `/aml/service-orders/by-property/${propertyId}`);
  assert.equal(so.status, 200, so.text);
  const soId = so.json.serviceOrders[0].id as number;
  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/payments/payment-methods"],
    ["POST", "/payments/payment-methods", { scope: "Mine", providerCustomerRef: "cus_x", providerPaymentMethodRef: "pm_x" }],
    ["DELETE", "/payments/payment-methods/999999901"],
    ["POST", `/payments/service-orders/${soId}/charge`],
    ["GET", `/payments/service-orders/${soId}/payments`],
    ["GET", `/payments/service-orders/${soId}`],
    ["POST", "/payments/999999902/refund"],
  ];
  for (const [label, keys] of [["GrowOnly", GROW], ["Unsubscribed", [] as string[]]] as const) {
    await setGrants(t.brokerageId, keys);
    for (const [who, u] of [["BA", t.admin], ["Agent", t.agent], ["Pit Crew", t.pitCrew]] as const) {
      for (const [m, p, b] of routes) {
        const r = await call(u.cookie, m, p, b);
        assert.equal(r.status, 403, `${label} ${who} ${m} ${p}: ${r.text}`);
      }
    }
  }
  await setGrants(t.brokerageId, RUN);
  // Pit Crew may read, never execute.
  assert.equal((await call(t.pitCrew.cookie, "GET", `/payments/service-orders/${soId}`)).status, 200);
  assert.equal((await call(t.pitCrew.cookie, "POST", `/payments/service-orders/${soId}/charge`)).status, 403);
  // Run Agent (property's agent = creator here is BA; agent of same brokerage) and BA can charge.
  const add = await call(t.admin.cookie, "POST", "/payments/payment-methods", { scope: "Mine", providerCustomerRef: `cus_${tag}`, providerPaymentMethodRef: `pm_${tag}` });
  assert.equal(add.status, 201, add.text);
  const ch = await call(t.admin.cookie, "POST", `/payments/service-orders/${soId}/charge`);
  assert.equal(ch.status, 201, ch.text);
  // Refund stays BA-only.
  assert.equal((await call(t.agent.cookie, "POST", `/payments/${ch.json.payment.id}/refund`)).status, 403);
  // Cross-brokerage still 404-shaped.
  const other = await tenant("pay-other");
  assert.equal((await call(other.admin.cookie, "GET", `/payments/service-orders/${soId}`)).status, 404);
});

// ------------------------------------------------------------- (B) acceptance
async function wonProposal(cookie: string, label: string) {
  const p = await call(cookie, "POST", "/properties", { formattedAddress: `${Math.floor(Math.random() * 1e5)} ${label} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
  assert.equal(p.status, 201, p.text);
  const s = await call(cookie, "POST", "/parties", { propertyId: p.json.property.id, role: "Seller", firstName: "Olive", lastName: "Owner", email: `o-${Math.floor(Math.random() * 1e9)}-${tag}@example.com` });
  assert.equal(s.status, 201, s.text);
  const propertyId = p.json.property.id as number; const partyId = s.json.party.id as number;
  const c = await call(cookie, "POST", "/grow/appraisals/from-contact", { partyId, propertyId });
  assert.ok(c.status < 300, c.text);
  const id = (c.json.appraisal ?? c.json).id as number;
  return { propertyId, partyId, id };
}
async function markWon(cookie: string, id: number) {
  for (const toStatus of ["APPOINTMENT_SCHEDULED", "PRESENTED"]) assert.ok((await call(cookie, "POST", `/grow/appraisals/${id}/status`, { toStatus })).status < 300);
  assert.ok((await call(cookie, "POST", `/grow/appraisals/${id}/outcome`, { outcome: "WON" })).status < 300);
}
const acceptedAt = () => new Date(Date.now() - 3600_000).toISOString().replace("Z", "+00:00");

test("acceptance: validation (WON first, owner party, representative authority, evidence, no future time, Pit Crew 403, one active), evidence + timestamps stored, no agreement created", async () => {
  const t = await tenant("acc");
  const w = await wonProposal(t.admin.cookie, "Acc");
  const base = { acceptorCapacity: "OWNER", acceptorPartyId: w.partyId, acceptorName: "Olive Owner", evidenceType: "EMAIL", evidenceReference: "Email 2026-10-30 'Happy to proceed'", acceptedAt: acceptedAt() };
  let r = await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, base);
  assert.equal(r.status, 409); assert.equal(r.json.code, "PROPOSAL_NOT_WON");
  await markWon(t.admin.cookie, w.id);
  assert.equal((await call(t.pitCrew.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, base)).status, 403);
  r = await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, { ...base, commissionRateBps: 200 });
  assert.equal(r.status, 400); assert.equal(r.json.code, "AGENCY_AGREEMENT_NOT_IN_PROPOSAL");
  assert.equal((await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, { ...base, evidenceReference: " " })).status, 400);
  assert.equal((await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, { ...base, acceptedAt: "2026-10-30T10:00:00" })).status, 400, "timezone offset required");
  r = await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, { ...base, acceptedAt: new Date(Date.now() + 864e5).toISOString() });
  assert.equal(r.json?.code, "ACCEPTED_AT_IN_FUTURE");
  r = await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, { ...base, acceptorCapacity: "AUTHORISED_REPRESENTATIVE", acceptorPartyId: null, acceptorName: "Rep" });
  assert.equal(r.json?.code, "AUTHORITY_BASIS_REQUIRED");
  r = await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, { ...base, acceptorPartyId: null });
  assert.equal(r.json?.code, "OWNER_PARTY_REQUIRED");
  const ok = await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, base);
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.activation, "AWAITING_SIGNED_AGREEMENT");
  assert.equal(new Date(ok.json.acceptance.acceptedAt).toISOString(), new Date(base.acceptedAt).toISOString());
  assert.ok(ok.json.acceptance.recordedAt && ok.json.acceptance.recordedByUserId === t.admin.user.id);
  const dup = await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, base);
  assert.equal(dup.json?.code, "ACCEPTANCE_ALREADY_RECORDED");
  // Another agent cannot see the BA's property (#147 own-property scope): 404, not the record.
  assert.equal((await call(t.agent.cookie, "GET", `/grow/appraisals/${w.id}/acceptance`)).status, 404);
  const g = await call(t.admin.cookie, "GET", `/grow/appraisals/${w.id}/acceptance`);
  assert.equal(g.status, 200); assert.equal(g.json.acceptance.evidenceType, "EMAIL");
  // Never an agreement, package or launch plan.
  assert.equal((await db.select().from(documentPackages).where(eq(documentPackages.propertyId, w.propertyId))).length, 0);
  assert.equal((await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, w.propertyId))).length, 0);
  assert.equal((await db.select().from(launchPlans).where(eq(launchPlans.propertyId, w.propertyId))).length, 0);
  // Append-only at the database.
  await assert.rejects(db.delete(proposalAcceptances).where(eq(proposalAcceptances.id, ok.json.acceptance.id)));
  await assert.rejects(db.update(proposalAcceptances).set({ evidenceReference: "edited" }).where(eq(proposalAcceptances.id, ok.json.acceptance.id)));
  // Authorised representative with basis is accepted on another proposal; cross-brokerage is 404.
  const w2 = await wonProposal(t.admin.cookie, "Rep"); await markWon(t.admin.cookie, w2.id);
  const rep = await call(t.admin.cookie, "POST", `/grow/appraisals/${w2.id}/acceptance`, { acceptorCapacity: "AUTHORISED_REPRESENTATIVE", acceptorName: "Rita Rep", authorityBasis: "Enduring power of attorney (sighted)", evidenceType: "SIGNED_ACCEPTANCE", evidenceReference: "Scan ref 42", acceptedAt: acceptedAt() });
  assert.equal(rep.status, 201, rep.text);
  const other = await tenant("acc-other");
  assert.equal((await call(other.admin.cookie, "GET", `/grow/appraisals/${w.id}/acceptance`)).status, 404);
});

async function signAgreement(cookie: string, propertyId: number) {
  const pkg = (await call(cookie, "POST", `/properties/${propertyId}/ready-to-list`)).json.documentPackage.id as number;
  assert.equal((await call(cookie, "PUT", `/documents/agency-agreement-terms/${propertyId}`, { commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90 })).status, 200);
  assert.equal((await call(cookie, "POST", `/documents/packages/${pkg}/populate`)).status, 200);
  const sent = await call(cookie, "POST", `/documents/packages/${pkg}/send-for-signature`);
  assert.equal(sent.status, 201, sent.text);
  const docs = await call(cookie, "GET", `/documents/packages/by-property/${propertyId}`);
  const body = JSON.stringify({ providerReference: sent.json.signatureRequest.providerReference, status: "Completed", completedDocuments: (docs.json.documents as Array<{ id: number }>).map((d) => ({ documentId: d.id, contentBase64: Buffer.from("signed").toString("base64"), filename: `d${d.id}.txt`, contentType: "text/plain" })) });
  const wh = await fetch(`${baseUrl}/api/documents/webhook`, { method: "POST", headers: signedSandboxEsignWebhookHeaders(body), body });
  assert.equal(wh.status, 200, await wh.text());
}
const plans = (pid: number) => db.select().from(launchPlans).where(eq(launchPlans.propertyId, pid));

test("Pit Crew activation: signed agreement without an accepted proposal -> no launch plan; recording the acceptance afterwards activates", async () => {
  const t = await tenant("order1");
  const w = await wonProposal(t.admin.cookie, "Order1");
  await signAgreement(t.admin.cookie, w.propertyId);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await plans(w.propertyId)).length, 0, "signed only: not activated");
  await markWon(t.admin.cookie, w.id);
  const ok = await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, { acceptorCapacity: "OWNER", acceptorPartyId: w.partyId, acceptorName: "Olive Owner", evidenceType: "RECORDED_CALL", evidenceReference: "Call 123", acceptedAt: acceptedAt() });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.activation, "LAUNCH_PLAN_PROPOSED");
  assert.equal((await plans(w.propertyId)).length, 1);
});

test("Pit Crew activation: accepted proposal first, then the fully signed agreement activates", async () => {
  const t = await tenant("order2");
  const w = await wonProposal(t.admin.cookie, "Order2");
  await markWon(t.admin.cookie, w.id);
  assert.equal((await call(t.admin.cookie, "POST", `/grow/appraisals/${w.id}/acceptance`, { acceptorCapacity: "OWNER", acceptorPartyId: w.partyId, acceptorName: "Olive Owner", evidenceType: "IN_PERSON_WITNESSED", evidenceReference: "Witnessed by agent", acceptedAt: acceptedAt() })).status, 201);
  assert.equal((await plans(w.propertyId)).length, 0, "accepted only: not activated");
  await signAgreement(t.admin.cookie, w.propertyId);
  for (let i = 0; i < 40 && (await plans(w.propertyId)).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await plans(w.propertyId)).length, 1);
});
