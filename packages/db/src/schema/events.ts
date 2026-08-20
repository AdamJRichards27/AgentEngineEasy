import { pgTable, uuid, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Persistence for the 19 canonical domain events — see packages/events for
// the types/registry/publisher. Mirrors Agent Engine Staging's proven
// domain_events shape (Build Brief §17).
export const domainEvents = pgTable(
  "domain_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull().default(1),

    occurredAt: timestamp("occurred_at").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),

    propertyId: integer("property_id"),
    transactionId: integer("transaction_id"),
    partyId: integer("party_id"),
    brokerageId: integer("brokerage_id"),
    agentId: integer("agent_id"),

    actorType: text("actor_type").notNull(), // USER | SYSTEM | PIT_CREW | INTEGRATION
    actorId: integer("actor_id"),

    source: text("source").notNull(), // "api:properties:start", "webhook:aml:mock", etc.

    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),

    idempotencyKey: text("idempotency_key"),

    payload: jsonb("payload"),
    metadata: jsonb("metadata"),

    processingStatus: text("processing_status").notNull().default("PROCESSED"),
    handlerErrors: jsonb("handler_errors"),
    attemptCount: integer("attempt_count").notNull().default(1),
  },
  (table) => ({
    idempotencyKeyIdx: uniqueIndex("domain_events_idempotency_key_idx").on(table.idempotencyKey),
  }),
);

export type DomainEventRow = typeof domainEvents.$inferSelect;
