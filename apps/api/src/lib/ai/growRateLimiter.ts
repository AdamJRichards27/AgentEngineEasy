// AE GROW Priority 6 Stage B — Grow-scoped Ask AE rate limiting.
//
// Scope: this limiter applies ONLY to Grow-scoped asks (contextType "grow"),
// called from orchestrator.ts's askCopilot() right after the feature-flag
// check and before any context/database work. RUN Copilot's existing
// property/business/transaction asks are completely unaffected - this is a
// new, additive control, not a change to existing rate-limiting behaviour
// (there was none for Copilot before this file, and there still is none
// after it, outside of Grow).
//
// Implementation: a small, in-memory, per-process fixed-window counter,
// keyed by brokerageId (Grow-scoped Ask AE is a brokerage-wide feature - see
// growContext.ts - so this keeps the limiter's memory bounded by brokerage
// count rather than by every individual user).
//
// Documented limitation: this does NOT coordinate across multiple API
// server processes/replicas - each process enforces its own independent
// window, so the effective ceiling scales with replica count. That is an
// acceptable interim control for a Level 0, read-only feature rather than a
// distributed-correctness requirement; a shared store (e.g. Redis) would be
// needed before this API runs multiple replicas in production. Recorded as
// a known limitation in this stage's completion report, not silently
// assumed away.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;

interface WindowState {
  windowStartMs: number;
  count: number;
}

const windowsByBrokerageId = new Map<number, WindowState>();

export class GrowRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowRateLimitError";
  }
}

// Throws GrowRateLimitError if this brokerage has already made
// MAX_REQUESTS_PER_WINDOW Grow-scoped asks within the current window;
// otherwise records this call and returns normally. `now` is a parameter
// (defaulting to Date.now()) purely so tests can drive the clock explicitly
// rather than sleeping in real time.
export function assertGrowRateLimit(brokerageId: number, now: number = Date.now()): void {
  const existing = windowsByBrokerageId.get(brokerageId);
  if (existing === undefined || now - existing.windowStartMs >= WINDOW_MS) {
    windowsByBrokerageId.set(brokerageId, { windowStartMs: now, count: 1 });
    return;
  }
  if (existing.count >= MAX_REQUESTS_PER_WINDOW) {
    throw new GrowRateLimitError(
      "Too many Ask AE requests for this brokerage in the last minute. Please wait a moment and try again."
    );
  }
  existing.count += 1;
}

// Test-only reset hook. Without this, tests in the same file would leak
// state through this module's shared `windowsByBrokerageId` map (node:test
// runs separate test files concurrently, but tests within one file share
// this module's state).
export function _resetGrowRateLimiterForTests(): void {
  windowsByBrokerageId.clear();
}
