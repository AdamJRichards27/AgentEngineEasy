// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Consent and opt-out enforcement (Section 16). Rules are configurable
// per-brokerage, never hardcoded legal exemptions:
//   - MARKETING requires an explicit marketingOptIn = true consent record.
//     No record at all is treated as NOT opted in (safe default).
//   - TRANSACTIONAL / SERVICE are implicitly permitted unless the
//     destination has transactionalOptOut = true recorded AND the
//     brokerage's settings.transactionalOptOutAllowed permits that opt-out
//     to actually block a send (some jurisdictions do not allow opting out
//     of genuinely transactional/service communication — this knob is
//     where that policy is set, not baked into this function).
//
// Every check and every consent write is logged to the shared audit log
// (Section 35: security/privacy — consent decisions must be traceable) and
// publishes COMMUNICATION_CONSENT_UPDATED so downstream consumers (the
// Exception & Risk Engine, the Workflow Automation Engine) can react.

import { and, eq } from "drizzle-orm";
import { db, communicationConsent, type CommunicationConsent } from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { logAudit } from "../audit.js";
import { getOrCreateCommunicationSettings } from "./settings.js";
import type { CommunicationChannel, CommunicationClassification } from "./types.js";
import { consentChannelFor } from "./types.js";

export function normalizeDestination(channel: "EMAIL" | "SMS", raw: string): string {
  const trimmed = raw.trim();
  if (channel === "EMAIL") return trimmed.toLowerCase();
  // Light phone normalisation: strip everything but digits and a leading +.
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  return hasPlus ? `+${digits}` : digits;
}

export interface ConsentCheckResult {
  allowed: boolean;
  reason: string | null;
  consent: CommunicationConsent | null;
}

/**
 * The single gate every outbound EMAIL/SMS message passes through before
 * it can leave DRAFT/QUEUED (Section 16, Section 20 step 2 — "validate").
 * PHONE_CALL / EXTERNAL_MESSAGE / INTERNAL_NOTE carry no consent record and
 * are always allowed here — INTERNAL_NOTE never leaves the app at all, and
 * PHONE_CALL/EXTERNAL_MESSAGE are records of something that already
 * happened outside this app, not a send this app is about to perform.
 */
export async function checkConsent(
  brokerageId: number,
  channel: CommunicationChannel,
  destinationRaw: string,
  classification: CommunicationClassification,
): Promise<ConsentCheckResult> {
  const consentChannel = consentChannelFor(channel);
  if (!consentChannel) return { allowed: true, reason: null, consent: null };

  const destination = normalizeDestination(consentChannel, destinationRaw);
  const [consent] = await db
    .select()
    .from(communicationConsent)
    .where(and(eq(communicationConsent.brokerageId, brokerageId), eq(communicationConsent.destination, destination), eq(communicationConsent.channel, consentChannel)));

  if (classification === "MARKETING") {
    if (!consent?.marketingOptIn) {
      return { allowed: false, reason: "This recipient has not opted in to marketing communications.", consent: consent ?? null };
    }
    return { allowed: true, reason: null, consent };
  }

  // TRANSACTIONAL / SERVICE.
  if (consent?.transactionalOptOut) {
    const settings = await getOrCreateCommunicationSettings(brokerageId);
    if (settings.transactionalOptOutAllowed) {
      return { allowed: false, reason: "This recipient has opted out of transactional/service communications.", consent };
    }
  }
  return { allowed: true, reason: null, consent: consent ?? null };
}

export interface RecordConsentInput {
  brokerageId: number;
  partyId?: number | null;
  channel: "EMAIL" | "SMS";
  destination: string;
  marketingOptIn?: boolean;
  transactionalOptOut?: boolean;
  source: "MANUAL" | "WEBHOOK_REPLY_STOP" | "INITIAL_CAPTURE" | "IMPORTED";
  recordedByUserId?: number | null;
  notes?: string | null;
}

export async function recordConsent(input: RecordConsentInput): Promise<CommunicationConsent> {
  const destination = normalizeDestination(input.channel, input.destination);
  const [existing] = await db
    .select()
    .from(communicationConsent)
    .where(and(eq(communicationConsent.brokerageId, input.brokerageId), eq(communicationConsent.destination, destination), eq(communicationConsent.channel, input.channel)));

  const patch = {
    partyId: input.partyId ?? existing?.partyId ?? null,
    marketingOptIn: input.marketingOptIn ?? existing?.marketingOptIn ?? false,
    transactionalOptOut: input.transactionalOptOut ?? existing?.transactionalOptOut ?? false,
    source: input.source,
    recordedByUserId: input.recordedByUserId ?? null,
    notes: input.notes ?? null,
    updatedAt: new Date(),
  };

  const row = existing
    ? (await db.update(communicationConsent).set(patch).where(eq(communicationConsent.id, existing.id)).returning())[0]
    : (
        await db
          .insert(communicationConsent)
          .values({ brokerageId: input.brokerageId, destination, channel: input.channel, ...patch })
          .returning()
      )[0];

  await logAudit({
    userId: input.recordedByUserId ?? undefined,
    action: "communication_consent_updated",
    recordType: "communication_consent",
    recordId: String(row.id),
    updatedValue: `marketingOptIn=${row.marketingOptIn},transactionalOptOut=${row.transactionalOptOut}`,
  });

  await publishDomainEvent({
    eventType: "COMMUNICATION_CONSENT_UPDATED",
    occurredAt: new Date(),
    propertyId: null,
    transactionId: null,
    partyId: row.partyId,
    brokerageId: input.brokerageId,
    agentId: null,
    actorType: input.source === "WEBHOOK_REPLY_STOP" ? "SYSTEM" : "USER",
    actorId: input.recordedByUserId ?? null,
    source: `communications:consent:${input.source.toLowerCase()}`,
    correlationId: newCorrelationId(),
    causationId: null,
    idempotencyKey: null,
    payload: { consentId: row.id, channel: row.channel, marketingOptIn: row.marketingOptIn, transactionalOptOut: row.transactionalOptOut },
    metadata: {},
  }).catch((err) => console.error("publishDomainEvent(COMMUNICATION_CONSENT_UPDATED) failed", err));

  return row;
}
