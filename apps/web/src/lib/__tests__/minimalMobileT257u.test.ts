import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { usableNumber } from "../../minimal/mobile/mobileCalling";

// The phone's number rule against the SAME 24 shared vectors the server uses (apps/api/.../shared-number-vectors.json): every vector must give
// exactly the expected tel: link or none, with no exceptions. (Broader coverage, including generated masked variants, is in
// minimalMobileCallingVectors.test.ts.)

const VECTORS = (JSON.parse(readFileSync(new URL("../../../../api/src/lib/__tests__/fixtures/shared-number-vectors.json", import.meta.url), "utf8")) as { vectors: { input: string; expected_telHref: string | null }[] }).vectors;

test("the phone rule matches all 24 shared vectors exactly", () => {
  assert.equal(VECTORS.length, 24);
  const diffs = VECTORS.filter((v) => { const u = usableNumber(v.input); return (u ? `tel:${u.dial}` : null) !== v.expected_telHref; }).map((v) => v.input);
  assert.deepEqual(diffs, [], "no vector may differ from the server's rule");
});
