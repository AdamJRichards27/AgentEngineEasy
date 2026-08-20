import { pgTable, serial, integer, text, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties, parties } from "./property.js";
import { users, brokerages } from "./users.js";

// Who pays for a service — designed so the payer can later become a team,
// brokerage, or subscription allowance without rebuilding ServiceOrder (§12).
export const PAYER_TYPES = ["Agent", "Team", "Brokerage", "SubscriptionAllowance", "Central"] as const;

export const paymentMethods = pgTable("payment_methods", {
  id: serial("id").primaryKey(),
  payerType: text("payer_type").notNull().default("Agent"),
  payerId: integer("payer_id").notNull(), // polymorphic: userId or brokerageId depending on payerType
  provider: text("provider").notNull(), // e.g. "stripe"
  providerCustomerRef: text("provider_customer_ref").notNull(),
  providerPaymentMethodRef: text("provider_payment_method_ref").notNull(),
  label: text("label"), // e.g. "Visa ending 4242"
  isDefault: numeric("is_default", { precision: 1 }).default("1"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Generic paid-service entity (Build Brief §11) — every new chargeable
// service (AML, searches, paid forms) flows through this one table.
export const serviceOrders = pgTable("service_orders", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  partyId: integer("party_id").references(() => parties.id),
  serviceType: text("service_type").notNull(), // e.g. "AmlVerification", "TitleSearch"
  provider: text("provider").notNull(),
  providerReference: text("provider_reference"),
  wholesaleCostCents: integer("wholesale_cost_cents").notNull(),
  customerPriceCents: integer("customer_price_cents").notNull(),
  gstCents: integer("gst_cents").notNull().default(0),
  paymentStatus: text("payment_status").notNull().default("Pending"), // Pending | Charged | Failed | Refunded
  status: text("status").notNull().default("Ordered"), // Ordered | InProgress | Completed | Failed
  orderedAt: timestamp("ordered_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  serviceOrderId: integer("service_order_id").notNull().references(() => serviceOrders.id),
  paymentMethodId: integer("payment_method_id").references(() => paymentMethods.id),
  provider: text("provider").notNull(),
  providerChargeRef: text("provider_charge_ref"),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("Pending"), // Pending | Succeeded | Failed | Refunded
  // Idempotency key on every charge attempt (Build Brief §21 — critical:
  // repeated button clicks must never charge twice).
  idempotencyKey: text("idempotency_key").notNull().unique(),
  receiptUrl: text("receipt_url"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPaymentMethodSchema = createInsertSchema(paymentMethods).omit({ id: true, createdAt: true });
export const insertServiceOrderSchema = createInsertSchema(serviceOrders).omit({ id: true, orderedAt: true, completedAt: true });
export const insertPaymentSchema = createInsertSchema(payments).omit({ id: true, createdAt: true });

export type InsertPaymentMethod = z.infer<typeof insertPaymentMethodSchema>;
export type InsertServiceOrder = z.infer<typeof insertServiceOrderSchema>;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type ServiceOrder = typeof serviceOrders.$inferSelect;
export type Payment = typeof payments.$inferSelect;

// re-exported for callers that only need brokerage/user typing alongside commerce types
export type { Brokerage, User } from "./users.js";
