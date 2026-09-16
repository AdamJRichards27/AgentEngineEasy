import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { brokerages } from "./users";

// Ported pattern from Agent Engine Staging's audit.ts / logAudit() — the
// Property Timeline is a read projection over this table plus domain_events.
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  // Added for tenant-scoped decision evidence. Nullable preserves the
  // historical rows written before audit records carried tenant context.
  brokerageId: integer("brokerage_id").references(() => brokerages.id),
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
}, (table) => ({
  brokerageIdx: index("audit_logs_brokerage_idx").on(table.brokerageId, table.createdAt),
}));

export type AuditLogRow = typeof auditLogs.$inferSelect;
