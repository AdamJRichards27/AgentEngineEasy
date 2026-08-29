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

    // Agent Engine 2.0 (Stage 2): generalised aggregate reference so the
    // Workflow Automation Engine can correlate/trigger against any domain
    // entity, not just the fixed property/transaction/party/brokerage/agent
    // columns above (which remain for existing consumers).
    aggregateType: text("aggregate_type"),
    aggregateId: text("aggregate_id"),

    actorType: text("actor_type").notNull(), // USER | SYSTEM | PIT_CREW | INTEGRATION
    actorId: integer("actor_id"),

    source: text("source").notNull(), // "api:properties:start", "webhook:aml:mock", etc.

    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),

    idempotencyKey: text("idempotency_key"),

    payload: jsonb("payload"),
    metadata: jsonb("metadata"),

    // Agent Engine 2.0 (Stage 2, Build Instructions section on audit/observability):
    // sensitive values/credentials/identity documents must not be written
    // into logs. This marks payload sensitivity so audit/log surfaces can
    // redact SENSITIVE rows; it does not itself redact anything.
    dataClassification: text("data_classification").notNull().default("STANDARD"), // STANDARD | SENSITIVE

    processingStatus: text("processing_status").notNull().default("PROCESSED"),
    handlerErrors: jsonb("handler_errors"),
    attemptCount: integer("attempt_count").notNull().default(1),
  },
  (table) => ({
    idempotencyKeyIdx: uniqueIndex("domain_events_idempotency_key_idx").on(table.idempotencyKey),
  }),
);

export type DomainEventRow = typeof domainEvents.$inferSelect;
