// t236u Tap-to-Call. Reuses the existing Grow consent tables
// (grow_contact_channel_consents, grow_contact_channel_suppressions,
// grow_contact_dncr_statuses); NO new table or migration.
//
// Rules (Owner t236u):
// - When an agent creates a contact they may confirm the contact agreed to be
//   called. One PHONE_CALL consent row records it: captured_at (timestamp),
//   recorded_by_user_id (confirming agent), evidence.restrictions (any
//   communication restrictions, free text), evidence.doNotCall (boolean).
// - No re-confirmation per call; nothing here dials. The client renders a
//   plain tel: link; the device's own dialler places the call.
// - The action is hidden when consent is withdrawn, absent, a do-not-call
//   restriction is recorded, an active PHONE_CALL suppression exists, or the
//   latest DNCR status is LISTED.
// - Calls are never recorded and never auto-marked complete. An optional
//   post-call note is a plain grow_activities row the agent chooses to add.
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  growActivities,
  growContactChannelConsents,
  growContactChannelSuppressions,
  growContactDncrStatuses,
  parties,
} from "@aee/db";

export const TAP_TO_CALL_CHANNEL = "PHONE_CALL";
export const CALL_CONSENT_SOURCE = "AGENT_CONFIRMATION";

export type TapToCallReason =
  | "AVAILABLE"
  | "NO_PHONE"
  | "NO_CONSENT"
  | "CONSENT_WITHDRAWN"
  | "DO_NOT_CALL"
  | "SUPPRESSED"
  | "DNCR_LISTED";

export interface TapToCallStatus {
  available: boolean;
  reason: TapToCallReason;
  /** Only when available. */
  telHref?: string;
  confirmedAt?: string;
  confirmedByUserId?: number;
  restrictions?: string | null;
}

export interface CallConsentInput {
  confirmed: boolean;
  restrictions?: string | null;
  doNotCall?: boolean;
}

/** tel: URI with only digits and a leading +; null when nothing dialable remains. */
export function telHrefFor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const digits = t.replace(/[^\d]/g, "");
  if (digits.length < 6) return null;
  return `tel:${t.startsWith("+") ? "+" : ""}${digits}`;
}

/** Records the creating agent's confirmation. No-op unless confirmed or a restriction is given. */
export async function recordCallConsentConfirmation(
  executor: Pick<typeof db, "insert">,
  input: { brokerageId: number; partyId: number; userId: number } & CallConsentInput,
): Promise<number | null> {
  const restrictions = input.restrictions?.trim() ? input.restrictions.trim().slice(0, 500) : null;
  if (!input.confirmed && !restrictions && !input.doNotCall) return null;
  const [row] = await executor
    .insert(growContactChannelConsents)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      channel: TAP_TO_CALL_CHANNEL,
      // An agent-confirmed agreement to be called is express consent. A
      // restriction-only record (not confirmed) is NONE: it never enables calling.
      state: input.confirmed ? "EXPRESS" : "NONE",
      source: CALL_CONSENT_SOURCE,
      captureMethod: "AGENT_CONFIRMED_ON_CONTACT_CREATE",
      purpose: "TAP_TO_CALL",
      scope: "PHONE_CALL",
      evidence: { restrictions, doNotCall: input.doNotCall === true },
      recordedByUserId: input.userId,
    })
    .returning({ id: growContactChannelConsents.id });
  return row?.id ?? null;
}

const ENABLING_STATES = ["EXPRESS", "INFERRED", "NOT_REQUIRED"];

export async function tapToCallStatus(brokerageId: number, partyId: number): Promise<TapToCallStatus | null> {
  const [party] = await db
    .select({ id: parties.id, mobile: parties.mobile })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)));
  if (!party) return null;
  const tel = telHrefFor(party.mobile);
  if (!tel) return { available: false, reason: "NO_PHONE" };

  const [consent] = await db
    .select()
    .from(growContactChannelConsents)
    .where(
      and(
        eq(growContactChannelConsents.brokerageId, brokerageId),
        eq(growContactChannelConsents.partyId, partyId),
        inArray(growContactChannelConsents.channel, ["PHONE_CALL", "VOICE_CALL"]),
      ),
    )
    .orderBy(desc(growContactChannelConsents.capturedAt), desc(growContactChannelConsents.id))
    .limit(1);
  const evidence = (consent?.evidence ?? {}) as { restrictions?: string | null; doNotCall?: boolean };
  if (consent && (consent.state === "WITHDRAWN" || consent.withdrawnAt)) return { available: false, reason: "CONSENT_WITHDRAWN" };
  if (evidence.doNotCall) return { available: false, reason: "DO_NOT_CALL", restrictions: evidence.restrictions ?? null };

  const [suppression] = await db
    .select({ state: growContactChannelSuppressions.state, expiresAt: growContactChannelSuppressions.expiresAt })
    .from(growContactChannelSuppressions)
    .where(
      and(
        eq(growContactChannelSuppressions.brokerageId, brokerageId),
        eq(growContactChannelSuppressions.partyId, partyId),
        inArray(growContactChannelSuppressions.channel, ["PHONE_CALL", "VOICE_CALL"]),
      ),
    )
    .orderBy(desc(growContactChannelSuppressions.effectiveAt), desc(growContactChannelSuppressions.id))
    .limit(1);
  if (suppression && suppression.state === "SUPPRESSED" && (!suppression.expiresAt || suppression.expiresAt > new Date())) {
    return { available: false, reason: "SUPPRESSED" };
  }

  const [dncr] = await db
    .select({ status: growContactDncrStatuses.status })
    .from(growContactDncrStatuses)
    .where(
      and(
        eq(growContactDncrStatuses.brokerageId, brokerageId),
        eq(growContactDncrStatuses.partyId, partyId),
        inArray(growContactDncrStatuses.channel, ["PHONE_CALL", "VOICE_CALL"]),
      ),
    )
    .orderBy(desc(growContactDncrStatuses.checkedAt), desc(growContactDncrStatuses.id))
    .limit(1);
  if (dncr?.status === "LISTED") return { available: false, reason: "DNCR_LISTED" };

  if (!consent || !ENABLING_STATES.includes(consent.state)) return { available: false, reason: "NO_CONSENT" };
  return {
    available: true,
    reason: "AVAILABLE",
    telHref: tel,
    confirmedAt: consent.capturedAt.toISOString(),
    confirmedByUserId: consent.recordedByUserId,
    restrictions: evidence.restrictions ?? null,
  };
}

/** Optional post-call note. Never a recording, never a completion. */
export async function addPostCallNote(input: { brokerageId: number; partyId: number; propertyId: number | null; userId: number; note: string; occurredAt?: Date }) {
  const [row] = await db
    .insert(growActivities)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      propertyId: input.propertyId,
      activityType: "call_note",
      occurredAt: input.occurredAt ?? new Date(),
      summary: input.note.trim().slice(0, 2000),
      details: { via: "tap_to_call", recorded: false, outcome: null },
      responsibleUserId: input.userId,
      source: "tap_to_call",
    })
    .returning();
  return row;
}
