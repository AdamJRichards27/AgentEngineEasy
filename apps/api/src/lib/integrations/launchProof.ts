// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation —
// Domain Integration Proof A (Property Launch).
//
// Wires the generic integration foundation (registry/outbox/webhooks) to
// ONE real domain: Launch's portal-destination flow, using the mock portal
// adapter only. This file is deliberately the ONLY place that connects
// "an integration event happened" to "a Launch record changed" — every
// mutation still runs through lib/launch/model.ts's own exported functions
// (recordPortalSubmission, recordPortalFailure, confirmPortalLive), never a
// duplicate write path (Section 4: "adapters call the domain service
// boundary, never bypass it").
//
// What this proves (see __tests__/launchProof.test.ts for the actual
// assertions):
//   - A mock portal connection can publish a listing through the real
//     outbox -> adapter -> attempt-recording path.
//   - A signed mock status webhook, processed through the real gateway,
//     updates the destination via Launch's own service boundary.
//   - A duplicate webhook produces exactly one domain effect (the
//     gateway's own idempotency, exercised here rather than re-implemented).
//   - An out-of-order webhook (a stale "still submitted" event arriving
//     after a "live" one already applied) never regresses recorded state.
//   - confirmPortalLive is the ONLY thing this webhook effect ever calls —
//     it never calls confirmLaunchLive/goLiveProperty, so Launch's Market
//     Ready / Listing Live approval gate cannot be bypassed by a mock
//     portal event, no matter what that event claims.

import { loadPortalDestinationInBrokerage, recordPortalSubmission, recordPortalFailure, confirmPortalLive } from "../launch/model.js";
import { dispatchCommand, enqueueCommand, mintIdempotencyKey } from "./outbox.js";
import { registerWebhookEffectHandler, type WebhookEffectContext, type WebhookEffectResult } from "./webhooks.js";
import { resolveActiveConnection } from "./registry.js";
import { MOCK_PORTAL_PROVIDER_ID } from "./adapters/mockPortal.js";
import { INTEGRATION_CAPABILITIES, type ActorRef } from "./types.js";

export const LAUNCH_PORTAL_WEBHOOK_EVENT_TYPE = "LISTING_STATUS_UPDATE";

export interface PublishListingResult {
  outboxStatus: "SENT" | "RETRY_SCHEDULED" | "DEAD_LETTERED";
  portalDestinationId: string;
}

/**
 * The outbound half of Proof A. Enqueues a portal.publishListing command
 * (through the real transactional outbox — Section 5) against an ACTIVE
 * mock portal connection, dispatches it once immediately (an admin action,
 * "publish now" — a background sweep would otherwise pick it up), and
 * reflects the outcome onto the destination through Launch's own
 * recordPortalSubmission/recordPortalFailure — never a direct write.
 */
export async function publishListingToMockPortal(portalDestinationId: string, brokerageId: number, connectionId: string, actor: ActorRef): Promise<PublishListingResult> {
  // Fail-closed check up front (Section 4) — resolveActiveConnection throws
  // IntegrationError for every disabled/unapproved/wrong-scope case; the
  // caller (routes/launch.ts's new action) turns that into the right HTTP
  // status, exactly like every other lib/*/model.ts error today.
  await resolveActiveConnection(brokerageId, connectionId, INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING);

  const destination = await loadPortalDestinationInBrokerage(portalDestinationId, brokerageId);

  const command = await enqueueCommand({
    brokerageId,
    connectionId,
    capability: INTEGRATION_CAPABILITIES.PORTAL_PUBLISH_LISTING,
    commandPayload: { portalDestinationId, portalName: destination.portalName },
    idempotencyKey: mintIdempotencyKey(`portal-publish:${portalDestinationId}`),
    sourceRecordType: "portal_destination",
    sourceRecordId: portalDestinationId,
  });

  const dispatched = await dispatchCommand(command.id);

  if (dispatched.status === "SENT") {
    await recordPortalSubmission(portalDestinationId, brokerageId, actor, undefined);
    return { outboxStatus: "SENT", portalDestinationId };
  }
  if (dispatched.status === "DEAD_LETTERED") {
    await recordPortalFailure(portalDestinationId, brokerageId, actor, dispatched.lastError ?? "The mock portal permanently rejected this submission.");
    return { outboxStatus: "DEAD_LETTERED", portalDestinationId };
  }
  // RETRY_SCHEDULED — a background dispatchDueOutbox sweep resolves this
  // later; the destination is deliberately left as-is (still
  // NOT_STARTED/READY_TO_SUBMIT) rather than guessing an interim status.
  return { outboxStatus: "RETRY_SCHEDULED", portalDestinationId };
}

