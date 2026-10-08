import { test } from "node:test";
import assert from "node:assert/strict";

// Foundation Remediation Stage 1.5: prove the session mechanism now fails
// closed. These tests set a real SESSION_SECRET for the duration of the
// process (this test file's own setup) since apps/api/src/lib/session.ts
// is meant to throw when one isn't configured - that specific behaviour is
// covered separately below by temporarily deleting it.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

const { createSessionToken, verifySessionToken, assertSessionSecretConfigured } = await import("../session.js");

test("a freshly created session token verifies to the same user id", () => {
  const before = Date.now();
  const token = createSessionToken(42);
  const verified = verifySessionToken(token);
  const after = Date.now();
  // Foundation Remediation - server-side session revocation: createSessionToken's
  // epoch parameter defaults to 0 (matching the users.sessionEpoch column's
  // own default), so a caller that doesn't pass one still gets back a
  // well-formed { uid, epoch, iat } pair.
  assert.equal(verified?.uid, 42);
  assert.equal(verified?.epoch, 0);
  assert.ok(verified && verified.iat >= before && verified.iat <= after);
});

test("a session token embeds the epoch it was signed with, and verifySessionToken returns it", () => {
  const before = Date.now();
  const token = createSessionToken(42, 7);
  const verified = verifySessionToken(token);
  const after = Date.now();
  assert.equal(verified?.uid, 42);
  assert.equal(verified?.epoch, 7);
  assert.ok(verified && verified.iat >= before && verified.iat <= after);
});

test("verifySessionToken defaults epoch to 0 for a legacy token payload with no epoch field", async () => {
  // Simulates a token signed before the epoch field existed (or by a client
  // that only ever sent uid/iat) - it must still verify, treating the
  // absent epoch the same as the sessionEpoch column's own default of 0,
  // rather than being rejected outright.
  const { createHmac } = await import("node:crypto");
  const iat = Date.now();
  const payload = Buffer.from(JSON.stringify({ uid: 42, iat })).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
  const verified = verifySessionToken(`${payload}.${signature}`);
  assert.deepEqual(verified, { uid: 42, epoch: 0, iat });
});

test("verifySessionToken rejects a missing token", () => {
  assert.equal(verifySessionToken(undefined), null);
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken(""), null);
});

test("verifySessionToken rejects a malformed token (no signature separator)", () => {
  assert.equal(verifySessionToken("not-a-real-token"), null);
});

test("verifySessionToken rejects a token with a tampered payload", () => {
  const token = createSessionToken(42);
  const [, signature] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ uid: 999, iat: Date.now() })).toString("base64url");
  const forged = `${forgedPayload}.${signature}`;
  assert.equal(verifySessionToken(forged), null);
});

test("verifySessionToken rejects a token signed with a different secret", async () => {
  const token = createSessionToken(42);
  const [payload] = token.split(".");
  const { createHmac } = await import("node:crypto");
  const wrongSignature = createHmac("sha256", "a-completely-different-secret-value-xyz")
    .update(payload)
    .digest("base64url");
  assert.equal(verifySessionToken(`${payload}.${wrongSignature}`), null);
});

test("verifySessionToken rejects an expired session (older than 30 days)", async () => {
  const { createHmac } = await import("node:crypto");
  const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(
    JSON.stringify({ uid: 42, iat: Date.now() - THIRTY_ONE_DAYS_MS }),
  ).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
  assert.equal(verifySessionToken(`${payload}.${signature}`), null);
});

test("verifySessionToken rejects a token with a future iat (clock-skew / forged timestamp)", async () => {
  const { createHmac } = await import("node:crypto");
  const payload = Buffer.from(
    JSON.stringify({ uid: 42, iat: Date.now() + 60_000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
  assert.equal(verifySessionToken(`${payload}.${signature}`), null);
});

test("assertSessionSecretConfigured throws when SESSION_SECRET is absent", async () => {
  const previous = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const fresh = await import(`../session.js?t=${Date.now()}-${Math.random()}`);
    assert.throws(() => fresh.assertSessionSecretConfigured());
  } finally {
    process.env.SESSION_SECRET = previous;
  }
});

test("assertSessionSecretConfigured throws when SESSION_SECRET is too short", async () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "too-short";
  try {
    const fresh = await import(`../session.js?t=${Date.now()}-${Math.random()}`);
    assert.throws(() => fresh.assertSessionSecretConfigured());
  } finally {
    process.env.SESSION_SECRET = previous;
  }
});

test("assertSessionSecretConfigured does not throw when a strong secret is configured", () => {
  assert.doesNotThrow(() => assertSessionSecretConfigured());
});
