// PROPOSAL / AGENCY-AGREEMENT BOUNDARY (Owner t221u, 2026-10-31).
// A proposal (Grow appraisal) is not a legally binding agency agreement.
// - Proposals: Grow or Run subscribers holding the Grow keys (grow.access + grow.opportunities.manage).
//   With #281, a Run (Starter) subscription carries those keys; here each persona's grants are set directly.
// - Agency agreements (terms, package generation/populate = template, send for signature, ready-to-list
//   which creates the package): run.access AND (Brokerage Administrator OR the property's own agent).
//   Pit Crew may read but not create/generate/execute. Grow-only and unsubscribed: 403 everywhere.
// - Proposal writes carrying agency-agreement fields are rejected (400).
// - Proposal send / outcome WON never create an agreement or activate Pit Crew. Pit Crew launch
//   activation happens only on a fully signed agreement (AGENCY_AGREEMENT_SIGNED).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db, entitlementGrants, users, documentPackages, agencyAgreementTerms, launchPlans, pitCrewAssignments, domainEvents, ENTITLEMENT_KEYS,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, devLogin, cleanupBrokerages, signedSandboxEsignWebhookHeaders, recordAcceptedProposalFixture, type DevLoginResult } from "./testSupport.js";

const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const PERSONAS = {
  GrowOnly: [...GROW],
  Run: ["run.access", ...GROW], // a Run subscription as provisioned by #281 (Starter = run.access + Grow)
  Bundle: ["run.access", ...GROW],
  RunLegacy: ["run.access"], // dev-login / migration grant only, no subscription (a7b2b0ef default)
  Unsubscribed: [] as string[],
} as const;
type Persona = keyof typeof PERSONAS;

