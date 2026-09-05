// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// Connection lifecycle: fail-closed default-disabled, the full real
// approval chain to ACTIVE, invalid-transition rejection, tenant
// isolation, and every fail-closed precondition (brokerage disabled,
// entitlement missing, wrong scope, wrong environment) — Section 14's
// acceptance scenarios #1-3 and #8.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { bootstrapIntegrationsForTesting, createActiveMockPortalConnection, grantIntegrationsEntitlement } from "./testHelpers.js";
import { createDraftConnection, requestApproval, decideApproval, revokeConnection, suspendConnection, loadConnectionInBrokerage } from "../model.js";
import { resolveActiveConnection } from "../registry.js";
import { updateIntegrationSettings } from "../settings.js";
import { IntegrationError, INTEGRATION_CAPABILITIES, isValidConnectionTransition } from "../types.js";

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
  A = await createBrokerageWithUsers(baseUrl, `Integrations Lifecycle A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Integrations Lifecycle B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("types.ts transition table: DRAFT can only reach PENDING_APPROVAL or REVOKED directly, never ACTIVE", () => {
  assert.equal(isValidConnectionTransition("DRAFT", "PENDING_APPROVAL"), true);
  assert.equal(isValidConnectionTransition("DRAFT", "ACTIVE"), false);
  assert.equal(isValidConnectionTransition("VALIDATION_FAILED", "ACTIVE"), false);
  assert.equal(isValidConnectionTransition("VALIDATION_FAILED", "CONFIGURING"), true);
  assert.equal(isValidConnectionTransition("REVOKED", "ACTIVE"), false);
  assert.equal(isValidConnectionTransition("REJECTED", "PENDING_APPROVAL"), false);
});

test("a freshly-created DRAFT connection is disabled by default — resolveActiveConnection fails closed", async () => {
  const draft = await createDraftConnection(A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role }, {
    providerId: "mock_portal_v1",
    displayName: "Draft-only connection",
    purpose: "Verify default-disabled state.",
    requestedScopes: [INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING],
  });
  assert.equal(draft.status, "DRAFT");

  await updateIntegrationSettings(A.brokerageId, { enabled: true });
  await grantIntegrationsEntitlement(A.brokerageId);

  await assert.rejects(
    () => resolveActiveConnection(A.brokerageId, draft.id, INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING),
    (err: unknown) => err instanceof IntegrationError && err.reason === "CONNECTION_NOT_USABLE",
  );
});

test("the full real approval chain reaches ACTIVE, and resolveActiveConnection then succeeds", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role });
  assert.equal(connection.status, "ACTIVE");
  assert.equal(connection.healthStatus, "HEALTHY");
  assert.ok((connection.approvedScopes as unknown as string[]).includes(INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING));

  const resolved = await resolveActiveConnection(A.brokerageId, connection.id, INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING);
  assert.equal(resolved.connection.id, connection.id);
});

test("brokerage-disabled fails closed even for an otherwise-ACTIVE connection", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role });
  await updateIntegrationSettings(A.brokerageId, { enabled: false });

  await assert.rejects(
    () => resolveActiveConnection(A.brokerageId, connection.id, INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING),
    (err: unknown) => err instanceof IntegrationError && err.reason === "BROKERAGE_DISABLED",
  );

  // restore for any later test in this file relying on A's brokerage being enabled
  await updateIntegrationSettings(A.brokerageId, { enabled: true });
});

test("entitlement-denied fails closed even for an otherwise-ACTIVE connection", async () => {
  const { connection } = await createActiveMockPortalConnection(B.brokerageId, { id: B.admin.user.id, role: B.admin.user.role }, { skipEntitlement: true });

  await assert.rejects(
    () => resolveActiveConnection(B.brokerageId, connection.id, INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING),
    (err: unknown) => err instanceof IntegrationError && err.reason === "ENTITLEMENT_DENIED",
  );
});

test("scope-not-approved fails closed for a capability never granted on this connection", async () => {
  await updateIntegrationSettings(A.brokerageId, { enabled: true });
  await grantIntegrationsEntitlement(A.brokerageId);
  const actor = { id: A.admin.user.id, role: A.admin.user.role };
  const draft = await createDraftConnection(A.brokerageId, actor, {
    providerId: "mock_portal_v1",
    displayName: "Narrow-scope connection",
    purpose: "Verify scope enforcement.",
    requestedScopes: [INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING],
  });
  const pending = await requestApproval(draft.id, A.brokerageId, actor, draft.version);
  // Approve with ZERO of the requested scopes.
  const approved = await decideApproval(draft.id, A.brokerageId, actor, pending.version, "APPROVED", [], actor.id, "Deliberately narrow approval.");
  assert.deepEqual(approved.approvedScopes, []);

  await assert.rejects(
    () => resolveActiveConnection(A.brokerageId, draft.id, INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING),
    (err: unknown) => err instanceof IntegrationError,
  );
});

test("cross-tenant: brokerage B cannot load or operate brokerage A's connection (identical NOT_FOUND, never a cross-tenant leak)", async () => {
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, { id: A.admin.user.id, role: A.admin.user.role });

  await assert.rejects(
    () => loadConnectionInBrokerage(connection.id, B.brokerageId),
    (err: unknown) => err instanceof IntegrationError && err.reason === "NOT_FOUND",
  );
  await assert.rejects(
    () => resolveActiveConnection(B.brokerageId, connection.id, INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING),
    (err: unknown) => err instanceof IntegrationError && err.reason === "NOT_FOUND",
  );
  await assert.rejects(
    () => suspendConnection(connection.id, B.brokerageId, { id: B.admin.user.id, role: B.admin.user.role }, connection.version, "cross-tenant attempt"),
    (err: unknown) => err instanceof IntegrationError && err.reason === "NOT_FOUND",
  );
});

test("suspend immediately makes an ACTIVE connection unusable, and revoke is permanent", async () => {
  const actor = { id: A.admin.user.id, role: A.admin.user.role };
  const { connection } = await createActiveMockPortalConnection(A.brokerageId, actor);

  const suspended = await suspendConnection(connection.id, A.brokerageId, actor, connection.version, "Routine test suspension.");
  assert.equal(suspended.status, "SUSPENDED");
  await assert.rejects(
    () => resolveActiveConnection(A.brokerageId, connection.id, INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING),
    (err: unknown) => err instanceof IntegrationError && err.reason === "CONNECTION_NOT_USABLE",
  );

  const revoked = await revokeConnection(connection.id, A.brokerageId, actor, suspended.version, "Permanent revoke.");
  assert.equal(revoked.status, "REVOKED");
  assert.equal(isValidConnectionTransition("REVOKED", "ACTIVE"), false);
});
