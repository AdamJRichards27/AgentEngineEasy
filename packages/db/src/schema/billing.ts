import { pgTable, serial, text, integer, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";

// Grow Stage A - Subscription, Entitlement & Billing domain (ARCHITECTURE.md Phase 10).
// Commercial product definitions (products/prices) are kept separate from runtime access
// decisions (entitlementGrants). Nothing here hard-codes a dollar figure - pricing lives in
// the `prices` table as seeded catalogue data, not in code.

export const products = pgTable("billing_products", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(), // stable machine id, e.g. "grow", "agent_engine_starter"
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("Active"), // Active | Archived
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const prices = pgTable("billing_prices", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  billingProviderPriceId: text("billing_provider_price_id"), // Stripe price id once real
  currency: text("currency").notNull().default("AUD"),
  amountCents: integer("amount_cents").notNull(),
  billingInterval: text("billing_interval").notNull(), // month | year | one_time
  taxBehaviour: text("tax_behaviour").notNull().default("unspecified"),
  activeFrom: timestamp("active_from").notNull().defaultNow(),
  activeUntil: timestamp("active_until"),
  status: text("status").notNull().default("Active"), // Active | Archived
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Suggested subscriber types today: only "brokerage" is resolvable (there is no office/team
// tenancy layer in this codebase yet - see ARCHITECTURE.md's own "office = tenant by
// convention only" gap note, not repeated here). "user" is schema-ready for a future
// individually-purchased seat but nothing issues one yet.
export const subscriptions = pgTable("billing_subscriptions", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  subscriberType: text("subscriber_type").notNull().default("brokerage"), // brokerage | user
  subscriberId: integer("subscriber_id").notNull(),
  billingCustomerRef: text("billing_customer_ref"),
  billingSubscriptionRef: text("billing_subscription_ref"),
  status: text("status").notNull().default("Trialing"), // Trialing | Active | PastDue | Cancelled | Ended
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  cancelledAt: timestamp("cancelled_at"),
  trialEndsAt: timestamp("trial_ends_at"),
  graceEndsAt: timestamp("grace_ends_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const subscriptionItems = pgTable("billing_subscription_items", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscription_id").notNull().references(() => subscriptions.id),
  productId: integer("product_id").notNull().references(() => products.id),
  priceId: integer("price_id").notNull().references(() => prices.id),
  quantity: integer("quantity").notNull().default(1),
  status: text("status").notNull().default("Active"), // Active | Cancelled
  effectiveFrom: timestamp("effective_from").notNull().defaultNow(),
  effectiveUntil: timestamp("effective_until"),
});

// A small, meaningful set of capabilities - not one entitlement per button (Build Brief intent).
//
// AE GROW Priority 0.5 — Workstream 3: "run.access" was added here as the minimum coarse RUN
// entitlement foundation (see docs/AE_GROW_PRIORITY_0_5_FOUNDATION_REPORT.md §"Grow/Run
// Boundary" for the full key-by-key REMAINS GROW / BECOMES RUN / SHARED CORE mapping). Every
// key below it is unchanged and REMAINS scoped to the Grow product exactly as before — none of
// the existing 13 grow.* keys became a RUN key. run.access is deliberately coarse (one key
// covering the whole existing RUN surface — Pit Crew, Financial), matching this phase's
// "minimum foundation, not a full RUN entitlement redesign" mandate; a finer-grained RUN
// entitlement taxonomy (mirroring Grow's per-capability keys) is explicitly deferred, not
// something this phase invents speculatively.
//
// AE GROW Priority 2 — Contact Intelligence & Relationship Timeline: no new entitlement key
// was required. grow.contacts.read (already reserved above, previously unused) is now the
// read gate for Contact 360 / contact list+search; grow.contacts.manage (already reserved,
// previously unused) is now the write gate for relationship-classification and
// contact-property relationship mutations introduced by this priority. Notes/commitments
// continue to reuse grow.activities.manage exactly as Priority 1 already established for
// growActivities writes — see routes/contacts.ts's own header comment.
//
// AE GROW Priority 5 — Data & Property Intelligence: two new keys, deliberately separate from
// grow.properties.link (linking a contact to a property) and grow.opportunities.manage
// (owning a real pipeline opportunity). grow.propertyIntelligence.read gates viewing provider
// observations / match candidates / opportunity signals (Contact 360, property-view panel,
// GET routes); grow.propertyIntelligence.manage gates confirming/rejecting a match,
// reviewing/dismissing a signal, and promoting a signal into a real growOpportunities row —
// see routes/propertyIntelligence.ts's own header comment.
//
// AE GROW Priority 6 Stage F1 — Call Foundation, Consent Model and Sandbox Telephony: three
// new keys, reviewed against the entitlement names PR #39's discovery proposed and renamed to
// match this file's existing grow.<domain>.<verb> convention exactly.
// grow.calling.access gates the call-session lifecycle itself (create/confirm/cancel/view a
// sandbox call, the Contact 360 eligibility check) — see routes/growCalls.ts. grow.calling.
// recording gates capturing/withdrawing call-recording consent — a SEPARATE key from
// grow.calling.access, since being entitled to place a (sandbox) call must never imply being
// entitled to manage recording consent for it. grow.calling.transcription gates Stage F3/F4 —
// transcribing a consented recording, the human review/edit/discard of its draft summary, and
// proposing governed follow-ups from the approved items (routes/growCalls.ts,
// routes/growCallFollowups.ts).
export const ENTITLEMENT_KEYS = [
  "run.access",
  "grow.access",
  "grow.contacts.read",
  "grow.contacts.manage",
  "grow.properties.link",
  "grow.relationships.manage",
  "grow.activities.manage",
  "grow.opportunities.manage",
  "grow.import.execute",
  "grow.import.review",
  "grow.ai.use",
  "grow.automation.use",
  "grow.campaigns.use",
  "grow.admin.configure",
  "grow.propertyIntelligence.read",
  "grow.propertyIntelligence.manage",
  "grow.calling.access",
  "grow.calling.recording",
  "grow.calling.transcription",
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export const entitlementDefinitions = pgTable("entitlement_definitions", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const productEntitlements = pgTable("product_entitlements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  entitlementDefinitionId: integer("entitlement_definition_id").notNull().references(() => entitlementDefinitions.id),
  enabled: boolean("enabled").notNull().default(true),
  limitValue: integer("limit_value"),
  configuration: jsonb("configuration"),
  effectiveFrom: timestamp("effective_from").notNull().defaultNow(),
  effectiveUntil: timestamp("effective_until"),
});

// The resolved / explicit access grant - what the entitlement resolver actually reads.
// grantee_type covers the full suggested hierarchy for forward compatibility, but only
// "platform" and "brokerage" are resolvable today; "office"/"team" have no tenancy table to
// join against yet and "user" seat-level allocation is schema-ready but unused in Stage A.
export const entitlementGrants = pgTable("entitlement_grants", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  entitlementKey: text("entitlement_key").notNull(),
  granteeType: text("grantee_type").notNull().default("brokerage"), // platform | brokerage | office | team | user
  granteeId: integer("grantee_id"),
  sourceType: text("source_type").notNull(), // subscription | trial | promotion | admin_override | migration
  sourceId: integer("source_id"),
  status: text("status").notNull().default("Active"), // Active | Revoked | Expired
  startsAt: timestamp("starts_at").notNull().defaultNow(),
  endsAt: timestamp("ends_at"),
  limitValue: integer("limit_value"),
  configuration: jsonb("configuration"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Inbound billing-provider webhooks. Idempotency mirrors domain_events' idempotencyKey
// pattern but is scoped to (provider, providerEventId) since that's the natural dedupe key
// a payment provider gives us, and webhook processing must tolerate repeated/out-of-order
// delivery without re-applying an already-processed event.
export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(), // mock | stripe
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull().default("Received"), // Received | Processed | Failed
    payload: jsonb("payload"),
    error: text("error"),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
  },
  (table) => ({
    providerEventIdx: uniqueIndex("billing_webhook_events_provider_event_idx").on(table.provider, table.providerEventId),
  }),
);

export const insertProductSchema = createInsertSchema(products).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPriceSchema = createInsertSchema(prices).omit({ id: true, createdAt: true });
export const insertSubscriptionSchema = createInsertSchema(subscriptions).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSubscriptionItemSchema = createInsertSchema(subscriptionItems).omit({ id: true });
export const insertEntitlementDefinitionSchema = createInsertSchema(entitlementDefinitions).omit({ id: true, createdAt: true });
export const insertProductEntitlementSchema = createInsertSchema(productEntitlements).omit({ id: true });
export const insertEntitlementGrantSchema = createInsertSchema(entitlementGrants).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBillingWebhookEventSchema = createInsertSchema(billingWebhookEvents).omit({ id: true, receivedAt: true });

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type InsertPrice = z.infer<typeof insertPriceSchema>;
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type InsertSubscriptionItem = z.infer<typeof insertSubscriptionItemSchema>;
export type InsertEntitlementDefinition = z.infer<typeof insertEntitlementDefinitionSchema>;
export type InsertProductEntitlement = z.infer<typeof insertProductEntitlementSchema>;
export type InsertEntitlementGrant = z.infer<typeof insertEntitlementGrantSchema>;
export type InsertBillingWebhookEvent = z.infer<typeof insertBillingWebhookEventSchema>;

export type Product = typeof products.$inferSelect;
export type Price = typeof prices.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionItem = typeof subscriptionItems.$inferSelect;
export type EntitlementDefinition = typeof entitlementDefinitions.$inferSelect;
export type ProductEntitlement = typeof productEntitlements.$inferSelect;
export type EntitlementGrant = typeof entitlementGrants.$inferSelect;
export type BillingWebhookEvent = typeof billingWebhookEvents.$inferSelect;
