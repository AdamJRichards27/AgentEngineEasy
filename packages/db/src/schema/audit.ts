import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

// Ported pattern from Agent Engine Staging's audit.ts / logAudit() — the
// Property Timeline is a read projection over this table plus domain_events.
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  userEmail: text("user_email"),
  action: text("action").notNull(),
  recordType: text("record_type").notNull(),
  recordId: text("record_id").notNull(),
  propertyId: integer("property_id"),
  previousValue: text("previous_value"),
  updatedValue: text("updated_value"),
  providerReference: text("provider_reference"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AuditLogRow = typeof auditLogs.$inferSelect;
