import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, growOpportunitySignals, type GrowOpportunitySignal } from "@aee/db";
import type { SignalCandidate } from "./evaluation.js";

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 1 — the single WRITE path for
 * system-generated signals.
 *
 * Both callers (the single-property recalculate route and the brokerage-wide
 * sweep) persist through this module and nothing else, so the re-review
 * policy can only be implemented once. See
 * lib/propertyIntelligence/signals.ts's module header for the policy itself.
 *
 * BATCHED, NOT PER-CANDIDATE. The previous implementation did one SELECT
 * plus one INSERT-or-UPDATE per candidate. Here, each chunk of candidates is
 * a single multi-row `insert ... on conflict (dedupe_key) do update`, so the
 * statement count is ceil(candidates / UPSERT_CHUNK_SIZE), not 2 x
 * candidates. 2,000 candidates cost 8 statements instead of 4,000 round
 * trips.
 *
 * THE CONFLICT CLAUSE IS THE POLICY. A human-decided row is only rewritten
 * when the `setWhere` predicate passes, and Postgres evaluates that
 * atomically against the row as it exists at write time — there is no
 * check-then-write race between a concurrent human dismissal and a sweep.
 * A row that fails the predicate is not updated AND not returned, which is
 * also how the caller counts "left alone".
 */

/**
 * Rows per upsert statement. Each row binds ~16 parameters, so this stays an
 * order of magnitude below Postgres' 65,535-parameter ceiling while keeping
 * the statement count low.
 */
export const UPSERT_CHUNK_SIZE = 250;

/** Statuses a human put a signal into. Only the re-review policy may move a row out of one of these. */
export const HUMAN_DECIDED_STATUSES = ["Dismissed", "Reviewed", "Superseded"] as const;

export interface UpsertSummary {
  created: number;
  updated: number;
  /** Rows that were human-decided and became Active again under the re-review policy. Included in `updated`. */
  reRaised: number;
  /** Rows whose dedupeKey already existed in a human-decided state that the policy did NOT permit re-raising. */
  leftDecided: number;
}

const HUMAN_DECIDED_SQL = sql`${growOpportunitySignals.status} in ('Dismissed', 'Reviewed', 'Superseded')`;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Upserts a batch of candidates for ONE brokerage.
 *
 * `now` is the single evaluation instant for the whole batch — every
 * computed_at/last_swept_at/updated_at it writes, and the instant the
 * re-review quiet period is compared against, so a long-running sweep can
 * never straddle a quiet-period boundary mid-batch.
 */