const tag = `pab-${process.pid}-${Date.now()}`;
let server: Server; let baseUrl = ""; const created: number[] = [];
interface Tenant { brokerageId: number; admin: DevLoginResult; agent: DevLoginResult; pitCrew: DevLoginResult; name: string }

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
async function tenant(label: string, keys: readonly string[] = PERSONAS.Run): Promise<Tenant> {
  const name = `${tag} ${label}`;
  const b = await createBrokerageWithUsers(baseUrl, name);
  created.push(b.brokerageId);
  const email = `pc-${label.replace(/\W/g, "")}-${tag}@example.com`;
  const first = await devLogin(baseUrl, { email, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, first.user.id));
  const pitCrew = await devLogin(baseUrl, { email, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await setGrants(b.brokerageId, PERSONAS.Run); // set-up runs as a full Run tenant
  return { ...b, pitCrew, name, _keys: keys } as Tenant & { _keys: readonly string[] };
}
async function finalise(t: Tenant & { _keys?: readonly string[] }) { await setGrants(t.brokerageId, t._keys ?? PERSONAS.Run); }

const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${baseUrl}/api${path}`, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};
async function propertyWithSeller(cookie: string, label: string) {
  const p = await call(cookie, "POST", "/properties", { formattedAddress: `${Math.floor(Math.random() * 1e5)} ${label} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
  assert.equal(p.status, 201, p.text);
  const s = await call(cookie, "POST", "/parties", { propertyId: p.json.property.id, role: "Seller", firstName: "Sam", lastName: "Seller", email: `seller-${Math.floor(Math.random() * 1e9)}-${tag}@example.com` });
  assert.equal(s.status, 201, s.text);
  return { propertyId: p.json.property.id as number, partyId: s.json.party.id as number };
}
async function readyPackage(cookie: string, propertyId: number) {
  const r = await call(cookie, "POST", `/properties/${propertyId}/ready-to-list`);
  assert.equal(r.status, 200, r.text);
  return r.json.documentPackage.id as number;
}
const TERMS = { commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90 };

// ---------------------------------------------------------------- agreements
test("Grow-only and unsubscribed: every agency-agreement route is 403 for BA, Agent and Pit Crew (direct API)", async () => {
  const owner = await tenant("agr-owner");
  const { propertyId } = await propertyWithSeller(owner.admin.cookie, "AgrOwner");
  const packageId = await readyPackage(owner.admin.cookie, propertyId);
  for (const persona of ["GrowOnly", "Unsubscribed"] as Persona[]) {
    const t = await tenant(`agr-${persona}`, PERSONAS[persona]);
    const own = await propertyWithSeller(t.admin.cookie, `Agr${persona}`);
    const ownPkg = await readyPackage(t.admin.cookie, own.propertyId);
    await finalise(t);
    for (const [who, u] of [["BA", t.admin], ["Agent", t.agent], ["Pit Crew", t.pitCrew]] as const) {
      for (const [m, p, body] of [
        ["PUT", `/documents/agency-agreement-terms/${own.propertyId}`, TERMS],
        ["GET", `/documents/agency-agreement-terms/${own.propertyId}`, undefined],
        ["POST", `/documents/packages/${ownPkg}/populate`, undefined],
        ["POST", `/documents/packages/${ownPkg}/send-for-signature`, undefined],
        ["GET", `/documents/packages/by-property/${own.propertyId}`, undefined],
        ["POST", `/properties/${own.propertyId}/ready-to-list`, undefined],
        ["POST", `/documents/packages/${packageId}/populate`, undefined],
      ] as const) {
        const r = await call(u.cookie, m, p, body);
        assert.equal(r.status, 403, `${persona} ${who} ${m} ${p}: ${r.text}`);
      }
    }
  }
});

test("Grow-only: property workspace never exposes agency-agreement terms or the agreement package", async () => {
  const t = await tenant("ws-grow", PERSONAS.GrowOnly);
  const { propertyId } = await propertyWithSeller(t.admin.cookie, "WsGrow");
  await readyPackage(t.admin.cookie, propertyId);
  assert.equal((await call(t.admin.cookie, "PUT", `/documents/agency-agreement-terms/${propertyId}`, TERMS)).status, 200);
  await finalise(t);
  const r = await call(t.admin.cookie, "GET", `/properties/${propertyId}/workspace`);
  if (r.status === 200) {
    assert.equal(r.json.agencyAgreementTerms, null, "terms stripped");
    assert.equal(r.json.documentPackage, null, "package stripped");
  } else assert.equal(r.status, 403);
});

test("Run: BA and the property's own Agent may create terms, generate and send; Pit Crew 403; another Agent 404; reads by role", async () => {
  for (const persona of ["Run", "Bundle"] as Persona[]) {
    const t = await tenant(`agr-run-${persona}`, PERSONAS[persona]);
    await finalise(t);
    // BA-owned property
    const ba = await propertyWithSeller(t.admin.cookie, `RunBa${persona}`);
    // Agent-owned property
    const ag = await propertyWithSeller(t.agent.cookie, `RunAg${persona}`);

    // Pit Crew: cannot create the package, terms, populate or send
    assert.equal((await call(t.pitCrew.cookie, "POST", `/properties/${ba.propertyId}/ready-to-list`)).status, 403, "PC ready-to-list");
    const baPkg = await readyPackage(t.admin.cookie, ba.propertyId);
    for (const [m, p, body] of [
      ["PUT", `/documents/agency-agreement-terms/${ba.propertyId}`, TERMS],
      ["POST", `/documents/packages/${baPkg}/populate`, undefined],
      ["POST", `/documents/packages/${baPkg}/send-for-signature`, undefined],
    ] as const) assert.equal((await call(t.pitCrew.cookie, m, p, body)).status, 403, `${persona} PC ${m} ${p}`);

    // An Agent who is not the property's agent: 404 (same as cross-brokerage; #147 visibility)
    for (const [m, p, body] of [
      ["POST", `/properties/${ba.propertyId}/ready-to-list`, undefined],
      ["PUT", `/documents/agency-agreement-terms/${ba.propertyId}`, TERMS],
      ["GET", `/documents/agency-agreement-terms/${ba.propertyId}`, undefined],
      ["GET", `/documents/packages/by-property/${ba.propertyId}`, undefined],
      ["POST", `/documents/packages/${baPkg}/populate`, undefined],
      ["POST", `/documents/packages/${baPkg}/send-for-signature`, undefined],
    ] as const) assert.equal((await call(t.agent.cookie, m, p, body)).status, 404, `${persona} other Agent ${m} ${p}`);

    // BA: full flow on its property
    assert.equal((await call(t.admin.cookie, "PUT", `/documents/agency-agreement-terms/${ba.propertyId}`, TERMS)).status, 200);
    assert.equal((await call(t.admin.cookie, "POST", `/documents/packages/${baPkg}/populate`)).status, 200);
    assert.equal((await call(t.admin.cookie, "POST", `/documents/packages/${baPkg}/send-for-signature`)).status, 201);

    // The property's own Agent: full flow on their property
    const agPkg = await readyPackage(t.agent.cookie, ag.propertyId);
    assert.equal((await call(t.agent.cookie, "PUT", `/documents/agency-agreement-terms/${ag.propertyId}`, TERMS)).status, 200);
    assert.equal((await call(t.agent.cookie, "POST", `/documents/packages/${agPkg}/populate`)).status, 200);
    assert.equal((await call(t.agent.cookie, "POST", `/documents/packages/${agPkg}/send-for-signature`)).status, 201);
    // BA may act on the Agent's property (written authority over the brokerage)
    assert.equal((await call(t.admin.cookie, "GET", `/documents/agency-agreement-terms/${ag.propertyId}`)).status, 200);

    // Pit Crew may read
    assert.equal((await call(t.pitCrew.cookie, "GET", `/documents/agency-agreement-terms/${ba.propertyId}`)).status, 200, "PC read terms");
    assert.equal((await call(t.pitCrew.cookie, "GET", `/documents/packages/by-property/${ba.propertyId}`)).status, 200, "PC read package");
  }
});

test("RunLegacy (run.access only): agreements follow the same role rule; proposals need the Grow keys (403 until #281 provisions them)", async () => {
  const t = await tenant("legacy", PERSONAS.RunLegacy);
  const { propertyId, partyId } = await propertyWithSeller(t.admin.cookie, "Legacy");
  await finalise(t);
  const pkg = await readyPackage(t.admin.cookie, propertyId);
  assert.equal((await call(t.admin.cookie, "PUT", `/documents/agency-agreement-terms/${propertyId}`, TERMS)).status, 200);
  assert.equal((await call(t.pitCrew.cookie, "POST", `/documents/packages/${pkg}/populate`)).status, 403);
  assert.equal((await call(t.admin.cookie, "POST", "/grow/appraisals/from-contact", { partyId, propertyId })).status, 403);
});

test("cross-brokerage: agreement routes answer 404 for another brokerage's property and package", async () => {
  const a = await tenant("iso-a"); await finalise(a);
  const b = await tenant("iso-b"); await finalise(b);
  const { propertyId } = await propertyWithSeller(b.admin.cookie, "IsoB");
  const pkg = await readyPackage(b.admin.cookie, propertyId);
  for (const u of [a.admin, a.agent, a.pitCrew]) {
    for (const [m, p, body] of [
      ["PUT", `/documents/agency-agreement-terms/${propertyId}`, TERMS],
      ["GET", `/documents/agency-agreement-terms/${propertyId}`, undefined],
      ["POST", `/documents/packages/${pkg}/populate`, undefined],
      ["POST", `/documents/packages/${pkg}/send-for-signature`, undefined],
      ["GET", `/documents/packages/by-property/${propertyId}`, undefined],
      ["POST", `/properties/${propertyId}/ready-to-list`, undefined],
    ] as const) {
      const r = await call(u.cookie, m, p, body);
      assert.equal(r.status, 404, `${m} ${p}: ${r.text}`);
    }
  }
  const [terms] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, propertyId));
  assert.equal(terms, undefined, "no cross-brokerage write happened");
});

