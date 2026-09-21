// AE GROW Completion W3-A (A-6) — Contact 360's contactability read model.
//
// WHAT THIS SUITE IS ACTUALLY PROVING. The F2 consent/DNC engine has been
// complete and, since PR #52, writable over HTTP — but GET
// /grow/contacts/:partyId returned nothing about it at all. `grep -ni
// "consent|dncr|suppress|contactab" apps/api/src/routes/contacts.ts` matched
// zero lines. Contact 360 is the one screen an agent opens before reaching
// out to someone, and it could not say whether reaching out was permitted.
//
// THE LOAD-BEARING TEST is "N reads add zero grow_consent_decisions rows and
// never take the consent advisory lock". There is an existing defect of
// exactly that shape elsewhere: GET /grow/calls/contacts/:partyId/eligibility
// calls the MUTATING evaluator, so every poll of that endpoint locks the
// brokerage and appends an enforcement-decision row. This slice adds a read
// over the same engine, so the one thing worth proving beyond "the fields are
// there" is that it did not reproduce that. It is asserted three ways: row
// counts before/after, a process-wide statement observer over the actual SQL
// the route issued, and a real exclusive hold of the consent advisory lock on
// a separate connection while the read runs.
//
// THE SECOND THING WORTH PROVING is that the pilot state is reported HONESTLY.
// No consent policy row is approved — timeZone and the allowed/quiet hours are
// deliberately null pending AU/NZ legal sign-off — so the evaluator returns
// REVIEW_REQUIRED for essentially everything and PHONE_CALL can never be
// ELIGIBLE in AU/NZ today. The assertions below pin that answer rather than
// working around it, including the reason codes that let the screen explain
// WHY a channel is unavailable.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  entitlementGrants,
  growConsentDecisions,
  growContactChannelConsents,
  growContactChannelSuppressions,
  growContactDncrStatuses,
  setDbQueryObserver,
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
/** A: fully entitled. */
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
/** B: a separate tenant, used for the cross-tenant check. */
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
/** C: has Grow, but deliberately NOT grow.contacts.read. */
let C: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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

  A = await createBrokerageWithUsers(baseUrl, `W3A Contactability A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `W3A Contactability B ${suffix}`);
  C = await createBrokerageWithUsers(baseUrl, `W3A Contactability C ${suffix}`);

  for (const brokerageId of [A.brokerageId, B.brokerageId]) {
    await grant(brokerageId, "grow.access");
    await grant(brokerageId, "grow.contacts.read");
    await grant(brokerageId, "grow.contacts.manage");
    await grant(brokerageId, "grow.admin.configure");
  }
  // C gets Grow itself and the WRITE key, but never the read key — so a 403
  // below cannot be explained away as "that tenant has no Grow at all".
  await grant(C.brokerageId, "grow.access");
  await grant(C.brokerageId, "grow.contacts.manage");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId, C?.brokerageId]);
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

async function get(cookie: string, path: string) {
  const res = await fetch(api(path), { headers: { cookie } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function post(cookie: string, path: string, body: unknown) {
  const res = await fetch(api(path), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function freshContact(cookie: string, label: string) {
  const property = await post(cookie, "/properties", {
    formattedAddress: `${label} ${Math.random().toString(36).slice(2, 8)} St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  if (property.status !== 201) throw new Error(`create property failed: ${property.status} ${JSON.stringify(property.body)}`);
  const party = await post(cookie, "/parties", {
    propertyId: property.body.property.id,
    role: "Buyer",
    firstName: "Contactability",
    lastName: label,
  });
  if (party.status !== 201) throw new Error(`create party failed: ${party.status} ${JSON.stringify(party.body)}`);
  return party.body.party.id as number;
}

/* =====================================================================
 * 1. The payload, for a contact with NO consent data at all.
 * ===================================================================*/

