// GP-4 — fail-closed consent on every A-8 email/SMS send, including the
// appraisal (AI-draft) path. Lookups that miss, come back unknown, or throw
// refuse before the message is queued. The audit row records ids and the
// reason only.

import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  auditLogs,
  communicationConsent,
  communicationDeliveryAttempts,
  communicationMessages,
  entitlementGrants,
  growContactChannelConsents,
  growContactDncrStatuses,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { normalizeDestination } from "../../lib/communications/consent.js";
import {
  OUTBOUND_CONSENT_REQUIRED_MESSAGE,
  OUTBOUND_DNC_BLOCKED_MESSAGE,
  outboundConsentReads,
} from "../../lib/communications/outboundConsent.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let agent: DevLoginResult;
let brokerageId: number;
let otherAgent: DevLoginResult;
let otherBrokerageId: number;
let phoneSeq = 0;

function authHeaders(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function jsonOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
}

async function grant(targetBrokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId: targetBrokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: targetBrokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(targetBrokerageId);
}

async function createContact(email: string): Promise<number> {
  phoneSeq += 1;
  const phone = `04${String(phoneSeq).padStart(8, "0")}`;
  const res = await fetch(`${baseUrl}/api/grow/contacts`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ name: "Consent Contact", email, phone }),
  });
  if (res.status !== 201) throw new Error(`create contact failed: ${res.status} ${await res.text()}`);
  const body = await jsonOf<{ contact: { id: number } }>(res);
  return body.contact.id;
}

async function createContactThread(partyId: number): Promise<number> {
  const res = await fetch(`${baseUrl}/api/grow/contacts/${partyId}/communications/threads`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ subject: "Consent gate" }),
  });
  if (res.status !== 201) throw new Error(`create thread failed: ${res.status} ${await res.text()}`);
  const body = await jsonOf<{ id: number }>(res);
  return body.id;
}

async function draftOnThread(
  threadId: number,
  input: { channel: "EMAIL" | "SMS"; classification?: string; bodyText: string; recipientParticipantId?: number; recipientDestination?: string },
) {
  const res = await fetch(`${baseUrl}/api/communications/threads/${threadId}/messages`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ classification: "TRANSACTIONAL", ...input }),
  });
  if (res.status !== 201) throw new Error(`create draft failed: ${res.status} ${await res.text()}`);
  return jsonOf<{ id: number; version: number; status: string }>(res);
}

async function send(messageId: number, expectedVersion: number) {
  const res = await fetch(`${baseUrl}/api/communications/messages/${messageId}/send`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ expectedVersion }),
  });
  return { status: res.status, body: await jsonOf<{ error?: string; code?: string; message?: { status: string }; blocked?: boolean }>(res) };
}

async function seedLegacy(partyId: number, channel: "EMAIL" | "SMS", destination: string, marketingOptIn = false) {
  await db.insert(communicationConsent).values({
    brokerageId,
    partyId,
    destination: normalizeDestination(channel, destination),
    channel,
    marketingOptIn,
    transactionalOptOut: false,
    source: "MANUAL",
    recordedByUserId: agent.user.id,
  });
}

async function seedExpress(partyId: number, channel: "EMAIL" | "SMS") {
  const [row] = await db
    .insert(growContactChannelConsents)
    .values({
      brokerageId,
      partyId,
      channel,
      state: "EXPRESS",
      source: "MANUAL",
      captureMethod: "WRITTEN",
      purpose: channel,
      scope: "OUTBOUND",
      recordedByUserId: agent.user.id,
    })
    .returning({ id: growContactChannelConsents.id });
  return row!.id;
}

async function blockedAudits(messageId: number) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "communication_send_blocked"), eq(auditLogs.recordId, String(messageId)), eq(auditLogs.recordType, "communication_message")));
}

