import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// AgentEngineEasy's role model is deliberately small (Build Brief §22) —
// grown later by deliberate decision, not accretion.
export const USER_ROLES = ["Agent", "Brokerage Administrator", "Pit Crew"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const brokerages = pgTable("brokerages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Real first-class tenancy entity from day one — the prior Agent Engine
  // audit flagged "office = tenant by convention only" as a gap; not repeated here.
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  authProviderId: text("auth_provider_id").notNull().unique(),
  email: text("email").notNull(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  role: text("role").notNull().default("Agent"),
  brokerageId: integer("brokerage_id").references(() => brokerages.id),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBrokerageSchema = createInsertSchema(brokerages).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBrokerage = z.infer<typeof insertBrokerageSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Brokerage = typeof brokerages.$inferSelect;
export type User = typeof users.$inferSelect;
