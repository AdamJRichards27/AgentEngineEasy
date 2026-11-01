// t236u Tap-to-Call. Reuses the existing Grow consent tables
// (grow_contact_channel_consents, grow_contact_channel_suppressions,
// grow_contact_dncr_statuses); NO new table or migration.
//
// t239u (Owner, FINAL) supersedes the t236u consent gating: the tel: link is
// shown whenever the authorised caller can access a phone number; nothing here
// dials, records or completes a call. Consent capture (recordCallConsentConfirmation)
// is kept as optional record-keeping only and is never read for gating.
import { and, eq } from "drizzle-orm";
import {
  db,
  growActivities,
  growContactChannelConsents,
  parties,
} from "@aee/db";

export const TAP_TO_CALL_CHANNEL = "PHONE_CALL";
export const CALL_CONSENT_SOURCE = "AGENT_CONFIRMATION";

export type TapToCallReason = "AVAILABLE" | "NO_PHONE";

export interface TapToCallStatus {
  available: boolean;
  reason: TapToCallReason;
  /** Only when available. */
  telHref?: string;
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

// t239u (Owner, FINAL): the Call action is shown for every phone number the
// authorised caller can access. Consent, withdrawn consent, do-not-call,
// suppression, DNCR and communication preferences are NOT read here and never
// block, warn or ask for confirmation; the agent is responsible for compliance.
// Existing consent/preference rows are left untouched (no delete, no backfill).
// Access control is unchanged: the route still requires auth plus
// grow.contacts.manage or run.access, and the party must be in the caller's
// brokerage (otherwise null -> 404, no number).
export async function tapToCallStatus(brokerageId: number, partyId: number): Promise<TapToCallStatus | null> {
  const [party] = await db
    .select({ id: parties.id, mobile: parties.mobile })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)));
  if (!party) return null;
  const tel = telHrefFor(party.mobile);
  if (!tel) return { available: false, reason: "NO_PHONE" };
  return { available: true, reason: "AVAILABLE", telHref: tel };
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
