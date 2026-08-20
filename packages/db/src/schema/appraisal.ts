import { pgTable, serial, integer, text, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties } from "./property.js";

export const appraisals = pgTable("appraisals", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  priceRangeLow: numeric("price_range_low", { precision: 12, scale: 2 }),
  priceRangeHigh: numeric("price_range_high", { precision: 12, scale: 2 }),
  comparableSales: jsonb("comparable_sales"),
  isFinalised: boolean("is_finalised").notNull().default(false),
  // Immutable snapshot on finalisation — pattern kept from Agent Engine Staging's appraisals.ts.
  finalisedSnapshot: jsonb("finalised_snapshot"),
  shareToken: text("share_token").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAppraisalSchema = createInsertSchema(appraisals).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAppraisal = z.infer<typeof insertAppraisalSchema>;
export type Appraisal = typeof appraisals.$inferSelect;
