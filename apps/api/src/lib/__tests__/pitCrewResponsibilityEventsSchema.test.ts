// R-F14 PR 1 — pit_crew_responsibility_events schema contract.
//
// Proves migration 0032 created the table (CI applies migrations before
// this suite) and that the CHECKs and the partial unique index match the
// approved design. No route or library behaviour is exercised here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import {
  db,
  brokerages,
  users,
  properties,
  pitCrewAssignments,
  pitCrewResponsibilityEvents,
  PIT_CREW_ITEM_STATUSES,
  PIT_CREW_RESPONSIBILITY_EVENT_KINDS,
  PIT_CREW_HAND_BACK_REASON_CATEGORIES,
  PIT_CREW_ESCALATION_REASON_CATEGORIES,
  PIT_CREW_ESCALATION_SEVERITIES,
  PIT_CREW_RESPONSIBILITY_EVENT_STATUSES,
  PIT_CREW_RESULTING_RESPONSIBILITIES,
  PIT_CREW_RESPONSIBILITY_RECIPIENT_ROLES,
} from "@aee/db";

const nonce = `${Date.now()}-${process.pid}`;

let brokerageId: number;
let userId: number;
let propertyId: number;
let assignmentId: number;

type PgFailure = { code?: string; constraint?: string; message?: string };

function pgFailure(err: unknown): PgFailure {
  const wrapped = err as { code?: string; constraint?: string; message?: string; cause?: PgFailure };
  return {
    code: wrapped.cause?.code ?? wrapped.code,
    constraint: wrapped.cause?.constraint ?? wrapped.constraint,
    message: wrapped.cause?.message ?? wrapped.message,
  };
}

async function expectDbRejection(run: () => Promise<unknown>, code: string, constraint: string): Promise<void> {
  try {
    await run();
  } catch (err) {
    const pg = pgFailure(err);
    assert.equal(pg.code, code, pg.message);
    assert.equal(pg.constraint, constraint, pg.message);
    return;
  }
  assert.fail(`expected ${code} from ${constraint}`);
}

function handBack(overrides: Partial<typeof pitCrewResponsibilityEvents.$inferInsert> = {}) {
  return {
    brokerageId,
    assignmentId,
    propertyId,
    kind: "HAND_BACK" as const,
    reasonCategory: "WORK_COMPLETE",
    nextAction: "Review the returned evidence and confirm the next step.",
    originatingUserId: userId,
    recipientUserId: userId,
    resultingResponsibility: "AGENT" as const,
    ...overrides,
  };
}

function escalation(overrides: Partial<typeof pitCrewResponsibilityEvents.$inferInsert> = {}) {
  return {
    brokerageId,
    assignmentId,
    propertyId,
    kind: "ESCALATION" as const,
    reasonCategory: "BLOCKED_DEPENDENCY",
    severity: "ATTENTION",
    nextAction: "Decide whether the brokerage will authorise the next step.",
    originatingUserId: userId,
    recipientRole: "Brokerage Administrator",
    resultingResponsibility: "BROKERAGE_ADMINISTRATOR" as const,
    ...overrides,
  };
}

before(async () => {
  const [brokerage] = await db.insert(brokerages).values({ name: `R-F14 schema ${nonce}` }).returning();
  assert.ok(brokerage);
  brokerageId = brokerage.id;
  const [user] = await db.insert(users).values({
    authProviderId: `rf14-schema-${nonce}`,
    email: `rf14-schema-${nonce}@example.test`,
    firstName: "RF14",
    lastName: "Schema",
    role: "Pit Crew",
    brokerageId,
  }).returning();
  assert.ok(user);
  userId = user.id;
  const [property] = await db.insert(properties).values({
    brokerageId,
    agentId: userId,
    formattedAddress: `1 Responsibility Event St ${nonce}`,
  }).returning();
  assert.ok(property);
  propertyId = property.id;
  const [assignment] = await db.insert(pitCrewAssignments).values({
    brokerageId,
    sourceType: "EXCEPTION",
    sourceRecordId: `rf14-schema-${nonce}`,
    propertyId,
    status: "IN_PROGRESS",
  }).returning();
  assert.ok(assignment);
  assignmentId = assignment.id;
});

after(async () => {
  if (brokerageId) {
    await db.delete(pitCrewResponsibilityEvents).where(eq(pitCrewResponsibilityEvents.brokerageId, brokerageId));
    await db.delete(pitCrewAssignments).where(eq(pitCrewAssignments.brokerageId, brokerageId));
  }
  if (propertyId) await db.delete(properties).where(eq(properties.id, propertyId));
  if (userId) await db.delete(users).where(eq(users.id, userId));
  if (brokerageId) await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
});

