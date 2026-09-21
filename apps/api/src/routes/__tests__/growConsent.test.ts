// AE GROW Priority 6 Stage F2 step 2 — route-level HTTP coverage for
// routes/growConsent.ts.
//
// WHAT THIS SUITE IS ACTUALLY PROVING. Before this router existed, every
// state writer in lib/consentControlsPersistence.ts had exactly zero non-test
// callers: no route imported it, no script imported it, no scheduled job
// called it. Consent and DNC state could only be set BY A TEST, which made
// AE's Do Not Contact control fully implemented and fully inert — the reader
// side (lib/propertyIntelligence/contactability.ts, evaluateConsentDecision)
// interrogated tables nothing in production could populate.
//
// So the assertions below are deliberately end-to-end over real HTTP, the
// real session cookie, the real entitlement middleware and real Postgres —
// the same technique growToday.test.ts and growCalls.test.ts use. A test that
// called the library directly would prove nothing about the gap this slice
// closes.
//
// THE LOAD-BEARING TEST is "a suppression written through the route is
// observed by contactability on the very next Grow Today read". That single
// assertion is the difference between a control that exists and a control
// that works: it starts from an ordinary Grow Today card with a live email
// affordance, writes a suppression over HTTP, and shows the same card come
// back on the next read as do_not_contact with the contact's email and mobile
// stripped out of the response body.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  entitlementGrants,
  growContactChannelConsents,
  growContactChannelSuppressions,
  growContactDncrStatuses,
  GROW_CONSENT_CHANNELS,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Grow Consent A ${suffix}`;
const brokerageBName = `Grow Consent B ${suffix}`;
/** A: fully entitled (contacts.read + contacts.manage + admin.configure + grow.access). */
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
/** B: a separate tenant, entitled the same way, used for cross-tenant checks. */
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);

  for (const brokerageId of [A.brokerageId, B.brokerageId]) {
    await grant(brokerageId, "grow.access");
    await grant(brokerageId, "grow.contacts.read");
    await grant(brokerageId, "grow.contacts.manage");
    await grant(brokerageId, "grow.admin.configure");
    await grant(brokerageId, "grow.opportunities.manage");
  }
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

function api(path: string) {
  return `${baseUrl}/api${path}`;
}

async function post(cookie: string, path: string, body: unknown) {
  const res = await fetch(api(path), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function get(cookie: string, path: string) {
  const res = await fetch(api(path), { headers: { cookie } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function createProperty(cookie: string, address: string) {
  const res = await fetch(api("/properties"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}) {
  const res = await fetch(api("/parties"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

/** A fresh property + contact inside brokerage A, which most tests below need one of. */
async function freshContact(label: string, overrides: Record<string, unknown> = {}) {
  const propertyId = await createProperty(A.agent.cookie, `${label} ${Math.random().toString(36).slice(2, 8)} St`);
  const partyId = await createParty(A.agent.cookie, propertyId, overrides);
  return { propertyId, partyId };
}

const EXPRESS_CONSENT = {
  channel: "EMAIL",
  state: "EXPRESS",
  source: "Signed appraisal authority",
  captureMethod: "WRITTEN",
  purpose: "MARKETING",
  scope: "BROKERAGE",
  jurisdiction: "AU",
} as const;

/* =====================================================================
 * 1. Reachability — the finding itself.
 * ===================================================================*/

test("all four F2 state writers are reachable over HTTP and actually write their own table", async () => {
  const { partyId } = await freshContact("1 Reachable");

  const consent = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, EXPRESS_CONSENT);
  assert.equal(consent.status, 201, JSON.stringify(consent.body));
  assert.equal(consent.body.consent.state, "EXPRESS");
  assert.equal(consent.body.consent.brokerageId, A.brokerageId);
  // recordedByUserId comes from the SESSION, never from the body.
  assert.equal(consent.body.consent.recordedByUserId, A.agent.user.id);

  const dncr = await post(A.agent.cookie, `/grow/contacts/${partyId}/dncr`, {
    channel: "PHONE_CALL",
    status: "LISTED",
    source: "Manual register check",
    jurisdiction: "AU",
  });
  assert.equal(dncr.status, 201, JSON.stringify(dncr.body));
  assert.equal(dncr.body.dncrStatus.status, "LISTED");

  const suppression = await post(A.agent.cookie, `/grow/contacts/${partyId}/suppression`, {
    channel: "SMS",
    state: "SUPPRESSED",
    reason: "Contact asked not to be texted.",
  });
  assert.equal(suppression.status, 201, JSON.stringify(suppression.body));
  assert.equal(suppression.body.suppression.state, "SUPPRESSED");

  const policy = await post(A.admin.cookie, "/grow/consent/policies", {
    jurisdiction: "AU",
    version: `route-reachability-${suffix}`,
    effectiveAt: new Date().toISOString(),
    dncrRequired: true,
  });
  assert.equal(policy.status, 201, JSON.stringify(policy.body));
  assert.equal(policy.body.policyVersion.jurisdiction, "AU");

  // Each row really is in its own table, scoped to this brokerage.
  const consentRows = await db
    .select()
    .from(growContactChannelConsents)
    .where(and(eq(growContactChannelConsents.brokerageId, A.brokerageId), eq(growContactChannelConsents.partyId, partyId)));
  assert.equal(consentRows.length, 1);
  const dncrRows = await db
    .select()
    .from(growContactDncrStatuses)
    .where(and(eq(growContactDncrStatuses.brokerageId, A.brokerageId), eq(growContactDncrStatuses.partyId, partyId)));
  assert.equal(dncrRows.length, 1);
  const suppressionRows = await db
    .select()
    .from(growContactChannelSuppressions)
    .where(
      and(
        eq(growContactChannelSuppressions.brokerageId, A.brokerageId),
        eq(growContactChannelSuppressions.partyId, partyId),
      ),
    );
  assert.equal(suppressionRows.length, 1);
});

/* =====================================================================
 * 2. THE LOAD-BEARING PROOF — a suppression written over HTTP is observed
 *    by lib/propertyIntelligence/contactability.ts on the next Grow Today
 *    read. This is what makes the Do Not Contact control non-inert.
 * ===================================================================*/

test("a suppression written through the route is observed by contactability on the NEXT Grow Today read", async () => {
  const propertyId = await createProperty(A.agent.cookie, `2 Suppression Proof ${suffix} St`);
  const partyId = await createParty(A.agent.cookie, propertyId, {
    firstName: "Sunny",
    lastName: "Suppressed",
    email: `sunny-${suffix}@example.com`,
    mobile: "0412345678",
  });

  // An ordinary agent commitment, so this contact has a Grow Today card at all.
  const opportunityRes = await post(A.agent.cookie, "/grow/opportunities", {
    partyId,
    propertyId,
    opportunityType: "Listing",
    reason: "Expressed interest in selling.",
  });
  assert.equal(opportunityRes.status, 201, JSON.stringify(opportunityRes.body));
  const opportunityId = opportunityRes.body.opportunity.id as number;
  const overdue = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const patchRes = await fetch(api(`/grow/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: overdue.toISOString(), recommendedNextAction: "Call Sunny back." }),
  });
  assert.equal(patchRes.status, 200);

  // BEFORE — a normal, contactable card with live outreach affordances.
  const before_ = await get(A.agent.cookie, "/grow/today");
  assert.equal(before_.status, 200);
  const cardBefore = before_.body.priorityActions.find((a: any) => a.id === `opportunity:${opportunityId}`);
  assert.ok(cardBefore, "the opportunity must surface on Today before any suppression");
  assert.equal(cardBefore.contactability, "contactable");
  assert.equal(cardBefore.contactEmail, `sunny-${suffix}@example.com`);
  assert.equal(cardBefore.contactMobile, "0412345678");
  assert.ok(
    cardBefore.availableActions.some((x: any) => x.action === "email"),
    "an email affordance must be offered before suppression",
  );
  assert.equal(cardBefore.contactabilityNote, null);

  // THE WRITE — over real HTTP, through requireEntitlement, into the real
  // table, with no test-only helper anywhere in the path. contactability.ts
  // withholds a contact only when EVERY channel is suppressed (a partial
  // suppression deliberately still shows the card), so suppress all of them
  // exactly as an operator would have to.
  for (const channel of GROW_CONSENT_CHANNELS) {
    const res = await post(A.agent.cookie, `/grow/contacts/${partyId}/suppression`, {
      channel,
      state: "SUPPRESSED",
      reason: "Contact asked to be removed from all outreach.",
    });
    assert.equal(res.status, 201, `suppressing ${channel}: ${JSON.stringify(res.body)}`);
  }

  // AFTER — the very next read, no sweep, no job, no restart.
  const after_ = await get(A.agent.cookie, "/grow/today");
  assert.equal(after_.status, 200);
  const cardAfter = after_.body.priorityActions.find((a: any) => a.id === `opportunity:${opportunityId}`);
  assert.ok(cardAfter, "an agent's own dated commitment is still shown — it is never silently deleted");
  assert.equal(
    cardAfter.contactability,
    "do_not_contact",
    "contactability.ts must observe a suppression written through the new route",
  );
  assert.equal(cardAfter.contactEmail, null, "the contact's email must be stripped from the response itself");
  assert.equal(cardAfter.contactMobile, null, "the contact's mobile must be stripped from the response itself");
  assert.ok(
    !cardAfter.availableActions.some((x: any) => x.action === "email" || x.action === "sms"),
    "no outreach affordance may survive a full-channel suppression",
  );
  assert.ok(cardAfter.contactabilityNote, "the surface must explain why outreach is withheld");
  assert.equal(cardAfter.rankScore, 0);

  // And a RELEASE through the same route is observed just as immediately —
  // proving the read is genuinely live rather than a one-way latch.
  for (const channel of GROW_CONSENT_CHANNELS) {
    const res = await post(A.agent.cookie, `/grow/contacts/${partyId}/suppression`, {
      channel,
      state: "RELEASED",
      reason: "Contact re-opted in during a listing appointment.",
    });
    assert.equal(res.status, 201, `releasing ${channel}: ${JSON.stringify(res.body)}`);
  }
  const released = await get(A.agent.cookie, "/grow/today");
  const cardReleased = released.body.priorityActions.find((a: any) => a.id === `opportunity:${opportunityId}`);
  assert.equal(cardReleased.contactability, "contactable");
  assert.equal(cardReleased.contactEmail, `sunny-${suffix}@example.com`);
});

