import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTACT_NOT_FOUND, CONTACT_NO_ACCESS, contactLoadMessage } from "../../minimal/mobile/mobileContactMessages";
import { MobileContactMessage } from "../../minimal/mobile/MobileContactView";
import { all, text } from "./mobileTreeHelpers";

// AE Mobile (CC Task #64, M4): found in the real app: another brokerage's contact is a 404, and the screen said "couldn't be
// found, try again". Trying again cannot help, and the words must not say whether it exists.

test("a 404 says it could not be found, does not reveal why, and offers no Try again", () => {
  const m = contactLoadMessage(404, "Couldn't load this contact.");
  assert.deepEqual(m, { text: CONTACT_NOT_FOUND, retry: false });
  assert.match(CONTACT_NOT_FOUND, /couldn’t be found/);
  assert.match(CONTACT_NOT_FOUND, /removed, or it may not be available to you/);
  assert.doesNotMatch(CONTACT_NOT_FOUND, /brokerage|another|forbidden|permission|exists/i, "says nothing that confirms the record exists elsewhere");
  assert.equal(contactLoadMessage(403, "x").retry, false);
  assert.equal(contactLoadMessage(403, "x").text, CONTACT_NO_ACCESS);
});

test("a failure that trying again can fix still offers it, with the server's own sentence", () => {
  for (const status of [500, 502, 503, null, undefined]) assert.deepEqual(contactLoadMessage(status, "Couldn't load this contact."), { text: "Couldn't load this contact.", retry: true });
});

test("the message screen shows Try again only when it is given a retry", () => {
  const without = MobileContactMessage({ text: CONTACT_NOT_FOUND, backHref: "/grow?tab=contacts" });
  assert.equal(all(without, (e) => e.type === "button").length, 0);
  assert.match(text(without), /People/);
  const withRetry = MobileContactMessage({ text: "Couldn't load this contact.", backHref: "/grow?tab=contacts", onRetry: () => {} });
  assert.equal(all(withRetry, (e) => e.type === "button" && text(e) === "Try again").length, 1);
});

test("the container decides from the response status, never from the wording", () => {
  const src = readFileSync(new URL("../../minimal/mobile/MobileContact.tsx", import.meta.url), "utf8");
  assert.match(src, /contactLoadMessage\(detail\.error instanceof ApiError \? detail\.error\.status : null/);
  assert.match(src, /onRetry=\{failure\.retry \? \(\) => void detail\.refetch\(\) : undefined\}/);
  assert.match(src, /text=\{CONTACT_NOT_FOUND\}/);
});
