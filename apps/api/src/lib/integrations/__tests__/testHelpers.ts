// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// Shared test setup: drives a connection through the REAL lifecycle
// (DRAFT -> PENDING_APPROVAL -> APPROVED -> CONFIGURING -> VALIDATING ->
// ACTIVE) via model.ts's own exported functions — never a shortcut/direct
// DB write to fake an ACTIVE row — so every test that uses this helper is
// implicitly also exercising the full approval chain, not just its own
// scenario. Not itself a *.test.ts file, so tsx --test's glob does not pick
// it up as a test (mirrors routes/__tests__/testSupport.ts's own module comment).

import { eq } from "drizzle-orm";
import { db, entitlementGrants, type IntegrationConnection } from "@aee/db";
import { seedProviderCatalogue, registerAdapter, clearAdaptersForTesting } from "../registry.js";
import { mockPortalAdapter, clearMockPortalStateForTesting } from "../adapters/mockPortal.js";
import { mockSmsAdapter, clearMockSmsStateForTesting } from "../adapters/mockSms.js";
import { mockPaymentStatusAdapter } from "../adapters/mockPaymentStatus.js";
import { registerLaunchIntegrationHandlers, clearLaunchIntegrationHandlersForTesting } from "../launchProof.js";
// AE Step 5 remediation — Proof B/C: registered/cleared alongside Proof A's
// own handler, same idempotent-latch + testing-reset template.
import { registerCommsIntegrationHandlers, clearCommsIntegrationHandlersForTesting, COMMS_SMS_ENTITLEMENT_KEY } from "../commsProof.js";
import { registerFinancialIntegrationHandlers, clearFinancialIntegrationHandlersForTesting } from "../financialProof.js";
import { clearIntegrationSourceRecordResolversForTesting } from "../sourceRecordResolvers.js";
import { createDraftConnection, requestApproval, decideApproval, beginConfiguration, validateConnection } from "../model.js";
import { mintMockAuthFlow } from "../credentials.js";
import { updateIntegrationSettings } from "../settings.js";
import { INTEGRATION_CAPABILITIES, type ActorRef, type IntegrationCapability } from "../types.js";

export async function bootstrapIntegrationsForTesting(): Promise<void> {
  clearAdaptersForTesting();
  clearLaunchIntegrationHandlersForTesting();
  clearCommsIntegrationHandlersForTesting();
  clearFinancialIntegrationHandlersForTesting();
  clearIntegrationSourceRecordResolversForTesting();
  clearMockPortalStateForTesting();
  clearMockSmsStateForTesting();
  registerAdapter(mockPortalAdapter);
  registerAdapter(mockSmsAdapter);
  registerAdapter(mockPaymentStatusAdapter);
  registerLaunchIntegrationHandlers();
  registerCommsIntegrationHandlers();
  registerFinancialIntegrationHandlers();
  await seedProviderCatalogue();
}

export async function grantIntegrationsEntitlement(brokerageId: number): Promise<void> {
  await db.insert(entitlementGrants).values({
    brokerageId,
    granteeType: "brokerage",
    granteeId: brokerageId,
    entitlementKey: "integrations.access",
    status: "Active",
    sourceType: "manual",
  });
}

/**
 * AE Step 5 remediation — Proof B's own subscription entitlement (Section:
 * "checked SEPARATELY from the sending user's own role authority"). A
 * distinct helper from grantIntegrationsEntitlement above deliberately — a
 * test that wants to prove the two authorities are independent grants one
 * without the other.
 */
export async function grantCommsSmsEntitlement(brokerageId: number): Promise<void> {
  await db.insert(entitlementGrants).values({
    brokerageId,
    granteeType: "brokerage",
    granteeId: brokerageId,
    entitlementKey: COMMS_SMS_ENTITLEMENT_KEY,
    status: "Active",
    sourceType: "manual",
  });
}

/** Generic — used by the AI/SMS separation tests to grant an UNRELATED entitlement (e.g. grow.ai.use) and prove it never substitutes for communications.sms. */
export async function grantEntitlement(brokerageId: number, entitlementKey: string): Promise<void> {
  await db.insert(entitlementGrants).values({
    brokerageId,
    granteeType: "brokerage",
    granteeId: brokerageId,
    entitlementKey,
    status: "Active",
    sourceType: "manual",
  });
}

export interface ActiveMockPortalConnectionResult {
  connection: IntegrationConnection;
}

/**
 * Drives a brand-new connection to ACTIVE through the real lifecycle —
 * enables the brokerage setting, grants the entitlement, creates a DRAFT,
 * requests approval, approves it (both requested capabilities), mints the
 * mock credential reference, configures, and validates. Returns the final
 * ACTIVE row.
 */
