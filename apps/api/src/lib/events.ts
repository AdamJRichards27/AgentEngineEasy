import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, domainEvents } from "@aee/db";
import { configureEventStore } from "@aee/events";
import type { EventStore, PublishEventInput, DomainEvent } from "@aee/events";

// Wires the events package's abstract EventStore to this app's actual
// database table — same separation Agent Engine Staging uses (the package
// itself has no database dependency, so it can be unit-tested with a fake).
class DrizzleEventStore implements EventStore {
  async append(input: PublishEventInput): Promise<DomainEvent> {
    const [row] = await db
      .insert(domainEvents)
      .values({
        eventType: input.eventType,
        eventVersion: input.eventVersion ?? 1,
        occurredAt: input.occurredAt,
        propertyId: input.propertyId,
        transactionId: input.transactionId,
        partyId: input.partyId,
        brokerageId: input.brokerageId,
        agentId: input.agentId,
        actorType: input.actorType,
        actorId: input.actorId,
        source: input.source,
        correlationId: input.correlationId ?? randomUUID(),
        causationId: input.causationId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        metadata: input.metadata,
      })
      .returning();

    return {
      ...row,
      recordedAt: row.recordedAt,
      handlerErrors: row.handlerErrors as DomainEvent["handlerErrors"],
    } as DomainEvent;
  }

  async updateProcessingStatus(
    id: string,
    status: DomainEvent["processingStatus"],
    handlerErrors: DomainEvent["handlerErrors"],
  ): Promise<void> {
    await db
      .update(domainEvents)
      .set({ processingStatus: status, handlerErrors })
      .where(eq(domainEvents.id, id));
  }
}

export function configureEvents(): void {
  configureEventStore(new DrizzleEventStore());
}
