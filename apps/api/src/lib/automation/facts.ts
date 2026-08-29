// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// Builds the flat "facts" record that conditions.ts evaluates against and
// templating.ts substitutes from, out of a triggering domain event. This is
// the ONLY place a domain event's shape is translated into automation
// input — conditions.ts/templating.ts never touch a DomainEvent directly,
// so a future new event field only ever needs a change here.
//
// getFactValue is a deliberately narrow, safe dot-path reader: no eval, no
// Function construction, no dynamic property access beyond plain
// dot-separated keys, and an explicit denylist of prototype-polluting key
// names. This is part of the "never execute an arbitrary function, prompt,
// script, URL, or database mutation supplied through workflow
// configuration" safety requirement — field paths come from an
// administrator-authored conditionGroup/action params, not from
// unvalidated external input, but this stays defensive regardless.

import type { DomainEvent } from "@aee/events";

export type AutomationFacts = Record<string, unknown>;

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function buildFacts(event: DomainEvent): AutomationFacts {
  return {
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
    propertyId: event.propertyId,
    transactionId: event.transactionId,
    partyId: event.partyId,
    brokerageId: event.brokerageId,
    agentId: event.agentId,
    actorType: event.actorType,
    actorId: event.actorId,
    source: event.source,
    payload: (event.payload ?? {}) as Record<string, unknown>,
    metadata: (event.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Reads a dot-path (e.g. "payload.offerId") out of a facts record. Returns
 * undefined for a missing/forbidden segment rather than throwing — a
 * missing field is a normal, expected outcome for the "exists"/"notExists"
 * operators and for templating placeholders, never a crash.
 */
export function getFactValue(facts: AutomationFacts, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = facts;
  for (const segment of segments) {
    if (!segment || FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
