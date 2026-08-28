import { pgTable, serial, integer, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties } from "./property";
import { brokerages, users } from "./users";

// Generic engine: a Property (or, later, a Transaction) has an active
// Workflow made of ordered WorkflowSteps. This is what answers "what needs
// to happen next?" generically, and what lets state/brokerage rules vary
// the milestone set later without a schema change (Build Brief §16).
export const workflows = pgTable("workflows", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  workflowType: text("workflow_type").notNull(), // "ReadyToList" | "Transaction"
  status: text("status").notNull().default("Active"), // Active | Completed | Abandoned
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const workflowSteps = pgTable("workflow_steps", {
  id: serial("id").primaryKey(),
  workflowId: integer("workflow_id").notNull().references(() => workflows.id),
  stepKey: text("step_key").notNull(), // e.g. "VerifySellers", "AgencyAgreement"
  label: text("label").notNull(),
  sequence: integer("sequence").notNull(),
  status: text("status").notNull().default("Pending"), // Pending | Ready | InProgress | Complete | Blocked
  blockedReason: text("blocked_reason"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// AI Governance Stage G8 (Build Instructions Part 9): AI must never silently modify
// an ACTIVE workflow. It may only propose a change, which lands here as a new,
// inert proposal row; only an authorised human activating a proposal is meaningful
// to the running engine. This is a deliberately separate table from workflows/
// workflowSteps above (which represent a live per-property instance, not a
// versioned definition) so existing Grow Stage A/B behaviour is untouched.
export const workflowChangeProposals = pgTable("workflow_change_proposals", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  propertyId: integer("property_id").references(() => properties.id),
  workflowType: text("workflow_type").notNull(), // "ReadyToList" | "Transaction"
  version: integer("version").notNull().default(1),
  previousVersionId: integer("previous_version_id"),
  proposedSteps: jsonb("proposed_steps").notNull(), // snapshot of {stepKey,label,sequence}[]
  changeReason: text("change_reason").notNull(),
  proposedByAi: boolean("proposed_by_ai").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id),
  createdSource: text("created_source").notNull().default("human"), // "human" | "ai"
  // DRAFT | PROPOSED | APPROVED | ACTIVE | SUPERSEDED | ARCHIVED
  status: text("status").notNull().default("DRAFT"),
  approvedBy: integer("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  activatedAt: timestamp("activated_at"),
  rollbackReference: integer("rollback_reference"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertWorkflowSchema = createInsertSchema(workflows).omit({ id: true, createdAt: true, completedAt: true });
export const insertWorkflowStepSchema = createInsertSchema(workflowSteps).omit({ id: true, createdAt: true, completedAt: true });

export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type InsertWorkflowStep = z.infer<typeof insertWorkflowStepSchema>;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowStep = typeof workflowSteps.$inferSelect;

export const insertWorkflowChangeProposalSchema = createInsertSchema(workflowChangeProposals).omit({ id: true, createdAt: true });
export type InsertWorkflowChangeProposal = z.infer<typeof insertWorkflowChangeProposalSchema>;
export type WorkflowChangeProposal = typeof workflowChangeProposals.$inferSelect;
