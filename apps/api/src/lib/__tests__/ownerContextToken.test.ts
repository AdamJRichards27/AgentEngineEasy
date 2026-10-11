import { test } from "node:test";
import assert from "node:assert/strict";
import { createOwnerContextToken, verifyOwnerContextToken } from "../ownerContextToken.js";
const secret = "isolated-owner-test-secret-not-for-real-use";
test("Owner context is signed, expires, and is bound to the exact login session", () => {
  const token = createOwnerContextToken(7, "session-a", secret, 1000);
  assert.equal(verifyOwnerContextToken(token, "session-a", secret, 1001), 7);
  assert.equal(verifyOwnerContextToken(token, "session-b", secret, 1001), null);
  assert.equal(verifyOwnerContextToken(token, "session-a", secret + "x", 1001), null);
  assert.equal(verifyOwnerContextToken(token, "session-a", secret, 1000 + 8 * 3600000), null);
  assert.equal(verifyOwnerContextToken(`${token}x`, "session-a", secret, 1001), null);
  assert.equal(verifyOwnerContextToken(`${token}.extra`, "session-a", secret, 1001), null);
});
test("Owner context rejects malformed, unsigned, invalid-target and weak-secret inputs", () => {
  for (const token of ["", "a.b", "x".repeat(2000), Buffer.from('{"brokerageId":1}').toString("base64url")]) {
    assert.equal(verifyOwnerContextToken(token, "session", secret), null);
  }
  for (const target of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => createOwnerContextToken(target, "s", secret));
  assert.throws(() => createOwnerContextToken(1, "s", "short"));
});
