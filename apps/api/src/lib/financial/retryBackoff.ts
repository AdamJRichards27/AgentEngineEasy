// Owner t181u(C): safe retry delays for stored-card collection of the Pit Crew
// service fee. Exponential backoff from a base, capped; the next attempt time
// is stored on the payment request (next_attempt_at). A retry is attempted
// only by the collection scheduler or an explicit, fully re-gated collect, and
// never before next_attempt_at. UNKNOWN charges are never retried here (a
// Brokerage Administrator resolves them first).
export const CARD_RETRY_BASE_MS = 30 * 60_000;
export const CARD_RETRY_CAP_MS = 24 * 60 * 60_000;

/** Delay before the next attempt after `failedAttempts` failures (1 -> base, doubling, capped). */
export function cardRetryDelayMs(failedAttempts: number): number {
  const n = Math.max(1, Math.floor(failedAttempts));
  if (n > 20) return CARD_RETRY_CAP_MS;
  return Math.min(CARD_RETRY_BASE_MS * 2 ** (n - 1), CARD_RETRY_CAP_MS);
}

export function nextCardRetryAt(now: Date, failedAttempts: number): Date {
  return new Date(now.getTime() + cardRetryDelayMs(failedAttempts));
}

/** Fail closed: a scheduled retry with no next_attempt_at is never due. */
export function cardRetryDue(nextAttemptAt: Date | null, now: Date = new Date()): boolean {
  return nextAttemptAt != null && nextAttemptAt.getTime() <= now.getTime();
}