export async function createActiveMockPortalConnection(brokerageId: number, actor: ActorRef, opts?: { skipEnableSettings?: boolean; skipEntitlement?: boolean }): Promise<ActiveMockPortalConnectionResult> {
  if (!opts?.skipEnableSettings) await updateIntegrationSettings(brokerageId, { enabled: true });
  if (!opts?.skipEntitlement) await grantIntegrationsEntitlement(brokerageId);

  const draft = await createDraftConnection(brokerageId, actor, {
    providerId: "mock_portal_v1",
    displayName: "Test Mock Portal Connection",
    purpose: "Automated test coverage for the Integration and Data Exchange Foundation.",
    requestedScopes: [INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING, INTEGRATION_CAPABILITIES.PORTAL_UPDATE_LISTING_STATUS],
  });

  const pending = await requestApproval(draft.id, brokerageId, actor, draft.version);
  const approved = await decideApproval(
    draft.id,
    brokerageId,
    actor,
    pending.version,
    "APPROVED",
    [INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING, INTEGRATION_CAPABILITIES.PORTAL_UPDATE_LISTING_STATUS],
    actor.id,
    "Approved for automated test coverage.",
  );
  await mintMockAuthFlow(draft.id, brokerageId, actor);
  const configuring = await beginConfiguration(draft.id, brokerageId, actor, approved.version);
  const active = await validateConnection(draft.id, brokerageId, actor, configuring.version);

  return { connection: active };
}

export interface ActiveConnectionResult {
  connection: IntegrationConnection;
}

/**
 * AE Step 5 remediation — Proof B. Same real-lifecycle discipline as
 * createActiveMockPortalConnection above, against the mock_sms_v1 provider.
 * `approvedScopes` defaults to the one real capability this provider
 * declares; pass [] to prove the "unapproved connection" safety case
 * (scope requested but never granted).
 */
export async function createActiveMockSmsConnection(
  brokerageId: number,
  actor: ActorRef,
  opts?: { skipEnableSettings?: boolean; skipEntitlement?: boolean; approvedScopes?: IntegrationCapability[] },
): Promise<ActiveConnectionResult> {
  if (!opts?.skipEnableSettings) await updateIntegrationSettings(brokerageId, { enabled: true });
  if (!opts?.skipEntitlement) await grantIntegrationsEntitlement(brokerageId);

  const draft = await createDraftConnection(brokerageId, actor, {
    providerId: "mock_sms_v1",
    displayName: "Test Mock SMS Connection",
    purpose: "Automated test coverage for Proof B (Communications Hub).",
    requestedScopes: [INTEGRATION_CAPABILITIES.COMMS_SEND_SMS],
  });

  const pending = await requestApproval(draft.id, brokerageId, actor, draft.version);
  const approved = await decideApproval(
    draft.id,
    brokerageId,
    actor,
    pending.version,
    "APPROVED",
    opts?.approvedScopes ?? [INTEGRATION_CAPABILITIES.COMMS_SEND_SMS],
    actor.id,
    "Approved for automated test coverage.",
  );
  await mintMockAuthFlow(draft.id, brokerageId, actor);
  const configuring = await beginConfiguration(draft.id, brokerageId, actor, approved.version);
  const active = await validateConnection(draft.id, brokerageId, actor, configuring.version);

  return { connection: active };
}

/**
 * AE Step 5 remediation — Proof C. Same real-lifecycle discipline, against
 * the mock_payment_status_v1 provider (inbound-only — see
 * mockPaymentStatusSync.ts's own header comment).
 */
export async function createActiveMockPaymentStatusConnection(
  brokerageId: number,
  actor: ActorRef,
  opts?: { skipEnableSettings?: boolean; skipEntitlement?: boolean; approvedScopes?: IntegrationCapability[] },
): Promise<ActiveConnectionResult> {
  if (!opts?.skipEnableSettings) await updateIntegrationSettings(brokerageId, { enabled: true });
  if (!opts?.skipEntitlement) await grantIntegrationsEntitlement(brokerageId);

  const draft = await createDraftConnection(brokerageId, actor, {
    providerId: "mock_payment_status_v1",
    displayName: "Test Mock Payment Status Connection",
    purpose: "Automated test coverage for Proof C (Financial Transaction Engine).",
    requestedScopes: [INTEGRATION_CAPABILITIES.PAYMENTS_STATUS_SYNC],
  });

  const pending = await requestApproval(draft.id, brokerageId, actor, draft.version);
  const approved = await decideApproval(
    draft.id,
    brokerageId,
    actor,
    pending.version,
    "APPROVED",
    opts?.approvedScopes ?? [INTEGRATION_CAPABILITIES.PAYMENTS_STATUS_SYNC],
    actor.id,
    "Approved for automated test coverage.",
  );
  await mintMockAuthFlow(draft.id, brokerageId, actor);
  const configuring = await beginConfiguration(draft.id, brokerageId, actor, approved.version);
  const active = await validateConnection(draft.id, brokerageId, actor, configuring.version);

  return { connection: active };
}
