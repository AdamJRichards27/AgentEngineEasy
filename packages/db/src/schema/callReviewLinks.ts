import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { aiActionRequests } from "./ai";
import { growCallTranscriptions } from "./callTranscriptions";
import { growCommitments } from "./contacts";
import { growCallSessions } from "./telephony";
import { brokerages } from "./users";

// E-8 — durable call-review → commitment proposal → commitment link.
//
// A call-review COMMITMENT or FOLLOWUP item is not its own row (it lives in
// the transcription's review JSON). This table is the join: one row per
// CREATE_GROW_COMMITMENT proposal that came from that item, with foreign
// keys to the call session, the transcription, the action request, and —
// only after governed execution — the Open grow_commitments row.
//
// Proposing writes the row and does not set commitment_id. Approving does
// not create a commitment. Execution sets commitment_id. The action
// request's resourceId stays an opaque dedupe token for the existing
// partial unique index; it is not this join.

export const GROW_CALL_REVIEW_LINK_ITEM_TYPES = ["COMMITMENT", "FOLLOWUP"] as const;
export type GrowCallReviewLinkItemType = (typeof GROW_CALL_REVIEW_LINK_ITEM_TYPES)[number];

export const growCallReviewLinks = pgTable(
  "grow_call_review_links",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    callSessionId: integer("call_session_id").notNull().references(() => growCallSessions.id),
    transcriptionId: integer("transcription_id").notNull().references(() => growCallTranscriptions.id),
    itemType: text("item_type").notNull(),
    itemId: text("item_id").notNull(),
    actionRequestId: integer("action_request_id").notNull().references(() => aiActionRequests.id),
    commitmentId: integer("commitment_id").references(() => growCommitments.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    actionRequestUnique: uniqueIndex("grow_call_review_links_action_request_uidx").on(table.actionRequestId),
    itemIdx: index("grow_call_review_links_item_idx").on(
      table.brokerageId,
      table.transcriptionId,
      table.itemType,
      table.itemId,
    ),
    commitmentIdx: index("grow_call_review_links_commitment_idx").on(table.commitmentId),
    itemTypeCheck: check(
      "grow_call_review_links_item_type_check",
      sql`${table.itemType} in ('COMMITMENT', 'FOLLOWUP')`,
    ),
    itemIdCheck: check("grow_call_review_links_item_id_check", sql`length(${table.itemId}) > 0`),
  }),
);

export type GrowCallReviewLink = typeof growCallReviewLinks.$inferSelect;