test("a DNCR LISTED status written through the route is likewise observed by contactability", async () => {
  const propertyId = await createProperty(A.agent.cookie, `3 DNCR Proof ${suffix} St`);
  const partyId = await createParty(A.agent.cookie, propertyId, {
    firstName: "Derek",
    lastName: "Listed",
    email: `derek-${suffix}@example.com`,
  });
  const opportunityRes = await post(A.agent.cookie, "/grow/opportunities", {
    partyId,
    propertyId,
    opportunityType: "Listing",
    reason: "Enquired about market value.",
  });
  const opportunityId = opportunityRes.body.opportunity.id as number;
  await fetch(api(`/grow/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: new Date(Date.now() - 86_400_000).toISOString() }),
  });

  const before_ = await get(A.agent.cookie, "/grow/today");
  const cardBefore = before_.body.priorityActions.find((a: any) => a.id === `opportunity:${opportunityId}`);
  assert.equal(cardBefore.contactability, "contactable");

  // Unlike suppression, ONE channel is enough for DNCR: being on the register
  // for any channel is the conservative read (contactability.ts condition 1).
  const dncr = await post(A.agent.cookie, `/grow/contacts/${partyId}/dncr`, {
    channel: "PHONE_CALL",
    status: "LISTED",
    source: "Do Not Call Register check",
    jurisdiction: "AU",
  });
  assert.equal(dncr.status, 201, JSON.stringify(dncr.body));

  const after_ = await get(A.agent.cookie, "/grow/today");
  const cardAfter = after_.body.priorityActions.find((a: any) => a.id === `opportunity:${opportunityId}`);
  assert.equal(cardAfter.contactability, "do_not_contact");
  assert.equal(cardAfter.contactEmail, null);
});

/* =====================================================================
 * 3. Withdrawal — an append that supersedes, with the DB CHECK live.
 * ===================================================================*/

test("withdrawal through the route is an append that supersedes the head, and its metadata is enforced, not defaulted", async () => {
  const { partyId } = await freshContact("4 Withdrawal");

  const captured = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, EXPRESS_CONSENT);
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const headId = captured.body.consent.id as number;

  // A withdrawal with NO reason must be REJECTED, not silently accepted. The
  // DB CHECK grow_contact_channel_consents_withdrawal_fields_check requires
  // withdrawn_at, withdrawn_by_user_id and a non-blank withdrawal_reason; the
  // route deliberately supplies only the actor (the authenticated caller) and
  // invents neither of the other two.
  const missingReason = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    ...EXPRESS_CONSENT,
    state: "WITHDRAWN",
    withdrawnAt: new Date().toISOString(),
    supersedesConsentId: headId,
  });
  assert.equal(missingReason.status, 400, JSON.stringify(missingReason.body));
  assert.match(missingReason.body.error, /withdrawal time, actor, and reason/i);

  const missingTime = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    ...EXPRESS_CONSENT,
    state: "WITHDRAWN",
    withdrawalReason: "Asked to be removed at the open home.",
    supersedesConsentId: headId,
  });
  assert.equal(missingTime.status, 400, JSON.stringify(missingTime.body));

  // Nothing was written by either rejected attempt: the stream is still one row.
  const afterRejections = await db
    .select()
    .from(growContactChannelConsents)
    .where(and(eq(growContactChannelConsents.brokerageId, A.brokerageId), eq(growContactChannelConsents.partyId, partyId)));
  assert.equal(afterRejections.length, 1, "a rejected withdrawal must write nothing at all");

  // A complete withdrawal appends a NEW row that supersedes the head; the
  // original EXPRESS row is left exactly as it was (append-only, never mutated).
  const withdrawnAt = new Date();
  const withdrawal = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    ...EXPRESS_CONSENT,
    state: "WITHDRAWN",
    withdrawnAt: withdrawnAt.toISOString(),
    withdrawalReason: "Asked to be removed at the open home.",
    supersedesConsentId: headId,
  });
  assert.equal(withdrawal.status, 201, JSON.stringify(withdrawal.body));
  assert.equal(withdrawal.body.consent.state, "WITHDRAWN");
  assert.equal(withdrawal.body.consent.supersedesConsentId, headId);
  // The withdrawing actor is the SESSION user — never a client-supplied id.
  assert.equal(withdrawal.body.consent.withdrawnByUserId, A.agent.user.id);
  assert.notEqual(withdrawal.body.consent.id, headId);

  const rows = await db
    .select()
    .from(growContactChannelConsents)
    .where(and(eq(growContactChannelConsents.brokerageId, A.brokerageId), eq(growContactChannelConsents.partyId, partyId)))
    .orderBy(growContactChannelConsents.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "EXPRESS", "the superseded row is never mutated");
  assert.equal(rows[0].withdrawnAt, null);

  // RE-CONSENT AFTER WITHDRAWAL IS REFUSED BY THE LIBRARY AND SURFACED CLEANLY.
  // consentControlsPersistence.ts:168-170 throws; this router maps it to 409
  // rather than working around it.
  const reconsent = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    ...EXPRESS_CONSENT,
    supersedesConsentId: withdrawal.body.consent.id,
  });
  assert.equal(reconsent.status, 409, JSON.stringify(reconsent.body));
  assert.equal(reconsent.body.error, "Consent purpose/scope stream is withdrawn; step 1 does not support re-consent.");
});

test("an append that does not supersede the current head is refused with 409", async () => {
  const { partyId } = await freshContact("5 Supersede Rule");
  const first = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, EXPRESS_CONSENT);
  assert.equal(first.status, 201);

  const blind = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, EXPRESS_CONSENT);
  assert.equal(blind.status, 409, JSON.stringify(blind.body));
  assert.equal(blind.body.error, "Every append after the first consent must supersede the current purpose/scope head.");
});

test("withdrawal is scoped to one (channel, purpose, scope) stream — contact-wide withdrawal is NOT implemented", async () => {
  // Recorded as a test rather than only a comment: whether withdrawal should
  // apply contact-wide is an OPEN PROJECT OWNER DECISION. This asserts the
  // current, narrow step-1 behaviour so that a later decision to widen it is
  // a deliberate, visible change rather than an accident.
  const { partyId } = await freshContact("6 Narrow Withdrawal");

  const email = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, EXPRESS_CONSENT);
  const sms = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, { ...EXPRESS_CONSENT, channel: "SMS" });
  assert.equal(email.status, 201);
  assert.equal(sms.status, 201);

  const withdrawEmail = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    ...EXPRESS_CONSENT,
    state: "WITHDRAWN",
    withdrawnAt: new Date().toISOString(),
    withdrawalReason: "Email opt-out.",
    supersedesConsentId: email.body.consent.id,
  });
  assert.equal(withdrawEmail.status, 201);

  const read = await get(A.agent.cookie, `/grow/contacts/${partyId}/consent`);
  assert.equal(read.status, 200);
  const byChannel = new Map(read.body.consents.map((c: any) => [c.channel, c]));
  assert.equal((byChannel.get("EMAIL") as any).state, "WITHDRAWN");
  assert.equal((byChannel.get("SMS") as any).state, "EXPRESS", "withdrawing EMAIL must not touch the SMS stream");
});

/* =====================================================================
 * 4. Entitlement gating.
 * ===================================================================*/

test("every write requires grow.contacts.manage and the read requires grow.contacts.read — 403 without them", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Consent Unentitled ${suffix}`);
  try {
    // A contact inside the unentitled brokerage, created directly so the test
    // does not depend on any other route's gating.
    const propertyRes = await fetch(api("/properties"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: fresh.agent.cookie },
      body: JSON.stringify({ formattedAddress: `7 Unentitled ${suffix} St`, state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    assert.equal(propertyRes.status, 201);
    const { property } = (await propertyRes.json()) as { property: { id: number } };
    const partyRes = await fetch(api("/parties"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: fresh.agent.cookie },
      body: JSON.stringify({ propertyId: property.id, role: "Buyer", firstName: "Un", lastName: "Entitled" }),
    });
    assert.equal(partyRes.status, 201);
    const { party } = (await partyRes.json()) as { party: { id: number } };

    for (const [path, body] of [
      [`/grow/contacts/${party.id}/consent`, EXPRESS_CONSENT],
      [`/grow/contacts/${party.id}/dncr`, { channel: "PHONE_CALL", status: "LISTED", source: "check" }],
      [`/grow/contacts/${party.id}/suppression`, { channel: "SMS", state: "SUPPRESSED", reason: "asked" }],
    ] as const) {
      const res = await post(fresh.agent.cookie, path, body);
      assert.equal(res.status, 403, `${path} must be 403 without grow.contacts.manage`);
      assert.equal(res.body.entitlementKey, "grow.contacts.manage");
    }

    const read = await get(fresh.agent.cookie, `/grow/contacts/${party.id}/consent`);
    assert.equal(read.status, 403);
    assert.equal(read.body.entitlementKey, "grow.contacts.read");

    // Nothing was written by any of the refused calls.
    const rows = await db
      .select()
      .from(growContactChannelConsents)
      .where(eq(growContactChannelConsents.brokerageId, fresh.brokerageId));
    assert.equal(rows.length, 0);

    // grow.contacts.manage is NOT enough for a policy version: that is
    // brokerage-wide configuration and needs grow.admin.configure.
    await grant(fresh.brokerageId, "grow.contacts.manage");
    const policyStillRefused = await post(fresh.agent.cookie, "/grow/consent/policies", {
      jurisdiction: "AU",
      version: `unentitled-${suffix}`,
      effectiveAt: new Date().toISOString(),
      dncrRequired: true,
    });
    assert.equal(policyStillRefused.status, 403);
    assert.equal(policyStillRefused.body.entitlementKey, "grow.admin.configure");

    // ...and once it is granted, the same request succeeds.
    await grant(fresh.brokerageId, "grow.admin.configure");
    const policyAllowed = await post(fresh.agent.cookie, "/grow/consent/policies", {
      jurisdiction: "AU",
      version: `unentitled-${suffix}`,
      effectiveAt: new Date().toISOString(),
      dncrRequired: true,
    });
    assert.equal(policyAllowed.status, 201, JSON.stringify(policyAllowed.body));
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("unauthenticated requests are rejected before any gate or write", async () => {
  const consent = await fetch(api("/grow/contacts/1/consent"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(EXPRESS_CONSENT),
  });
  assert.equal(consent.status, 401);
  const read = await fetch(api("/grow/contacts/1/consent"));
  assert.equal(read.status, 401);
  const policy = await fetch(api("/grow/consent/policies"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jurisdiction: "AU", version: "x", effectiveAt: new Date().toISOString(), dncrRequired: true }),
  });
  assert.equal(policy.status, 401);
});

/* =====================================================================
 * 5. Tenancy.
 * ===================================================================*/

test("a foreign-tenant partyId is rejected and nothing is written for either tenant", async () => {
  // A real contact that genuinely exists — in brokerage B.
  const propertyId = await createProperty(B.agent.cookie, `8 Foreign Tenant ${suffix} St`);
  const foreignPartyId = await createParty(B.agent.cookie, propertyId, { firstName: "Fern", lastName: "Foreign" });

  for (const [path, body] of [
    [`/grow/contacts/${foreignPartyId}/consent`, EXPRESS_CONSENT],
    [`/grow/contacts/${foreignPartyId}/dncr`, { channel: "PHONE_CALL", status: "LISTED", source: "check" }],
    [`/grow/contacts/${foreignPartyId}/suppression`, { channel: "SMS", state: "SUPPRESSED", reason: "asked" }],
  ] as const) {
    // A's agent is FULLY entitled — so this can only be stopped by tenancy.
    const res = await post(A.agent.cookie, path, body);
    assert.equal(res.status, 404, `${path} must not be writable across tenants`);
  }
  const read = await get(A.agent.cookie, `/grow/contacts/${foreignPartyId}/consent`);
  assert.equal(read.status, 404);

  for (const table of [growContactChannelConsents, growContactDncrStatuses, growContactChannelSuppressions] as const) {
    const rows = await db.select().from(table).where(eq(table.partyId, foreignPartyId));
    assert.equal(rows.length, 0, "no row may be written against a foreign tenant's contact, under either brokerage id");
  }
});

test("a malformed contact id is a 400 answered before any query runs", async () => {
  for (const bad of ["abc", "0", "-1", "2147483648", "1.5"]) {
    const res = await post(A.agent.cookie, `/grow/contacts/${bad}/suppression`, {
      channel: "SMS",
      state: "SUPPRESSED",
      reason: "asked",
    });
    assert.equal(res.status, 400, `partyId "${bad}" must be a 400`);
    assert.equal(res.body.error, "Invalid contact id.");
  }
});

/* =====================================================================
 * 6. The evaluator with no policy row — the correct pilot posture.
 * ===================================================================*/

test("with NO consent policy row present, an eligibility evaluation returns REVIEW_REQUIRED rather than erroring", async () => {
  // A separate brokerage precisely so no policy version written by any other
  // test in this file is in scope. Nothing here seeds a policy row: AU/NZ
  // calling-hours policy is pending legal approval, and the evaluator
  // returning REVIEW_REQUIRED with the window unset is the CORRECT state.
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Consent No Policy ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.contacts.read");
    await grant(fresh.brokerageId, "grow.contacts.manage");

    const propertyRes = await fetch(api("/properties"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: fresh.agent.cookie },
      body: JSON.stringify({ formattedAddress: `9 No Policy ${suffix} St`, state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    const { property } = (await propertyRes.json()) as { property: { id: number } };
    const partyRes = await fetch(api("/parties"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: fresh.agent.cookie },
      body: JSON.stringify({ propertyId: property.id, role: "Buyer", firstName: "No", lastName: "Policy" }),
    });
    const { party } = (await partyRes.json()) as { party: { id: number } };

    // Evaluating a contact with no consent data at all still answers.
    const empty = await get(
      fresh.agent.cookie,
      `/grow/contacts/${party.id}/consent?channel=PHONE_CALL&purpose=MARKETING&scope=BROKERAGE`,
    );
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.consents, []);
    assert.ok(empty.body.evaluation, "an evaluation must be returned even with no data");
    assert.equal(empty.body.evaluation.decision, null, "a read must never manufacture a decision row");

    // And with EXPRESS consent recorded but still no policy row, the answer is
    // REVIEW_REQUIRED — not ELIGIBLE, not a 500.
    const captured = await post(fresh.agent.cookie, `/grow/contacts/${party.id}/consent`, {
      ...EXPRESS_CONSENT,
      channel: "PHONE_CALL",
    });
    assert.equal(captured.status, 201, JSON.stringify(captured.body));

    const evaluated = await get(
      fresh.agent.cookie,
      `/grow/contacts/${party.id}/consent?channel=PHONE_CALL&purpose=MARKETING&scope=BROKERAGE`,
    );
    assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
    assert.equal(evaluated.body.evaluation.evaluation.decision, "REVIEW_REQUIRED");
    assert.equal(evaluated.body.evaluation.evidence.policySnapshot, null, "no policy row may be conjured by the route");
    assert.notEqual(evaluated.body.evaluation.evaluation.decision, "ELIGIBLE");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

/* =====================================================================
 * 7. Payload rules stay enforced by the library, through the route.
 * ===================================================================*/

test("the library's own payload rules are surfaced as clean client errors, not 500s", async () => {
  const { partyId } = await freshContact("10 Payload Rules");

  // CLEARED DNCR without a supporting reference.
  const noReference = await post(A.agent.cookie, `/grow/contacts/${partyId}/dncr`, {
    channel: "PHONE_CALL",
    status: "CLEARED",
    source: "Register check",
  });
  assert.equal(noReference.status, 400, JSON.stringify(noReference.body));
  assert.equal(noReference.body.error, "CLEARED DNCR status requires a provider-neutral supporting reference.");

  // CLEARED DNCR with a reference but no validity/review window.
  const noWindow = await post(A.agent.cookie, `/grow/contacts/${partyId}/dncr`, {
    channel: "PHONE_CALL",
    status: "CLEARED",
    source: "Register check",
    reference: "REG-12345",
  });
  assert.equal(noWindow.status, 400);
  assert.equal(noWindow.body.error, "CLEARED DNCR status requires validity and review timestamps.");

  // A fully specified CLEARED check is accepted.
  const ok = await post(A.agent.cookie, `/grow/contacts/${partyId}/dncr`, {
    channel: "PHONE_CALL",
    status: "CLEARED",
    source: "Register check",
    reference: "REG-12345",
    validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    reviewAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  // INFERRED consent without its evidence bundle (DB CHECK
  // grow_contact_channel_consents_inferred_evidence_check backs this up).
  const inferred = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    ...EXPRESS_CONSENT,
    state: "INFERRED",
    purpose: "INFERRED_TEST",
  });
  assert.equal(inferred.status, 400, JSON.stringify(inferred.body));
  assert.match(inferred.body.error, /INFERRED consent requires/i);

  // NOT_REQUIRED without a justification.
  const notRequired = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    ...EXPRESS_CONSENT,
    state: "NOT_REQUIRED",
    purpose: "NOT_REQUIRED_TEST",
  });
  assert.equal(notRequired.status, 400, JSON.stringify(notRequired.body));
  assert.match(notRequired.body.error, /NOT_REQUIRED consent requires a justification/i);

  // Blank-but-present required strings are rejected by the route schema
  // before the library is reached.
  const blank = await post(A.agent.cookie, `/grow/contacts/${partyId}/suppression`, {
    channel: "SMS",
    state: "SUPPRESSED",
    reason: "   ",
  });
  assert.equal(blank.status, 400);

  // An unsupported enum value never reaches the library at all.
  const badChannel = await post(A.agent.cookie, `/grow/contacts/${partyId}/suppression`, {
    channel: "CARRIER_PIGEON",
    state: "SUPPRESSED",
    reason: "asked",
  });
  assert.equal(badChannel.status, 400);
});

test("a duplicate consent policy version is a 409, and the driver's own text never reaches the client", async () => {
  const version = `duplicate-${suffix}`;
  const first = await post(A.admin.cookie, "/grow/consent/policies", {
    jurisdiction: "NZ",
    version,
    effectiveAt: new Date().toISOString(),
    dncrRequired: true,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const second = await post(A.admin.cookie, "/grow/consent/policies", {
    jurisdiction: "NZ",
    version,
    effectiveAt: new Date().toISOString(),
    dncrRequired: true,
  });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  const text = JSON.stringify(second.body);
  assert.ok(!/select |insert |grow_consent_policy_versions|constraint/i.test(text), `internal detail leaked: ${text}`);
});

test("a policy version is recorded with its calling-hours window left unset, exactly as sent", async () => {
  const written = await post(A.admin.cookie, "/grow/consent/policies", {
    jurisdiction: "AU",
    version: `unset-window-${suffix}`,
    effectiveAt: new Date().toISOString(),
    dncrRequired: true,
  });
  assert.equal(written.status, 201, JSON.stringify(written.body));
  // Not defaulted by the transport — pending AU/NZ legal approval.
  assert.equal(written.body.policyVersion.timeZone, null);
  assert.equal(written.body.policyVersion.allowedHoursStart, null);
  assert.equal(written.body.policyVersion.allowedHoursEnd, null);
  assert.equal(written.body.policyVersion.quietHoursStart, null);
  assert.equal(written.body.policyVersion.quietHoursEnd, null);
  assert.equal(written.body.policyVersion.recordedByUserId, A.admin.user.id);
});

/* =====================================================================
 * 8. The read.
 * ===================================================================*/

test("GET returns the current head per (channel, purpose, scope) by append order, plus DNCR and in-force suppressions", async () => {
  const { partyId } = await freshContact("11 Read Surface");

  const first = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, EXPRESS_CONSENT);
  const second = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    ...EXPRESS_CONSENT,
    state: "NONE",
    source: "Verbal decline",
    captureMethod: "VERBAL",
    supersedesConsentId: first.body.consent.id,
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  await post(A.agent.cookie, `/grow/contacts/${partyId}/dncr`, {
    channel: "PHONE_CALL",
    status: "NOT_CHECKED",
    source: "Pending register check",
  });
  await post(A.agent.cookie, `/grow/contacts/${partyId}/suppression`, {
    channel: "SMS",
    state: "SUPPRESSED",
    reason: "Asked not to be texted.",
  });
  // A suppression dated in the FUTURE is not yet in force and must not read
  // as the current state — the exact divergence contactability.ts documents.
  await post(A.agent.cookie, `/grow/contacts/${partyId}/suppression`, {
    channel: "SMS",
    state: "RELEASED",
    reason: "Scheduled re-opt-in.",
    effectiveAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });

  const read = await get(A.agent.cookie, `/grow/contacts/${partyId}/consent`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.partyId, partyId);
  assert.equal(read.body.consents.length, 1, "only the head of each stream is current");
  assert.equal(read.body.consents[0].id, second.body.consent.id);
  assert.equal(read.body.consents[0].state, "NONE");
  assert.equal(read.body.dncrStatuses.length, 1);
  assert.equal(read.body.dncrStatuses[0].status, "NOT_CHECKED");
  assert.equal(read.body.suppressions.length, 1);
  assert.equal(read.body.suppressions[0].state, "SUPPRESSED", "a future-dated RELEASED row is not yet in force");
  assert.equal(read.body.evaluation, null, "no evaluation without channel+purpose+scope");
});

test("the read refuses a partial channel/purpose/scope triple rather than guessing", async () => {
  const { partyId } = await freshContact("12 Partial Query");
  const res = await get(A.agent.cookie, `/grow/contacts/${partyId}/consent?channel=EMAIL`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /must be supplied together/i);
});
