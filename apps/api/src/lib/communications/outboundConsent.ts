// GP-4 (owner decision D2): fail-closed consent before any A-8 email or SMS
// leaves the composer, including before it is queued or handed to a mock
// provider.
//
// Two existing sources are consulted. Neither is weakened.
//
//   * Legacy communication_consent, keyed by (brokerage, normalised
//     destination, channel). checkConsent() still owns the marketing versus
//     transactional/service distinction.
//   * F2 grow_contact_channel_consents, plus DNCR and suppression rows, when
//     the recipient is a party this brokerage owns.
//
// A party-linked send needs both: a legacy row for the destination that
// checkConsent allows, and an affirmative F2 head (EXPRESS or INFERRED, not
// expired, not past review) on that channel. A destination change (#186)
// does not move the destination-keyed row, so the old F2 head is not enough.
// A manual recipient with no party keeps the legacy rule only, so a
// transactional/service message with no row stays allowed and a marketing
// message without marketingOptIn is refused.
//
// Missing, unknown, and thrown lookups refuse. Nothing is queued. DNC
// (LISTED on any channel, or an in-force suppression on the send channel)
// always refuses. The audit row records ids and the reason code only.

import { and, asc, desc, eq, lte } from "drizzle-orm";
import {
  db,
  communicationParticipants,
  communicationThreads,
  growContactChannelConsents,
  growContactChannelSuppressions,
  growContactDncrStatuses,
  parties,
  type CommunicationMessage,
  type GrowContactChannelConsent,
  type GrowContactDncrStatus,
} from "@aee/db";
import { logAudit } from "../audit.js";
import { checkConsent, type ConsentCheckResult } from "./consent.js";
import { CommunicationTenancyError, consentChannelFor, isDispatchedChannel, type CommunicationChannel, type CommunicationClassification } from "./types.js";

export const OUTBOUND_CONSENT_REQUIRED_MESSAGE = "Can't send: no recorded consent for this email/mobile.";
export const OUTBOUND_DNC_BLOCKED_MESSAGE = "Can't send: this contact is on the do-not-contact list.";

export type OutboundConsentCode = "CONSENT_REQUIRED" | "DNC_BLOCKED";

export type OutboundConsentReasonCode =
  | "NO_CONSENT_ROW"
  | "NO_F2_CONSENT"
  | "LEGACY_DENIED"
  | "DNC_LISTED"
  | "SUPPRESSED"
  | "DNCR_STATUS_UNKNOWN"
  | "LOOKUP_FAILED";

export class OutboundConsentRefused extends Error {
  readonly code: OutboundConsentCode;
  readonly statusCode = 409;
  readonly reasonCode: OutboundConsentReasonCode;

  constructor(code: OutboundConsentCode, reasonCode: OutboundConsentReasonCode, message: string) {
    super(message);
    this.name = "OutboundConsentRefused";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

interface OutboundConsentSnapshot {
  partyId: number | null;
  consent: ConsentCheckResult;
  f2Heads: GrowContactChannelConsent[];
  dncrByChannel: Map<string, GrowContactDncrStatus>;
  suppression: { id: number; state: string; expiresAt: Date | null } | null;
}

export interface OutboundConsentLoadInput {
  id: number;
  brokerageId: number;
  threadId: number;
  channel: string;
  classification: string;
  recipientDestination: string | null;
  recipientParticipantId: number | null;
  partyId: number | null;
}

/** Test seam. node:test mock.method replaces load so a thrown lookup fails closed. */
export const outboundConsentReads = {
  async load(message: OutboundConsentLoadInput): Promise<OutboundConsentSnapshot> {
    const channel = consentChannelFor(message.channel as CommunicationChannel);
    if (!channel) {
      throw new Error(`Channel ${message.channel} is dispatched but has no consent channel.`);
    }
    const partyId = await resolveRecipientPartyId(message);
    if (partyId != null) {
      const [party] = await db
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.id, partyId), eq(parties.brokerageId, message.brokerageId)))
        .limit(1);
      if (!party) throw new CommunicationTenancyError();
    }

    const destination = message.recipientDestination?.trim() ?? "";
    if (!destination) {
      return {
        partyId,
        consent: { allowed: false, reason: null, consent: null },
        f2Heads: [],
        dncrByChannel: new Map(),
        suppression: null,
      };
    }

    const consent = await checkConsent(
      message.brokerageId,
      message.channel as CommunicationChannel,
      destination,
      message.classification as CommunicationClassification,
    );

    if (partyId == null) {
      return { partyId: null, consent, f2Heads: [], dncrByChannel: new Map(), suppression: null };
    }

