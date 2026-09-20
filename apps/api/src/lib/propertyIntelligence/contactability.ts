import { sql } from "drizzle-orm";
import { db, GROW_CONSENT_CHANNELS } from "@aee/db";

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 1 — contactability filter
 * (MINIMUM DEPENDENCY, READ-ONLY).
 *
 * WHAT THIS IS. One small, documented seam that answers a single question:
 * "is there already a recorded reason not to put this contact in front of an
 * agent as a prospecting suggestion?" The sweep consults it before raising or
 * refreshing any party-linked signal.
 *
 * WHAT THIS IS NOT. It is not a consent decision. It does not resolve a
 * consent policy, does not pick a channel, does not write a
 * grow_consent_decisions row, and never writes anything at all — the F2
 * consent model's own writers (lib/consentControlsPersistence.ts) stay the
 * sole writers, and today they are only reachable from telephony. A later
 * consent phase extends THIS function; nothing else in the sweep knows the
 * consent tables exist.
 *
 * THE TWO CONDITIONS (deliberately the minimum that is unambiguous):
 *
 *   1. DNC listed. The latest grow_contact_dncr_statuses row for this
 *      contact on ANY channel has status LISTED. DNCR is recorded per
 *      channel; "listed on at least one channel" is the conservative read,
 *      and conservative is the correct direction for a suggestion surface.
 *      CLEARED / UNKNOWN / NOT_CHECKED never suppress anything.
 *
 *   2. Fully suppressed. The latest grow_contact_channel_suppressions row
 *      for this contact is an in-force SUPPRESSED (state SUPPRESSED and
 *      either no expiry or an expiry still in the future) on EVERY channel
 *      in GROW_CONSENT_CHANNELS. A partial suppression — say SMS only —
 *      deliberately does NOT hide the signal: the agent can still reach that
 *      contact another way, and hiding it would silently lose information
 *      they are entitled to see. Only a contact suppressed everywhere is
 *      withheld.
 *
 * THE COMMON PILOT CASE IS "NO DATA". Neither table has any rows for most
 * tenants today (their only writers are on the telephony path). Absence of
 * consent data therefore changes nothing at all: no DNC row means not
 * LISTED, no suppression row means not suppressed-everywhere, and the
 * contact's signals behave exactly as they did before this filter existed.
 *
 * COST. Two statements per batch of parties, regardless of how many parties
 * are in the batch — DISTINCT ON does the "latest per (party, channel)"
 * reduction in the database. Batches are chunked only to keep a single bind
 * parameter array sane.
 */

/** Parties per statement. Two statements per chunk; 2,000 parties is one chunk. */
export const CONTACTABILITY_CHUNK_SIZE = 5000;

export interface ContactabilityFilter {
  /** Party ids that must not have a signal raised or refreshed for them this run. */
  readonly suppressedPartyIds: ReadonlySet<number>;
  /** Convenience predicate; a null partyId (an observation-derived, property-only signal) is never suppressed — there is no contact to protect. */
  isSuppressed(partyId: number | null): boolean;
}

const EMPTY_FILTER: ContactabilityFilter = {
  suppressedPartyIds: new Set<number>(),
  isSuppressed: () => false,
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Loads the contactability filter for one brokerage and a bounded set of
 * party ids. Always brokerage-scoped: a party id from another tenant simply
 * matches nothing, and no other tenant's consent rows are ever read.
 */
export async function loadContactabilityFilter(brokerageId: number, partyIds: Array<number | null>): Promise<ContactabilityFilter> {
  // Number.isInteger is not defensive theatre: these ids are interpolated
  // into an array literal below (a bind parameter cannot carry an int[] here
  // without a driver-specific array codec), so only genuine integers may
  // ever reach that string.
  const ids = [...new Set(partyIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id)))];
  if (ids.length === 0) return EMPTY_FILTER;

  const now = new Date();
  const suppressed = new Set<number>();

  for (const batch of chunk(ids, CONTACTABILITY_CHUNK_SIZE)) {
    const idArray = sql`${sql.raw(`array[${batch.join(",")}]::int[]`)}`;

    // Condition 1 — latest DNC status per (party, channel); LISTED on any
    // channel suppresses.
    const dncr = await db.execute<{ party_id: number }>(sql`
      select distinct on (party_id, channel) party_id, status
      from grow_contact_dncr_statuses
      where brokerage_id = ${brokerageId} and party_id = any(${idArray})
      order by party_id, channel, checked_at desc, id desc
    `);
    for (const row of dncr.rows as Array<{ party_id: number; status: string }>) {
      if (row.status === "LISTED") suppressed.add(Number(row.party_id));
    }

    // Condition 2 — latest suppression per (party, channel); suppressed on
    // EVERY channel suppresses. The channel count is compared in JS against
    // GROW_CONSENT_CHANNELS so the rule stays readable and so adding a
    // channel to that list cannot silently change SQL semantics.
    const suppressions = await db.execute<{ party_id: number; channel: string; state: string; expires_at: string | null }>(sql`
      select distinct on (party_id, channel) party_id, channel, state, expires_at
      from grow_contact_channel_suppressions
      where brokerage_id = ${brokerageId} and party_id = any(${idArray})
      order by party_id, channel, effective_at desc, id desc
    `);
    const activeChannelsByParty = new Map<number, Set<string>>();
    for (const row of suppressions.rows as Array<{ party_id: number; channel: string; state: string; expires_at: string | Date | null }>) {
      if (row.state !== "SUPPRESSED") continue;
      if (row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime()) continue; // lapsed suppression is not in force
      const partyId = Number(row.party_id);
      const set = activeChannelsByParty.get(partyId) ?? new Set<string>();
      set.add(row.channel);
      activeChannelsByParty.set(partyId, set);
    }
    for (const [partyId, channels] of activeChannelsByParty) {
      if (GROW_CONSENT_CHANNELS.every((c) => channels.has(c))) suppressed.add(partyId);
    }
  }

  return {
    suppressedPartyIds: suppressed,
    isSuppressed: (partyId: number | null) => partyId !== null && suppressed.has(partyId),
  };
}
