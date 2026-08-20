import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties } from "./property.js";

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

export const insertWorkflowSchema = createInsertSchema(workflows).omit({ id: true, createdAt: true, completedAt: true });
export const insertWorkflowStepSchema = createInsertSchema(workflowSteps).omit({ id: true, createdAt: true, completedAt: true });

export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type InsertWorkflowStep = z.infer<typeof insertWorkflowStepSchema>;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowStep = typeof workflowSteps.$inferSelect;