const LIVE_TERMINAL_STATUSES = ["LIVE", "FAILED"];

/**
 * The inbound half of Proof A, registered once at bootstrap
 * (registerLaunchIntegrationHandlers below). Transforms the mock portal's
 * OWN status vocabulary (payload.status: "SUBMITTED" | "LIVE" | "REJECTED")
 * into a call on Launch's real service boundary — the raw payload never
 * reaches lib/launch code directly (Section 4's "transform before entering
 * domain workflows").
 */
async function applyListingStatusUpdate({ connection, inboxRow }: WebhookEffectContext): Promise<WebhookEffectResult> {
  const brokerageId = connection.brokerageId;
  const payload = inboxRow.payload as { portalDestinationId?: string; status?: string; listingUrl?: string; failureReason?: string };
  if (!payload.portalDestinationId || !payload.status) {
    throw new Error("Malformed mock portal webhook — missing portalDestinationId or status.");
  }

  const destination = await loadPortalDestinationInBrokerage(payload.portalDestinationId, brokerageId);

  // Out-of-order guard (Section 14): once a destination reached a terminal
  // status (LIVE or FAILED), an older/duplicate "still submitted" or
  // "still processing" event must never regress it — mirrors
  // communications/webhooks.ts's own applyDeliveryReceipt
  // "message.status !== SENT -> ignored as stale" precedent.
  if (LIVE_TERMINAL_STATUSES.includes(destination.status) && payload.status !== "LIVE") {
    return { summary: `Destination ${destination.id} is already ${destination.status} — stale/out-of-order event ignored.` };
  }

  if (payload.status === "LIVE") {
    if (destination.status === "LIVE") {
      return { summary: `Destination ${destination.id} is already LIVE — duplicate/replayed event, no further effect.` };
    }
    // Deliberately confirmPortalLive, NEVER confirmLaunchLive — see this
    // file's own header comment. A null actor records actorType SYSTEM
    // throughout (lib/launch/model.ts's emit()).
    await confirmPortalLive(payload.portalDestinationId, brokerageId, null, payload.listingUrl);
    return { summary: `Destination ${destination.id} confirmed LIVE via mock portal webhook.` };
  }

  if (payload.status === "REJECTED") {
    await recordPortalFailure(payload.portalDestinationId, brokerageId, null, payload.failureReason ?? "Mock portal reported this submission as rejected.");
    return { summary: `Destination ${destination.id} marked FAILED via mock portal webhook.` };
  }

  // "SUBMITTED" (an acknowledgement echo) — already SUBMITTED from the
  // outbound half; nothing further to apply, recorded for audit only.
  return { summary: `Mock portal acknowledged submission for destination ${destination.id} — no state change required.` };
}

let registered = false;
export function registerLaunchIntegrationHandlers(): void {
  if (registered) return; // idempotent, safe to call more than once (mirrors exceptions/engine.ts's own registerExceptionEventHandlers guard)
  registerWebhookEffectHandler(MOCK_PORTAL_PROVIDER_ID, LAUNCH_PORTAL_WEBHOOK_EVENT_TYPE, applyListingStatusUpdate);
  registered = true;
}

export function clearLaunchIntegrationHandlersForTesting(): void {
  registered = false;
}
