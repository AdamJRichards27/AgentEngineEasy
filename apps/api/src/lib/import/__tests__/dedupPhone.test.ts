// Import duplicate review already scores a mobile match. The comparison uses
// the same normalised key as manual contact creation, so a spreadsheet row
// stored as +61400000103 matches a hand-typed 0400 000 103. The match type
// is still the existing one: phone alone is probable, phone plus email is exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findContactMatches, type ContactCandidate } from "../dedup.js";
import type { NormalisedImportRecord } from "../neutralFormat.js";

function record(mobile: string, email?: string): NormalisedImportRecord {
  return {
    person: { firstName: "Dee", lastName: "Example", mobile, email },
    meta: { sourceRowNumber: 1, originalValues: {}, mappingConfidence: "manual", warnings: [] },
  };
}

function candidate(mobile: string, email: string | null = null): ContactCandidate {
  return {
    id: 7,
    firstName: "Dee",
    middleName: null,
    lastName: "Example",
    organisationName: null,
    mobile,
    email,
    residentialAddress: null,
  };
}

test("an imported +61 mobile matches a hand-typed Australian number, and a different number does not", () => {
  const match = findContactMatches(record("+61400000103"), [candidate("0400 000 103")]);
  assert.equal(match.matchType, "probable");
  assert.equal(match.matches[0]?.candidateId, 7);
  assert.ok(match.matches[0]?.matchedOn.includes("mobile"));

  const spaced = findContactMatches(record("0400 000 103"), [candidate("+61400000103")]);
  assert.equal(spaced.matches[0]?.candidateId, 7);

  const compact = findContactMatches(record("0400000103"), [candidate("+61400000103")]);
  assert.equal(compact.matches[0]?.candidateId, 7);

  // Same name with a different number is still only a possible name match.
  // A different person with a different number is new.
  const different = findContactMatches(
    {
      person: { firstName: "Pat", lastName: "Other", mobile: "+61400000104" },
      meta: { sourceRowNumber: 2, originalValues: {}, mappingConfidence: "manual", warnings: [] },
    },
    [candidate("0400 000 103")],
  );
  assert.equal(different.matchType, "new");
  assert.equal(different.matches.length, 0);
});

test("email plus the same phone is still an exact match", () => {
  const match = findContactMatches(record("+61400000103", "dee@example.test"), [candidate("0400 000 103", "dee@example.test")]);
  assert.equal(match.matchType, "exact");
  assert.equal(match.matches[0]?.score, 100);
});
