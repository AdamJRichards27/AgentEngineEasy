import { pgTable, serial, integer, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties, parties } from "./property";
import { users, brokerages } from "./users";

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
  // Phase 6: fixed from this table's original numeric(1) "1"/"0" — this
  // table had zero rows anywhere in the app until Phase 6 actually wired up
  // charging, so there's no data to migrate and no reason to keep a
  // string-typed boolean around (same "real structured fields, not a
  // workaround" principle ARCHITECTURE.md §3 already applies elsewhere).
  isDefault: boolean("is_default").notNull().default(false),
  // Soft-delete: paymentMethods.id is referenced by payments.paymentMethodId
  // (never cascaded — a payment's record of which card it charged must
  // survive that card being removed), so "delete" deactivates rather than
  // removes the row.
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
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
  // Surfaced to the agent when a charge fails (e.g. "card_declined:
  // insufficient_funds") rather than a bare "Failed" with no explanation.
  failureReason: text("failure_reason"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertPaymentMethodSchema = createInsertSchema(paymentMethods).omit({ id: true, createdAt: true, updatedAt: true });
export const insertServiceOrderSchema = createInsertSchema(serviceOrders).omit({ id: true, orderedAt: true, completedAt: true });
export const insertPaymentSchema = createInsertSchema(payments).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertPaymentMethod = z.infer<typeof insertPaymentMethodSchema>;
export type InsertServiceOrder = z.infer<typeof insertServiceOrderSchema>;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type ServiceOrder = typeof serviceOrders.$inferSelect;
export type Payment = typeof payments.$inferSelect;

// re-exported for callers that only need brokerage/user typing alongside commerce types
export type { Brokerage, User } from "./users";
