// C-6 — read-side qualifying Comms Hub messages.
//
// Grow Today recency and the coach's activity count used to read only
// grow_activities. The Hub stores email, SMS, and call records in
// communication_messages and does not copy them into grow_activities.
// These two reads consult the Hub directly. Nothing in this file inserts,
// updates, or deletes a row.
//
// QUALIFYING. A message counts only when all of the following hold:
//
//   1. Channel is EMAIL, SMS, or PHONE_CALL. Those are the Hub's email,
//      SMS, and call records. INTERNAL_NOTE never leaves the brokerage.
//      EXTERNAL_MESSAGE is an unstructured external note, not a confirmed
//      email, SMS, or call.
//   2. It is a completed contact, not an attempt and not a failure:
//        - OUTBOUND with status SENT or DELIVERED, or
//        - INBOUND with status RECEIVED.
//      DRAFT, AWAITING_APPROVAL, APPROVED, QUEUED, SENDING,
//      RETRY_SCHEDULED, FAILED, BOUNCED, UNDELIVERABLE, CANCELLED,
//      BLOCKED_BY_CONSENT, and BLOCKED_BY_COST_CONTROL do not qualify.
//      Status is the message's latest state, so a late bounce (now
//      BOUNCED) stops qualifying even though it was once DELIVERED.
//   3. The contact is linked through communication_participants.party_id.
//      communication_messages.party_id and communication_threads.party_id
//      are denormalised anchors. A message with no participant row for
//      the contact does not qualify.
//   4. The moment of that contact is known:
//        - SENT: sent_at
//        - DELIVERED: delivered_at, or sent_at when delivered_at is null
//        - RECEIVED: created_at
//      A row whose moment is null does not qualify.
//
// Coach activity rows use the same moment, and the activity type is the
// grow_activities vocabulary for that channel: email, sms, call. A Hub
// row is not deduped against a grow_activities row. The Hub does not
// write one, so when both exist they are two records and both count.
//
// TENANCY (A3). communication_participants has no brokerage_id. Every
// query joins the participant to its thread and the party, and filters
// communication_threads.brokerage_id and parties.brokerage_id to the
// caller's brokerage. communication_messages.brokerage_id is filtered as
// well: a message stamped with this brokerage cannot qualify through
// another brokerage's thread, and a foreign message cannot qualify
// through this brokerage's thread.
//
// A message on a property the caller cannot see is not their contact,
// same rule as grow_activities (visibleLinkedPropertySql). A null
// propertyId is a contact-first record and stays visible.
import { and, asc, eq, exists, inArray, isNotNull, max, or, sql } from "drizzle-orm";
import {
  db,
  communicationMessages,
  communicationParticipants,
  communicationThreads,
  parties,
} from "@aee/db";
import { visibleLinkedPropertySql } from "./propertyVisibility.js";

export const QUALIFYING_COMMUNICATION_CHANNELS = ["EMAIL", "SMS", "PHONE_CALL"] as const;

/** grow_activities.activity_type vocabulary for a qualifying Hub channel. */
export function qualifyingCommunicationActivityType(channel: string): string {
  if (channel === "SMS") return "sms";
  if (channel === "PHONE_CALL") return "call";
  return "email";
}

// The moment of contact. `at time zone 'UTC'` yields timestamptz so the
// driver returns an absolute instant. The source columns are timestamp
// without time zone holding UTC wall-clock (the session zone is UTC).
function qualifyingContactedAt() {
  return sql`(case
    when ${communicationMessages.direction} = 'INBOUND' and ${communicationMessages.status} = 'RECEIVED' then ${communicationMessages.createdAt}
    when ${communicationMessages.direction} = 'OUTBOUND' and ${communicationMessages.status} = 'DELIVERED' then coalesce(${communicationMessages.deliveredAt}, ${communicationMessages.sentAt})
    when ${communicationMessages.direction} = 'OUTBOUND' and ${communicationMessages.status} = 'SENT' then ${communicationMessages.sentAt}
    else null
  end) at time zone 'UTC'`;
}

function qualifyingChannelAndStatus() {
  return and(
    inArray(communicationMessages.channel, [...QUALIFYING_COMMUNICATION_CHANNELS]),
    or(
      and(eq(communicationMessages.direction, "OUTBOUND"), inArray(communicationMessages.status, ["SENT", "DELIVERED"])),
      and(eq(communicationMessages.direction, "INBOUND"), eq(communicationMessages.status, "RECEIVED")),
    ),
  );
}

function asUtcDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function asPartyId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Latest qualifying contact moment per party, for the party ids the caller
 * already has in scope. One grouped aggregate. An empty id list issues no
 * query.
 *
 * The party-id bind is one JSON array expanded server-side, the same shape
 * as Grow Today's activity aggregate, so the statement text does not grow
 * with the batch and no id is concatenated into SQL. communication_participants
 * (party_id) is the index for that predicate; the thread and party brokerage
 * predicates sit on the joined parents.
 */
export async function fetchLastQualifyingContactByParty(
  brokerageId: number,
  partyIds: number[],
  restrictToPropertyIds: number[] | null,
): Promise<Map<number, Date>> {
  const lastByParty = new Map<number, Date>();
  const ids = partyIds.filter((id) => Number.isInteger(id));
  if (ids.length === 0) return lastByParty;

  const idArray = sql`array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::int)`;

  const rows = await db
    .select({
      partyId: communicationParticipants.partyId,
      // A fresh expression each time: a drizzle SQL object is not reusable
      // across two clauses.
      lastContactedAt: max(qualifyingContactedAt()),
    })
    .from(communicationMessages)
    .innerJoin(communicationThreads, eq(communicationThreads.id, communicationMessages.threadId))
    .innerJoin(communicationParticipants, eq(communicationParticipants.threadId, communicationThreads.id))
    .innerJoin(parties, eq(parties.id, communicationParticipants.partyId))
    .where(
      and(
        eq(communicationThreads.brokerageId, brokerageId),
        eq(parties.brokerageId, brokerageId),
        eq(communicationMessages.brokerageId, brokerageId),
        isNotNull(communicationParticipants.partyId),
        sql`${communicationParticipants.partyId} = any(${idArray})`,
        qualifyingChannelAndStatus(),
        sql`${qualifyingContactedAt()} is not null`,
        visibleLinkedPropertySql(communicationMessages.propertyId, restrictToPropertyIds),
      ),
    )
    .groupBy(communicationParticipants.partyId);

  for (const row of rows) {
    const partyId = asPartyId(row.partyId);
    const contacted = asUtcDate(row.lastContactedAt);
    if (partyId === null || contacted === null) continue;
    lastByParty.set(partyId, contacted);
  }
  return lastByParty;
}

export interface QualifyingCommunicationActivityRow {
  id: number;
  partyId: number | null;
  activityType: string;
  occurredAt: Date;
}

/**
 * Qualifying Hub messages whose contact moment falls in [periodStart, periodEnd),
 * one row per message, oldest first, capped by `limit`.
 *
 * EXISTS (rather than a join) keeps one message as one activity when the
 * thread has several participants. The EXISTS still joins parties and
 * requires parties.brokerage_id, because the participant table cannot
 * carry that predicate itself.
 */
export async function fetchQualifyingCommunicationActivityRows(
  brokerageId: number,
  periodStart: Date,
  periodEnd: Date,
  restrictToPropertyIds: number[] | null,
  limit: number,
): Promise<QualifyingCommunicationActivityRow[]> {
  if (limit <= 0) return [];

  const rows = await db
    .select({
      id: communicationMessages.id,
      partyId: communicationMessages.partyId,
      channel: communicationMessages.channel,
      occurredAt: qualifyingContactedAt(),
    })
    .from(communicationMessages)
    .innerJoin(communicationThreads, eq(communicationThreads.id, communicationMessages.threadId))
    .where(
      and(
        eq(communicationThreads.brokerageId, brokerageId),
        eq(communicationMessages.brokerageId, brokerageId),
        qualifyingChannelAndStatus(),
        sql`${qualifyingContactedAt()} >= ${periodStart}`,
        sql`${qualifyingContactedAt()} < ${periodEnd}`,
        visibleLinkedPropertySql(communicationMessages.propertyId, restrictToPropertyIds),
        exists(
          db
            .select({ id: communicationParticipants.id })
            .from(communicationParticipants)
            .innerJoin(parties, eq(parties.id, communicationParticipants.partyId))
            .where(
              and(
                eq(communicationParticipants.threadId, communicationThreads.id),
                eq(parties.brokerageId, brokerageId),
                isNotNull(communicationParticipants.partyId),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(qualifyingContactedAt()), asc(communicationMessages.id))
    .limit(limit);

  const activities: QualifyingCommunicationActivityRow[] = [];
  for (const row of rows) {
    const occurredAt = asUtcDate(row.occurredAt);
    if (occurredAt === null) continue;
    activities.push({
      id: row.id,
      partyId: asPartyId(row.partyId),
      activityType: qualifyingCommunicationActivityType(row.channel),
      occurredAt,
    });
  }
  return activities;
}
