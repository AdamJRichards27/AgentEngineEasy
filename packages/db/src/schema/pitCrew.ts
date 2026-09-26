// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7), data model.
//
// Deliberately a thin overlay table, not a new source of truth. The work
// items themselves (exceptions, workflow/automation actions, launch items,
// offers, contract/settlement milestones) already live in and are already
// normalised by the Agent Daily Command Centre's ActionItem model
// (apps/api/src/lib/commandCentre/queries.ts, Priority 6), which itself
// reuses the Exception and Risk Engine (Priority 4) and Launch and Campaign
// Coordination (Priority 5) as authoritative sources. Duplicating that
// content here would violate the reuse-never-duplicate mandate.
//
// What genuinely does not exist anywhere in the codebase -- confirmed by
// exceptions.ts's own comment ("Pit Crew ownership requires a
// service-assignment record this baseline does not have") and by
// restrictedPropertyIdsFor's doc comment in routes/exceptions.ts -- is any
// record of WHO on the Pit Crew team is working an item, WHAT STATE that
// work is in from Pit Crew's point of view, and WAITING-ON / HANDOFF
// metadata. That is the only new state this table adds: one row per source
// item, keyed by (sourceType, sourceRecordId) -- the same identity the
// Command Centre's ActionItem already uses -- pointing back at the property
// and (optionally) the assigned Pit Crew user.
//
// Full history of status changes, claims, assignments, waiting-on entries
// and handoffs is not duplicated here -- it is written to the existing
// audit log (lib/audit.ts's logAudit, which already feeds the Property
// Timeline) so Pit Crew activity shows up in the same timeline an agent
// already reads, instead of a second, competing history mechanism.

import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties } from "./property";
import { users, brokerages } from "./users";

// Section 9 status vocabulary. UNCLAIMED is the implicit starting state (no
// row, or a row reset back to it) -- the other four are the states a row
// actually gets persisted in.
export const PIT_CREW_ITEM_STATUSES = [
  "UNCLAIMED",
  "CLAIMED",
  "IN_PROGRESS",
  "WAITING_ON",
  "DONE",
] as const;
export type PitCrewItemStatus = (typeof PIT_CREW_ITEM_STATUSES)[number];

// One row per (sourceType, sourceRecordId). A row only exists once Pit Crew
// has touched the item in some way (claimed, was assigned, entered
// waiting-on, etc.); an item with no row is simply unclaimed and unassigned.
export const pitCrewAssignments = pgTable(
  "pit_crew_assignments",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    sourceType: text("source_type").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    propertyId: integer("property_id").notNull().references(() => properties.id),

    status: text("status").notNull().default("UNCLAIMED"), // see PIT_CREW_ITEM_STATUSES

    assignedToUserId: integer("assigned_to_user_id").references(() => users.id),
    claimedAt: timestamp("claimed_at"),

    // Waiting-On (Section 14): who/what the item is blocked on, and when it
    // should be surfaced again if nobody actively returns it.
    waitingOnParty: text("waiting_on_party"),
    waitingOnNote: text("waiting_on_note"),
    waitingOnSince: timestamp("waiting_on_since"),
    waitingOnExpectedAt: timestamp("waiting_on_expected_at"),

    // Handoff (Section 13): last handoff only -- full history lives in the
    // audit log via logAudit, not here.
    handoffFromUserId: integer("handoff_from_user_id").references(() => users.id),
    handoffToUserId: integer("handoff_to_user_id").references(() => users.id),
    handoffNote: text("handoff_note"),
    handoffAt: timestamp("handoff_at"),

    completedAt: timestamp("completed_at"),

    // Optimistic concurrency token (Section 12: safe concurrent
    // assignment/claiming). Every mutating action reads this value and
    // passes it back; a mismatch means someone else moved the item first.
    version: integer("version").notNull().default(1),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    sourceUnique: uniqueIndex("pit_crew_assignments_source_unique").on(table.sourceType, table.sourceRecordId),
    brokerageStatusIdx: index("pit_crew_assignments_brokerage_status_idx").on(table.brokerageId, table.status),
    assignedToIdx: index("pit_crew_assignments_assigned_to_idx").on(table.assignedToUserId),
    propertyIdx: index("pit_crew_assignments_property_idx").on(table.propertyId),
  }),
);

export const insertPitCrewAssignmentSchema = createInsertSchema(pitCrewAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPitCrewAssignment = z.infer<typeof insertPitCrewAssignmentSchema>;
export type PitCrewAssignment = typeof pitCrewAssignments.$inferSelect;

// R-F5: per-brokerage policy for the scheduled WAITING_ON detection sweep.
// One row per brokerage, created on the first successful detection run (or
// by an explicit upsert). A brokerage with no row uses the code defaults in
// apps/api/src/lib/pitCrew/waitingOnDetection.ts. This is detection policy
// only — it does not authorise the scheduler to change Pit Crew status.
export const pitCrewWaitingOnSweepSettings = pgTable(
  "pit_crew_waiting_on_sweep_settings",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id).unique(),

    // How often this brokerage is detected. The process wake interval is a
    // separate env knob; a brokerage is skipped until this cadence has elapsed.
    cadenceMs: integer("cadence_ms").notNull().default(1_800_000),

    // Local operating window. "HH:MM", start inclusive, end exclusive.
    // windowWeekdays is ISO weekday numbers (Monday=1 .. Sunday=7), comma-separated.
    // Null timeZone means "use communication settings, else Australia/Brisbane".
    windowStart: text("window_start").notNull().default("08:00"),
    windowEnd: text("window_end").notNull().default("18:00"),
    windowWeekdays: text("window_weekdays").notNull().default("1,2,3,4,5"),
    timeZone: text("time_zone"),

    // Hour boundaries against waitingOnExpectedAt. Overdue but below
    // attentionThresholdHours is "visible"; below elevatedThresholdHours is
    // "pit_crew_attention"; at or above elevatedThresholdHours is "elevated_attention".
    attentionThresholdHours: integer("attention_threshold_hours").notNull().default(2),
    elevatedThresholdHours: integer("elevated_threshold_hours").notNull().default(4),

    // Clock of the last detection run that got past the window and cadence
    // gates. Not a task-state field.
    lastDetectionAt: timestamp("last_detection_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
);

// Last surfaced fingerprint per assignment. A later scheduled run does not
// alert again while this fingerprint still matches. Not a task-state field:
// the assignment row itself is not updated.
export const pitCrewWaitingOnSweepSightings = pgTable(
  "pit_crew_waiting_on_sweep_sightings",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    assignmentId: integer("assignment_id").notNull().references(() => pitCrewAssignments.id),
    fingerprint: text("fingerprint").notNull(),
    tier: text("tier").notNull(),
    priorityException: boolean("priority_exception").notNull(),
    surfacedAt: timestamp("surfaced_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    assignmentUnique: uniqueIndex("pit_crew_waiting_on_sweep_sightings_assignment_uidx").on(table.assignmentId),
    brokerageIdx: index("pit_crew_waiting_on_sweep_sightings_brokerage_idx").on(table.brokerageId),
  }),
);

export type PitCrewWaitingOnSweepSettings = typeof pitCrewWaitingOnSweepSettings.$inferSelect;
export type PitCrewWaitingOnSweepSighting = typeof pitCrewWaitingOnSweepSightings.$inferSelect;