// ---------------------------------------------------------------- proposals
test("proposals: Grow-only, Run and bundle may create, edit, save, resume and send; unsubscribed 403; cross-brokerage 404", async () => {
  const other = await tenant("prop-other"); await finalise(other);
  const op = await propertyWithSeller(other.admin.cookie, "PropOther");
  const oa = await call(other.admin.cookie, "POST", "/grow/appraisals/from-contact", { partyId: op.partyId, propertyId: op.propertyId });
  assert.ok(oa.status === 200 || oa.status === 201, oa.text);
  const otherAppraisal = (oa.json.appraisal ?? oa.json).id as number;

  for (const persona of ["GrowOnly", "Run", "Bundle"] as Persona[]) {
    const t = await tenant(`prop-${persona}`, PERSONAS[persona]);
    const own = await propertyWithSeller(t.agent.cookie, `Prop${persona}`);
    await finalise(t);
    const c = await call(t.agent.cookie, "POST", "/grow/appraisals/from-contact", { partyId: own.partyId, propertyId: own.propertyId });
    assert.ok(c.status === 200 || c.status === 201, `${persona} create ${c.status} ${c.text}`);
    const id = (c.json.appraisal ?? c.json).id as number;
    const e = await call(t.agent.cookie, "PATCH", `/grow/appraisals/${id}`, { marketingProposal: "Campaign plan", sellingStrategy: "Auction", commissionRatePercent: "2.2", commissionProposal: "2.2% incl. GST" });
    assert.equal(e.status, 200, `${persona} edit ${e.text}`);
    const g = await call(t.agent.cookie, "GET", `/grow/appraisals/${id}`);
    assert.equal(g.status, 200, `${persona} resume`);
    const s = await call(t.agent.cookie, "POST", `/grow/appraisals/${id}/send`, { subject: "Your proposal", bodyText: "Attached." });
    // Send may still be refused by the consent rule (409 CONSENT_REQUIRED); permission must not refuse it.
    assert.ok(s.status < 300 || (s.status === 409 && s.json?.code === "CONSENT_REQUIRED"), `${persona} send ${s.status} ${s.text}`);
    for (const u of [t.admin, t.agent, t.pitCrew]) {
      assert.equal((await call(u.cookie, "GET", `/grow/appraisals/${otherAppraisal}`)).status, 404, `${persona} cross-brokerage proposal`);
      assert.equal((await call(u.cookie, "PATCH", `/grow/appraisals/${otherAppraisal}`, { marketingProposal: "x" })).status, 404, `${persona} cross-brokerage edit`);
    }
  }
  const u = await tenant("prop-unsub", PERSONAS.Unsubscribed);
  const up = await propertyWithSeller(u.admin.cookie, "PropUnsub");
  await finalise(u);
  assert.equal((await call(u.admin.cookie, "POST", "/grow/appraisals/from-contact", { partyId: up.partyId, propertyId: up.propertyId })).status, 403);
  assert.equal((await call(u.admin.cookie, "GET", `/appraisals/by-property/${up.propertyId}`)).status, 403, "Run appraisal route needs a subscription too");
  assert.equal((await call(u.admin.cookie, "POST", `/appraisals/by-property/${up.propertyId}/start`, {})).status, 403);
});