test("responsibility event constants are the locked R-F14 lists", () => {
  assert.deepEqual(PIT_CREW_RESPONSIBILITY_EVENT_KINDS, ["HAND_BACK", "ESCALATION"]);
  assert.deepEqual(PIT_CREW_HAND_BACK_REASON_CATEGORIES, [
    "WORK_COMPLETE",
    "NEXT_ACTION_WITH_AGENT",
    "INFORMATION_RETURNED",
    "NOT_PIT_CREW_WORK",
  ]);
  assert.deepEqual(PIT_CREW_ESCALATION_REASON_CATEGORIES, [
    "BLOCKED_DEPENDENCY",
    "OVERDUE_THIRD_PARTY",
    "SETTLEMENT_OR_COMPLIANCE_RISK",
    "MISSING_AUTHORITY",
    "MISSING_INFORMATION",
    "OTHER_MATERIAL_EXCEPTION",
  ]);
  assert.deepEqual(PIT_CREW_ESCALATION_SEVERITIES, ["ATTENTION", "AT_RISK", "CRITICAL"]);
  assert.deepEqual(PIT_CREW_RESPONSIBILITY_EVENT_STATUSES, [
    "OPEN",
    "ACKNOWLEDGED",
    "RESOLVED",
    "RETURNED",
    "SUPERSEDED",
  ]);
  assert.deepEqual(PIT_CREW_RESULTING_RESPONSIBILITIES, ["AGENT", "BROKERAGE_ADMINISTRATOR"]);
  assert.deepEqual(PIT_CREW_RESPONSIBILITY_RECIPIENT_ROLES, ["Brokerage Administrator"]);
  assert.ok(PIT_CREW_ITEM_STATUSES.includes("HANDED_BACK"));
  assert.ok(PIT_CREW_ITEM_STATUSES.includes("ESCALATED"));
});