    const now = new Date();
    const [consentRows, dncrRows, suppressionRows] = await Promise.all([
      db
        .select()
        .from(growContactChannelConsents)
        .where(
          and(
            eq(growContactChannelConsents.brokerageId, message.brokerageId),
            eq(growContactChannelConsents.partyId, partyId),
            eq(growContactChannelConsents.channel, channel),
          ),
        )
        .orderBy(asc(growContactChannelConsents.id)),
      db
        .select()
        .from(growContactDncrStatuses)
        .where(and(eq(growContactDncrStatuses.brokerageId, message.brokerageId), eq(growContactDncrStatuses.partyId, partyId)))
        .orderBy(asc(growContactDncrStatuses.id)),
      db
        .select({
          id: growContactChannelSuppressions.id,
          state: growContactChannelSuppressions.state,
          expiresAt: growContactChannelSuppressions.expiresAt,
        })
        .from(growContactChannelSuppressions)
        .where(
          and(
            eq(growContactChannelSuppressions.brokerageId, message.brokerageId),
            eq(growContactChannelSuppressions.partyId, partyId),
            eq(growContactChannelSuppressions.channel, channel),
            lte(growContactChannelSuppressions.effectiveAt, now),
          ),
        )
        .orderBy(desc(growContactChannelSuppressions.id))
        .limit(1),
    ]);

    const heads = new Map<string, GrowContactChannelConsent>();
    for (const row of consentRows) heads.set(`${row.purpose}\0${row.scope}`, row);

    const dncrByChannel = new Map<string, GrowContactDncrStatus>();
    for (const row of dncrRows) dncrByChannel.set(row.channel, row);

    return {
      partyId,
      consent,
      f2Heads: [...heads.values()],
      dncrByChannel,
      suppression: suppressionRows[0] ?? null,
    };
  },
};

async function resolveRecipientPartyId(message: OutboundConsentLoadInput): Promise<number | null> {
  if (message.partyId != null) return message.partyId;
  if (message.recipientParticipantId == null) return null;
  // Participants have no brokerage_id. A row counts only when it sits on
  // this message's thread and that thread belongs to this brokerage.
  // A miss throws CommunicationTenancyError, so the send is refused
  // before the legacy no-party consent path.
  const [participant] = await db
    .select({ partyId: communicationParticipants.partyId })
    .from(communicationParticipants)
    .innerJoin(communicationThreads, eq(communicationThreads.id, communicationParticipants.threadId))
    .where(
      and(
        eq(communicationParticipants.id, message.recipientParticipantId),
        eq(communicationParticipants.threadId, message.threadId),
        eq(communicationThreads.id, message.threadId),
        eq(communicationThreads.brokerageId, message.brokerageId),
      ),
    )
    .limit(1);
  if (!participant) throw new CommunicationTenancyError();
  return participant.partyId ?? null;
}

function f2HeadIsAffirmative(row: GrowContactChannelConsent, now: Date): boolean {
  if (row.state !== "EXPRESS" && row.state !== "INFERRED") return false;
  if (row.expiresAt != null && row.expiresAt.getTime() <= now.getTime()) return false;
  if (row.reviewAt != null && row.reviewAt.getTime() <= now.getTime()) return false;
  return true;
}

