import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { usableNumber } from "../../minimal/mobile/mobileCalling";

// t257u (separate file; Claude's mobile tests untouched). (1) the phone's rule against the same 24 shared vectors the
// server uses; (2) "Link a contact" is hidden without relationship-manage, and the container passes that decision.

const VECTORS = (JSON.parse(readFileSync(new URL("../../../../api/src/lib/__tests__/fixtures/shared-number-vectors.json", import.meta.url), "utf8")) as { vectors: { input: string; expected_telHref: string | null }[] }).vectors;
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Known phone-side gap on this base (#295 mobileCalling.ts, Claude's file, NOT edited here): the two partial masks
// still give a link on the phone. The server rejects them. Claude's C4 is expected to close this; when it lands,
// empty PHONE_KNOWN_GAP and this test then requires all 24.
const PHONE_KNOWN_GAP: string[] = [];
test("phone rule matches the 24 shared vectors except the recorded partial-mask gap", () => {
  assert.equal(VECTORS.length, 24);
  const diffs = VECTORS.filter((v) => { const u = usableNumber(v.input); return (u ? `tel:${u.dial}` : null) !== v.expected_telHref; }).map((v) => v.input);
  assert.deepEqual(diffs, PHONE_KNOWN_GAP);
});

// t261u (review 9 R6): the source-text check that was here is replaced by the behaviour test in minimalPropertyDuplicatePanel.test.ts.
