import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMinimalContactModel } from "../../minimal/minimalContactModel";
import { MinimalContact360View } from "../../minimal/MinimalContact360";
import { buildMobileContactLayout } from "../../minimal/mobile/mobileContactLayout";
import { parseContactLinksResult } from "../../minimal/mobile/mobileLinking";
import { GROW_RELATIONSHIP_TYPE_LABELS, ALSO_LISTED_LABEL, GROW_INTEREST_TITLE } from "../growInterest";
import type { GrowContact360 } from "../growContact360";

// t267u (Grok, desktop): the desktop Contact 360 classifies Grow rows through the SAME shared helper (lib/growInterest.ts) as the phone,
// so both screens show identical rows, words, kinds and "Also listed under Properties" for the same responses. Real captured responses
// (synthetic data) plus every Grow type × every status. No flag is read or changed; contactCanonicalRead stays OFF.
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/real-api/${name}`, import.meta.url), "utf8"));
const NOW = new Date("2026-11-04T09:00:00Z");

type Row = { key: number; relationship: string; kindLabel: string; alsoListed: boolean; label: string };
const pick = (r: Row) => ({ key: r.key, relationship: r.relationship, kindLabel: r.kindLabel, alsoListed: r.alsoListed, label: r.label });

function desktop(data: GrowContact360, byContact: { properties: { propertyId: number; role: string }[] }) {
  return buildMinimalContactModel(data, { runAccess: true, canonicalLinks: byContact.properties.map((r) => ({ propertyId: r.propertyId, role: r.role })) });
}
function phone(data: GrowContact360, byContact: unknown) {
  const r = parseContactLinksResult(byContact);
  return buildMobileContactLayout(data, { now: NOW, canLog: true, canonicalLinks: r.links, canonicalMeta: { truncated: r.truncated, total: r.total, skipped: r.skipped }, canonicalMatchLinks: r.matchLinks });
}

for (const [grow, by] of [
  ["r1-grow-contact-5-with-interest.json", "r1-by-contact-5.json"],
  ["r1-grow-contact-91.json", "r1-by-contact-91.json"],
] as const) {
  test(`desktop and phone classify ${grow} identically (rows, order, words, kind, Also listed)`, () => {
    const data = read(grow) as GrowContact360;
    const byContact = read(by);
    const d = desktop(data, byContact).growInterest;
    const m = phone(data, byContact);
    assert.ok(d);
    assert.deepEqual(d.rows.map(pick), m.interest.map(pick));
    assert.equal(d.count, m.interestCount, "the Grow count is the same number on both");
    assert.equal(d.count, data.properties.length, "every Grow row is listed, none left out");
  });
}

test("contact 5 on the desktop: proper-case words, Grow role kept, Historical shown as Past, Buyer not duplicated but labelled", () => {
  const data = read("r1-grow-contact-5-with-interest.json") as GrowContact360;
  const g = desktop(data, read("r1-by-contact-5.json")).growInterest!;
  for (const r of g.rows) assert.doesNotMatch(r.relationship, /_|^[a-z]/, `no raw stored type: ${r.relationship}`);
  const withRole = data.properties.find((p) => p.role && p.role.trim().length > 0);
  if (withRole) assert.ok(g.rows.some((r) => r.key === withRole.relationshipId && r.relationship.includes(withRole.role!.trim())), "the Grow role is kept");
  const former = g.rows.find((r) => r.relationship.startsWith("Former owner"));
  assert.equal(former?.kindLabel, "Past", "the Historical former owner is shown, as Past");
  const buyers = g.rows.filter((r) => r.relationship.startsWith("Buyer"));
  assert.equal(buyers.length, 1, "the Grow Buyer appears once in Grow interest");
  assert.equal(buyers[0].alsoListed, true, "and carries Also listed under Properties instead of repeating as a second property");
  assert.equal(g.alsoListedCount, 1);
});

test("every Grow type × every status: desktop and phone agree row for row (shared precedence: PendingReview, unknown, non-Active, former owner)", () => {
  const types = [...Object.keys(GROW_RELATIONSHIP_TYPE_LABELS), "made_up_type"];
  const statuses = ["Active", "PendingReview", "Historical", "Archived"];
  let id = 1;
  const rows = types.flatMap((t) => statuses.map((s) => ({ relationshipId: id++, propertyId: 7, propertyAddress: "7 Test St", relationshipType: t, role: null, status: s, isPrimary: false, validFrom: "2020-01-01", validTo: null })));
  const data = { ...(read("r1-grow-contact-5-with-interest.json") as GrowContact360), properties: rows };
  const byContact = { partyId: 5, properties: [{ linkId: 1, propertyId: 7, role: "Owner", isPrimary: true, createdAt: "2026-01-01T00:00:00Z", formattedAddress: "7 Test St", suburb: "X", state: "QLD", postcode: "4000" }], links: [{ linkId: 1, role: "Owner", isPrimary: true, createdAt: "2026-01-01T00:00:00Z", property: { id: 7, formattedAddress: "7 Test St", suburb: "X", state: "QLD", postcode: "4000" } }], truncated: false, total: 1, limit: 100 };
  const d = desktop(data, byContact).growInterest!;
  const m = phone(data, byContact);
  assert.deepEqual(d.rows.map(pick), m.interest.map(pick));
  const kind = (t: string, s: string) => d.rows.find((r) => r.key === rows.find((x) => x.relationshipType === t && x.status === s)!.relationshipId)!.kindLabel;
  assert.equal(kind("made_up_type", "Historical"), "To review", "unknown type is To review (Owner)");
  assert.equal(kind("former_owner", "Active"), "Past", "former owner is Past (Owner)");
  assert.equal(kind("owner", "PendingReview"), "To review", "PendingReview takes priority (Owner)");
  assert.equal(kind("owner", "Archived"), "Past");
  assert.deepEqual(d.rows.filter((r) => r.alsoListed).map((r) => r.relationship), ["Owner"], "only the Active owner at the same property matches");
});

test("desktop screen: one Grow interest & history section with its own count, the Also listed label, and no 'Other relationships'", () => {
  const data = read("r1-grow-contact-5-with-interest.json") as GrowContact360;
  const model = desktop(data, read("r1-by-contact-5.json"));
  const json = JSON.stringify(MinimalContact360View({ model, propertyLinks: { partyId: 5, canManage: false } }));
  assert.ok(json.includes(GROW_INTEREST_TITLE));
  assert.ok(json.includes(` (${data.properties.length})`));
  assert.ok(json.includes(ALSO_LISTED_LABEL));
  assert.equal(json.includes("Other relationships"), false);
  const src = readFileSync(new URL("../../minimal/MinimalContact360.tsx", import.meta.url), "utf8");
  assert.equal(src.includes("relationshipType}"), false, "the desktop never renders the raw stored type");
});

test("t271u: over the 100-link cap (Claude's real 130-link fixture, Owner link #120) desktop and phone still agree, label included", () => {
  const data = read("e47-grow-contact-over100.json") as GrowContact360;
  const byContact = read("e47-by-contact-over100.json");
  assert.equal(byContact.links.length, 100);
  assert.equal(byContact.properties.length, 130);
  const d = desktop(data, byContact).growInterest!;
  const m = phone(data, byContact);
  assert.deepEqual(d.rows.map(pick), m.interest.map(pick));
  assert.ok(d.rows.some((r) => r.alsoListed), "the Grow owner whose canonical link is beyond the cap is labelled on both");
});