function assertAuditHasNoContent(updatedValue: string | null, secrets: string[]) {
  assert.ok(updatedValue);
  const parsed = JSON.parse(updatedValue!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "channel",
    "code",
    "dncrStatusId",
    "f2ConsentId",
    "legacyConsentId",
    "messageId",
    "partyId",
    "reasonCode",
  ]);
  const serialised = JSON.stringify(parsed);
  for (const secret of secrets) {
    assert.equal(serialised.includes(secret), false, `audit must not contain ${secret}`);
  }
}

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

  const created = await createBrokerageWithUsers(baseUrl, `GP4 Consent ${Date.now()}`);
  agent = created.agent;
  brokerageId = created.brokerageId;
  const other = await createBrokerageWithUsers(baseUrl, `GP4 Consent Other ${Date.now()}`);
  otherAgent = other.agent;
  otherBrokerageId = other.brokerageId;

  for (const key of ["grow.contacts.manage", "grow.contacts.read", "grow.access", "grow.opportunities.manage"]) {
    await grant(brokerageId, key);
  }
});

after(async () => {
  await cleanupBrokerages([brokerageId, otherBrokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("a party-linked transactional email with legacy and F2 consent is sent", async () => {
  const email = `consented-${Date.now()}@example.com`;
  const partyId = await createContact(email);
  await seedLegacy(partyId, "EMAIL", email);
  await seedExpress(partyId, "EMAIL");
  const threadId = await createContactThread(partyId);
  const draft = await draftOnThread(threadId, {
    channel: "EMAIL",
    bodyText: "Your inspection is confirmed.",
    recipientDestination: email,
  });

  const result = await send(draft.id, draft.version);
  assert.equal(result.status, 200);
  assert.equal(result.body.blocked, false);
  assert.equal(result.body.message?.status, "SENT");
  assert.equal((await blockedAudits(draft.id)).length, 0);
});

test("a party-linked send with no consent row is refused and not queued", async () => {
  const email = `no-row-${Date.now()}@example.com`;
  const bodyText = `NO-ROW-BODY-${Date.now()}`;
  const partyId = await createContact(email);
  const threadId = await createContactThread(partyId);
  const draft = await draftOnThread(threadId, { channel: "EMAIL", bodyText, recipientDestination: email });

  const result = await send(draft.id, draft.version);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "CONSENT_REQUIRED");
  assert.equal(result.body.error, OUTBOUND_CONSENT_REQUIRED_MESSAGE);

  const [row] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, draft.id));
  assert.equal(row?.status, "DRAFT");
  assert.equal(row?.version, draft.version);
  const attempts = await db.select().from(communicationDeliveryAttempts).where(eq(communicationDeliveryAttempts.messageId, draft.id));
  assert.equal(attempts.length, 0);

  const audits = await blockedAudits(draft.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.brokerageId, brokerageId);
  assert.equal(audits[0]!.userId, agent.user.id);
  assertAuditHasNoContent(audits[0]!.updatedValue, [bodyText, email]);
  const parsed = JSON.parse(audits[0]!.updatedValue!) as { reasonCode: string; code: string; messageId: number; partyId: number };
  assert.equal(parsed.code, "CONSENT_REQUIRED");
  assert.equal(parsed.reasonCode, "NO_CONSENT_ROW");
  assert.equal(parsed.messageId, draft.id);
  assert.equal(parsed.partyId, partyId);
});

test("DNC listed blocks a send that otherwise has consent", async () => {
  const email = `dnc-${Date.now()}@example.com`;
  const bodyText = `DNC-BODY-${Date.now()}`;
  const partyId = await createContact(email);
  await seedLegacy(partyId, "EMAIL", email);
  await seedExpress(partyId, "EMAIL");
  await db.insert(growContactDncrStatuses).values({
    brokerageId,
    partyId,
    channel: "SMS",
    status: "LISTED",
    source: "MANUAL",
    recordedByUserId: agent.user.id,
  });
  const threadId = await createContactThread(partyId);
  const draft = await draftOnThread(threadId, { channel: "EMAIL", bodyText, recipientDestination: email });

  const result = await send(draft.id, draft.version);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "DNC_BLOCKED");
  assert.equal(result.body.error, OUTBOUND_DNC_BLOCKED_MESSAGE);
  const [row] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, draft.id));
  assert.equal(row?.status, "DRAFT");
  const audits = await blockedAudits(draft.id);
  assert.equal(audits.length, 1);
  assertAuditHasNoContent(audits[0]!.updatedValue, [bodyText, email]);
  const parsed = JSON.parse(audits[0]!.updatedValue!) as { code: string; reasonCode: string; dncrStatusId: number | null };
  assert.equal(parsed.code, "DNC_BLOCKED");
  assert.equal(parsed.reasonCode, "DNC_LISTED");
  assert.equal(typeof parsed.dncrStatusId, "number");
});