test("0032 table exists with the responsibility-event indexes and without routing_rule_id", async () => {
  const present = await db.execute(sql`
    select to_regclass('public.pit_crew_responsibility_events')::text as name
  `);
  assert.equal((present as unknown as { rows: Array<{ name: string | null }> }).rows[0]?.name, "pit_crew_responsibility_events");

  const columns = await db.execute(sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'pit_crew_responsibility_events'
  `);
  const names = (columns as unknown as { rows: Array<{ column_name: string }> }).rows.map((row) => row.column_name);
  assert.equal(names.includes("routing_rule_id"), false);
  for (const column of [
    "brokerage_id",
    "assignment_id",
    "property_id",
    "kind",
    "reason_category",
    "severity",
    "note",
    "closing_note",
    "next_action",
    "originating_user_id",
    "recipient_user_id",
    "recipient_role",
    "resulting_responsibility",
    "expected_response_at",
    "status",
    "acknowledged_at",
    "acknowledged_by_user_id",
    "closed_at",
    "closed_by_user_id",
  ]) {
    assert.ok(names.includes(column), column);
  }

  const indexes = await db.execute(sql`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'pit_crew_responsibility_events'
  `);
  const indexNames = (indexes as unknown as { rows: Array<{ indexname: string }> }).rows.map((row) => row.indexname);
  for (const indexName of [
    "pit_crew_responsibility_events_one_open_uidx",
    "pit_crew_responsibility_events_brokerage_recipient_idx",
    "pit_crew_responsibility_events_brokerage_role_idx",
    "pit_crew_responsibility_events_assignment_created_idx",
    "pit_crew_responsibility_events_property_idx",
  ]) {
    assert.ok(indexNames.includes(indexName), indexName);
  }
});

test("0033 closing_note is nullable text with no default and no length check", async () => {
  const columns = await db.execute(sql`
    select data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pit_crew_responsibility_events'
      and column_name = 'closing_note'
  `);
  const column = (columns as unknown as { rows: Array<{ data_type: string; is_nullable: string; column_default: string | null }> }).rows[0];
  assert.equal(column?.data_type, "text");
  assert.equal(column?.is_nullable, "YES");
  assert.equal(column?.column_default, null);

  const checks = await db.execute(sql`
    select conname
    from pg_constraint
    where contype = 'c'
      and conrelid = 'public.pit_crew_responsibility_events'::regclass
      and pg_get_constraintdef(oid) ilike '%closing_note%'
  `);
  assert.equal((checks as unknown as { rows: unknown[] }).rows.length, 0);
});

test("checks reject an incoherent responsibility event and the partial unique index allows one open event", async () => {
  const [openHandBack] = await db.insert(pitCrewResponsibilityEvents).values(handBack()).returning();
  assert.equal(openHandBack?.status, "OPEN");
  assert.equal(openHandBack?.severity, null);

  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(handBack({ reasonCategory: "NEXT_ACTION_WITH_AGENT" })),
    "23505",
    "pit_crew_responsibility_events_one_open_uidx",
  );
  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(escalation({
      status: "ACKNOWLEDGED",
      acknowledgedAt: new Date(),
      acknowledgedByUserId: userId,
    })),
    "23505",
    "pit_crew_responsibility_events_one_open_uidx",
  );

  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(handBack({ severity: "ATTENTION" })),
    "23514",
    "pit_crew_responsibility_events_hand_back_shape_check",
  );
  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(escalation({ severity: null })),
    "23514",
    "pit_crew_responsibility_events_escalation_shape_check",
  );
  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(handBack({
      recipientUserId: userId,
      recipientRole: "Brokerage Administrator",
    })),
    "23514",
    "pit_crew_responsibility_events_one_recipient_check",
  );
  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(handBack({
      recipientUserId: null,
      recipientRole: null,
    })),
    "23514",
    "pit_crew_responsibility_events_one_recipient_check",
  );
  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(handBack({ nextAction: "" })),
    "23514",
    "pit_crew_responsibility_events_next_action_check",
  );
  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(handBack({ nextAction: "   " })),
    "23514",
    "pit_crew_responsibility_events_next_action_check",
  );
  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(handBack({ reasonCategory: "MISSING_AUTHORITY" })),
    "23514",
    "pit_crew_responsibility_events_reason_category_check",
  );
  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(escalation({ reasonCategory: "WORK_COMPLETE" })),
    "23514",
    "pit_crew_responsibility_events_reason_category_check",
  );
  const statusDef = await db.execute(sql`
    select pg_get_constraintdef(oid) as def
    from pg_constraint
    where conname = 'pit_crew_responsibility_events_status_check'
  `);
  const statusCheck = (statusDef as unknown as { rows: Array<{ def: string }> }).rows[0]?.def ?? "";
  for (const status of ["OPEN", "ACKNOWLEDGED", "RESOLVED", "RETURNED", "SUPERSEDED"]) {
    assert.match(statusCheck, new RegExp(status));
  }
  assert.doesNotMatch(statusCheck, /BOGUS/);
  // A status outside the list also fails the closed-pair check, and Postgres
  // reports one constraint. Either name is a rejection of the bad status.
  try {
    await db.insert(pitCrewResponsibilityEvents).values(handBack({ status: "BOGUS" }));
    assert.fail("expected a bad event status to be rejected");
  } catch (err) {
    const pg = pgFailure(err);
    assert.equal(pg.code, "23514", pg.message);
    assert.ok(
      pg.constraint === "pit_crew_responsibility_events_status_check"
        || pg.constraint === "pit_crew_responsibility_events_closed_check",
      pg.constraint,
    );
  }

  const superseded = await db.update(pitCrewResponsibilityEvents).set({
    status: "SUPERSEDED",
    closedAt: new Date(),
    closedByUserId: userId,
    updatedAt: new Date(),
  }).where(eq(pitCrewResponsibilityEvents.id, openHandBack!.id)).returning();
  assert.equal(superseded[0]?.status, "SUPERSEDED");

  const [openEscalation] = await db.insert(pitCrewResponsibilityEvents).values(escalation({
    note: "Original escalation note.",
  })).returning();
  assert.equal(openEscalation?.status, "OPEN");
  assert.equal(openEscalation?.severity, "ATTENTION");
  assert.equal(openEscalation?.note, "Original escalation note.");
  assert.equal(openEscalation?.closingNote, null);

  await expectDbRejection(
    () => db.insert(pitCrewResponsibilityEvents).values(handBack()),
    "23505",
    "pit_crew_responsibility_events_one_open_uidx",
  );

  const resolved = await db.update(pitCrewResponsibilityEvents).set({
    status: "RESOLVED",
    closingNote: "Closing note that must not replace the original.",
    closedAt: new Date(),
    closedByUserId: userId,
    updatedAt: new Date(),
  }).where(eq(pitCrewResponsibilityEvents.id, openEscalation!.id)).returning();
  assert.equal(resolved[0]?.status, "RESOLVED");
  assert.equal(resolved[0]?.note, "Original escalation note.");
  assert.equal(resolved[0]?.closingNote, "Closing note that must not replace the original.");

  const [afterResolved] = await db.insert(pitCrewResponsibilityEvents).values(handBack({
    reasonCategory: "INFORMATION_RETURNED",
  })).returning();
  assert.equal(afterResolved?.status, "OPEN");
  assert.equal(afterResolved?.reasonCategory, "INFORMATION_RETURNED");
});
