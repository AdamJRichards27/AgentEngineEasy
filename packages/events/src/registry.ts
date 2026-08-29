import type { AgentEngineEasyEventType, DomainEvent, EventHandler } from "./types.js";

// Handlers are isolated: one handler throwing never blocks a sibling handler
// or corrupts the event's persisted record (Agent Engine Staging's proven pattern).
const handlers = new Map<AgentEngineEasyEventType, EventHandler[]>();

export function registerHandler<TPayload>(eventType: AgentEngineEasyEventType, handler: EventHandler<TPayload>): void {
  const existing = handlers.get(eventType) ?? [];
  existing.push(handler as EventHandler);
  handlers.set(eventType, existing);
}

export async function dispatchToHandlers(
  event: DomainEvent,
): Promise<{ ok: boolean; errors: Array<{ handler: string; error: string }> }> {
  const registered = handlers.get(event.eventType) ?? [];
  const errors: Array<{ handler: string; error: string }> = [];

  for (const handler of registered) {
    try {
      await handler(event);
    } catch (err: any) {
      errors.push({ handler: handler.name || "anonymous", error: String(err?.message ?? err) });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function clearHandlersForTesting(): void {
  handlers.clear();
}