test("a thrown consent lookup is refused and audited without the database error or the body", async () => {
  const email = `lookup-${Date.now()}@example.com`;
  const bodyText = `LOOKUP-BODY-${Date.now()}`;
  const partyId = await createContact(email);
  await seedLegacy(partyId, "EMAIL", email);
  await seedExpress(partyId, "EMAIL");
  const threadId = await createContactThread(partyId);
  const draft = await draftOnThread(threadId, { channel: "EMAIL", bodyText, recipientDestination: email });

  const databaseError = "relation grow_contact_channel_consents does not exist";
  const load = mock.method(outboundConsentReads, "load", async () => {
    throw new Error(databaseError);
  });
  try {
    const result = await send(draft.id, draft.version);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "CONSENT_REQUIRED");
    assert.equal(result.body.error, OUTBOUND_CONSENT_REQUIRED_MESSAGE);
  } finally {
    load.mock.restore();
  }

  const [row] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, draft.id));
  assert.equal(row?.status, "DRAFT");
  const audits = await blockedAudits(draft.id);
  assert.equal(audits.length, 1);
  assertAuditHasNoContent(audits[0]!.updatedValue, [bodyText, email, databaseError]);
  const parsed = JSON.parse(audits[0]!.updatedValue!) as { reasonCode: string };
  assert.equal(parsed.reasonCode, "LOOKUP_FAILED");
});

test("a destination changed by a contact edit is blocked when the new address has no consent row", async () => {
  const oldEmail = `before-edit-${Date.now()}@example.com`;
  const newEmail = `after-edit-${Date.now()}@example.com`;
  const bodyText = `EDIT-BODY-${Date.now()}`;
  const partyId = await createContact(oldEmail);
  await seedLegacy(partyId, "EMAIL", oldEmail);
  const f2Id = await seedExpress(partyId, "EMAIL");

  const patched = await fetch(`${baseUrl}/api/grow/contacts/${partyId}`, {
    method: "PATCH",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ email: newEmail }),
  });
  assert.equal(patched.status, 200, await patched.clone().text());

  const threadId = await createContactThread(partyId);
  const participantRes = await fetch(`${baseUrl}/api/communications/threads/${threadId}/participants`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ partyId, role: "Contact" }),
  });
  assert.equal(participantRes.status, 201, await participantRes.clone().text());
  const participant = await jsonOf<{ id: number; email: string | null }>(participantRes);
  assert.equal(participant.email, newEmail);

  const draft = await draftOnThread(threadId, {
    channel: "EMAIL",
    bodyText,
    recipientParticipantId: participant.id,
  });
  const result = await send(draft.id, draft.version);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "CONSENT_REQUIRED");
  const [row] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, draft.id));
  assert.equal(row?.status, "DRAFT");
  assert.equal(row?.recipientDestination, newEmail);
  const audits = await blockedAudits(draft.id);
  assert.equal(audits.length, 1);
  assertAuditHasNoContent(audits[0]!.updatedValue, [bodyText, oldEmail, newEmail]);
  const parsed = JSON.parse(audits[0]!.updatedValue!) as { reasonCode: string; f2ConsentId: number | null; legacyConsentId: number | null };
  assert.equal(parsed.reasonCode, "NO_CONSENT_ROW");
  assert.equal(parsed.legacyConsentId, null);
  assert.equal(parsed.f2ConsentId, f2Id);
});