export async function upsertSignalCandidates(brokerageId: number, candidates: SignalCandidate[], now: Date): Promise<UpsertSummary> {
  const summary: UpsertSummary = { created: 0, updated: 0, reRaised: 0, leftDecided: 0 };
  if (candidates.length === 0) return summary;

  // Marker written into prior_decision on (and only on) a re-raise, so this
  // call can tell "I re-raised this row" from "this row was already Active"
  // in the RETURNING clause — Postgres' RETURNING cannot see the pre-update
  // row, and a per-call nonce is exact where comparing timestamps would not be.
  const reRaiseMarker = randomUUID();

  for (const batch of chunk(candidates, UPSERT_CHUNK_SIZE)) {
    const values = batch.map((c) => ({
      brokerageId: c.brokerageId,
      partyId: c.partyId,
      propertyId: c.propertyId,
      signalType: c.signalType,
      title: c.title,
      explanation: c.explanation,
      evidence: c.evidence,
      source: c.source,
      sourceTimestamp: c.sourceTimestamp,
      computedAt: now,
      confidenceBand: c.confidenceBand,
      status: "Active" as const,
      dedupeKey: c.dedupeKey,
      expiresAt: c.expiresAt,
      evidenceFingerprint: c.evidenceFingerprint,
      lastSweptAt: now,
      updatedAt: now,
    }));

    const returned = await db
      .insert(growOpportunitySignals)
      .values(values)
      .onConflictDoUpdate({
        target: growOpportunitySignals.dedupeKey,
        set: {
          // Editorial/evidence refresh — identical to the pre-sweep behaviour.
          title: sql`excluded.title`,
          explanation: sql`excluded.explanation`,
          evidence: sql`excluded.evidence`,
          source: sql`excluded.source`,
          sourceTimestamp: sql`excluded.source_timestamp`,
          confidenceBand: sql`excluded.confidence_band`,
          expiresAt: sql`excluded.expires_at`,
          evidenceFingerprint: sql`excluded.evidence_fingerprint`,
          computedAt: sql`excluded.computed_at`,
          lastSweptAt: sql`excluded.last_swept_at`,
          updatedAt: sql`excluded.updated_at`,
          // The anchor can legitimately be filled in later (e.g. an
          // appraisal gaining a contact); never blanked back to NULL.
          partyId: sql`coalesce(excluded.party_id, ${growOpportunitySignals.partyId})`,
          propertyId: sql`coalesce(excluded.property_id, ${growOpportunitySignals.propertyId})`,
          // Active again: either it was Active/Expired (the pre-sweep
          // "revive an expired signal whose evidence is still produced"
          // behaviour) or the re-review policy in setWhere just allowed it.
          status: sql`'Active'`,
          reRaiseCount: sql`${growOpportunitySignals.reRaiseCount} + (case when ${HUMAN_DECIDED_SQL} then 1 else 0 end)`,
          priorDecision: sql`case when ${HUMAN_DECIDED_SQL} then jsonb_build_object(
              'status', ${growOpportunitySignals.status},
              'dismissedReason', ${growOpportunitySignals.dismissedReason},
              'reviewedByUserId', ${growOpportunitySignals.reviewedByUserId},
              'reviewedAt', ${growOpportunitySignals.reviewedAt},
              'reRaisedAt', excluded.computed_at,
              'reRaiseMarker', ${reRaiseMarker}::text
            ) else ${growOpportunitySignals.priorDecision} end`,
          // A re-raised row must not keep presenting the superseded decision
          // as if it were current; the decision is preserved in
          // prior_decision (and, authoritatively, in the audit log).
          dismissedReason: sql`case when ${HUMAN_DECIDED_SQL} then null else ${growOpportunitySignals.dismissedReason} end`,
          reviewedByUserId: sql`case when ${HUMAN_DECIDED_SQL} then null else ${growOpportunitySignals.reviewedByUserId} end`,
          reviewedAt: sql`case when ${HUMAN_DECIDED_SQL} then null else ${growOpportunitySignals.reviewedAt} end`,
          // The quiet period has been consumed; a fresh decision sets a new one.
          nextReviewAt: sql`null`,
        },
        // ---------------------------------------------------------------
        // THE RE-REVIEW POLICY, expressed exactly once.
        //
        //   - Active / Expired are auto-managed: always refreshed, exactly
        //     as before this change.
        //   - Dismissed / Reviewed / Superseded are human decisions. They are
        //     re-raised only when BOTH
        //       (a) a quiet period was set and has elapsed
        //           (next_review_at is not null and <= this run's instant),
        //           so a dismissal is never overridden before its own quiet
        //           period — and a NULL next_review_at, which is what
        //           promotion leaves behind, is permanently terminal; and
        //       (b) the evidence fingerprint has materially changed
        //           (IS DISTINCT FROM, so a legacy NULL fingerprint counts as
        //           changed the first time the sweep sees the row — the sweep
        //           has no record of what that row was decided against).
        // ---------------------------------------------------------------
        setWhere: sql`${growOpportunitySignals.status} in ('Active', 'Expired')
          or (
            ${growOpportunitySignals.nextReviewAt} is not null
            and ${growOpportunitySignals.nextReviewAt} <= excluded.computed_at
            and ${growOpportunitySignals.evidenceFingerprint} is distinct from excluded.evidence_fingerprint
          )`,
      })
      .returning({
        id: growOpportunitySignals.id,
        // xmax = 0 identifies a row this statement INSERTED rather than
        // updated — the standard Postgres upsert discriminator.
        inserted: sql<boolean>`(xmax = 0)`,
        priorDecision: growOpportunitySignals.priorDecision,
      });

    let written = 0;
    for (const row of returned) {
      written += 1;
      if (row.inserted) {
        summary.created += 1;
        continue;
      }
      summary.updated += 1;
      const marker = (row.priorDecision as { reRaiseMarker?: unknown } | null)?.reRaiseMarker;
      if (marker === reRaiseMarker) summary.reRaised += 1;
    }
    // Rows the setWhere predicate refused are neither updated nor returned.
    summary.leftDecided += batch.length - written;
  }

  return summary;
}

