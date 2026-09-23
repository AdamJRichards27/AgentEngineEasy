import { sql } from "drizzle-orm";
import { db, GROW_CONSENT_CHANNELS, GROW_CONSENT_SUPPRESSION_STATES } from "@aee/db";
import { logger } from "@aee/events";

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
 * "LATEST ROW" MEANS WHAT THE CONSENT MODEL SAYS IT MEANS.
 * lib/consentControlsPersistence.ts is the canonical resolver for these two
 * tables, and its definition of the current row is SERIAL id DESC — because
 * checked_at / effective_at / captured_at are CALLER-SUPPLIED evidence
 * metadata, while the serial id is the append order and therefore the only
 * ordering the database itself guarantees. It additionally requires a
 * suppression to be in force (effective_at <= now) before it counts at all.
 * This module follows that definition exactly rather than inventing a second
 * one. It previously ordered by the caller-supplied timestamps, which
 * diverged in the UNSAFE direction: a contact suppressed on every channel and
 * then given a RELEASED row dated in the FUTURE stayed blocked for the
 * consent engine while this filter read them as released and raised their
 * signal.
 *
 * THE TWO CONDITIONS (deliberately the minimum that is unambiguous):
 *
 *   1. DNC listed or unknown. The latest grow_contact_dncr_statuses row for
 *      this contact on ANY channel has status LISTED or UNKNOWN. DNCR is
 *      recorded per channel; "blocked on at least one channel" is the
 *      conservative read, and conservative is the correct direction for a
 *      suggestion surface.
 *
 *      UNKNOWN FAILS CLOSED, and that is not the same thing as missing data.
 *      An UNKNOWN row means somebody CHECKED the register and could not
 *      determine the answer — the consent engine treats exactly that as
 *      DNCR_STATUS_UNKNOWN and refuses to proceed. NOT_CHECKED (nobody has
 *      looked yet) and CLEARED do not suppress.
 *
 *   2. Fully suppressed. The latest in-force grow_contact_channel_suppressions
 *      row for this contact suppresses EVERY channel in
 *      GROW_CONSENT_CHANNELS. "In force" is effective_at <= now and either no
 *      expiry or an expiry still in the future. "Suppresses" is any state
 *      other than the one recognised release state: a state this build does
 *      not recognise (a corrupted value, or an enum value added by a newer
 *      build writing into the same database) must never silently UN-suppress
 *      a channel. A partial suppression — say SMS only — deliberately does
 *      NOT hide the signal: the agent can still reach that contact another
 *      way, and hiding it would silently lose information they are entitled
 *      to see. Only a contact suppressed everywhere is withheld.
 *
 * THE COMMON PILOT CASE IS "NO DATA", AND IT IS NOT A FAILURE. Neither table
 * has any rows for most tenants today (their only writers are on the
 * telephony path). Absence of consent data therefore changes nothing at all:
 * no DNC row means not LISTED and not UNKNOWN, no suppression row means not
 * suppressed-everywhere, and the contact's signals behave exactly as they did
 * before this filter existed. The fail-closed rules above apply only to a row
 * that EXISTS and says something this build cannot interpret as permissive —
 * failing closed on genuinely absent data would suppress every contact in
 * every pilot tenant, which is the opposite of conservative.
 *
 * COST. Two statements per batch of parties, regardless of how many parties
 * are in the batch — DISTINCT ON does the "latest per (party, channel)"
 * reduction in the database. Batches are chunked only to keep a single bind
 * parameter array sane. I-16: the id list is de-duplicated before it is
 * chunked, so a party handed in more than once (Grow Today concatenates
 * overlapping rule reads; the sweep can repeat a party) is one bind slot
 * and cannot land in a second chunk. The two statements in a chunk read
 * different tables, share no state, and issue together. Chunks stay serial:
 * a second chunk is 5,000 distinct parties, and parallel chunks are not
 * worth the extra pool pressure.
 */

/** Parties per statement. Two statements per chunk; 5,000 parties is one chunk. */
export const CONTACTABILITY_CHUNK_SIZE = 5000;

/**
 * DNCR statuses that suppress. LISTED is on the register; UNKNOWN means the
 * register WAS consulted and could not answer, which
 * lib/consentControlsPersistence.ts also refuses to proceed on
 * (DNCR_STATUS_UNKNOWN). NOT_CHECKED and CLEARED do not suppress.
 */
export const CONTACTABILITY_BLOCKING_DNCR_STATUSES: ReadonlySet<string> = new Set(["LISTED", "UNKNOWN"]);