test("a cross-brokerage recipient is 404 and is not audited as a consent refusal", async () => {
  const listed = await createListedProperty(baseUrl, otherAgent.cookie, { address: `9 Other Brokerage Rd ${Date.now()}` });
  const partyRes = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: authHeaders(otherAgent.cookie),
    body: JSON.stringify({
      propertyId: listed.propertyId,
      role: "Buyer",
      firstName: "Other",
      lastName: "Tenant",
      email: `other-${Date.now()}@example.com`,
    }),
  });
  assert.equal(partyRes.status, 201, await partyRes.clone().text());
  const { party } = await jsonOf<{ party: { id: number } }>(partyRes);

  const ownListed = await createListedProperty(baseUrl, agent.cookie, { address: `8 Own Brokerage Rd ${Date.now()}` });
  const threadRes = await fetch(`${baseUrl}/api/properties/${ownListed.propertyId}/communications/threads`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ subject: "Cross brokerage recipient" }),
  });
  assert.equal(threadRes.status, 201);
  const thread = await jsonOf<{ id: number }>(threadRes);
  const draft = await draftOnThread(thread.id, {
    channel: "EMAIL",
    bodyText: "This must not be sent to another brokerage's contact.",
    recipientDestination: `manual-${Date.now()}@example.com`,
  });
  await db.update(communicationMessages).set({ partyId: party.id }).where(eq(communicationMessages.id, draft.id));

  const result = await send(draft.id, draft.version);
  assert.equal(result.status, 404);
  const [row] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, draft.id));
  assert.equal(row?.status, "DRAFT");
  assert.equal((await blockedAudits(draft.id)).length, 0);
  const attempts = await db.select().from(communicationDeliveryAttempts).where(eq(communicationDeliveryAttempts.messageId, draft.id));
  assert.equal(attempts.length, 0);
});

test("the appraisal send path refuses an AI-supplied body when consent is absent", async () => {
  const email = `appraisal-${Date.now()}@example.com`;
  const sentinel = `GP4-APPRAISAL-SENTINEL-${Date.now()}-do-not-log`;
  const partyId = await createContact(email);
  const listed = await createListedProperty(baseUrl, agent.cookie, { address: `4 Appraisal Consent St ${Date.now()}`, withoutAcceptedProposal: true });
  const created = await fetch(`${baseUrl}/api/grow/appraisals/from-contact`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ partyId, propertyId: listed.propertyId }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { appraisal } = await jsonOf<{ appraisal: { id: number } }>(created);

  const sent = await fetch(`${baseUrl}/api/grow/appraisals/${appraisal.id}/send`, {
    method: "POST",
    headers: authHeaders(agent.cookie),
    body: JSON.stringify({ bodyText: sentinel, subject: "Your appraisal" }),
  });
  const body = await jsonOf<{ error?: string; code?: string }>(sent);
  assert.equal(sent.status, 409, JSON.stringify(body));
  assert.equal(body.code, "CONSENT_REQUIRED");
  assert.equal(body.error, OUTBOUND_CONSENT_REQUIRED_MESSAGE);

  const drafts = await db
    .select()
    .from(communicationMessages)
    .where(and(eq(communicationMessages.brokerageId, brokerageId), eq(communicationMessages.partyId, partyId)));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.status, "DRAFT");
  assert.equal(drafts[0]!.bodyText, sentinel);
  const attempts = await db.select().from(communicationDeliveryAttempts).where(eq(communicationDeliveryAttempts.messageId, drafts[0]!.id));
  assert.equal(attempts.length, 0);
  const audits = await blockedAudits(drafts[0]!.id);
  assert.equal(audits.length, 1);
  assertAuditHasNoContent(audits[0]!.updatedValue, [sentinel, email, "Your appraisal"]);
});
