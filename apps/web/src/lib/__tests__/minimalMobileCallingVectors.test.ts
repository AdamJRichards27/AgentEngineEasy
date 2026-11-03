import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callPlan, isMaskedNumber, numbersOf, usableNumber } from "../../minimal/mobile/mobileCalling";
import { mobileLinkedContacts } from "../../minimal/mobile/mobilePropertyContactRows";

// Positive regression coverage for the phone's number rule (replaces the test that pinned the known partial-mask gap).
// The SAME 24 vectors the server is tested with: one fixture, read from the API's tests, never copied. The phone must give
// exactly the expected call link for every one, through the real path (numbersOf -> callPlan), not just usableNumber.
const FIXTURE = new URL("../../../../api/src/lib/__tests__/fixtures/shared-number-vectors.json", import.meta.url);
const VECTORS = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { vectors: { input: string; expected_telHref: string | null; note?: string }[] }).vectors;
const hrefFor = (input: string): string | null => callPlan(numbersOf({ mobile: input }), "Test Contact").options[0]?.href ?? null;

test("the shared fixture is the 24 agreed vectors", () => {
  assert.equal(VECTORS.length, 24);
  assert.equal(VECTORS.filter((v) => v.expected_telHref !== null).length, 9, "nine give a link, fifteen do not");
});

test("every one of the 24 shared vectors gives exactly the expected tel: link (or none) through the real call path", () => {
  const wrong = VECTORS.filter((v) => hrefFor(v.input) !== v.expected_telHref).map((v) => `${JSON.stringify(v.input)} -> ${hrefFor(v.input)} (expected ${v.expected_telHref})`);
  assert.deepEqual(wrong, [], "no vector may differ from the server's rule");
});

test("the two partial masks that used to give a link on the phone now give none", () => {
  assert.equal(hrefFor("0491 570 ***"), null, "seven digits survive the mask: still never dialled");
  assert.equal(hrefFor("0491 570 15•"), null);
  assert.equal(usableNumber("0491 570 ***"), null);
});

test("a masked number never becomes a tel: link, whichever mask character hides which part", () => {
  const real = VECTORS.filter((v) => v.expected_telHref !== null).map((v) => v.input);
  const masks = ["*", "•", "●", "∗", "⁎", "·", "…"];
  let tried = 0;
  for (const number of real) {
    const digitsAt = [...number].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
    for (const m of masks) {
      for (const hide of [1, 2, 3, 5]) {
        const chars = [...number];
        for (const i of digitsAt.slice(-hide)) chars[i] = m; // hide the last N digits: the shape a partial mask has
        assert.equal(hrefFor(chars.join("")), null, `${chars.join("")} must not be a call link`);
        tried++;
      }
      const lead = [...number];
      for (const i of digitsAt.slice(0, 2)) lead[i] = m; // and the first two
      assert.equal(hrefFor(lead.join("")), null, `${lead.join("")} must not be a call link`);
      tried++;
    }
    const hidden = number.replace(/\d{3}\s*$/, "XXX"); // only where the last three characters really were digits (not an extension tail)
    if (hidden !== number) {
      assert.equal(hrefFor(hidden), null, `${hidden}: a run of X hides digits too`);
      tried++;
    }
  }
  assert.ok(tried > 300, `exercised ${tried} masked variants`);
});

test("what is a mask and what is not: single x is an extension marker, not a mask", () => {
  for (const masked of ["***123", "0491 570 ***", "04** *** 156", "XXXX XXX 156", "xx 156", "••• 123", "0491 570 15•", "…156", "0491 570 15●", "0491 570 15∗"]) assert.equal(isMaskedNumber(masked), true, masked);
  for (const plain of ["0491 570 156", "+61 491 570 156", "(07) 5550 0123", "0491 570 156 x12", "0491 570 156 ext 12", "07 5550 0123 #4", "", "n/a", null, undefined]) assert.equal(isMaskedNumber(plain), false, String(plain));
});

test("real numbers are unaffected by the guard: the nine positive vectors still link, an extension is cut and never dialled", () => {
  assert.equal(hrefFor("0491 570 156"), "tel:0491570156");
  assert.equal(hrefFor("+61 491 570 156"), "tel:+61491570156");
  assert.equal(hrefFor("0491 570 156 ext 12"), "tel:0491570156");
  assert.equal(hrefFor("0491 570 156 x12"), "tel:0491570156");
  assert.equal(hrefFor("07 5550 0123 #4"), "tel:0755500123");
});

test("property page rows: a masked or partly masked number gives no Call option, a real number gives exactly one", () => {
  const row = (linkId: number, mobile: string | null) => ({ linkId, role: "Owner", isPrimary: false, party: { id: linkId, displayName: `Contact ${linkId}`, mobile } }) as never;
  const contacts = mobileLinkedContacts([row(1, "***123"), row(2, "0491 570 ***"), row(3, "0491 570 15•"), row(4, "0491 570 156"), row(5, null)]);
  const options = contacts.map((c) => callPlan(numbersOf({ mobile: c.mobile }), c.name).options.map((o) => o.href));
  assert.deepEqual(options, [[], [], [], ["tel:0491570156"], []]);
});
