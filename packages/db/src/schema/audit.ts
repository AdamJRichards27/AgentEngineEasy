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
  // AE GROW Completion Wave 1 index batch. The other half of the Property
  // Timeline read (apps/api/src/lib/timeline.ts): `where property_id = $1 and
  // action in (...)`. The brokerage index above does not serve it — this
  // table has no brokerage_id predicate on that path at all (the tenant check
  // happens on the property before the query runs), so the timeline was
  // sequential-scanning audit_logs on every open.
  propertyActionIdx: index("audit_logs_property_action_idx").on(table.propertyId, table.action),
}));

export type AuditLogRow = typeof auditLogs.$inferSelect;
