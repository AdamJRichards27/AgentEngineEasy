import assert from "node:assert/strict";
import test from "node:test";
import { formatAuDateTime } from "../auDateTime";

test("t274u item 5: timeline dates are DD/MM/YYYY (en-AU), not en-US M/D/YYYY", () => {
  const s = formatAuDateTime("2026-11-04T18:31:16Z", "Australia/Brisbane");
  assert.match(s, /^05\/11\/2026, 4:31\s?am$/i);
  assert.match(formatAuDateTime("2026-01-02T00:00:00Z", "UTC"), /^02\/01\/2026, 12:00\s?am$/i);
});

test("t274u item 5: day before month is unambiguous for day > 12", () => {
  assert.match(formatAuDateTime("2026-03-25T02:00:00Z", "UTC"), /^25\/03\/2026/);
});

test("t274u item 5: invalid input renders empty, never 'Invalid Date'", () => {
  assert.equal(formatAuDateTime("not a date"), "");
});
