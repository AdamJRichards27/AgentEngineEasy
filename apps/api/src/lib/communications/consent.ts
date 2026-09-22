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
// (Section 35: security/privacy — consent decisions must be traceable).
// The legacy consent mutation and its before/after audit row commit in one
// transaction. COMMUNICATION_CONSENT_UPDATED is published only after that
// transaction commits, so an audit failure rolls the consent change back
// and never announces a change that did not commit. Downstream consumers
// (the Exception & Risk Engine, the Workflow Automation Engine) still react
// to that same event.

import { and, eq } from "drizzle-orm";
import { auditLogs, db, communicationConsent, parties, type CommunicationConsent } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit, type AuditLogInput } from "../audit.js";
import { getOrCreateCommunicationSettings } from "./settings.js";
import type { CommunicationChannel, CommunicationClassification } from "./types.js";
import { consentChannelFor, isDispatchedChannel } from "./types.js";

/**
 * AE GROW W1-A (A-5): a consent write named a party the caller's brokerage
 * does not own. Raised BEFORE any row is written or any event published, so
 * a rejected write leaves no trace of the foreign party id anywhere — not on
 * the consent row, and not in the (brokerageId, partyId) pair
 * COMMUNICATION_CONSENT_UPDATED carries onto the event bus.
 *
 * A distinct error type (rather than reusing CommunicationTenancyError,
 * which routes/communications.ts maps to 404 "not found") because this is a
 * malformed request body, not an unreachable resource: the caller supplied a
 * partyId that is not theirs to name, which is a 400.
 */
export class CommunicationConsentPartyError extends Error {
  constructor(message = "That contact does not belong to your brokerage.") {
    super(message);
    this.name = "CommunicationConsentPartyError";
  }
}

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
  if (!consentChannel) {
    // AE GROW W1-A (A-3 hardening): outbox.ts's dispatchMessage() now leans
    // on this function as the last gate before a provider call, so "no
    // consent channel" must never silently become "allowed" for a channel
    // this app actually dispatches. Today no dispatched channel maps to
    // null; if one is ever added without a consent mapping, fail loudly here
    // instead of reopening the bypass A-3 closed. (The permissive return for
    // the genuinely record-only channels is tracked separately as A-P2-3.)
    if (isDispatchedChannel(channel)) {
      throw new Error(`Channel ${channel} is dispatched through a provider but has no consent channel mapping.`);
    }
    return { allowed: true, reason: null, consent: null };
  }

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

/** The audit/event shape of a consent record's two decision-bearing fields. */
function describeConsentState(state: { marketingOptIn: boolean; transactionalOptOut: boolean } | null | undefined): string {
  if (!state) return "none";
  return `marketingOptIn=${state.marketingOptIn},transactionalOptOut=${state.transactionalOptOut}`;
}

type ConsentDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function writeConsentAudit(tx: ConsentDbTransaction, input: AuditLogInput): Promise<void> {
  await tx.insert(auditLogs).values(input);
}

export async function recordConsent(input: RecordConsentInput): Promise<CommunicationConsent> {
  // AE GROW W1-A (A-5): partyId arrives straight off the request body at
  // routes/communications.ts's POST /communications/consent and used to be
  // written through unchecked, stamping a foreign tenant's party id onto
  // this brokerage's consent row and then emitting that mismatched
  // (brokerageId, partyId) pair on the event bus below. Validate it against
  // the caller's own brokerage before any consent write or publish, so a
  // rejected request changes nothing at all.
  const destination = normalizeDestination(input.channel, input.destination);

  // AE GROW W1-A (A-4): consent is still mutated in place (the schema
  // redesign that would keep a full consent history belongs to the later
  // model-reconciliation slice), so the audit entry is the only record of
  // what the value was before this change. The prior state is read from the
  // same transaction as the update/insert ("none" means there was no consent
  // row at all until this write created one) and the audit insert uses the
  // strict transaction-owned writer. An audit failure aborts the transaction,
  // which rolls the consent mutation back with it. The domain event is
  // published only after commit, from the committed row.
  const row = await db.transaction(async (tx) => {
    if (input.partyId != null) {
      const [party] = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.id, input.partyId), eq(parties.brokerageId, input.brokerageId)));
      if (!party) throw new CommunicationConsentPartyError();
    }

    const [existing] = await tx
      .select()
      .from(communicationConsent)
      .where(and(eq(communicationConsent.brokerageId, input.brokerageId), eq(communicationConsent.destination, destination), eq(communicationConsent.channel, input.channel)))
      .for("update");

    const patch = {
      partyId: input.partyId ?? existing?.partyId ?? null,
      marketingOptIn: input.marketingOptIn ?? existing?.marketingOptIn ?? false,
      transactionalOptOut: input.transactionalOptOut ?? existing?.transactionalOptOut ?? false,
      source: input.source,
      recordedByUserId: input.recordedByUserId ?? null,
      notes: input.notes ?? null,
      updatedAt: new Date(),
    };

    const written = existing
      ? (await tx.update(communicationConsent).set(patch).where(eq(communicationConsent.id, existing.id)).returning())[0]
      : (
          await tx
            .insert(communicationConsent)
            .values({ brokerageId: input.brokerageId, destination, channel: input.channel, ...patch })
            .returning()
        )[0];

    await logAudit(
      {
        brokerageId: input.brokerageId,
        userId: input.recordedByUserId ?? undefined,
        action: "communication_consent_updated",
        recordType: "communication_consent",
        recordId: String(written.id),
        previousValue: describeConsentState(existing),
        updatedValue: describeConsentState(written),
      },
      { strict: true, write: (auditInput) => writeConsentAudit(tx, auditInput) },
    );

    return written;
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
    correlationId: currentCorrelationId(),
    causationId: null,
    idempotencyKey: null,
    payload: { consentId: row.id, channel: row.channel, marketingOptIn: row.marketingOptIn, transactionalOptOut: row.transactionalOptOut },
    metadata: {},
  }).catch((err) => logger.error("publish_domain_event_failed", { eventType: "COMMUNICATION_CONSENT_UPDATED", consentId: row.id, error: err instanceof Error ? err.message : String(err) }));

  return row;
}
