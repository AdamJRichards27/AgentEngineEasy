import { pgTable, integer, serial, text, timestamp, index } from "drizzle-orm/pg-core";
import { users, brokerages } from "./users";

// Separate from USER_ROLES: a brokerage administrator can never assign this
// permission through invitations or the ordinary user-management API.
export const platformOwners = pgTable("platform_owners", {
  userId: integer("user_id").primaryKey().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const platformOwnerAudit = pgTable("platform_owner_audit", {
  id: serial("id").primaryKey(),
  ownerUserId: integer("owner_user_id").notNull().references(() => users.id),
  brokerageId: integer("brokerage_id").references(() => brokerages.id),
  action: text("action").notNull(),
  method: text("method").notNull(),
  // Only a static route family, never URLs, cookies, bodies, or query strings.
  surface: text("surface").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => ({
  ownerTimeIdx: index("platform_owner_audit_owner_time_idx").on(table.ownerUserId, table.createdAt),
}));
