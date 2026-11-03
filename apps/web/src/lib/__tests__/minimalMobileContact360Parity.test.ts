import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMobileContactLayout } from "../../minimal/mobile/mobileContactLayout";
import { parseContactLinks } from "../../minimal/mobile/mobileLinking";
import { MOBILE_LINKING } from "../../minimal/mobile/mobileLinkingConfig";
import { buildContactPropertyLinks, type ContactPropertyRow } from "../../minimal/properties/minimalPropertyContactsModel";
import type { GrowContact360 } from "../growContact360";

// X13 without changing any flag: ONE real response from GET /parties/by-contact/:id (captured from the Release 1 backend, synthetic data) is fed to
// the desktop's row builder and to the phone's parser and layout. The canonical-read value is handed to the layout as an argument (canonicalLinks);
// MOBILE_LINKING is never edited, and contactCanonicalRead stays OFF.
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/real-api/${name}`, import.meta.url), "utf8"));
const byContact = read("r1-by-contact-91.json");
const overCap = read("r1-by-contact-1-over-cap.json");
const legacy = read("r1-grow-contact-91.json") as GrowContact360;
const NOW = new Date("2026-11-04T09:00:00Z");
const desktop = (resp: { properties: ContactPropertyRow[] }) => buildContactPropertyLinks(resp.properties).map((l) => [l.label, l.role, l.roleLabel, l.isPrimary]);
const phone = (resp: unknown, data: GrowContact360 = legacy) => buildMobileContactLayout(data, { now: NOW, canLog: true, canonicalLinks: parseContactLinks(resp) }).properties.map((p) => [p.label, p.roleValue, p.relationship, p.primary]);

test("the captured responses are real and have the agreed shape (links, total, limit, truncated, the uncapped properties)", () => {
  for (const r of [byContact, overCap]) for (const k of ["links", "total", "limit", "truncated", "properties"]) assert.ok(k in r, k);
  assert.deepEqual([byContact.links.length, byContact.total, byContact.limit, byContact.truncated], [2, 2, 100, false]);
  assert.deepEqual([overCap.links.length, overCap.properties.length, overCap.total, overCap.limit, overCap.truncated], [100, 105, 105, 100, true], "the real cap: 100 shown of 105");
  assert.equal(legacy.properties.length, 0, "contact 91 has no row in the older Grow relationship table");
});

test("canonical read supplied: the phone and the desktop show the same properties, roles, role words and Primary (real response, 2 links)", () => {
  const p = phone(byContact);
  assert.equal(p.length, 2);
  assert.deepEqual(p, desktop(byContact));
});

test("canonical read supplied, over the cap: the phone's 100 rows equal the desktop's first 100; the desktop shows all 105", () => {
  const d = desktop(overCap);
  const p = phone(overCap);
  assert.equal(d.length, 105);
  assert.equal(p.length, 100);
  assert.deepEqual(p, d.slice(0, 100));
});

test("X13 by design: with the canonical read OFF the phone shows the older list only (none for contact 91) while the desktop shows the canonical links", () => {
  const withoutCanonical = buildMobileContactLayout(legacy, { now: NOW, canLog: true }).properties;
  assert.equal(withoutCanonical.length, 0, "the phone: nothing, because the older table has no row for this contact");
  assert.equal(desktop(byContact).length, 2, "the desktop: the canonical links");
  const src = readFileSync(new URL("../../minimal/mobile/MobileContact.tsx", import.meta.url), "utf8");
  assert.match(src, /enabled: partyId !== null && MOBILE_LINKING\.contactCanonicalRead/, "the phone requests by-contact ONLY when the flag is on");
  assert.equal(MOBILE_LINKING.contactCanonicalRead, false, "and the flag is OFF");
});

test.todo("over the cap the phone must SAY so: 'Showing 100 of {total}' from the server's total/limit/truncated, never a silent cut (display work still to build, behind the OFF flag)");