test("proposal payloads carrying agency-agreement fields are rejected (400) and nothing is written", async () => {
  const t = await tenant("payload", PERSONAS.Run); await finalise(t);
  const own = await propertyWithSeller(t.admin.cookie, "Payload");
  const c = await call(t.admin.cookie, "POST", "/grow/appraisals/from-contact", { partyId: own.partyId, propertyId: own.propertyId, agencyAgreementTerms: TERMS });
  assert.equal(c.status, 400, c.text);
  assert.equal(c.json.code, "AGENCY_AGREEMENT_NOT_IN_PROPOSAL");
  const ok = await call(t.admin.cookie, "POST", "/grow/appraisals/from-contact", { partyId: own.partyId, propertyId: own.propertyId });
  const id = (ok.json.appraisal ?? ok.json).id as number;
  for (const [m, p, body] of [
    ["PATCH", `/grow/appraisals/${id}`, { marketingProposal: "x", commissionType: "Percentage", commissionRateBps: 220 }],
    ["PATCH", `/grow/appraisals/${id}`, { agreementTermDays: 90 }],
    ["POST", `/grow/appraisals/${id}/send`, { subject: "s", sendForSignature: true }],
    ["POST", `/grow/appraisals/${id}/outcome`, { outcome: "WON", agencyAgreement: { sign: true } }],
    ["POST", `/appraisals/by-property/${own.propertyId}`, { flatFeeCents: 100 }],
  ] as const) {
    const r = await call(t.admin.cookie, m, p, body);
    assert.equal(r.status, 400, `${m} ${p}: ${r.text}`);
    assert.equal(r.json.code, "AGENCY_AGREEMENT_NOT_IN_PROPOSAL", p);
  }
  const [terms] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, own.propertyId));
  assert.equal(terms, undefined);
});