function suppressionInForce(row: { state: string; expiresAt: Date | null } | null, now: Date): boolean {
  if (!row) return false;
  if (row.state === "RELEASED") return false;
  if (row.expiresAt != null && row.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

interface Refusal {
  code: OutboundConsentCode;
  reasonCode: OutboundConsentReasonCode;
  partyId: number | null;
  legacyConsentId: number | null;
  f2ConsentId: number | null;
  dncrStatusId: number | null;
}

function decide(snapshot: OutboundConsentSnapshot, classification: string, channel: string): Refusal | null {
  const now = new Date();
  const legacyConsentId = snapshot.consent.consent?.id ?? null;
  const affirmative = snapshot.f2Heads.filter((row) => f2HeadIsAffirmative(row, now));
  const f2ConsentId = (affirmative.at(-1) ?? snapshot.f2Heads.at(-1))?.id ?? null;
  const sendDncr = snapshot.dncrByChannel.get(channel) ?? null;

  if (snapshot.partyId != null) {
    for (const dncr of snapshot.dncrByChannel.values()) {
      if (dncr.status === "LISTED") {
        return {
          code: "DNC_BLOCKED",
          reasonCode: "DNC_LISTED",
          partyId: snapshot.partyId,
          legacyConsentId,
          f2ConsentId,
          dncrStatusId: dncr.id,
        };
      }
    }
    if (suppressionInForce(snapshot.suppression, now)) {
      return {
        code: "DNC_BLOCKED",
        reasonCode: "SUPPRESSED",
        partyId: snapshot.partyId,
        legacyConsentId,
        f2ConsentId,
        dncrStatusId: sendDncr?.id ?? null,
      };
    }
    if (sendDncr?.status === "UNKNOWN") {
      return {
        code: "CONSENT_REQUIRED",
        reasonCode: "DNCR_STATUS_UNKNOWN",
        partyId: snapshot.partyId,
        legacyConsentId,
        f2ConsentId,
        dncrStatusId: sendDncr.id,
      };
    }
    if (!snapshot.consent.consent) {
      return {
        code: "CONSENT_REQUIRED",
        reasonCode: "NO_CONSENT_ROW",
        partyId: snapshot.partyId,
        legacyConsentId: null,
        f2ConsentId,
        dncrStatusId: sendDncr?.id ?? null,
      };
    }
    if (!snapshot.consent.allowed) {
      return {
        code: "CONSENT_REQUIRED",
        reasonCode: "LEGACY_DENIED",
        partyId: snapshot.partyId,
        legacyConsentId,
        f2ConsentId,
        dncrStatusId: sendDncr?.id ?? null,
      };
    }
    if (affirmative.length === 0) {
      return {
        code: "CONSENT_REQUIRED",
        reasonCode: "NO_F2_CONSENT",
        partyId: snapshot.partyId,
        legacyConsentId,
        f2ConsentId,
        dncrStatusId: sendDncr?.id ?? null,
      };
    }
    return null;
  }

  if (snapshot.consent.allowed) return null;
  return {
    code: "CONSENT_REQUIRED",
    reasonCode: snapshot.consent.consent ? "LEGACY_DENIED" : classification === "MARKETING" ? "NO_CONSENT_ROW" : "LEGACY_DENIED",
    partyId: null,
    legacyConsentId,
    f2ConsentId: null,
    dncrStatusId: null,
  };
}

function publicSentence(code: OutboundConsentCode): string {
  return code === "DNC_BLOCKED" ? OUTBOUND_DNC_BLOCKED_MESSAGE : OUTBOUND_CONSENT_REQUIRED_MESSAGE;
}

async function writeBlockedAudit(
  message: OutboundConsentLoadInput,
  actorUserId: number | null,
  refusal: Pick<Refusal, "code" | "reasonCode" | "partyId" | "legacyConsentId" | "f2ConsentId" | "dncrStatusId">,
): Promise<void> {
  const updatedValue = JSON.stringify({
    code: refusal.code,
    reasonCode: refusal.reasonCode,
    channel: message.channel,
    messageId: message.id,
    partyId: refusal.partyId,
    legacyConsentId: refusal.legacyConsentId,
    f2ConsentId: refusal.f2ConsentId,
    dncrStatusId: refusal.dncrStatusId,
  });
  await logAudit({
    brokerageId: message.brokerageId,
    userId: actorUserId,
    action: "communication_send_blocked",
    recordType: "communication_message",
    recordId: String(message.id),
    updatedValue,
  });
}

/**
 * Refuse an EMAIL/SMS send that does not have affirmative consent for its
 * destination and channel. Record-only channels return without a lookup.
 * A cross-brokerage party is CommunicationTenancyError (404, no audit).
 * Any other lookup failure is audited as LOOKUP_FAILED and refused.
 */
export async function assertMessageMayLeave(message: CommunicationMessage, actorUserId: number | null): Promise<void> {
  if (!isDispatchedChannel(message.channel as CommunicationChannel)) return;

  const input: OutboundConsentLoadInput = {
    id: message.id,
    brokerageId: message.brokerageId,
    threadId: message.threadId,
    channel: message.channel,
    classification: message.classification,
    recipientDestination: message.recipientDestination,
    recipientParticipantId: message.recipientParticipantId,
    partyId: message.partyId,
  };

  let snapshot: OutboundConsentSnapshot;
  try {
    snapshot = await outboundConsentReads.load(input);
  } catch (err) {
    if (err instanceof CommunicationTenancyError) throw err;
    await writeBlockedAudit(input, actorUserId, {
      code: "CONSENT_REQUIRED",
      reasonCode: "LOOKUP_FAILED",
      partyId: message.partyId,
      legacyConsentId: null,
      f2ConsentId: null,
      dncrStatusId: null,
    });
    throw new OutboundConsentRefused("CONSENT_REQUIRED", "LOOKUP_FAILED", OUTBOUND_CONSENT_REQUIRED_MESSAGE);
  }

  const refusal = decide(snapshot, message.classification, consentChannelFor(message.channel as CommunicationChannel)!);
  if (!refusal) return;
  await writeBlockedAudit(input, actorUserId, refusal);
  throw new OutboundConsentRefused(refusal.code, refusal.reasonCode, publicSentence(refusal.code));
}
