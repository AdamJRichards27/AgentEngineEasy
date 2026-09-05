// Agent Engine 2.0 — AE Step 5 remediation — Integration administration UI
// (Settings → Integrations) read models, exercised at the real HTTP layer
// (routes/integrations.ts's /integrations/overview, /integrations/activity,
// /integrations/reconciliation) — these three endpoints are new surface
// this remediation adds (lib/integrations/adminViews.ts) specifically for
// the admin UI and had no route-level coverage yet. Proves: the overview
// never implies a catalogue entry is connected when it isn't (Section 10's
// hard requirement), the activity feed never leaks a raw command/webhook
// payload, the reconciliation snapshot is a correct live computation, every
// view is strictly brokerage-scoped (cross-tenant), and every view is
// enforced at the API level (not just hidden in the UI) against a
// non-admin Agent — mirrors this router's own top-level requireRole gate.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, financialPaymentRequests, integrationCredentials } from "@aee/db";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPortalConnection, createActiveMockPaymentStatusConnection } from "../../lib/integrations/__tests__/testHelpers.js";
import { enqueueCommand, dispatchCommand, mintIdempotencyKey } from "../../lib/integrations/outbox.js";
import { processInboundWebhook } from "../../lib/integrations/webhooks.js";
import { PAYMENT_STATUS_WEBHOOK_EVENT_TYPE } from "../../lib/integrations/financialProof.js";
import { MOCK_PAYMENT_STATUS_PROVIDER_ID } from "../../lib/integrations/adapters/mockPaymentStatus.js";
import { linkPaymentRequestToExternalReference } from "../../lib/financial/mockPaymentStatusSync.js";
import { createDraftConnection } from "../../lib/integrations/model.js";
import { INTEGRATION_CAPABILITIES } from "../../lib/integrations/types.js";

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
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  await bootstrapIntegrationsForTesting();
  A = await createBrokerageWithUsers(baseUrl, `Integrations Admin Views A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Integrations Admin Views B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function actorOf(login: DevLoginResult) {
  return { id: login.user.id, role: login.user.role };
}

interface OverviewRow {
  providerId: string;
  connectionId: string | null;
  connectionStatus: string | null;
  approvalStatus: string | null;
  health: string | null;
  reconciliationStatus: string;
}
interface ActivityRow {
  id: string;
  direction: "OUTBOUND" | "INBOUND";
  connectionId: string;
  status: string;
  deadLettered: boolean;
  [key: string]: unknown;
}
interface ReconciliationSnapshot {
  aeRecordCount: number;
  providerRecordCount: number;
  matchedCount: number;
  missingCount: number;
  fieldMismatchCount: number;
}

async function getJson<T>(path: string, cookie: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}/api${path}`, { headers: { cookie } });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

async function postJson<T>(path: string, cookie: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

test("GET /integrations/overview lists every catalogue provider and never implies a catalogue entry is connected when it isn't", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor);

  const { status, body } = await getJson<{ overview: OverviewRow[] }>("/integrations/overview", A.admin.cookie);
  assert.equal(status, 200);
  assert.equal(body.overview.length, 3, "the seeded catalogue has exactly 3 mock providers");

  const portalRow = body.overview.find((r) => r.providerId === "mock_portal_v1")!;
  assert.equal(portalRow.connectionId, connection.id);
  assert.equal(portalRow.connectionStatus, "ACTIVE");
  assert.equal(portalRow.approvalStatus, "APPROVED");
  assert.ok(portalRow.health, "an ACTIVE connection must report a health status, never null");

  const smsRow = body.overview.find((r) => r.providerId === "mock_sms_v1")!;
  const paymentRow = body.overview.find((r) => r.providerId === "mock_payment_status_v1")!;
  for (const uninstalledRow of [smsRow, paymentRow]) {
    assert.equal(uninstalledRow.connectionId, null, `${uninstalledRow.providerId} has no connection yet`);
    assert.equal(uninstalledRow.connectionStatus, null);
    assert.equal(uninstalledRow.approvalStatus, null);
    assert.equal(uninstalledRow.health, null);
    assert.equal(uninstalledRow.reconciliationStatus, "NOT_APPLICABLE");
  }
});

