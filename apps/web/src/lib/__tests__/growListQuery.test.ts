import assert from "node:assert/strict";
import test from "node:test";
import { growListPath, listSearchEmptyMessage, showingCountLabel } from "../growListQuery";

test("grow list paths omit empty filters and keep search on the server", () => {
  assert.equal(growListPath("/grow/contacts"), "/grow/contacts");
  assert.equal(growListPath("/grow/contacts", { search: "Sam Seller" }), "/grow/contacts?search=Sam+Seller");
  assert.equal(
    growListPath("/grow/contacts", { search: "Ada", cursor: "abc", excludePartyId: 9 }),
    "/grow/contacts?search=Ada&cursor=abc&excludePartyId=9",
  );
  assert.equal(growListPath("/grow/opportunities", { id: 41 }), "/grow/opportunities?id=41");
  assert.equal(growListPath("/grow/activities", { cursor: null, search: "" }), "/grow/activities");
  assert.equal(growListPath("/grow/opportunities", { type: "all" }), "/grow/opportunities");
  assert.equal(growListPath("/grow/opportunities", { type: "seller_side" }), "/grow/opportunities?type=seller_side");
  assert.equal(
    growListPath("/grow/opportunities", { search: "Ada", type: "other", cursor: "abc" }),
    "/grow/opportunities?search=Ada&type=other&cursor=abc",
  );
  assert.equal(
    growListPath("/grow/contacts", { search: "Ada", role: "Buyer" }),
    "/grow/contacts?search=Ada&role=Buyer",
  );
  assert.equal(growListPath("/grow/relationships", { search: "Queen St", role: "" }), "/grow/relationships?search=Queen+St");
});

test("a filtered empty list names the current search and an idle list does not", () => {
  assert.equal(listSearchEmptyMessage("", "relationships", "No relationships yet."), "No relationships yet.");
  assert.equal(listSearchEmptyMessage("  ", "activities", "No activity logged yet."), "No activity logged yet.");
  assert.equal(listSearchEmptyMessage("Ada", "opportunities", "No opportunities yet."), "No opportunities match “Ada”.");
});

test("showing count names the filtered total", () => {
  assert.equal(showingCountLabel(50, 1200, "contact", "contacts"), "Showing 50 of 1200 contacts");
  assert.equal(showingCountLabel(1, 1, "opportunity", "opportunities"), "Showing 1 of 1 opportunity");
});
