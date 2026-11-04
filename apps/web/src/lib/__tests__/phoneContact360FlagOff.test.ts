// Owner t274u item 2: with contactCanonicalRead OFF the phone Contact 360 keeps
// the Grow-only read exactly: no canonical request, no bypass. Source-level pins
// on Claude's files (read only; not edited by Grok).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MOBILE_LINKING } from "../../minimal/mobile/mobileLinkingConfig";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const contact = read("../../minimal/mobile/MobileContact.tsx");

test("t274u item 2: all 9 relationship flags (incl. contactCanonicalRead) are OFF in the shared config", () => {
  assert.deepEqual(Object.entries(MOBILE_LINKING).filter(([, on]) => on), []);
  assert.equal(Object.keys(MOBILE_LINKING).length, 9);
  assert.equal(MOBILE_LINKING.contactCanonicalRead, false);
});

test("t274u item 2: phone C360 reads GET /grow/contacts/:id, and the canonical by-contact request is gated by the flag only", () => {
  assert.match(contact, /queryFn: \(\) => apiFetch\(`\/grow\/contacts\/\$\{partyId\}`\)/);
  const canonicalQuery = contact.slice(contact.indexOf('queryKey: ["parties", "by-contact", partyId]'), contact.indexOf("const canonicalOn"));
  assert.match(canonicalQuery, /enabled: partyId !== null && MOBILE_LINKING\.contactCanonicalRead,/);
  assert.match(contact, /const canonicalOn = MOBILE_LINKING\.contactCanonicalRead;/);
  assert.match(contact, /const canonicalResult = canonicalOn && canonical\.isSuccess/);
  // No other path in the phone C360 calls the canonical read endpoints.
  assert.equal((contact.match(/canonicalContactLinksPath\(/g) ?? []).length, 1);
  assert.doesNotMatch(contact, /\/parties\/by-contact/);
});