test("GET /integrations/activity returns a unified outbound+inbound feed, filterable, and never leaks a raw command/webhook payload", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor);

  const sentCommand = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: `activity-sent-${suffix}` },
    idempotencyKey: mintIdempotencyKey(`admin-activity-sent-${suffix}`),
    sourceRecordType: "test",
    sourceRecordId: "activity-sent",
  });
  await dispatchCommand(sentCommand.id);

  const deadLetteredCommand = await enqueueCommand({
    brokerageId: A.brokerageId,
    connectionId: connection.id,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { destination: `activity-dead-${suffix}`, __forcePermanentRejection: true },
    idempotencyKey: mintIdempotencyKey(`admin-activity-dead-${suffix}`),
    sourceRecordType: "test",
    sourceRecordId: "activity-dead",
  });
  await dispatchCommand(deadLetteredCommand.id);

  const all = await getJson<{ activity: ActivityRow[] }>("/integrations/activity", A.admin.cookie);
  assert.equal(all.status, 200);
  const sentRow = all.body.activity.find((r) => r.id === sentCommand.id)!;
  const deadRow = all.body.activity.find((r) => r.id === deadLetteredCommand.id)!;
  assert.ok(sentRow, "expected the SENT command to appear in the activity feed");
  assert.ok(deadRow, "expected the dead-lettered command to appear in the activity feed");
  assert.equal(sentRow.direction, "OUTBOUND");
  assert.equal(sentRow.status, "SENT");
  assert.equal(sentRow.deadLettered, false);
  assert.equal(deadRow.status, "DEAD_LETTERED");
  assert.equal(deadRow.deadLettered, true);
  for (const row of all.body.activity) {
    assert.equal("commandPayload" in row, false, "the activity read model must never include a raw command payload");
    assert.equal("payload" in row, false, "the activity read model must never include a raw webhook payload");
  }

  const outboundOnly = await getJson<{ activity: ActivityRow[] }>("/integrations/activity?direction=OUTBOUND", A.admin.cookie);
  assert.ok(outboundOnly.body.activity.every((r) => r.direction === "OUTBOUND"));

  const deadOnly = await getJson<{ activity: ActivityRow[] }>("/integrations/activity?status=DEAD_LETTERED", A.admin.cookie);
  assert.ok(deadOnly.body.activity.every((r) => r.status === "DEAD_LETTERED"));
  assert.ok(deadOnly.body.activity.some((r) => r.id === deadLetteredCommand.id));
  assert.ok(!deadOnly.body.activity.some((r) => r.id === sentCommand.id));
});

test("GET /integrations/reconciliation computes a correct live snapshot from financial_payment_requests/financial_reconciliations", async () => {
  const actor = actorOf(A.admin);
  const { connection } = await createActiveMockPaymentStatusConnection(A.brokerageId, actor);
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.admin.cookie, { address: `1 Admin Views Rd ${suffix}` });
  const [request] = await db
    .insert(financialPaymentRequests)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      amountCents: 100000,
      currency: "AUD",
      idempotencyKey: `admin-views-recon-${suffix}`,
    })
    .returning();

  const externalReference = `ADMIN-VIEWS-REF-${suffix}`;
  await linkPaymentRequestToExternalReference(request.id, A.brokerageId, connection.id, externalReference, actor);
  const result = await processInboundWebhook({
    connectionId: connection.id,
    provider: MOCK_PAYMENT_STATUS_PROVIDER_ID,
    providerEventId: `admin-views-evt-${suffix}`,
    eventType: PAYMENT_STATUS_WEBHOOK_EVENT_TYPE,
    payload: { externalReference, amountCents: 100000, currency: "AUD", status: "PAID_IN_FULL" },
    signatureValid: true,
  });
  assert.equal(result.status, "PROCESSED");

  const { status, body } = await getJson<{ snapshot: ReconciliationSnapshot }>("/integrations/reconciliation", A.admin.cookie);
  assert.equal(status, 200);
  assert.equal(body.snapshot.aeRecordCount, 1);
  assert.equal(body.snapshot.providerRecordCount, 1);
  assert.equal(body.snapshot.matchedCount, 1);
  assert.equal(body.snapshot.missingCount, 0);
  assert.equal(body.snapshot.fieldMismatchCount, 0);
});

