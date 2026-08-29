import { randomUUID } from "node:crypto";
import type { DomainEvent, EventStore, PublishEventInput } from "./types.js";
import { EVENT_TYPE_REGISTRY } from "./types.js";
import { dispatchToHandlers } from "./registry.js";

let store: EventStore | null = null;

export function configureEventStore(s: EventStore): void {
  store = s;
}

/**
 * Publish a domain event. Rules (kept from the proven Agent Engine pattern):
 * 1. Persist first, publish second — call this AFTER the write it describes
 *    has already committed. If this call throws, the caller's business
 *    transaction has already succeeded and must not be rolled back for it.
 * 2. Callers must wrap this in their own try/catch and log on failure — a
 *    broken event pipeline must never break AML submission, offer creation,
 *    contract signing, or settlement recording.
 * 3. Set idempotencyKey whenever the trigger can plausibly re-fire (webhook
 *    retries, a user double-clicking a non-idempotent action).
 */
export async function publishDomainEvent<TPayload = Record<string, unknown>>(
  input: PublishEventInput<TPayload>,
): Promise<DomainEvent<TPayload>> {
  if (!store) {
    throw new Error("Event store not configured — call configureEventStore() at app bootstrap.");
  }

  const eventVersion = input.eventVersion ?? EVENT_TYPE_REGISTRY[input.eventType].version;

  const persisted = (await store.append({ ...input, eventVersion } as PublishEventInput)) as DomainEvent<TPayload>;

  const { ok, errors } = await dispatchToHandlers(persisted as DomainEvent);
  if (!ok) {
    await store.updateProcessingStatus(persisted.id, "PARTIAL_FAILURE", errors);
  }

  return persisted;
}

export function newCorrelationId(): string {
  return randomUUID();
}