/** The one suppression state that releases a channel. Everything else — including a value this build does not recognise — suppresses it. */
const RELEASE_STATE = "RELEASED";
const KNOWN_SUPPRESSION_STATES: ReadonlySet<string> = new Set(GROW_CONSENT_SUPPRESSION_STATES);

/** Distinct unrecognised suppression states already reported, so a corrupted column cannot flood the log. Process-local and purely diagnostic. */
const reportedUnrecognisedStates = new Set<string>();

function reportUnrecognisedSuppressionState(state: string): void {
  if (reportedUnrecognisedStates.has(state)) return;
  reportedUnrecognisedStates.add(state);
  // The state value is a schema constant, never tenant content; no ids are
  // logged here at all.
  logger.warn("property_signal_contactability_unrecognised_suppression_state", { state, treatedAs: "SUPPRESSED" });
}

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
  // I-16 — one evaluation per id, before chunk(). Nulls and non-integers are
  // not party ids. Set preserves first-seen order, which is what chunk
  // boundaries are then computed from.
  const ids = [...new Set(partyIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id)))];
  if (ids.length === 0) return EMPTY_FILTER;

  const now = new Date();
  const suppressed = new Set<number>();

  for (const batch of chunk(ids, CONTACTABILITY_CHUNK_SIZE)) {
    // ONE bind parameter (a JSON array expanded server-side), not N
    // parameters and not string concatenation. The statement text is then
    // identical whatever the batch contains, and no party id ever reaches the
    // SQL text — the same technique persistence.ts uses for its dedupe-key
    // set. (This used to build `array[1,2,3]::int[]` by joining the ids into
    // the statement, which was safe only because of the Number.isInteger
    // filter above and stayed safe only for as long as nobody removed it.)
    const idArray = sql`array(select jsonb_array_elements_text(${JSON.stringify(batch)}::jsonb)::int)`;

    // AE GROW COMPLETION PROGRAM W2-A (I-16) — THE TWO CONDITIONS NOW RUN
    // TOGETHER. They read different tables, share no state, and neither one's
    // result influences the other's query: running them one after the other
    // simply paid two network round trips where one would do, on the hot path
    // of the endpoint every agent loads every morning. The set-building below
    // is unchanged, and `suppressed` is still only written after both have
    // resolved, so the ordering of the two has no bearing on the result.
    const [dncr, suppressions] = await Promise.all([
      // Condition 1 — current DNC status per (party, channel) by SERIAL id,
      // matching consentControlsPersistence.latestDncr(). LISTED (on the
      // register) or UNKNOWN (checked, undeterminable) on any channel
      // suppresses; NOT_CHECKED and CLEARED do not.
      db.execute<{ party_id: number; status: string }>(sql`
        select distinct on (party_id, channel) party_id, status
        from grow_contact_dncr_statuses
        where brokerage_id = ${brokerageId} and party_id = any(${idArray})
        order by party_id, channel, id desc
      `),
      // Condition 2 — current suppression per (party, channel) by SERIAL id,
      // considering only rows already IN FORCE, matching
      // consentControlsPersistence.latestSuppression(). Without the
      // effective_at filter a RELEASED row dated in the future would read as
      // the current state here while the consent engine still treated the
      // party as suppressed. The channel count is compared in JS against
      // GROW_CONSENT_CHANNELS so the rule stays readable and so adding a
      // channel to that list cannot silently change SQL semantics.
      db.execute<{ party_id: number; channel: string; state: string; expires_at: string | null }>(sql`
        select distinct on (party_id, channel) party_id, channel, state, expires_at
        from grow_contact_channel_suppressions
        where brokerage_id = ${brokerageId}
          and party_id = any(${idArray})
          and effective_at <= now()
        order by party_id, channel, id desc
      `),
    ]);

    for (const row of dncr.rows as Array<{ party_id: number; status: string }>) {
      if (CONTACTABILITY_BLOCKING_DNCR_STATUSES.has(row.status)) suppressed.add(Number(row.party_id));
    }

    const activeChannelsByParty = new Map<number, Set<string>>();
    for (const row of suppressions.rows as Array<{ party_id: number; channel: string; state: string; expires_at: string | Date | null }>) {
      // FAIL CLOSED ON AN UNRECOGNISED STATE. Only the explicit release
      // state lets a channel through; anything this build does not recognise
      // counts as suppressing, so a corrupted value or a state added by a
      // newer build cannot silently un-suppress a contact.
      if (row.state === RELEASE_STATE) continue;
      if (!KNOWN_SUPPRESSION_STATES.has(row.state)) reportUnrecognisedSuppressionState(row.state);
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
