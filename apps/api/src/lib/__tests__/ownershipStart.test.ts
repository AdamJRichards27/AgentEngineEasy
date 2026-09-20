// AE GROW "Brokerage-wide Signal Sweep" stage 2 — the ownership-start parser.
//
// Pure functions, no database: this is the one piece of the feature where the
// whole risk is interpretation, and interpretation is exactly what a unit
// test can pin down exhaustively.
//
// THE PROPERTY UNDER TEST is not "parses dates correctly". It is "never
// guesses". A rejected value costs a missing signal; a guessed value costs an
// agent telling a homeowner they have lived somewhere for eleven years when
// they moved in last spring. Every ambiguous case below must resolve to
// "no value", and the tenure rule then abstains.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOwnershipStartDate, extractProviderOwnershipStart, PROVIDER_OWNERSHIP_START_KEYS } from "../ownershipStart.js";

/** A fixed "now" so the future-date boundary is deterministic. */
const NOW = new Date("2026-09-20T00:00:00.000Z");

function parse(raw: string | null | undefined) {
  return parseOwnershipStartDate(raw, NOW);
}

test("accepts the formats a real export actually contains, at the precision it supplied", () => {
  const cases: Array<{ input: string; iso: string; precision: string }> = [
    { input: "2011-03-14", iso: "2011-03-14T00:00:00.000Z", precision: "day" },
    { input: "2011-03-14T09:30:00Z", iso: "2011-03-14T00:00:00.000Z", precision: "day" },
    { input: "14/03/2011", iso: "2011-03-14T00:00:00.000Z", precision: "day" },
    { input: "14-03-2011", iso: "2011-03-14T00:00:00.000Z", precision: "day" },
    { input: "14.3.2011", iso: "2011-03-14T00:00:00.000Z", precision: "day" },
    { input: "4/3/2011", iso: "2011-03-04T00:00:00.000Z", precision: "day" },
    { input: "14 March 2011", iso: "2011-03-14T00:00:00.000Z", precision: "day" },
    { input: "14 Mar 2011", iso: "2011-03-14T00:00:00.000Z", precision: "day" },
    { input: "2011-03", iso: "2011-03-01T00:00:00.000Z", precision: "month" },
    { input: "03/2011", iso: "2011-03-01T00:00:00.000Z", precision: "month" },
    { input: "March 2011", iso: "2011-03-01T00:00:00.000Z", precision: "month" },
    { input: "2011", iso: "2011-01-01T00:00:00.000Z", precision: "year" },
    { input: "  2011-03-14  ", iso: "2011-03-14T00:00:00.000Z", precision: "day" },
  ];
  for (const c of cases) {
    const result = parse(c.input);
    assert.equal(result.value?.toISOString(), c.iso, `"${c.input}" parses to ${c.iso}`);
    assert.equal(result.precision, c.precision, `"${c.input}" precision`);
    assert.equal(result.rejectedReason, null, `"${c.input}" is not rejected`);
    assert.equal(result.original, c.input.trim(), `"${c.input}" preserves the original for audit`);
  }
});

test("a bare year is stored as 1 January but declared as YEAR precision, so it is never presented as a day", () => {
  const result = parse("2011");
  assert.equal(result.value?.toISOString(), "2011-01-01T00:00:00.000Z");
  // The precision is the whole point: it is what stops
  // formatDateAtPrecision() rendering this as "1 January 2011" to an agent
  // who might then repeat it to a customer.
  assert.equal(result.precision, "year");
});

test("REJECTS rather than reinterprets an ambiguous US-order date", () => {
  // 14 cannot be an Australian month. Silently switching convention here
  // would mean silently switching it for "03/04/2011" too, where nothing
  // distinguishes the two readings and the wrong choice is invisible.
  const result = parse("03/14/2011");
  assert.equal(result.value, null);
  assert.equal(result.precision, null);
  assert.match(result.rejectedReason ?? "", /day\/month\/year/i);
});

test("rejects everything it cannot read with certainty, with a reason a user can act on", () => {
  const cases: Array<{ input: string; reason: RegExp }> = [
    { input: "14/03/11", reason: /four-digit year/i },
    { input: "31/02/2011", reason: /not a real calendar date/i },
    { input: "2011-02-31", reason: /not a real calendar date/i },
    { input: "13/2011", reason: /not a month/i },
    { input: "Smarch 2011", reason: /not a month name/i },
    { input: "next tuesday", reason: /did not recognise/i },
    { input: "N/A", reason: /did not recognise/i },
    { input: "-", reason: /did not recognise/i },
    { input: "1799", reason: /before 1800/i },
  ];
  for (const c of cases) {
    const result = parse(c.input);
    assert.equal(result.value, null, `"${c.input}" must not produce a date`);
    assert.equal(result.precision, null, `"${c.input}" must not claim a precision`);
    assert.match(result.rejectedReason ?? "", c.reason, `"${c.input}" explains itself`);
  }
});

