import assert from "node:assert/strict";
import test from "node:test";
import { growListPath, showingCountLabel } from "../growListQuery";

test("grow list paths omit empty filters and keep search on the server", () => {
  assert.equal(growListPath("/grow/contacts"), "/grow/contacts");
  assert.equal(growListPath("/grow/contacts", { search: "Sam Seller" }), "/grow/contacts?search=Sam+Seller");
  assert.equal(
    growListPath("/grow/contacts", { search: "Ada", cursor: "abc", excludePartyId: 9 }),
    "/grow/contacts?search=Ada&cursor=abc&excludePartyId=9",
  );
  assert.equal(growListPath("/grow/opportunities", { id: 41 }), "/grow/opportunities?id=41");
  assert.equal(growListPath("/grow/activities", { cursor: null, search: "" }), "/grow/activities");
});

test("showing count names the filtered total", () => {
  assert.equal(showingCountLabel(50, 1200, "contact", "contacts"), "Showing 50 of 1200 contacts");
  assert.equal(showingCountLabel(1, 1, "opportunity", "opportunities"), "Showing 1 of 1 opportunity");
});
