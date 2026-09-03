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
import { registerLaunchIntegrationHandlers, clearLaunchIntegrationHandlersForTesting } from "../launchProof.js";
import { createDraftConnection, requestApproval, decideApproval, beginConfiguration, validateConnection } from "../model.js";
import { mintMockAuthFlow } from "../credentials.js";
import { updateIntegrationSettings } from "../settings.js";
import { INTEGRATION_CAPABILITIES, type ActorRef } from "../types.js";

export async function bootstrapIntegrationsForTesting(): Promise<void> {
  clearAdaptersForTesting();
  clearLaunchIntegrationHandlersForTesting();
  clearMockPortalStateForTesting();
  registerAdapter(mockPortalAdapter);
  registerLaunchIntegrationHandlers();
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
  await mintMockAuthFlow(draft.id, actor);
  const configuring = await beginConfiguration(draft.id, brokerageId, actor, approved.version);
  const active = await validateConnection(draft.id, brokerageId, actor, configuring.version);

  return { connection: active };
}
