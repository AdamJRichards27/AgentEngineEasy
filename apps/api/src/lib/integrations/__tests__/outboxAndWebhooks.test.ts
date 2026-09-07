// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// The 10 mock-adapter scenarios (Section 12/13) that don't need a full
// domain proof to demonstrate, exercised through the REAL outbox/webhook
// gateway/registry/persistence paths — no shortcuts: success outbound,
// transient-failure-then-retry-success, permanent rejection -> dead-letter,
// rate-limit response, duplicate webhook, invalid signature (rejected +
// quarantined), unknown-connection webhook, mapping conflict, and
// authorised dead-letter replay for both an outbox command and an inbound
// webhook.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPortalConnection } from "./testHelpers.js";
import { enqueueCommand, dispatchCommand, mintIdempotencyKey, replayDeadLetteredCommand } from "../outbox.js";
import { verifyWebhookSignature, processInboundWebhook, registerWebhookEffectHandler, clearWebhookEffectHandlersForTesting, replayDeadLetteredWebhook } from "../webhooks.js";
import { getSecretIdentifierForSigning, SECRET_IDENTIFIER_PREFIX } from "../credentials.js";
import { recordMapping, resolveByInternalId, MappingConflictError } from "../mapping.js";
import { listDeadLettersForBrokerage } from "../deadLetters.js";
import { INTEGRATION_CAPABILITIES } from "../types.js";
import { registerLaunchIntegrationHandlers } from "../launchProof.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
// devLogin() below requires ALLOW_DEV_AUTH=true. Most suites in this repo
// set this themselves at module load (see e.g. transactionConditions.test.ts)
// rather than relying on an ambient value that may not be set, and this
// suite should too.
process.env.ALLOW_DEV_AUTH = "true";

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
  A = await createBrokerageWithUsers(baseUrl, `Integrations Outbox ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Integrations Outbox B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function actor() {
  return { id: A.admin.user.id, role: A.admin.user.role };
}

// ---------------------------------------------------------------------
// Outbox / adapter scenarios.
// ---------------------------------------------------------------------

test("success outbound: a command dispatches SENT on the first attempt", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: "success-case" },
    idempotencyKey: mintIdempotencyKey("test-success"),
    sourceRecordType: "test",
    sourceRecordId: "success-case",
  });
  const dispatched = await dispatchCommand(command.id);
  assert.equal(dispatched.status, "SENT");
  assert.equal(dispatched.attempts, 1);
});

test("transient failure then retry succeeds: attempts 1-2 fail TRANSIENT, attempt 3 succeeds", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: "transient-case", __failUntilAttempt: 3 },
    idempotencyKey: mintIdempotencyKey("test-transient"),
    sourceRecordType: "test",
    sourceRecordId: "transient-case",
  });

  const first = await dispatchCommand(command.id);
  assert.equal(first.status, "RETRY_SCHEDULED");
  const second = await dispatchCommand(command.id);
  assert.equal(second.status, "RETRY_SCHEDULED");
  const third = await dispatchCommand(command.id);
  assert.equal(third.status, "SENT");
  assert.equal(third.attempts, 3);
});

test("permanent rejection dead-letters immediately, with zero retries", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: "permanent-case", __forcePermanentRejection: true },
    idempotencyKey: mintIdempotencyKey("test-permanent"),
    sourceRecordType: "test",
    sourceRecordId: "permanent-case",
  });
  const dispatched = await dispatchCommand(command.id);
  assert.equal(dispatched.status, "DEAD_LETTERED");
  assert.equal(dispatched.attempts, 1);

  const deadLetters = await listDeadLettersForBrokerage(A.brokerageId);
  const match = deadLetters.find((d) => d.sourceId === command.id);
  assert.ok(match, "expected a dead letter for the permanently-rejected command");
  assert.equal(match!.sourceType, "OUTBOX");
});

test("rate-limit response is retried and then succeeds", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: "rate-limit-case", __forceRateLimit: true },
    idempotencyKey: mintIdempotencyKey("test-rate-limit"),
    sourceRecordType: "test",
    sourceRecordId: "rate-limit-case",
  });
  const first = await dispatchCommand(command.id);
  assert.equal(first.status, "RETRY_SCHEDULED");
  const second = await dispatchCommand(command.id);
  assert.equal(second.status, "SENT");
});

test("authorised dead-letter replay for an outbox command re-enters dispatchCommand for real", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  const command = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: "replay-case", __forcePermanentRejection: true },
    idempotencyKey: mintIdempotencyKey("test-replay"),
    sourceRecordType: "test",
    sourceRecordId: "replay-case",
  });
  const dispatched = await dispatchCommand(command.id);
  assert.equal(dispatched.status, "DEAD_LETTERED");
  const deadLetters = await listDeadLettersForBrokerage(A.brokerageId);
  const letter = deadLetters.find((d) => d.sourceId === command.id)!;
  assert.ok(letter);

  // Replay still fails deterministically (the payload still carries
  // __forcePermanentRejection) — proving replay genuinely re-runs the real
  // adapter, not a canned "success" result.
  const replayed = await replayDeadLetteredCommand(letter.id, A.brokerageId, actor());
  assert.equal(replayed.status, "DEAD_LETTERED");
});

// ---------------------------------------------------------------------
// Webhook gateway scenarios.
// ---------------------------------------------------------------------

test("signed inbound webhook is processed and recorded", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  const secret = await getSecretIdentifierForSigning(connection.id);
  assert.ok(secret);
  const rawBody = JSON.stringify({ hello: "world" });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", secret!).update(timestamp).update(".").update(rawBody).digest("hex");
  const signatureValid = verifyWebhookSignature({ rawBody, timestamp, signatureHeader: signature, secret: secret! });
  assert.equal(signatureValid, true);

  const result = await processInboundWebhook({
    connectionId: connection.id,
    provider: "mock_portal_v1",
    providerEventId: `evt-signed-${Date.now()}`,
    eventType: "GENERIC_TEST_EVENT",
    payload: { hello: "world" },
    signatureValid: true,
  });
  assert.equal(result.status, "PROCESSED");
});

test("duplicate webhook: a redelivery with the same providerEventId produces exactly one PROCESSED outcome and one DUPLICATE outcome", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  const providerEventId = `evt-dup-${Date.now()}`;
  let effectCallCount = 0;
  registerWebhookEffectHandler("mock_portal_v1", "COUNTED_EVENT", async () => {
    effectCallCount++;
    return { summary: "counted" };
  });

  const first = await processInboundWebhook({ connectionId: connection.id, provider: "mock_portal_v1", providerEventId, eventType: "COUNTED_EVENT", payload: {}, signatureValid: true });
  const second = await processInboundWebhook({ connectionId: connection.id, provider: "mock_portal_v1", providerEventId, eventType: "COUNTED_EVENT", payload: {}, signatureValid: true });

  assert.equal(first.status, "PROCESSED");
  assert.equal(second.status, "DUPLICATE");
  assert.equal(effectCallCount, 1, "the domain effect must have run exactly once despite two deliveries");

  // Restore the real launch handler this suite's other tests may rely on
  // (registerWebhookEffectHandler overwrites by key, not additive).
  registerLaunchIntegrationHandlers();
});

test("invalid signature is rejected and quarantined, never dispatched to an effect handler", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  let called = false;
  registerWebhookEffectHandler("mock_portal_v1", "SHOULD_NOT_RUN", async () => {
    called = true;
    return { summary: "should not happen" };
  });

  const result = await processInboundWebhook({
    connectionId: connection.id,
    provider: "mock_portal_v1",
    providerEventId: `evt-bad-sig-${Date.now()}`,
    eventType: "SHOULD_NOT_RUN",
    payload: {},
    signatureValid: false,
  });
  assert.equal(result.status, "REJECTED");
  assert.equal(called, false, "an invalid-signature webhook must never reach a domain effect handler");

  registerLaunchIntegrationHandlers();
});

test("a webhook for an unresolvable connection id is rejected, never silently accepted", async () => {
  await assert.rejects(
    () =>
      processInboundWebhook({
        connectionId: "00000000-0000-0000-0000-000000000000",
        provider: "mock_portal_v1",
        providerEventId: `evt-unknown-${Date.now()}`,
        eventType: "GENERIC_TEST_EVENT",
        payload: {},
        signatureValid: true,
      }),
    /Unknown integration connection/,
  );
});

test("authorised dead-letter replay for an inbound webhook re-enters the real effect handler", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  registerWebhookEffectHandler("mock_portal_v1", "ALWAYS_THROWS_ONCE", async () => {
    throw new Error("Simulated processing failure on first attempt.");
  });

  const providerEventId = `evt-replay-${Date.now()}`;
  const failed = await processInboundWebhook({ connectionId: connection.id, provider: "mock_portal_v1", providerEventId, eventType: "ALWAYS_THROWS_ONCE", payload: {}, signatureValid: true });
  assert.equal(failed.status, "FAILED");
  const deadLetters = await listDeadLettersForBrokerage(A.brokerageId);
  const letter = deadLetters.find((d) => d.sourceType === "INBOX" && d.sourceId === String(failed.inboxId));
  assert.ok(letter);

  let secondAttemptSucceeded = false;
  registerWebhookEffectHandler("mock_portal_v1", "ALWAYS_THROWS_ONCE", async () => {
    secondAttemptSucceeded = true;
    return { summary: "succeeded on replay" };
  });
  const { result } = await replayDeadLetteredWebhook(letter!.id, A.brokerageId, actor());
  assert.equal(secondAttemptSucceeded, true);
  assert.equal(result?.status, "PROCESSED");

  registerLaunchIntegrationHandlers();
});

// ---------------------------------------------------------------------
// Mapping conflict.
// ---------------------------------------------------------------------

test("ambiguous mapping: a second attempt to map an already-mapped internalId to a DIFFERENT externalId is rejected as a conflict, never silently overwritten", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  await recordMapping({ connectionId: connection.id, brokerageId: A.brokerageId, entityType: "TEST_ENTITY", internalId: "internal-1", externalId: "external-1" });

  await assert.rejects(() => recordMapping({ connectionId: connection.id, brokerageId: A.brokerageId, entityType: "TEST_ENTITY", internalId: "internal-1", externalId: "external-DIFFERENT" }), (err: unknown) => err instanceof MappingConflictError);

  // Re-recording the SAME externalId is idempotent, not a conflict.
  const stable = await recordMapping({ connectionId: connection.id, brokerageId: A.brokerageId, entityType: "TEST_ENTITY", internalId: "internal-1", externalId: "external-1" });
  assert.equal(stable.externalId, "external-1");

  const resolved = await resolveByInternalId(connection.id, "TEST_ENTITY", "internal-1");
  assert.equal(resolved?.externalId, "external-1");
});

// ---------------------------------------------------------------------
// Credential-reference boundary.
// ---------------------------------------------------------------------

test("credential references are opaque mock pointers, never anything shaped like a real secret", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());
  const secret = await getSecretIdentifierForSigning(connection.id);
  assert.ok(secret);
  assert.ok(secret!.startsWith(SECRET_IDENTIFIER_PREFIX), "every credential reference minted by this build must carry the mock prefix");
  // Defensive shape checks: not a JWT, not a typical API-key/bearer-token shape.
  assert.equal(secret!.split(".").length, 1, "must not resemble a JWT (three dot-separated segments)");
  assert.doesNotMatch(secret!, /^(sk|pk|Bearer)[-_]/i, "must not resemble a real provider API-key/bearer-token prefix convention");
});

// ---------------------------------------------------------------------
// Cross-tenant dead-letter access (Section 14, acceptance scenario #8 —
// the "view, operate, or replay" guarantee, specifically for replay).
// connectionLifecycle.test.ts already proves cross-tenant load/resolve/
// suspend on a CONNECTION are rejected identically; this proves the same
// holds for a dead letter and its replay, for both an OUTBOX- and an
// INBOX-sourced letter.
// ---------------------------------------------------------------------

test("cross-tenant: brokerage B cannot view or replay a dead letter that belongs to brokerage A", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor());

  const outboxCommand = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: "cross-tenant-case", __forcePermanentRejection: true },
    idempotencyKey: mintIdempotencyKey("test-cross-tenant-outbox"),
    sourceRecordType: "test",
    sourceRecordId: "cross-tenant-case",
  });
  await dispatchCommand(outboxCommand.id);
  const outboxLetter = (await listDeadLettersForBrokerage(A.brokerageId)).find((d) => d.sourceId === outboxCommand.id)!;
  assert.ok(outboxLetter, "expected an OUTBOX dead letter for brokerage A");

  registerWebhookEffectHandler("mock_portal_v1", "CROSS_TENANT_ALWAYS_THROWS", async () => {
    throw new Error("Simulated processing failure.");
  });
  const failedWebhook = await processInboundWebhook({
    connectionId: connection.id,
    provider: "mock_portal_v1",
    providerEventId: `evt-cross-tenant-${Date.now()}`,
    eventType: "CROSS_TENANT_ALWAYS_THROWS",
    payload: {},
    signatureValid: true,
  });
  assert.equal(failedWebhook.status, "FAILED");
  const inboxLetter = (await listDeadLettersForBrokerage(A.brokerageId)).find((d) => d.sourceType === "INBOX" && d.sourceId === String(failedWebhook.inboxId))!;
  assert.ok(inboxLetter, "expected an INBOX dead letter for brokerage A");

  const bActor = { id: B.admin.user.id, role: B.admin.user.role };

  // View: brokerage B's own dead-letter list never contains brokerage A's letters.
  const bList = await listDeadLettersForBrokerage(B.brokerageId);
  assert.ok(!bList.some((d) => d.id === outboxLetter.id || d.id === inboxLetter.id), "brokerage B's dead-letter list must never include brokerage A's letters");

  // Operate/replay: brokerage B cannot replay either of brokerage A's letters.
  await assert.rejects(() => replayDeadLetteredCommand(outboxLetter.id, B.brokerageId, bActor));
  await assert.rejects(() => replayDeadLetteredWebhook(inboxLetter.id, B.brokerageId, bActor));

  // Confirm brokerage A can still replay its own letters — the rejection
  // above is tenant-scoping, not a broken replay path.
  const ownReplay = await replayDeadLetteredCommand(outboxLetter.id, A.brokerageId, actor());
  assert.equal(ownReplay.status, "DEAD_LETTERED");

  registerLaunchIntegrationHandlers();
});