test("Contact 360 reports contactability for a contact with no consent data: every channel UNKNOWN, nothing suppressed, and the pilot's REVIEW_REQUIRED explained", async () => {
  const partyId = await freshContact(A.agent.cookie, "Blank");

  const res = await get(A.agent.cookie, `/grow/contacts/${partyId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const contactability = res.body.contactability;
  assert.ok(contactability, "Contact 360 must carry a contactability block");

  // Nothing recorded — distinct from "recorded and unknown".
  assert.equal(contactability.hasConsentRecords, false);
  assert.deepEqual(contactability.history, []);
  assert.equal(contactability.historyTruncated, false);
  assert.deepEqual(contactability.activeSuppressions, []);

  // No policy version is approved for this brokerage, which is the pilot
  // state. The block says so rather than inventing one.
  assert.deepEqual(contactability.policies, []);
  assert.equal(contactability.awaitingPolicyApproval, true);

  // Fail-closed, and explained: REVIEW_REQUIRED because nothing is on file —
  // never ELIGIBLE, and never a bare failure.
  assert.equal(contactability.status, "REVIEW_REQUIRED");
  assert.equal(contactability.statusReasonCode, "UNKNOWN_CONSENT");

  assert.equal(contactability.channels.length, GROW_CONSENT_CHANNELS.length);
  assert.deepEqual(
    contactability.channels.map((c: any) => c.channel),
    [...GROW_CONSENT_CHANNELS],
  );
  for (const channel of contactability.channels) {
    assert.equal(channel.consentState, "UNKNOWN", `${channel.channel} consent state`);
    assert.equal(channel.consent, null);
    assert.deepEqual(channel.streams, []);
    assert.equal(channel.dncrStatus, "NOT_CHECKED", `${channel.channel} DNCR status`);
    assert.equal(channel.dncr, null);
    assert.equal(channel.suppressed, false);
    assert.equal(channel.suppression, null);
    assert.equal(channel.status, "REVIEW_REQUIRED");
    assert.equal(channel.reasonCode, "UNKNOWN_CONSENT");
    assert.equal(channel.lastRecordedDecision, null, "a contact nobody has tried to reach has no recorded decision");
    // The decision carried by a READ is explicitly not a recorded one.
    assert.equal(channel.decision.recorded, false);
    assert.equal(channel.decision.decision, "REVIEW_REQUIRED");
    assert.equal(channel.decision.reasonCode, "UNKNOWN_CONSENT");
    assert.equal(channel.decision.jurisdiction, null);
    assert.equal(channel.decision.policyVersion, null);
    // No stream exists, so the (purpose, scope) shown is a label only and the
    // payload says as much rather than implying a real consent stream.
    assert.equal(channel.decision.streamRecorded, false);
    assert.equal(typeof channel.decision.purpose, "string");
    assert.equal(typeof channel.decision.scope, "string");
  }

  // PHONE_CALL is evaluated against the SAME canonical stream the outbound
  // call boundary uses (lib/telephony/eligibility.ts), so the reason this
  // screen shows is the reason a call attempt would hit.
  const phone = contactability.channels.find((c: any) => c.channel === "PHONE_CALL");
  assert.equal(phone.decision.purpose, "PHONE_CALL");
  assert.equal(phone.decision.scope, "OUTBOUND");
  assert.notEqual(phone.status, "ELIGIBLE", "PHONE_CALL must never read as eligible while DNCR washing is unavailable");
});

/* =====================================================================
 * 2. The payload, for a fully suppressed contact.
 * ===================================================================*/

test("a contact suppressed on every channel reports BLOCKED with the suppression as the reason, and the suppressions are listed", async () => {
  const partyId = await freshContact(A.agent.cookie, "Suppressed");

  for (const channel of GROW_CONSENT_CHANNELS) {
    const res = await post(A.agent.cookie, `/grow/contacts/${partyId}/suppression`, {
      channel,
      state: "SUPPRESSED",
      reason: `Contact asked not to be reached on ${channel}.`,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  const res = await get(A.agent.cookie, `/grow/contacts/${partyId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const contactability = res.body.contactability;

  assert.equal(contactability.status, "BLOCKED");
  assert.equal(contactability.statusReasonCode, "SUPPRESSED");
  assert.equal(contactability.hasConsentRecords, true);
  assert.equal(contactability.activeSuppressions.length, GROW_CONSENT_CHANNELS.length);

  for (const channel of contactability.channels) {
    assert.equal(channel.suppressed, true, `${channel.channel} must be suppressed`);
    assert.equal(channel.status, "BLOCKED");
    assert.equal(channel.reasonCode, "SUPPRESSED");
    assert.equal(channel.suppression.state, "SUPPRESSED");
    assert.equal(channel.suppression.active, true);
    assert.equal(channel.suppression.reason, `Contact asked not to be reached on ${channel.channel}.`);
    // The underlying evaluator still exits at its OWN first failing gate — with
    // no consent on file that is UNKNOWN_CONSENT, well before its suppression
    // gate. Surfacing only that would hide a recorded do-not-contact from the
    // reader, which is why the channel status folds the suppression in. Both
    // are reported; neither is invented.
    assert.equal(channel.decision.reasonCode, "UNKNOWN_CONSENT");
  }

  // Append-only: the suppressions are in the audit history, newest first, with
  // the actor who recorded each one.
  const suppressionHistory = contactability.history.filter((h: any) => h.kind === "SUPPRESSION");
  assert.equal(suppressionHistory.length, GROW_CONSENT_CHANNELS.length);
  for (const entry of suppressionHistory) assert.equal(entry.recordedByUserId, A.agent.user.id);
});

/* =====================================================================
 * 3. Withdrawal, evidence and append-only history.
 * ===================================================================*/

test("consent capture and withdrawal are both visible: the head state, the evidence reference, the withdrawal reason, and the superseded row that is still in history", async () => {
  const partyId = await freshContact(A.agent.cookie, "Withdrawn");

  const captured = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    channel: "EMAIL",
    state: "EXPRESS",
    source: "Signed appraisal authority",
    captureMethod: "WRITTEN",
    purpose: "MARKETING",
    scope: "BROKERAGE",
    jurisdiction: "AU",
    evidenceReference: "appraisal-authority-4471",
  });
  assert.equal(captured.status, 201, JSON.stringify(captured.body));

  const afterCapture = await get(A.agent.cookie, `/grow/contacts/${partyId}`);
  const emailAfterCapture = afterCapture.body.contactability.channels.find((c: any) => c.channel === "EMAIL");
  assert.equal(emailAfterCapture.consentState, "EXPRESS");
  assert.equal(emailAfterCapture.consent.evidenceReference, "appraisal-authority-4471");
  assert.equal(emailAfterCapture.consent.purpose, "MARKETING");
  assert.equal(emailAfterCapture.consent.scope, "BROKERAGE");
  assert.equal(emailAfterCapture.decision.streamRecorded, true);
  assert.equal(emailAfterCapture.decision.purpose, "MARKETING");
  // EXPRESS consent on file and STILL not eligible, because no approved policy
  // defines a calling window. That is the correct pilot answer and the reason
  // code says exactly which input is missing.
  assert.equal(emailAfterCapture.status, "REVIEW_REQUIRED");
  assert.equal(emailAfterCapture.reasonCode, "POLICY_NOT_FOUND");

  const withdrawn = await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    channel: "EMAIL",
    state: "WITHDRAWN",
    source: "Inbound phone request",
    captureMethod: "VERBAL",
    purpose: "MARKETING",
    scope: "BROKERAGE",
    jurisdiction: "AU",
    withdrawnAt: new Date().toISOString(),
    withdrawalReason: "Asked to be removed from all marketing email.",
    supersedesConsentId: captured.body.consent.id,
  });
  assert.equal(withdrawn.status, 201, JSON.stringify(withdrawn.body));

  const res = await get(A.agent.cookie, `/grow/contacts/${partyId}`);
  const contactability = res.body.contactability;
  const email = contactability.channels.find((c: any) => c.channel === "EMAIL");

  assert.equal(email.consentState, "WITHDRAWN");
  assert.equal(email.consent.withdrawalReason, "Asked to be removed from all marketing email.");
  assert.equal(email.consent.withdrawnByUserId, A.agent.user.id);
  assert.equal(email.consent.supersedesConsentId, captured.body.consent.id);
  assert.equal(email.status, "BLOCKED");
  assert.equal(email.reasonCode, "WITHDRAWN");

  // The model is append-only: the superseded EXPRESS row is still there, and
  // the head is one of exactly two rows rather than an edited record.
  const consentHistory = contactability.history.filter((h: any) => h.kind === "CONSENT");
  assert.equal(consentHistory.length, 2);
  assert.deepEqual(
    consentHistory.map((h: any) => h.state),
    ["WITHDRAWN", "EXPRESS"],
    "history is newest first and still contains the superseded row",
  );
  // Only the head is the channel's current state; both remain auditable.
  assert.equal(email.streams.length, 1);
  assert.equal(email.streams[0].consentId, withdrawn.body.consent.id);
});

