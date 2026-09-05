// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Ambient request/job context, carried across async boundaries via
// AsyncLocalStorage (Node's built-in — no new dependency). This is what
// closes the gap flagged in apps/api/src/middlewares/requestId.ts's own
// comment: previously, every call site that needed a correlationId for a
// published domain event, an audit record, or a log line called
// newCorrelationId() and minted a brand-new, unrelated id — completely
// disconnected from the HTTP request (or scheduled sweep, or replay) that
// was actually running.
//
// The fix is structural, not per-call-site: wrap the top of each unit of
// work (an HTTP request, a scheduler tick, a single retry/replay attempt)
// in runWithCorrelationId(), and everything that runs underneath it —
// however deep, across however many awaited calls — can read the same id
// back via currentCorrelationId() without it being threaded through every
// function signature by hand.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface AmbientContext {
  correlationId: string;
  /** The record/event this unit of work is causally downstream of, if any — set by callers that are re-entering a chain (a retry, a replay) rather than starting a fresh one. Distinct from correlationId: correlationId identifies the whole causal chain, causationId identifies the one immediate predecessor step. */
  causationId?: string | null;
}

const storage = new AsyncLocalStorage<AmbientContext>();

/**
 * Runs `fn` with the given correlationId (and optional causationId)
 * established as the ambient context for its whole synchronous +
 * asynchronous extent — every awaited call inside `fn`, and everything
 * *they* call, sees this same context via currentCorrelationId() /
 * currentCausationId(), unless something further down calls
 * runWithCorrelationId() again to start a nested chain (e.g. a retry
 * re-entering with the original command's stored correlationId).
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T, causationId?: string | null): T {
  return storage.run({ correlationId, causationId: causationId ?? null }, fn);
}

/** The correlationId of the current ambient context, or undefined if none is active (e.g. a one-off script, or a test that never wrapped itself in runWithCorrelationId). */
export function getActiveCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** The causationId of the current ambient context, or null if none was set. */
export function getActiveCausationId(): string | null {
  return storage.getStore()?.causationId ?? null;
}

/**
 * The correlationId to use for whatever is happening right now: the
 * active ambient one if a context is running, otherwise a fresh one.
 * Prefer this over the old newCorrelationId() at any call site that
 * publishes a domain event, writes an audit record, or logs — it
 * automatically ties back to the request/job/retry currently in flight,
 * and degrades gracefully (a brand-new id, exactly newCorrelationId()'s
 * old behaviour) when called outside any established context.
 */
export function currentCorrelationId(): string {
  return getActiveCorrelationId() ?? randomUUID();
}
