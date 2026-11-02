// t253u: server-side usable-number rule must match the mobile client rule
// (apps/web/src/minimal/mobile/mobileCalling.ts usableNumber — read-only reference, not edited).
// The vectors below are the mobile rule's documented cases; keep both in step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usableNumber, telHrefFor, USABLE_MIN_DIGITS, USABLE_MAX_DIGITS } from "../tapToCall.js";

test("t253u: limits are the mobile limits (6..15 digits)", () => {
  assert.equal(USABLE_MIN_DIGITS, 6);
  assert.equal(USABLE_MAX_DIGITS, 15);
});

test("t253u: extensions and notes are never dialled (text from the first letter, # or * on is dropped)", () => {
  assert.deepEqual(usableNumber("0491 570 156 ext 12"), { display: "0491 570 156", dial: "0491570156" });
  assert.deepEqual(usableNumber("0491 570 156 x12"), { display: "0491 570 156", dial: "0491570156" });
  assert.deepEqual(usableNumber("+61 491 570 156#2"), { display: "+61 491 570 156", dial: "+61491570156" });
  assert.equal(telHrefFor("0491 570 156 ext 12"), "tel:0491570156");
  assert.equal(usableNumber("n/a"), null);
  assert.equal(usableNumber("ext 12"), null);
});

test("t253u: invalid lengths are rejected", () => {
  assert.equal(usableNumber("12345"), null, "5 digits");
  assert.ok(usableNumber("123456"), "6 digits");
  assert.ok(usableNumber("+123456789012345"), "15 digits");
  assert.equal(usableNumber("+1234567890123456"), null, "16 digits");
  assert.equal(telHrefFor("+1234567890123456"), null);
});

test("t253u: one repeated digit is not a number", () => {
  assert.equal(usableNumber("0000000"), null);
  assert.ok(usableNumber("+61 1111 1111"), "61 then 1s is not one repeated digit");
  assert.equal(usableNumber("9999 9999"), null);
  assert.equal(telHrefFor("000 000 000"), null);
});

test("t253u: national numbers are NOT rewritten to E.164; a leading + is kept; separators dropped", () => {
  assert.equal(telHrefFor("(02) 9876 5432"), "tel:0298765432");
  assert.equal(telHrefFor(" +61 2 9876-5432 "), "tel:+61298765432");
  assert.deepEqual(usableNumber("  0400   000  111 "), { display: "0400 000 111", dial: "0400000111" });
  assert.equal(usableNumber(null), null);
  assert.equal(usableNumber("   "), null);
});
