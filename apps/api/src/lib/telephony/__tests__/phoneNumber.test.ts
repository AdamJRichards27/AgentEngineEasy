// AE GROW Priority 6 Stage F1 — §5, §22 phone-number normalisation tests.
// Pure-function unit tests, no DB/server — mirrors
// apps/api/src/lib/communications/__tests__/consent.test.ts's style for a
// pure-function module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhoneNumber, PhoneNumberValidationError } from "../phoneNumber.js";

test("AU mobile national format requires assumedCountry and normalizes to E.164", () => {
  const result = normalizePhoneNumber("0412 345 678", { assumedCountry: "AU" });
  assert.equal(result.e164, "+61412345678");
  assert.equal(result.country, "AU");
  assert.equal(result.numberType, "MOBILE");
});

test("AU landline national format normalizes to E.164", () => {
  const result = normalizePhoneNumber("(02) 9876 5432", { assumedCountry: "AU" });
  assert.equal(result.e164, "+61298765432");
  assert.equal(result.country, "AU");
  assert.equal(result.numberType, "LANDLINE");
});

test("NZ mobile national format normalizes to E.164", () => {
  const result = normalizePhoneNumber("021 123 4567", { assumedCountry: "NZ" });
  assert.equal(result.e164, "+64211234567");
  assert.equal(result.country, "NZ");
  assert.equal(result.numberType, "MOBILE");
});

test("NZ landline national format normalizes to E.164", () => {
  const result = normalizePhoneNumber("09 312 3456", { assumedCountry: "NZ" });
  assert.equal(result.e164, "+6493123456");
  assert.equal(result.country, "NZ");
  assert.equal(result.numberType, "LANDLINE");
});

test("already-international AU format needs no assumedCountry", () => {
  const result = normalizePhoneNumber("+61 412 345 678");
  assert.equal(result.e164, "+61412345678");
  assert.equal(result.country, "AU");
  assert.equal(result.numberType, "MOBILE");
});

test("already-international NZ format needs no assumedCountry", () => {
  const result = normalizePhoneNumber("+64 21 123 4567");
  assert.equal(result.e164, "+64211234567");
  assert.equal(result.country, "NZ");
  assert.equal(result.numberType, "MOBILE");
});

test("invalid numbers are rejected with INVALID_FORMAT", () => {
  assert.throws(
    () => normalizePhoneNumber("0412345", { assumedCountry: "AU" }),
    (err: unknown) => err instanceof PhoneNumberValidationError && err.code === "INVALID_FORMAT",
  );
  assert.throws(
    () => normalizePhoneNumber("not-a-number-at-all", { assumedCountry: "AU" }),
    (err: unknown) => err instanceof PhoneNumberValidationError && err.code === "INVALID_FORMAT",
  );
});

test("a national-format number with no assumedCountry is AMBIGUOUS, never silently guessed", () => {
  assert.throws(
    () => normalizePhoneNumber("0212345678"),
    (err: unknown) => err instanceof PhoneNumberValidationError && err.code === "AMBIGUOUS",
  );
});

test("missing numbers are rejected with EMPTY", () => {
  assert.throws(
    () => normalizePhoneNumber(null),
    (err: unknown) => err instanceof PhoneNumberValidationError && err.code === "EMPTY",
  );
  assert.throws(
    () => normalizePhoneNumber(undefined),
    (err: unknown) => err instanceof PhoneNumberValidationError && err.code === "EMPTY",
  );
  assert.throws(
    () => normalizePhoneNumber("   "),
    (err: unknown) => err instanceof PhoneNumberValidationError && err.code === "EMPTY",
  );
});

test("a non-AU/NZ international number is rejected as UNSUPPORTED_COUNTRY", () => {
  assert.throws(
    () => normalizePhoneNumber("+1 415 555 0100"),
    (err: unknown) => err instanceof PhoneNumberValidationError && err.code === "UNSUPPORTED_COUNTRY",
  );
});
