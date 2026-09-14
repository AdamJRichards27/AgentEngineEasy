import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertVoiceRateLimit,
  acquireVoiceConcurrencySlot,
  releaseVoiceConcurrencySlot,
  _resetVoiceRateLimiterForTests,
  VoiceRateLimitError,
  VoiceConcurrentRequestError,
} from "../voiceRateLimiter.js";

// Every test uses an injected `now` (mirroring growRateLimiter.ts's own
// test-clock-injection convention) rather than real sleeping, and resets
// this module's shared in-memory state first — its maps/set are
// per-process, so an earlier test's state would otherwise leak in.

test("assertVoiceRateLimit allows up to 20 requests per brokerage within the hourly window, and rejects the 21st", () => {
  _resetVoiceRateLimiterForTests();
  const now = Date.now();
  const brokerageId = 1;
  // Distinct userIds per call so the tighter per-user ceiling (8) never
  // interferes with isolating the brokerage-level ceiling (20).
  for (let i = 0; i < 20; i++) {
    assert.doesNotThrow(() => assertVoiceRateLimit(brokerageId, 1000 + i, now));
  }
  assert.throws(
    () => assertVoiceRateLimit(brokerageId, 9999, now),
    (err: unknown) => err instanceof VoiceRateLimitError,
  );
});

test("assertVoiceRateLimit enforces a tighter per-user ceiling (8) within the same window, independent of the brokerage ceiling", () => {
  _resetVoiceRateLimiterForTests();
  const now = Date.now();
  const brokerageId = 2;
  const userId = 55;
  for (let i = 0; i < 8; i++) {
    assert.doesNotThrow(() => assertVoiceRateLimit(brokerageId, userId, now));
  }
  assert.throws(
    () => assertVoiceRateLimit(brokerageId, userId, now),
    (err: unknown) => err instanceof VoiceRateLimitError,
  );
});

test("assertVoiceRateLimit does not let one noisy user alone exhaust a shared brokerage's window before hitting their own per-user ceiling first", () => {
  _resetVoiceRateLimiterForTests();
  const now = Date.now();
  const brokerageId = 3;
  const userId = 77;
  for (let i = 0; i < 8; i++) {
    assertVoiceRateLimit(brokerageId, userId, now);
  }
  // The 9th request from this same user is rejected by the per-user
  // ceiling, even though the brokerage as a whole has only seen 8 of its
  // 20 allowed requests.
  assert.throws(
    () => assertVoiceRateLimit(brokerageId, userId, now),
    (err: unknown) => err instanceof VoiceRateLimitError,
  );
  // A different user at the same brokerage is unaffected.
  assert.doesNotThrow(() => assertVoiceRateLimit(brokerageId, 78, now));
});

test("assertVoiceRateLimit resets the window once an hour has elapsed", () => {
  _resetVoiceRateLimiterForTests();
  const start = Date.now();
  const brokerageId = 4;
  for (let i = 0; i < 20; i++) {
    assertVoiceRateLimit(brokerageId, 2000 + i, start);
  }
  assert.throws(() => assertVoiceRateLimit(brokerageId, 9999, start));
  const later = start + 60 * 60_000 + 1;
  assert.doesNotThrow(() => assertVoiceRateLimit(brokerageId, 3000, later));
});

test("acquireVoiceConcurrencySlot rejects a second concurrent request for the same user before release, and allows one after release", () => {
  _resetVoiceRateLimiterForTests();
  const userId = 42;
  acquireVoiceConcurrencySlot(userId);
  assert.throws(
    () => acquireVoiceConcurrencySlot(userId),
    (err: unknown) => err instanceof VoiceConcurrentRequestError,
  );
  releaseVoiceConcurrencySlot(userId);
  assert.doesNotThrow(() => acquireVoiceConcurrencySlot(userId));
  releaseVoiceConcurrencySlot(userId);
});

test("acquireVoiceConcurrencySlot tracks in-flight requests independently per user", () => {
  _resetVoiceRateLimiterForTests();
  acquireVoiceConcurrencySlot(1);
  assert.doesNotThrow(() => acquireVoiceConcurrencySlot(2));
  releaseVoiceConcurrencySlot(1);
  releaseVoiceConcurrencySlot(2);
});

test("releaseVoiceConcurrencySlot is safe to call for a user with no held slot", () => {
  _resetVoiceRateLimiterForTests();
  assert.doesNotThrow(() => releaseVoiceConcurrencySlot(12345));
});

test("_resetVoiceRateLimiterForTests clears brokerage window, user window, and in-flight concurrency state", () => {
  const brokerageId = 9;
  const userId = 9;
  assertVoiceRateLimit(brokerageId, userId, Date.now());
  acquireVoiceConcurrencySlot(userId);

  _resetVoiceRateLimiterForTests();

  // Concurrency state cleared: this user can acquire again immediately.
  assert.doesNotThrow(() => acquireVoiceConcurrencySlot(userId));
  releaseVoiceConcurrencySlot(userId);

  // Window state cleared: the per-user ceiling takes a full 8 fresh
  // requests again, not 7 (which would indicate a leaked prior count).
  _resetVoiceRateLimiterForTests();
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    assert.doesNotThrow(() => assertVoiceRateLimit(100, userId, now));
  }
  assert.throws(
    () => assertVoiceRateLimit(100, userId, now),
    (err: unknown) => err instanceof VoiceRateLimitError,
  );
});