test("cross-tenant: overview, activity, and reconciliation are strictly scoped per brokerage — Brokerage B sees none of Brokerage A's connections, activity, or reconciliation evidence", async () => {
  const overviewB = await getJson<{ overview: OverviewRow[] }>("/integrations/overview", B.admin.cookie);
  assert.equal(overviewB.status, 200);
  assert.equal(overviewB.body.overview.length, 3);
  assert.ok(
    overviewB.body.overview.every((r) => r.connectionId === null),
    "Brokerage B has created no connections of its own — it must never see Brokerage A's connections mixed into its own catalogue view",
  );

  const activityB = await getJson<{ activity: ActivityRow[] }>("/integrations/activity", B.admin.cookie);
  assert.equal(activityB.status, 200);
  assert.equal(activityB.body.activity.length, 0, "Brokerage B has no integration activity of its own and must never see Brokerage A's");

  const reconciliationB = await getJson<{ snapshot: ReconciliationSnapshot }>("/integrations/reconciliation", B.admin.cookie);
  assert.equal(reconciliationB.status, 200);
  assert.equal(reconciliationB.body.snapshot.aeRecordCount, 0, "Brokerage B has no payment requests of its own and must never see Brokerage A's reconciliation evidence");
});

test("a non-admin (Agent) receives 403 from every admin-view endpoint — enforced at the API, not just hidden in the UI", async () => {
  for (const path of ["/integrations/overview", "/integrations/activity", "/integrations/reconciliation"]) {
    const res = await fetch(`${baseUrl}/api${path}`, { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 403, `expected ${path} to refuse a non-admin Agent`);
  }
});

// ---------------------------------------------------------------------
// AE 2.0 Step 2 hardening — POST /integrations/connections/:id/mint-credential
// previously minted/reactivated a credential reference keyed only on the
// client-supplied :id, with no brokerage check at all (a cross-tenant IDOR:
// any Brokerage Administrator could mint a credential against ANY other
// brokerage's connection by guessing its id). mintMockAuthFlow now runs
// the same loadConnectionInBrokerage tenant chokepoint every other mutating
// handler on this router already goes through, before touching
// integration_credentials at all.
// ---------------------------------------------------------------------

test("cross-tenant: brokerage B cannot mint a credential against brokerage A's connection — identical NOT_FOUND to a nonexistent connection id, never a distinguishable 403", async () => {
  const actorA = actorOf(A.admin);
  const draft = await createDraftConnection(A.brokerageId, actorA, {
    providerId: "mock_portal_v1",
    displayName: "Cross-tenant mint-credential target",
    purpose: "Verify mint-credential is tenant-scoped.",
    requestedScopes: [INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING],
  });

  const crossTenant = await postJson<{ error: string; reason: string }>(`/integrations/connections/${draft.id}/mint-credential`, B.admin.cookie);
  const nonexistent = await postJson<{ error: string; reason: string }>(`/integrations/connections/${randomUUID()}/mint-credential`, B.admin.cookie);

  assert.equal(crossTenant.status, 404, "cross-tenant mint attempt must be refused, not silently succeed");
  assert.equal(crossTenant.body.reason, "NOT_FOUND");
  assert.equal(crossTenant.status, nonexistent.status, "cross-tenant connection must be indistinguishable from a nonexistent one");
  assert.equal(crossTenant.body.reason, nonexistent.body.reason);
  assert.equal(crossTenant.body.error, nonexistent.body.error);

  // And brokerage A's own draft must be completely unaffected — no credential minted by the attacker's attempt.
  const rows = await db.select().from(integrationCredentials).where(eq(integrationCredentials.connectionId, draft.id));
  assert.equal(rows.length, 0, "the cross-tenant attempt must not have created any integration_credentials row");
});

test("happy path: minting a credential for a connection that belongs to the caller's own brokerage still works", async () => {
  const actorA = actorOf(A.admin);
  const draft = await createDraftConnection(A.brokerageId, actorA, {
    providerId: "mock_portal_v1",
    displayName: "Same-tenant mint-credential target",
    purpose: "Verify mint-credential still works for the owning brokerage.",
    requestedScopes: [INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING],
  });

  const { status, body } = await postJson<{ credential: { id: string; referenceType: string; status: string; createdAt: string } }>(
    `/integrations/connections/${draft.id}/mint-credential`,
    A.admin.cookie,
  );

  assert.equal(status, 201);
  assert.equal(body.credential.referenceType, "MOCK_AUTH_FLOW");
  assert.equal(body.credential.status, "ACTIVE");
  assert.equal("secretIdentifier" in body.credential, false, "the response must never include the secret identifier");
});