test("rejects a future date — an ownership that has not started cannot have a tenure", () => {
  const result = parse("2030-01-01");
  assert.equal(result.value, null);
  assert.match(result.rejectedReason ?? "", /future/i);

  // And the boundary is inclusive of "today", not off by a day.
  const today = parse("2026-09-20");
  assert.equal(today.value?.toISOString(), "2026-09-20T00:00:00.000Z");
});

test("a blank value is NOT an error — it simply means AE does not know", () => {
  for (const blank of ["", "   ", null, undefined]) {
    const result = parse(blank);
    assert.equal(result.value, null);
    assert.equal(result.precision, null);
    assert.equal(result.rejectedReason, null, "a blank cell must not produce a warning; there is nothing wrong with it");
  }
});

test("is timezone-independent — every value is anchored at midnight UTC", () => {
  // The columns are `timestamp without time zone` and the system runs TZ=UTC.
  // A parser that built dates in an ambient local zone could shift a recorded
  // acquisition date across a day boundary in text an agent quotes back.
  for (const input of ["2011-03-14", "14/03/2011", "14 March 2011"]) {
    const value = parse(input).value;
    assert.ok(value);
    assert.equal(value.getUTCHours(), 0);
    assert.equal(value.getUTCMinutes(), 0);
    assert.equal(value.getUTCSeconds(), 0);
    assert.equal(value.getUTCMilliseconds(), 0);
  }
});

/* ---------------------------------------------------------------------
 * Provider payload extraction.
 * -----------------------------------------------------------------*/

test("extracts an explicit ownership-start key from a provider payload", () => {
  for (const key of PROVIDER_OWNERSHIP_START_KEYS) {
    const extracted = extractProviderOwnershipStart({ owners: ["A Person"], [key]: "2011-03-14" }, NOW);
    assert.ok(extracted, `${key} is recognised`);
    assert.equal(extracted.value.toISOString(), "2011-03-14T00:00:00.000Z");
    assert.equal(extracted.precision, "day");
    assert.equal(extracted.payloadKey, key, "the key it came from is recorded, so the provenance is traceable");
  }
});

test("IGNORES sale-history keys — a property's sale date is not this owner's acquisition date", () => {
  // The central judgement call in this module. "The property last sold in
  // 2011" is a fact about the PROPERTY. Treating it as "the contact AE has
  // recorded as the owner acquired it in 2011" is an inference, and it is
  // wrong exactly when it matters most: when the property HAS changed hands
  // and AE's owner record is the stale thing.
  const payload = { owners: ["A Person"], lastSaleDate: "2011-03-14", saleDate: "2011-03-14", previousSaleDate: "2005-01-01", last_sale_date: "2011-03-14" };
  assert.equal(extractProviderOwnershipStart(payload, NOW), null);
});

test("returns null for a payload with nothing usable, and never throws on a malformed one", () => {
  assert.equal(extractProviderOwnershipStart({ owners: ["A Person"] }, NOW), null);
  assert.equal(extractProviderOwnershipStart({ acquisitionDate: "not a date" }, NOW), null);
  assert.equal(extractProviderOwnershipStart({ acquisitionDate: null }, NOW), null);
  assert.equal(extractProviderOwnershipStart({ acquisitionDate: { nested: true } }, NOW), null);
  assert.equal(extractProviderOwnershipStart(null, NOW), null);
  assert.equal(extractProviderOwnershipStart("a string", NOW), null);
  assert.equal(extractProviderOwnershipStart([1, 2, 3], NOW), null);
  assert.equal(extractProviderOwnershipStart(undefined, NOW), null);
});

test("key precedence is deterministic, so the same payload always yields the same date", () => {
  const payload = { purchaseDate: "2015-05-05", acquisitionDate: "2011-03-14", ownershipStartDate: "2009-09-09" };
  const first = extractProviderOwnershipStart(payload, NOW);
  const second = extractProviderOwnershipStart({ ...payload }, NOW);
  assert.equal(first?.payloadKey, second?.payloadKey);
  assert.equal(first?.value.toISOString(), second?.value.toISOString());
  // ownershipStartDate is first in PROVIDER_OWNERSHIP_START_KEYS — the most
  // explicit name wins, rather than whichever key the provider happened to
  // serialise first.
  assert.equal(first?.payloadKey, "ownershipStartDate");
});

test("skips an unparseable value and falls through to the next recognised key", () => {
  const extracted = extractProviderOwnershipStart({ ownershipStartDate: "unknown", acquisitionDate: "2011-03-14" }, NOW);
  assert.equal(extracted?.payloadKey, "acquisitionDate");
  assert.equal(extracted?.value.toISOString(), "2011-03-14T00:00:00.000Z");
});
