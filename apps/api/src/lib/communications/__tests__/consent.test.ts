// Agent Engine 2.0 — Communications Hub (Priority 8).
// Pure-function tests for destination normalisation (Section 16) — no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDestination } from "../consent.js";

test("normalizeDestination lowercases and trims EMAIL destinations", () => {
  assert.equal(normalizeDestination("EMAIL", "  Someone@Example.COM  "), "someone@example.com");
});

test("normalizeDestination strips formatting from SMS destinations but keeps a leading +", () => {
  assert.equal(normalizeDestination("SMS", "+61 400 123 456"), "+61400123456");
  assert.equal(normalizeDestination("SMS", "0400 123 456"), "0400123456");
  assert.equal(normalizeDestination("SMS", "(04) 0012-3456"), "0400123456");
});

test("normalizeDestination is idempotent — normalising an already-normalised value is a no-op", () => {
  const email = normalizeDestination("EMAIL", "test@example.com");
  assert.equal(normalizeDestination("EMAIL", email), email);
  const mobile = normalizeDestination("SMS", "+61400123456");
  assert.equal(normalizeDestination("SMS", mobile), mobile);
});