/**
 * Brokerage-wide, sweep-driven expiry of signals past their own expiresAt.
 *
 * This replaces the lazy, per-property read-time expiry as the mechanism
 * that actually keeps the table honest. `propertyIds` narrows it for the
 * single-property route, which keeps that route's behaviour identical.
 * Returns the number of rows expired.
 */
export async function expireSignalsPastExpiry(brokerageId: number, now: Date, propertyIds?: number[]): Promise<number> {
  if (propertyIds && propertyIds.length === 0) return 0;
  const result = await db
    .update(growOpportunitySignals)
    .set({ status: "Expired", updatedAt: now })
    .where(
      and(
        eq(growOpportunitySignals.brokerageId, brokerageId),
        eq(growOpportunitySignals.status, "Active"),
        sql`${growOpportunitySignals.expiresAt} is not null and ${growOpportunitySignals.expiresAt} < ${now.toISOString()}`,
        ...(propertyIds ? [inArray(growOpportunitySignals.propertyId, propertyIds)] : []),
      ),
    );
  return result.rowCount ?? 0;
}

/**
 * Expires every Active signal in scope that this pass's candidate set no
 * longer supports (e.g. the relationship behind a long_ownership_tenure
 * signal became Historical). The row is preserved with status Expired —
 * never deleted — exactly as before.
 *
 * ONLY SAFE ON AN AUTHORITATIVE PASS. The caller must not invoke this when
 * the candidate set was truncated or a rule threw: an incomplete pass says
 * nothing about what is currently true, and treating its silence as proof
 * would expire live signals. This is the same guard lib/exceptions/engine.ts
 * applies before auto-resolving.
 */
export async function expireUnsupportedSignals(
  brokerageId: number,
  currentDedupeKeys: string[],
  now: Date,
  propertyIds?: number[],
): Promise<number> {
  if (propertyIds && propertyIds.length === 0) return 0;
  const conditions = [
    eq(growOpportunitySignals.brokerageId, brokerageId),
    eq(growOpportunitySignals.status, "Active"),
    ...(propertyIds ? [inArray(growOpportunitySignals.propertyId, propertyIds)] : []),
  ];
  if (currentDedupeKeys.length > 0) {
    // The supported set is passed as ONE bind parameter (a JSON array) and
    // expanded server-side, rather than as N parameters in a NOT IN list:
    // the statement text and parameter count are then identical whether a
    // brokerage has 3 supported keys or 5,000, which is what keeps a single
    // brokerage's expiry to exactly one statement.
    conditions.push(
      sql`not (${growOpportunitySignals.dedupeKey} = any(array(select jsonb_array_elements_text(${JSON.stringify(currentDedupeKeys)}::jsonb))))`,
    );
  }
  const result = await db
    .update(growOpportunitySignals)
    .set({ status: "Expired", updatedAt: now, lastSweptAt: now })
    .where(and(...conditions));
  return result.rowCount ?? 0;
}

/** Loads the signal rows behind a set of dedupe keys, for a caller that must return them (the single-property route's response body). One statement. */
export async function loadSignalsByDedupeKeys(brokerageId: number, dedupeKeys: string[]): Promise<GrowOpportunitySignal[]> {
  if (dedupeKeys.length === 0) return [];
  return db
    .select()
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.brokerageId, brokerageId), inArray(growOpportunitySignals.dedupeKey, dedupeKeys)))
    .orderBy(asc(growOpportunitySignals.id));
}
