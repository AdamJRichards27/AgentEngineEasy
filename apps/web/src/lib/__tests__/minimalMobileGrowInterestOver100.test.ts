import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMobileContactLayout } from "../../minimal/mobile/mobileContactLayout";
import { parseContactLinksResult, parsePropertyMatchLinks } from "../../minimal/mobile/mobileLinking";
import type { GrowContact360 } from "../growContact360";

// "Also listed under Properties" must give the SAME answer as the desktop whatever the 100-link display cap hides (Release 1, Contact 360).
// The by-contact response carries the capped `links` (100) AND the uncapped `properties[]` (every link this caller may see, flat rows, no phone numbers,
// the same hidden links excluded). Matching reads the uncapped rows' (propertyId, role) and nothing else. Real responses captured from the baseline API
// (e47b5dc, sandbox, synthetic data): contact 6 has 130 links; the Owner link is number 120 (beyond the cap) and an Active Grow `owner` record
// exists at that property.
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/real-api/${name}`, import.meta.url), "utf8"));
const byContact = read("e47-by-contact-over100.json");
const grow = read("e47-grow-contact-over100.json") as GrowContact360;
const TARGET = 169;
const NOW = new Date("2026-11-04T09:00:00Z");

// the desktop's rule, written out independently of the phone's code: an ACTIVE Grow row, the same property, a type named exactly as the role,
// for owner / tenant / landlord / buyer only; everything else is never matched.
const ROLE_OF: Record<string, string> = { owner: "Owner", tenant: "Tenant", landlord: "Landlord", buyer: "Buyer" };
const expectedAlso = (rows: GrowContact360["properties"], all: Array<{ propertyId: number; role: string }>) =>
  rows.filter((r) => r.status === "Active" && r.propertyId !== null && ROLE_OF[r.relationshipType.trim().toLowerCase()] !== undefined && all.some((l) => l.propertyId === r.propertyId && l.role === ROLE_OF[r.relationshipType.trim().toLowerCase()])).map((r) => r.relationshipId).sort();
const layoutFor = (capped: ReturnType<typeof parseContactLinksResult>, matchLinks: ReturnType<typeof parseContactLinksResult>["matchLinks"], opts: { total?: number | null } = {}) =>
  buildMobileContactLayout(grow, { now: NOW, canLog: true, canonicalLinks: capped.links, canonicalMatchLinks: matchLinks, canonicalMeta: { truncated: capped.truncated, total: opts.total === undefined ? capped.total : opts.total, skipped: capped.skipped } });
const alsoKeys = (l: ReturnType<typeof layoutFor>) => l.interest.filter((r) => r.alsoListed).map((r) => r.key).sort();

test("the captured response is what the tests claim: 100 shown of 130, the Owner link beyond the cap, present in the uncapped list", () => {
  const r = parseContactLinksResult(byContact);
  assert.deepEqual([r.links.length, r.total, r.truncated, r.limit], [100, 130, true, 100]);
  assert.equal(r.links.some((l) => l.propertyId === TARGET), false, "not in the capped list");
  assert.equal(r.matchLinks?.length, 130, "the uncapped list holds every link");
  assert.ok(r.matchLinks?.some((l) => l.propertyId === TARGET && l.role === "Owner"));
  assert.equal(grow.properties.length, 1);
  assert.equal(grow.properties[0].relationshipType, "owner");
});

test("REGRESSION: the Grow owner row whose Owner link is beyond the 100 cap IS labelled 'Also listed under Properties', as on the desktop", () => {
  const r = parseContactLinksResult(byContact);
  const l = layoutFor(r, r.matchLinks);
  assert.deepEqual(alsoKeys(l), expectedAlso(grow.properties, byContact.properties), "equals the desktop rule over the FULL set");
  assert.equal(l.interest.find((x) => x.propertyId === TARGET)?.alsoListed, true);
  assert.equal(l.interest.length, grow.properties.length, "nothing is left out: the row is labelled, never hidden");
  assert.equal(l.interest.find((x) => x.propertyId === TARGET)?.kindLabel, "Grow record", "matching never changes the original Grow classification");
});

test("the answer does not depend on the cap: whatever number of links the display shows, the labels are identical", () => {
  const full = parseContactLinksResult(byContact);
  const want = expectedAlso(grow.properties, byContact.properties);
  for (const cap of [1, 10, 50, 99, 100, 119, 120, 129, 130]) {
    const capped = { ...full, links: full.links.slice(0, cap), truncated: cap < 130, total: 130 };
    assert.deepEqual(alsoKeys(layoutFor(capped, full.matchLinks)), want, `cap ${cap}`);
  }
  const shuffled = [...(full.matchLinks ?? [])].reverse();
  assert.deepEqual(alsoKeys(layoutFor(full, shuffled)), want, "list order is irrelevant");
});

test("the Properties count and the Grow interest count stay separate, and the Properties count is the server's total, not what was matched", () => {
  const r = parseContactLinksResult(byContact);
  const l = layoutFor(r, r.matchLinks);
  assert.equal(l.propertiesCount, 130);
  assert.equal(l.interestCount, 1);
  assert.equal(l.properties.length, 100, "the display cap is unchanged: 100 rows");
  assert.match(l.propertiesNotice ?? "", /100 of 130/);
});

test("PRIVACY: only propertyId and role are kept from an uncapped row; nothing else is read, stored or shown", () => {
  const rows = [{ linkId: 9, propertyId: 5, role: "Owner", isPrimary: true, createdAt: "2026-01-01", formattedAddress: "5 Secret Street", suburb: "X", state: "QLD", postcode: "4000", mobile: "0491 570 156", email: "a@b.c", displayName: "A Person" }];
  const kept = parsePropertyMatchLinks({ properties: rows });
  assert.deepEqual(kept, [{ propertyId: 5, role: "Owner" }]);
  assert.deepEqual(Object.keys(kept?.[0] ?? {}).sort(), ["propertyId", "role"]);
  assert.doesNotMatch(JSON.stringify(kept), /Secret|0491|a@b|Person|2026/);
  const real = parsePropertyMatchLinks(byContact) ?? [];
  assert.equal(real.every((x) => Object.keys(x).length === 2), true);
  assert.doesNotMatch(JSON.stringify(real), /Over100|Paddington|QLD/);
});

test("defensive parsing: malformed rows are dropped, never guessed; no list at all gives null (an older server)", () => {
  assert.deepEqual(parsePropertyMatchLinks({ properties: [{ propertyId: 1, role: " Owner " }, { propertyId: -1, role: "Owner" }, { propertyId: 2 }, { propertyId: 3, role: "" }, { propertyId: 1.5, role: "Tenant" }, null, "x", { propertyId: "4", role: "Buyer" }] }), [{ propertyId: 1, role: "Owner" }]);
  for (const missing of [null, undefined, {}, { properties: null }, { properties: "no" }, [], 7]) assert.equal(parsePropertyMatchLinks(missing), null);
  assert.deepEqual(parsePropertyMatchLinks({ properties: [] }), [], "an empty list is a real answer: this contact has no links");
});

test("FALLBACK, stated plainly: with no uncapped list the phone matches against the links it shows (the old behaviour), and the truncation notice still tells the user", () => {
  const r = parseContactLinksResult({ ...byContact, properties: undefined });
  assert.equal(r.matchLinks, null);
  const l = layoutFor(r, r.matchLinks);
  assert.equal(l.interest.find((x) => x.propertyId === TARGET)?.alsoListed, false, "cannot know: only 100 links are available");
  assert.match(l.propertiesNotice ?? "", /100 of 130/, "the user is told the list is not complete and can open the full record");
  assert.match(l.fullRecordHref, /\/grow\/contacts\/6\?/);
});

test("the container hands the layout the uncapped matching set, from the same response (no extra request)", () => {
  const src = readFileSync(new URL("../../minimal/mobile/MobileContact.tsx", import.meta.url), "utf8");
  assert.match(src, /canonicalMatchLinks: canonicalResult \? canonicalResult\.matchLinks : null,/);
  assert.equal((src.match(/apiFetch\(/g) ?? []).length, 3, "still exactly three requests: no new fetch for the matching set");
});
