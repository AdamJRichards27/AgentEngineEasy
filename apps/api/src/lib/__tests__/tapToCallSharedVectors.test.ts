// t257u: Claude's 24 shared Tap-to-Call number vectors (SHARED-NUMBER-VECTORS.json, byte-copied from review 8).
// The server's one shared rule (usableNumber/telHrefFor) must return exactly the phone's expected telHref.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { telHrefFor, maskedPhoneDisplay, usableNumber } from "../tapToCall.js";

export const VECTORS = (JSON.parse(readFileSync(new URL("./fixtures/shared-number-vectors.json", import.meta.url), "utf8")) as { vectors: { input: string; expected_telHref: string | null; note: string }[] }).vectors;

test("t257u: exactly 24 shared vectors", () => assert.equal(VECTORS.length, 24));
for (const v of VECTORS) {
  test(`t257u vector ${JSON.stringify(v.input)} -> ${v.expected_telHref} (${v.note})`, () => {
    assert.equal(telHrefFor(v.input), v.expected_telHref);
  });
}
test("t257u: partial masks are rejected; extensions never reach the dialled part or the masked display", () => {
  for (const m of ["0491 570 ***", "0491 570 15•", "04** *** 156", "XXXX XXX 156", "0491 570 1●6", "0491·570·156", "0491 570 15∗", "0491 570 15⁎"]) assert.equal(usableNumber(m), null, m);
  const u = usableNumber("0491 570 156 ext 12")!;
  assert.equal(u.dial, "0491570156");
  assert.equal(maskedPhoneDisplay(u.dial), "***156");
});
