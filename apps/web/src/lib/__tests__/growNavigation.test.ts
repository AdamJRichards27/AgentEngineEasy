import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGrowWorkspaceHref,
  parseGrowContactId,
  parseGrowTab,
} from "../../pages/Grow";

test("Grow tab URL state defaults safely to Today", () => {
  assert.equal(parseGrowTab(""), "today");
  assert.equal(parseGrowTab("?tab=unknown"), "today");
  assert.equal(parseGrowTab("?tab=contacts"), "contacts");
});

test("Grow tab URL state round-trips existing tabs without creating routes", () => {
  for (const tab of ["today", "opportunities", "contacts", "nurture", "performance", "askAE"] as const) {
    const href = buildGrowWorkspaceHref(tab);
    assert.equal(href, `/grow?tab=${tab}`);
    assert.equal(parseGrowTab(href.slice("/grow".length)), tab);
  }
});

test("Contact 360 deep links use the existing Contacts tab and validate the party id", () => {
  assert.equal(buildGrowWorkspaceHref("contacts", 42), "/grow?tab=contacts&contact=42");
  assert.equal(parseGrowTab("?tab=contacts&contact=42"), "contacts");
  assert.equal(parseGrowContactId("?tab=contacts&contact=42"), 42);
  assert.equal(parseGrowContactId("?tab=contacts&contact=0"), null);
  assert.equal(parseGrowContactId("?tab=contacts&contact=not-a-party"), null);
  assert.equal(buildGrowWorkspaceHref("today", 42), "/grow?tab=today");
});