test("proposal submit and acceptance (send, outcome WON) create no agreement, no package, no launch plan and no Pit Crew work", async () => {
  const t = await tenant("nosidefx", PERSONAS.Run); await finalise(t);
  const own = await propertyWithSeller(t.admin.cookie, "NoSideFx");
  const c = await call(t.admin.cookie, "POST", "/grow/appraisals/from-contact", { partyId: own.partyId, propertyId: own.propertyId });
  const id = (c.json.appraisal ?? c.json).id as number;
  const sent = await call(t.admin.cookie, "POST", `/grow/appraisals/${id}/send`, { subject: "s", bodyText: "b" });
  assert.ok(sent.status < 300 || (sent.status === 409 && sent.json?.code === "CONSENT_REQUIRED"), sent.text);
  // Walk the proposal to an accepted state through the real lifecycle: DRAFT -> APPOINTMENT_SCHEDULED -> PRESENTED -> WON.
  for (const toStatus of ["APPOINTMENT_SCHEDULED", "PRESENTED"]) {
    const st = await call(t.admin.cookie, "POST", `/grow/appraisals/${id}/status`, { toStatus });
    assert.ok(st.status < 300, `${toStatus}: ${st.text}`);
  }
  const w = await call(t.admin.cookie, "POST", `/grow/appraisals/${id}/outcome`, { outcome: "WON" });
  assert.ok(w.status < 300, w.text);
  const pid = own.propertyId;
  assert.equal((await db.select().from(documentPackages).where(eq(documentPackages.propertyId, pid))).length, 0, "no package");
  assert.equal((await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, pid))).length, 0, "no terms");
  assert.equal((await db.select().from(launchPlans).where(eq(launchPlans.propertyId, pid))).length, 0, "no launch plan");
  assert.equal((await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.propertyId, pid))).length, 0, "no Pit Crew work");
  const ev = await db.select({ t: domainEvents.eventType }).from(domainEvents).where(eq(domainEvents.propertyId, pid));
  assert.ok(!ev.some((e) => e.t.startsWith("AGENCY_AGREEMENT")), JSON.stringify(ev));
});

test("Pit Crew activation gate: no launch plan after send-for-signature; created only once the agreement is fully signed (with an accepted proposal, t223u)", async () => {
  const t = await tenant("gate", PERSONAS.Run); await finalise(t);
  const own = await propertyWithSeller(t.admin.cookie, "Gate");
  await recordAcceptedProposalFixture(own.propertyId, own.partyId); // t223u: activation also needs an accepted proposal
  const pkg = await readyPackage(t.admin.cookie, own.propertyId);
  assert.equal((await call(t.admin.cookie, "PUT", `/documents/agency-agreement-terms/${own.propertyId}`, TERMS)).status, 200);
  assert.equal((await call(t.admin.cookie, "POST", `/documents/packages/${pkg}/populate`)).status, 200);
  const sent = await call(t.admin.cookie, "POST", `/documents/packages/${pkg}/send-for-signature`);
  assert.equal(sent.status, 201);
  const plans = () => db.select().from(launchPlans).where(eq(launchPlans.propertyId, own.propertyId));
  assert.equal((await plans()).length, 0, "sent but unsigned: no launch plan");
  const docs = await call(t.admin.cookie, "GET", `/documents/packages/by-property/${own.propertyId}`);
  const body = JSON.stringify({
    providerReference: sent.json.signatureRequest.providerReference, status: "Completed",
    completedDocuments: (docs.json.documents as Array<{ id: number; title: string }>).map((d) => ({ documentId: d.id, contentBase64: Buffer.from("signed").toString("base64"), filename: `d${d.id}.txt`, contentType: "text/plain" })),
  });
  const wh = await fetch(`${baseUrl}/api/documents/webhook`, { method: "POST", headers: signedSandboxEsignWebhookHeaders(body), body });
  assert.equal(wh.status, 200, await wh.text());
  for (let i = 0; i < 40 && (await plans()).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await plans()).length, 1, "fully signed: launch plan proposed");
  const ev = await db.select({ t: domainEvents.eventType }).from(domainEvents).where(and(eq(domainEvents.propertyId, own.propertyId), eq(domainEvents.eventType, "AGENCY_AGREEMENT_SIGNED")));
  assert.ok(ev.length >= 1);
});