/* =====================================================================
 * 4. The load-bearing test — this read writes nothing.
 * ===================================================================*/

test("N reads of Contact 360 append zero grow_consent_decisions rows, issue no consent INSERT, and never take the consent advisory lock", async () => {
  const partyId = await freshContact(A.agent.cookie, "NonMutating");
  // Give the read something real to resolve, so it exercises every lookup
  // rather than short-circuiting on an empty contact.
  await post(A.agent.cookie, `/grow/contacts/${partyId}/consent`, {
    channel: "SMS",
    state: "EXPRESS",
    source: "Web form",
    captureMethod: "DIGITAL",
    purpose: "MARKETING",
    scope: "BROKERAGE",
    jurisdiction: "AU",
  });
  await post(A.agent.cookie, `/grow/contacts/${partyId}/dncr`, {
    channel: "PHONE_CALL",
    status: "LISTED",
    source: "Manual register check",
    jurisdiction: "AU",
  });

  const countRows = async () => {
    const [decisions] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(growConsentDecisions)
      .where(eq(growConsentDecisions.brokerageId, A.brokerageId));
    const [consents] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(growContactChannelConsents)
      .where(eq(growContactChannelConsents.brokerageId, A.brokerageId));
    const [dncr] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(growContactDncrStatuses)
      .where(eq(growContactDncrStatuses.brokerageId, A.brokerageId));
    const [suppressions] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(growContactChannelSuppressions)
      .where(eq(growContactChannelSuppressions.brokerageId, A.brokerageId));
    return { decisions: decisions.n, consents: consents.n, dncr: dncr.n, suppressions: suppressions.n };
  };

  const before = await countRows();

  // Every statement the route actually issues, captured from the shared pool
  // this in-process server uses.
  const statements: string[] = [];
  const uninstall = setDbQueryObserver((query) => statements.push(query));
  try {
    for (let i = 0; i < 5; i++) {
      const res = await get(A.agent.cookie, `/grow/contacts/${partyId}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  } finally {
    uninstall();
  }

  const after = await countRows();
  assert.deepEqual(after, before, "five Contact 360 reads must not write a single consent-control row");
  assert.equal(after.decisions, 0, "no enforcement decision may be manufactured by a read");

  const lowered = statements.map((s) => s.toLowerCase());
  assert.ok(statements.length > 0, "the observer must actually have seen the route's statements");
  assert.ok(
    lowered.some((s) => s.includes("grow_contact_channel_consents")),
    "the observer must have seen the contactability lookups themselves",
  );
  assert.equal(
    lowered.filter((s) => s.includes("pg_advisory")).length,
    0,
    "a read must not take the consent brokerage advisory lock",
  );
  const writesTouchingConsent = lowered.filter(
    (s) =>
      (s.includes("insert into") || s.startsWith("update ") || s.includes("delete from")) &&
      (s.includes("grow_consent_decisions") ||
        s.includes("grow_contact_channel_consents") ||
        s.includes("grow_contact_dncr_statuses") ||
        s.includes("grow_contact_channel_suppressions") ||
        s.includes("grow_consent_policy_versions") ||
        s.includes("audit_logs")),
  );
  assert.deepEqual(writesTouchingConsent, [], "a read must issue no write against the consent model or its audit trail");

  // Independent proof, not inference: hold the consent advisory lock
  // EXCLUSIVELY on a separate connection and show the read still completes.
  // If the endpoint took that lock it would block until this transaction ends.
  const CONSENT_ADVISORY_LOCK_NAMESPACE = 2076418031;
  const holder = await pool.connect();
  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock($1, $2)", [CONSENT_ADVISORY_LOCK_NAMESPACE, A.brokerageId]);
    const outcome = await Promise.race([
      get(A.agent.cookie, `/grow/contacts/${partyId}`).then((r) => r.status),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 15_000)),
    ]);
    assert.equal(outcome, 200, "Contact 360 must read straight through a held consent advisory lock");
  } finally {
    await holder.query("rollback").catch(() => {});
    holder.release();
  }
});

/* =====================================================================
 * 5. Entitlement and tenancy.
 * ===================================================================*/

test("contactability is gated on grow.contacts.read and is tenant-isolated", async () => {
  const partyA = await freshContact(A.agent.cookie, "Tenancy");

  // A tenant with Grow and even the WRITE key, but not grow.contacts.read,
  // cannot read the block — the gate is the read key, not Grow access.
  const partyC = await freshContact(C.agent.cookie, "NoReadKey");
  const denied = await get(C.agent.cookie, `/grow/contacts/${partyC}`);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  // A fully entitled user in ANOTHER tenant cannot reach A's contact at all,
  // and gets the same 404 a non-existent id would produce — a foreign-tenant
  // id must not be distinguishable from a missing one.
  const foreign = await get(B.agent.cookie, `/grow/contacts/${partyA}`);
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  assert.equal(foreign.body.contactability, undefined);

  // And nothing recorded in B ever appears on A's contact: the block is built
  // from brokerage-scoped queries only.
  const own = await get(A.agent.cookie, `/grow/contacts/${partyA}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.contactability.hasConsentRecords, false);
  const rowsForOtherTenant = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(growContactChannelConsents)
    .where(and(eq(growContactChannelConsents.brokerageId, B.brokerageId), eq(growContactChannelConsents.partyId, partyA)));
  assert.equal(rowsForOtherTenant[0].n, 0);
});
