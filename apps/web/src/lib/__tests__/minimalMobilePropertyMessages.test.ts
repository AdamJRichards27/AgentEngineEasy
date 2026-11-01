import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROPERTY_NOT_FOUND, PROPERTY_NO_ACCESS, propertyLoadMessage } from "../../minimal/mobile/mobilePropertyMessages";

// AE Mobile (CC Task #64, M4): the property page's not-found wording, as the contact screen's: no Try again, and nothing that confirms the property exists elsewhere.

test("a 404 says it could not be found, reveals nothing, and offers no Try again", () => {
  assert.deepEqual(propertyLoadMessage(404, "Couldn't load this property."), { text: PROPERTY_NOT_FOUND, retry: false });
  assert.match(PROPERTY_NOT_FOUND, /couldn’t be found/);
  assert.match(PROPERTY_NOT_FOUND, /removed, or it may not be available to you/);
  assert.doesNotMatch(PROPERTY_NOT_FOUND, /brokerage|another|forbidden|permission|exists/i);
  assert.deepEqual(propertyLoadMessage(403, "x"), { text: PROPERTY_NO_ACCESS, retry: false });
});

test("a failure that trying again can fix still offers it", () => {
  for (const status of [500, 502, 503, null, undefined]) assert.deepEqual(propertyLoadMessage(status, "Couldn't load this property."), { text: "Couldn't load this property.", retry: true });
});

test("the property page decides from the response status, and an unreadable id says the same thing", () => {
  const src = readFileSync(new URL("../../minimal/properties/MinimalPropertyDetail.tsx", import.meta.url), "utf8");
  assert.match(src, /propertyLoadMessage\(property\.error instanceof ApiError \? property\.error\.status : null/);
  assert.match(src, /onRetry: failure\.retry \? \(\) => void property\.refetch\(\) : undefined/);
  assert.match(src, /kind: "error", text: PROPERTY_NOT_FOUND/);
  assert.equal(src.includes("That property couldn't be found."), false, "the old wording is gone");
});
