// Owner t181u(C): safe retry delays for stored-card collection of the Pit Crew
// service fee. Exponential backoff from a base, capped; the next attempt time
// is stored on the payment request (next_attempt_at). A retry is attempted
// only by the collection scheduler or an explicit, fully re-gated collect, and
// never before next_attempt_at. UNKNOWN charges are never retried here (a
// Brokerage Administrator resolves them first).
//
// Owner t183u(3) / #245 S3 retry policy:
//  - intervals: 30m, 1h, 2h, 4h, 8h, 16h, then 24h (cap) - see cardRetryDelayMs;
//  - maximum ATTEMPTS (first charge included) is configurable with
//    PC_FEE_MAX_PAYMENT_ATTEMPTS (integer 1..10, default 3; anything else
//    falls back to the default). It is snapshotted onto the payment request
//    (financial_payment_requests.max_retries) when the request is created, so
//    changing the env var never alters a fee already in flight;
//  - NEVER auto-retried: an uncertain transaction (UNKNOWN/PENDING charge, or a
//    PROCESSING request) or a fee whose authority is no longer valid (revoked,
//    replaced, expired, or its nominated card removed). Every retry re-gates
//    the authority at run time; uncertain outcomes need BA resolution first.
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

export const PC_FEE_MAX_PAYMENT_ATTEMPTS_DEFAULT = 3;
export const PC_FEE_MAX_PAYMENT_ATTEMPTS_CEILING = 10;

/** Maximum payment attempts for a new PC fee request (PC_FEE_MAX_PAYMENT_ATTEMPTS, 1..10, default 3). */
export function pcFeeMaxPaymentAttempts(): number {
  const raw = process.env.PC_FEE_MAX_PAYMENT_ATTEMPTS;
  if (raw == null || !/^\d+$/.test(raw.trim())) return PC_FEE_MAX_PAYMENT_ATTEMPTS_DEFAULT;
  const n = Number(raw.trim());
  return n >= 1 && n <= PC_FEE_MAX_PAYMENT_ATTEMPTS_CEILING ? n : PC_FEE_MAX_PAYMENT_ATTEMPTS_DEFAULT;
}
