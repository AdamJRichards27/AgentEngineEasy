// AE GROW Priority 6 Stage E — dedicated voice-transcription rate limiter.
//
// Deliberately separate from growRateLimiter.ts (20 Grow-scoped Ask AE TEXT
// requests per BROKERAGE per MINUTE) per the Stage E authorisation's
// explicit instruction for "a dedicated voice-transcription limiter": this
// stage's window (per brokerage per HOUR) and unit of work (an audio
// upload + a provider call, not a text prompt) are different enough that
// sharing growRateLimiter's counter would either under- or over-throttle
// one of the two features. Same in-memory, per-process, fixed-window
// implementation and the same documented single-process limitation as
// growRateLimiter.ts — see that file's own header comment for the full
// rationale, unchanged here: this does NOT coordinate across multiple API
// server processes/replicas, so the effective ceiling scales with replica
// count. Acceptable for the same reason it was acceptable there (an
// interim control, not a distributed-correctness requirement); a shared
// store (e.g. Redis) would be needed before this API runs multiple
// replicas in production.

const BROKERAGE_WINDOW_MS = 60 * 60_000; // 1 hour
const MAX_REQUESTS_PER_BROKERAGE_PER_WINDOW = 20;

// A tighter per-user ceiling within the same hourly window, so one noisy
// user cannot alone consume a shared brokerage's entire hourly budget —
// "reasonable protection per authenticated user" per the Stage E
// authorisation. Not configurable via env today (same as
// MAX_REQUESTS_PER_WINDOW in growRateLimiter.ts) — a fixed, documented
// default is preferable to an under-specified knob at this stage.
const MAX_REQUESTS_PER_USER_PER_WINDOW = 8;

interface WindowState {
  windowStartMs: number;
  count: number;
}

const windowsByBrokerageId = new Map<number, WindowState>();
const windowsByUserId = new Map<number, WindowState>();

// "Concurrent-request protection" — a user cannot have two transcription
// requests in flight at once. Also enforced client-side by
// voiceRecording.ts's own duplicate-start prevention, but never trusted
// client-side alone.
const usersWithRequestInFlight = new Set<number>();

export class VoiceRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceRateLimitError";
  }
}

export class VoiceConcurrentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConcurrentRequestError";
  }
}

function checkWindow(map: Map<number, WindowState>, id: number, limit: number, now: number): void {
  const existing = map.get(id);
  if (existing === undefined || now - existing.windowStartMs >= BROKERAGE_WINDOW_MS) {
    map.set(id, { windowStartMs: now, count: 1 });
    return;
  }
  if (existing.count >= limit) {
    throw new VoiceRateLimitError("Too many voice transcription requests. Please wait a while and try again.");
  }
  existing.count += 1;
}

/**
 * Called once per ATTEMPTED (not just completed) transcription request,
 * before any provider call — "20 completed or attempted transcription
 * requests per brokerage per hour" per the Stage E authorisation: a
 * request that goes on to fail upload validation or the provider call
 * still counts against the window, exactly like a successful one.
 */
export function assertVoiceRateLimit(brokerageId: number, userId: number, now: number = Date.now()): void {
  checkWindow(windowsByBrokerageId, brokerageId, MAX_REQUESTS_PER_BROKERAGE_PER_WINDOW, now);
  checkWindow(windowsByUserId, userId, MAX_REQUESTS_PER_USER_PER_WINDOW, now);
}

export function acquireVoiceConcurrencySlot(userId: number): void {
  if (usersWithRequestInFlight.has(userId)) {
    throw new VoiceConcurrentRequestError("A voice transcription request is already in progress for this user.");
  }
  usersWithRequestInFlight.add(userId);
}

export function releaseVoiceConcurrencySlot(userId: number): void {
  usersWithRequestInFlight.delete(userId);
}

// Test-only reset hook — mirrors growRateLimiter.ts's own
// _resetGrowRateLimiterForTests(). Without this, tests in the same file
// (and, since this module's state is shared per-process, across files run
// in the same worker) would leak state through this module's shared maps.
export function _resetVoiceRateLimiterForTests(): void {
  windowsByBrokerageId.clear();
  windowsByUserId.clear();
  usersWithRequestInFlight.clear();
}
