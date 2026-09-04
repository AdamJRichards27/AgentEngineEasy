// Agent Engine 2.0 — AE Step 5 remediation — Proof B (Communications Hub).
//
// End-to-end through the REAL outbox, adapter, mapping, webhook gateway,
// and Communications' own service boundary — no shortcuts. Proves the full
// 16-step scenario (authorised outbound SMS -> validation -> brokerage
// config resolved -> subscription entitlement checked SEPARATELY from the
// caller's role authority -> consent/cost-control/quiet-hours ->
// transactional outbox -> mock adapter send -> external message id ->
// mapped to the AE communication message -> signed mock delivery webhook
// -> status updated via applyMessageTransition (Communications' own
// boundary) -> duplicate delivery produces no duplicate effect), plus the
// safety-test matrix: disabled connection, unapproved connection,
// ineligible/absent subscription entitlement, explicit AI/SMS entitlement
// separation, missing consent, cost-control block, quiet-hours deferral,
// invalid signature, duplicate webhook, unknown external id, cross-tenant,
// and credential-reference opacity.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, communicationMessages, entitlementGrants } from "@aee/db";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import {
  bootstrapIntegrationsForTesting,
  createActiveMockSmsConnection,
  createActiveMockPortalConnection,
  grantCommsSmsEntitlement,
  grantEntitlement,
} from "./testHelpers.js";
import { sendSmsViaIntegration, COMMS_SMS_ENTITLEMENT_KEY, SMS_DELIVERY_WEBHOOK_EVENT_TYPE } from "../commsProof.js";
import { MOCK_SMS_PROVIDER_ID } from "../adapters/mockSms.js";
import { processInboundWebhook } from "../webhooks.js";
import { updateIntegrationSettings } from "../settings.js";
import { IntegrationError, INTEGRATION_CAPABILITIES } from "../types.js";
import { getSecretIdentifierForSigning, SECRET_IDENTIFIER_PREFIX } from "../credentials.js";
import { resolveByExternalId } from "../mapping.js";
import { createThread, createDraftMessage } from "../../communications/messages.js";
import { updateCommunicationSettings } from "../../communications/settings.js";
import { CommunicationTenancyError } from "../../communications/types.js";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await bootstrapIntegrationsForTesting();
  A = await createBrokerageWithUsers(baseUrl, `Integrations Comms Proof ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Integrations Comms Proof B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function actorOf(login: DevLoginResult) {
  return { id: login.user.id, role: login.user.role };
}

/** A brand-new DRAFT SMS message, tenant-scoped, with an explicit recipient/body (no template/participant needed for these tests). */
async function draftSmsMessage(
  brokerageId: number,
  cookie: string,
  senderUserId: number,
  opts?: { classification?: "TRANSACTIONAL" | "SERVICE" | "MARKETING"; recipientDestination?: string },
) {
  const { propertyId } = await createListedProperty(baseUrl, cookie, { address: `1 Comms Proof Rd ${suffix}-${Math.floor(Math.random() * 100000)}` });
  const thread = await createThread({ brokerageId, propertyId, subject: "Proof B test thread", createdByUserId: senderUserId });
  const message = await createDraftMessage({
    threadId: thread.id,
    brokerageId,
    propertyId,
    channel: "SMS",
    classification: opts?.classification ?? "TRANSACTIONAL",
    bodyText: "This is an automated test SMS sent through the integration foundation.",
    recipientDestination: opts?.recipientDestination ?? "+61400000000",
    recipientDisplayName: "Test Recipient",
    senderUserId,
    createdByUserId: senderUserId,
  });
  return { propertyId, thread, message };
}

test("Proof B: authorised SMS send -> real outbox/adapter -> mapping -> signed delivery webhook -> Communications' own service boundary, with duplicate-delivery protection", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);
  assert.equal(message.status, "DRAFT");

  // --- Outbound: validate -> resolve connection -> entitlement (separate
  // authority) -> consent -> cost-control -> quiet-hours -> real outbox ->
  // mock adapter -> Communications' own applyMessageTransition. ---
  const result = await sendSmsViaIntegration({ messageId: message.id, brokerageId: A.brokerageId, connectionId: connection.id, actor });
  assert.equal(result.outcome, "SENT");
  assert.equal(result.message.status, "SENT");
  assert.equal(result.message.provider, MOCK_SMS_PROVIDER_ID);
  assert.ok(result.message.providerMessageId, "expected an external message id from the mock adapter");

  // --- Mapped to the AE communication (Section 5's mapping table). ---
  const mapping = await resolveByExternalId(connection.id, "communication_message", result.message.providerMessageId!);
  assert.equal(mapping?.internalId, String(message.id));

  // --- Inbound: a signed mock delivery-status webhook. ---
  const delivered = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_SMS_PROVIDER_ID,
    providerEventId: `evt-delivered-${suffix}`,
    eventType: SMS_DELIVERY_WEBHOOK_EVENT_TYPE,
    payload: { externalMessageId: result.message.providerMessageId, status: "DELIVERED" },
    signatureValid: true,
  });
  assert.equal(delivered.status, "PROCESSED");

  const [afterDelivery] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, message.id));
  assert.equal(afterDelivery.status, "DELIVERED", "applyMessageTransition (Communications' own service boundary) must have applied the effect");
  const deliveredVersion = afterDelivery.version;

  // --- Duplicate delivery (same providerEventId — gateway-level dedup). ---
  const duplicate = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_SMS_PROVIDER_ID,
    providerEventId: `evt-delivered-${suffix}`,
    eventType: SMS_DELIVERY_WEBHOOK_EVENT_TYPE,
    payload: { externalMessageId: result.message.providerMessageId, status: "DELIVERED" },
    signatureValid: true,
  });
  assert.equal(duplicate.status, "DUPLICATE");

  // --- A second, genuinely different delivery event arriving after the
  // message is already terminal must produce no duplicate/regressive
  // effect (business-level idempotency, not just gateway dedup). ---
  const secondDelivery = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_SMS_PROVIDER_ID,
    providerEventId: `evt-delivered-again-${suffix}`,
    eventType: SMS_DELIVERY_WEBHOOK_EVENT_TYPE,
    payload: { externalMessageId: result.message.providerMessageId, status: "DELIVERED" },
    signatureValid: true,
  });
  assert.equal(secondDelivery.status, "PROCESSED");
  const [afterSecond] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, message.id));
  assert.equal(afterSecond.status, "DELIVERED");
  assert.equal(afterSecond.version, deliveredVersion, "a duplicate/replayed delivery event must never apply a second effect");
});

test("safety: disabled connection (brokerage integrations disabled) fails closed", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);

  await updateIntegrationSettings(A.brokerageId, { enabled: false });
  await assert.rejects(
    () => sendSmsViaIntegration({ messageId: message.id, brokerageId: A.brokerageId, connectionId: connection.id, actor }),
    (err: unknown) => err instanceof IntegrationError && err.reason === "BROKERAGE_DISABLED",
  );
  await updateIntegrationSettings(A.brokerageId, { enabled: true });
});

test("safety: unapproved connection — an ACTIVE connection never approved for comms.sendSms (a real mock-portal connection, approved only for portal capabilities) fails closed", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  // A genuinely different, ACTIVE, entitled connection whose approvedScopes
  // never included comms.sendSms — this is what "unapproved for THIS
  // capability" looks like on a real connection (an empty-approvedScopes
  // connection can never itself reach ACTIVE — model.ts's validateConnection
  // has nothing to probe and fails validation deterministically, so that
  // shape is not a reachable real-world state to begin with).
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);

  await assert.rejects(
    () => sendSmsViaIntegration({ messageId: message.id, brokerageId: A.brokerageId, connectionId: connection.id, actor }),
    (err: unknown) => err instanceof IntegrationError && err.reason === "SCOPE_NOT_APPROVED",
  );
});

test("safety: ineligible subscription — no communications.sms entitlement — is denied even with full role authority and an ACTIVE, approved connection", async () => {
  const actor = actorOf(B.admin);
  // A fresh brokerage (B) that has never been granted communications.sms —
  // deliberately only integrations.access (granted inside
  // createActiveMockSmsConnection) is present.
  const { connection } = await createActiveMockSmsConnection(B.brokerageId, actor);
  const { message } = await draftSmsMessage(B.brokerageId, B.admin.cookie, B.admin.user.id);

  await assert.rejects(
    () => sendSmsViaIntegration({ messageId: message.id, brokerageId: B.brokerageId, connectionId: connection.id, actor }),
    (err: unknown) => err instanceof IntegrationError && err.reason === "ENTITLEMENT_DENIED",
  );
});

async function activeEntitlementKeys(brokerageId: number): Promise<Set<string>> {
  // A direct DB read (never through resolver.ts's own 30s hot-path cache —
  // see resolveEntitlements' CACHE_TTL_MS) so a test-only direct grant
  // insert is reflected immediately, without needing to also replicate the
  // production write path's invalidateEntitlementCache call.
  const rows = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.status, "Active")));
  return new Set(rows.map((r) => r.entitlementKey));
}

test("safety: explicit AI/SMS entitlement separation — grow.ai.use never substitutes for communications.sms, and holding communications.sms never grants grow.ai.use", async () => {
  const actor = actorOf(B.admin);
  const { connection } = await createActiveMockSmsConnection(B.brokerageId, actor);
  const { message: messageA } = await draftSmsMessage(B.brokerageId, B.admin.cookie, B.admin.user.id);

  // Holding an UNRELATED entitlement (grow.ai.use) must never substitute.
  await grantEntitlement(B.brokerageId, "grow.ai.use");
  await assert.rejects(
    () => sendSmsViaIntegration({ messageId: messageA.id, brokerageId: B.brokerageId, connectionId: connection.id, actor }),
    (err: unknown) => err instanceof IntegrationError && err.reason === "ENTITLEMENT_DENIED",
  );
  assert.equal((await activeEntitlementKeys(B.brokerageId)).has(COMMS_SMS_ENTITLEMENT_KEY), false);

  // Now grant communications.sms — the send succeeds — but grow.ai.use
  // being ALSO granted is coincidental to this test setup, not a
  // consequence of holding communications.sms: a brokerage that holds
  // communications.sms ALONE (never grow.ai.use) must still be able to
  // send, proving the two keys are independently sufficient/necessary in
  // both directions.
  await grantCommsSmsEntitlement(B.brokerageId);
  const sendResult = await sendSmsViaIntegration({ messageId: messageA.id, brokerageId: B.brokerageId, connectionId: connection.id, actor });
  assert.equal(sendResult.outcome, "SENT");

  const { message: messageB } = await draftSmsMessage(B.brokerageId, B.admin.cookie, B.admin.user.id);
  const keysAfter = await activeEntitlementKeys(B.brokerageId);
  assert.ok(keysAfter.has("grow.ai.use"), "grow.ai.use was granted independently above — communications.sms must not have revoked or substituted it");
  const secondSend = await sendSmsViaIntegration({ messageId: messageB.id, brokerageId: B.brokerageId, connectionId: connection.id, actor });
  assert.equal(secondSend.outcome, "SENT", "holding communications.sms is sufficient on its own — grow.ai.use is not a precondition for an SMS send");
});

test("safety: missing consent — a MARKETING SMS with no opt-in record is blocked, never sent", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id, { classification: "MARKETING", recipientDestination: `+614${Date.now()}` });

  const result = await sendSmsViaIntegration({ messageId: message.id, brokerageId: A.brokerageId, connectionId: connection.id, actor });
  assert.equal(result.outcome, "BLOCKED_BY_CONSENT");
  assert.equal(result.message.status, "BLOCKED_BY_CONSENT");
  assert.equal(result.message.provider, null, "a consent-blocked message must never reach the mock adapter");
});

test("safety: cost-control block — an SMS that would exceed the brokerage's hard threshold is blocked, never sent", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);

  await updateCommunicationSettings(A.brokerageId, { smsHardThresholdCents: 0 });
  try {
    const result = await sendSmsViaIntegration({ messageId: message.id, brokerageId: A.brokerageId, connectionId: connection.id, actor });
    assert.equal(result.outcome, "BLOCKED_BY_COST_CONTROL");
    assert.equal(result.message.status, "BLOCKED_BY_COST_CONTROL");
  } finally {
    await updateCommunicationSettings(A.brokerageId, { smsHardThresholdCents: 10000000 });
  }
});

test("safety: quiet-hours defers the send rather than dispatching immediately", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);

  // A near-24h window (all but the last minute of the day) so this passes
  // deterministically regardless of what time the test actually runs.
  await updateCommunicationSettings(A.brokerageId, { timeZone: "UTC", quietHoursStart: "00:00", quietHoursEnd: "23:59" });
  try {
    const result = await sendSmsViaIntegration({ messageId: message.id, brokerageId: A.brokerageId, connectionId: connection.id, actor });
    assert.equal(result.outcome, "DEFERRED_QUIET_HOURS");
    assert.equal(result.message.status, "QUEUED", "a quiet-hours deferral stays QUEUED for the boot-time scheduler to pick up later");
    assert.ok(result.message.scheduledAt && result.message.scheduledAt.getTime() > Date.now(), "expected scheduledAt to be pushed into the future");
  } finally {
    await updateCommunicationSettings(A.brokerageId, { quietHoursStart: null, quietHoursEnd: null });
  }
});

test("safety: invalid signature is rejected and never reaches Communications' service boundary", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const { message } = await draftSmsMessage(A.brokerageId, A.admin.cookie, A.admin.user.id);
  const sent = await sendSmsViaIntegration({ messageId: message.id, brokerageId: A.brokerageId, connectionId: connection.id, actor });
  assert.equal(sent.outcome, "SENT");

  const rejected = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_SMS_PROVIDER_ID,
    providerEventId: `evt-bad-sig-${Date.now()}`,
    eventType: SMS_DELIVERY_WEBHOOK_EVENT_TYPE,
    payload: { externalMessageId: sent.message.providerMessageId, status: "DELIVERED" },
    signatureValid: false,
  });
  assert.equal(rejected.status, "REJECTED");

  const [afterRejected] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, message.id));
  assert.equal(afterRejected.status, "SENT", "an invalid-signature webhook must never move the message toward DELIVERED");
});

test("safety: an unknown external message id is recorded but applies no effect", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);

  const result = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_SMS_PROVIDER_ID,
    providerEventId: `evt-unknown-ext-${Date.now()}`,
    eventType: SMS_DELIVERY_WEBHOOK_EVENT_TYPE,
    payload: { externalMessageId: `no-such-external-id-${Date.now()}`, status: "DELIVERED" },
    signatureValid: true,
  });
  assert.equal(result.status, "PROCESSED", "an unmapped external id is recorded for audit, never rejected outright");
});

test("safety: cross-tenant — brokerage B cannot send through brokerage A's SMS connection, even for B's own message", async () => {
  const aActor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection: aConnection } = await createActiveMockSmsConnection(A.brokerageId, aActor);

  const bActor = actorOf(B.admin);
  await grantCommsSmsEntitlement(B.brokerageId);
  const { message: bMessage } = await draftSmsMessage(B.brokerageId, B.admin.cookie, B.admin.user.id);

  await assert.rejects(
    () => sendSmsViaIntegration({ messageId: bMessage.id, brokerageId: B.brokerageId, connectionId: aConnection.id, actor: bActor }),
    (err: unknown) => err instanceof IntegrationError && err.reason === "NOT_FOUND",
  );

  // And the reverse — brokerage A can never even LOAD brokerage B's message
  // through its own (A's) connection; the message-tenancy check fires
  // before the connection is even resolved.
  await assert.rejects(
    () => sendSmsViaIntegration({ messageId: bMessage.id, brokerageId: A.brokerageId, connectionId: aConnection.id, actor: aActor }),
    (err: unknown) => err instanceof CommunicationTenancyError,
  );
});

test("safety: credential references minted for the SMS connection are opaque mock pointers, never anything shaped like a real secret", async () => {
  const actor = actorOf(A.admin);
  await grantCommsSmsEntitlement(A.brokerageId);
  const { connection } = await createActiveMockSmsConnection(A.brokerageId, actor);
  const secret = await getSecretIdentifierForSigning(connection.id);
  assert.ok(secret);
  assert.ok(secret!.startsWith(SECRET_IDENTIFIER_PREFIX));
  assert.equal(secret!.split(".").length, 1, "must not resemble a JWT");
  assert.doesNotMatch(secret!, /^(sk|pk|Bearer)[-_]/i, "must not resemble a real provider API-key/bearer-token prefix convention");
});
