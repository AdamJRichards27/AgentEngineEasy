import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, passwordPolicyViolation, MIN_PASSWORD_LENGTH } from "../password.js";
import { generateToken, hashToken } from "../tokens.js";

test("hashPassword produces an Argon2id hash, and verifyPassword round-trips correctly", async () => {
  const hash = await hashPassword("a genuinely strong passphrase 42");
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(hash, "a genuinely strong passphrase 42"), true);
  assert.equal(await verifyPassword(hash, "wrong passphrase entirely"), false);
});

test("verifyPassword returns false (never throws) for a malformed hash", async () => {
  await assert.doesNotReject(async () => {
    const ok = await verifyPassword("not-a-real-hash", "anything");
    assert.equal(ok, false);
  });
});

test("passwordPolicyViolation rejects short and common passwords, accepts a strong one", () => {
  assert.ok(passwordPolicyViolation("short"));
  assert.ok(passwordPolicyViolation("password123"));
  assert.equal(passwordPolicyViolation("a".repeat(MIN_PASSWORD_LENGTH - 1)), `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  assert.equal(passwordPolicyViolation("Correct-Horse-Battery-Staple-42"), null);
});

test("generateToken produces a plaintext whose hash matches hashToken, and two calls never collide", () => {
  const a = generateToken();
  const b = generateToken();
  assert.equal(hashToken(a.plaintext), a.hash);
  assert.notEqual(a.plaintext, b.plaintext);
  assert.notEqual(a.hash, b.hash);
  // The hash must never simply equal the plaintext (sanity check against a no-op "hash").
  assert.notEqual(a.hash, a.plaintext);
});
