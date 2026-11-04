import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LINKING_OFF, MobileContactView, type MobileContactViewProps } from "../../minimal/mobile/MobileContactView";
import { buildMobileContactLayout, propertiesNoticeText, type MobileContactOptions } from "../../minimal/mobile/mobileContactLayout";
import { parseContactLinks, parseContactLinksResult } from "../../minimal/mobile/mobileLinking";
import { MOBILE_LINKING } from "../../minimal/mobile/mobileLinkingConfig";
import { GROW_INTEREST_TITLE } from "../../minimal/mobile/mobileGrowInterest";
import { buildContactPropertyLinks, type ContactPropertyRow } from "../../minimal/properties/minimalPropertyContactsModel";
import type { GrowContact360 } from "../growContact360";
import { all, hrefs, text } from "./mobileTreeHelpers";

// Contact 360 on the phone: PROPERTIES (canonical, property_parties) and GROW INTEREST & HISTORY (what Grow recorded that is not a current property
// link), separate and labelled. Every response below is REAL, captured from the Release 1 backend (synthetic data). The canonical value is handed to
// the layout as an argument; no flag is changed and MOBILE_LINKING is never edited: contactCanonicalRead stays OFF.
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/real-api/${name}`, import.meta.url), "utf8"));
const byContact5 = read("r1-by-contact-5.json");
const legacy5 = read("r1-grow-contact-5-with-interest.json") as GrowContact360;
const overCap = read("r1-by-contact-1-over-cap.json");
const legacy1 = read("r1-grow-contact-1-with-interest.json") as GrowContact360;
const byContact91 = read("r1-by-contact-91.json");
const NOW = new Date("2026-11-04T09:00:00Z");
const noop = () => {};

function layoutFor(data: GrowContact360, o: Partial<MobileContactOptions> = {}) {
  return buildMobileContactLayout(data, { now: NOW, canLog: true, ...o });
}
function ready(data: GrowContact360, resp: unknown) {
  const r = parseContactLinksResult(resp);
  return layoutFor(data, { canonicalLinks: r.links, canonicalMeta: { truncated: r.truncated, total: r.total, skipped: r.skipped } });
}
function view(layout: ReturnType<typeof layoutFor>, o: Partial<MobileContactViewProps> = {}) {
  return MobileContactView({ linking: LINKING_OFF, sectionsSlot: null, backHref: "/grow?tab=contacts", layout, historyExpanded: false, onToggleHistory: noop, form: null, formError: null, submitting: false, notice: null, pendingCommitmentId: null, onOpenForm: noop, onCloseForm: noop, onField: noop, onSubmit: noop, onComplete: noop, ...o } as MobileContactViewProps);
}
const section = (tree: unknown, label: string) => all(tree, (e) => e.type === "section" && e.props?.["aria-label"] === label)[0];

test("the captured responses are real: contact 5 holds ONE canonical link and SEVEN Grow rows; contact 1 is over the cap", () => {
  assert.deepEqual([byContact5.links.length, byContact5.total, byContact5.truncated], [1, 1, false]);
  assert.deepEqual(legacy5.properties.map((r) => r.relationshipType).sort(), ["buyer", "former_owner", "owner", "prospective_buyer", "referrer", "related_party", "seller"]);
  assert.equal(legacy5.properties.find((r) => r.relationshipType === "former_owner")?.status, "Historical");
  assert.deepEqual([overCap.links.length, overCap.properties.length, overCap.total, overCap.limit, overCap.truncated], [100, 105, 105, 100, true]);
});

test("FLAG OFF (as shipped): the screen is exactly what it was: Active Grow links under Properties, no interest section, no notice", () => {
  const l = layoutFor(legacy5);
  assert.equal(l.propertiesState, "legacy");
  assert.deepEqual(l.properties.map((p) => p.canonical), l.properties.map(() => false));
  assert.equal(l.properties.length, legacy5.properties.filter((r) => r.status === "Active").length, "Active rows only, as before");
  assert.deepEqual([l.interest, l.interestMatchedNote, l.propertiesNotice], [[], null, null]);
  const tree = view(l);
  assert.equal(section(tree, GROW_INTEREST_TITLE), undefined, "no Grow interest & history section while the read is OFF");
  assert.equal(all(tree, (e) => e.props?.["data-ae-properties-notice"] !== undefined).length, 0);
  assert.match(text(section(tree, "Properties")), /Seller/);
});

test("FLAG ON, ready: Properties = the canonical link only; every Grow row is under Grow interest & history or counted; nothing is shown twice", () => {
  const l = ready(legacy5, byContact5);
  assert.equal(l.propertiesState, "ready");
  assert.deepEqual(l.properties.map((p) => [p.relationship, p.canonical, p.propertyId]), [["Buyer", true, 2]]);
  assert.equal(l.interest.length + (l.interestMatchedNote ? 1 : 0), legacy5.properties.length, "6 listed + 1 matched = all 7 Grow rows");
  assert.equal(l.interestMatchedNote, "1 Grow record matches a property listed above, so it is not repeated here.");
  assert.equal(l.interest.some((r) => r.relationship === "Buyer" && r.propertyId === 2), false, "the Grow Buyer that IS the canonical link is not repeated");
  assert.ok(l.interest.some((r) => r.relationship === "Seller" && r.propertyId === 2), "a DIFFERENT fact at the same property (Seller) is kept, as a Grow record");
  const byKind = Object.fromEntries(l.interest.map((r) => [r.relationship, r.kindLabel]));
  assert.deepEqual(byKind, { Seller: "Grow record", Owner: "Grow record", "Related party · Executor": "Interest", "Prospective buyer": "Interest", Referrer: "Interest", "Former owner": "Past" });
});

test("the screen: two separate sections; historical and Grow rows are never in Properties and are labelled so they cannot read as current", () => {
  const tree = view(ready(legacy5, byContact5));
  const props = text(section(tree, "Properties"));
  const interest = text(section(tree, GROW_INTEREST_TITLE));
  assert.match(props, /Buyer/);
  for (const never of ["Former owner", "Past", "Grow record", "Interest", "Executor", "Referrer"]) assert.doesNotMatch(props, new RegExp(never), `Properties must not contain "${never}"`);
  assert.match(interest, /Former owner · Past/);
  assert.match(interest, /Owner · Grow record/);
  assert.match(interest, /Prospective buyer · Interest/);
  assert.match(interest, /Related party · Executor · Interest/);
  assert.match(interest, /These are not current property links\./);
  assert.match(interest, /1 Grow record matches a property listed above/);
  assert.deepEqual(hrefs(section(tree, GROW_INTEREST_TITLE)).sort(), ["/grow/properties/2", "/grow/properties/5", "/grow/properties/6", "/grow/properties/8", "/grow/properties/9"], "each Grow row with a property opens it; the person-level Referrer opens nothing");
});

test("role labels and the Primary indicator: the role is the approved word, and Primary appears exactly where the server says so", () => {
  const withPrimary = JSON.parse(JSON.stringify(byContact91));
  withPrimary.links[0].isPrimary = true;
  withPrimary.links[1].isPrimary = false;
  const l = ready(legacy5, withPrimary);
  const rows = text(section(view(l), "Properties"));
  assert.equal((rows.match(/ · Primary/g) ?? []).length, 1, "exactly one Primary");
  const primaryRole = l.properties[0].relationship;
  assert.match(rows, new RegExp(`${primaryRole} · Primary`));
  for (const p of l.properties) assert.match(p.relationship, /^(Owner|Landlord|Tenant|Buyer|Seller|Other|Power of attorney|Executor|Trustee|Agent|Property manager|Solicitor|Mortgagee|Developer|Occupier|Guarantor|Co-owner|Related party)/, "an approved role word, never a raw value");
  assert.equal(parseContactLinks(byContact91).length, 2);
});

test("PAGINATION: over the cap the phone says 'Showing 100 of 105' and offers the full record; it never silently cuts", () => {
  const l = ready(legacy1, overCap);
  assert.equal(l.properties.length, 100);
  assert.equal(l.propertiesNotice, "Showing 100 of 105 property links. Open the full record to see all of them.");
  assert.equal(layoutFor(legacy1).propertiesNotice, null, "flag OFF: no notice (nothing canonical is shown)");
  const tree = view(l);
  const notice = all(tree, (e) => e.props?.["data-ae-properties-notice"] !== undefined)[0];
  assert.ok(notice);
  assert.match(text(notice), /Showing 100 of 105/);
  assert.deepEqual(hrefs(notice), [l.fullRecordHref], "one tap to the full record, which holds all of them");
  const desktopAll = buildContactPropertyLinks(overCap.properties as ContactPropertyRow[]).length;
  assert.equal(desktopAll, 105, "the full record shows all 105");
});

test("pagination wording in every case: older server without a total, unreadable rows, no truncation, a total that is not believable", () => {
  const n = (shown: number, meta: Parameters<typeof propertiesNoticeText>[1]) => propertiesNoticeText(shown, meta);
  assert.equal(n(100, { truncated: true, total: 143, skipped: 0 }), "Showing 100 of 143 property links. Open the full record to see all of them.");
  assert.equal(n(100, { truncated: true, total: null, skipped: 0 }), "Showing the first 100 property links. Open the full record to see all of them.", "older server: no total, still says so");
  assert.equal(n(4, { truncated: false, total: 5, skipped: 1 }), "Showing 4 of 5 property links. 1 link couldn't be shown. Open the full record to see all of them.");
  assert.equal(n(98, { truncated: true, total: 103, skipped: 2 }), "Showing 98 of 103 property links. 2 links couldn't be shown. Open the full record to see all of them.");
  assert.equal(n(5, { truncated: false, total: 5, skipped: 0 }), null, "nothing to say when nothing is missing");
  assert.equal(n(2, null), null);
  const older = { links: overCap.links, truncated: true };
  assert.deepEqual([parseContactLinksResult(older).total, parseContactLinksResult(older).truncated], [null, true]);
  assert.equal(parseContactLinksResult({ links: overCap.links, total: 3 }).total, null, "a total smaller than what was shown is not believed");
  const withBad = { ...byContact91, links: [...byContact91.links, { linkId: 99, role: 7, property: {} }, null] };
  assert.deepEqual([parseContactLinksResult(withBad).links.length, parseContactLinksResult(withBad).skipped], [2, 2], "unreadable rows are counted, not dropped silently");
});

test("loading and failure are SAID; the older Grow list is never shown in Properties in their place", () => {
  for (const [status, words] of [["loading", /Loading property links/], ["error", /Couldn't load this contact's property links\./]] as const) {
    const l = layoutFor(legacy5, { canonicalStatus: status });
    assert.equal(l.propertiesState, status);
    assert.deepEqual([l.properties, l.interest], [[], []], "no Properties and no interest while the canonical list is not here");
    const tree = view(l, { onRetryProperties: noop });
    assert.match(text(section(tree, "Properties")), words);
    assert.equal(section(tree, GROW_INTEREST_TITLE), undefined);
  }
  const err = view(layoutFor(legacy5, { canonicalStatus: "error" }), { onRetryProperties: noop });
  const notice = all(err, (e) => e.props?.["data-ae-properties-notice"] !== undefined)[0];
  assert.equal(notice.props?.role, "alert");
  assert.deepEqual(all(notice, (e) => e.type === "button").map((b) => text(b)), ["Try again"]);
  assert.deepEqual(hrefs(notice).length, 1, "and the full record");
});

test("a contact with no canonical links says so, and still shows its Grow interest & history", () => {
  const l = layoutFor(legacy5, { canonicalLinks: [], canonicalMeta: { truncated: false, total: 0, skipped: 0 } });
  assert.equal(l.propertiesState, "ready");
  assert.equal(l.properties.length, 0);
  assert.match(text(section(view(l), "Properties")), /No property links\./);
  assert.equal(l.interest.length, legacy5.properties.length, "nothing matches, so all 7 are listed");
  assert.equal(l.interestMatchedNote, null);
});

test("the work stays behind the EXISTING flag: contactCanonicalRead is OFF, the screen asks for the canonical list only when it is on, and nothing overrides it", () => {
  assert.equal(MOBILE_LINKING.contactCanonicalRead, false);
  const dir = new URL("../../minimal/mobile/", import.meta.url);
  const code = (f: string) => readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const container = code("MobileContact.tsx");
  assert.match(container, /enabled: partyId !== null && MOBILE_LINKING\.contactCanonicalRead,/);
  assert.match(container, /const canonicalOn = MOBILE_LINKING\.contactCanonicalRead;/);
  for (const f of ["MobileContact.tsx", "MobileContactView.tsx", "mobileContactLayout.ts", "mobileGrowInterest.ts", "mobileLinking.ts"]) {
    const src = code(f);
    assert.doesNotMatch(src, /import\.meta\.env|localStorage|sessionStorage|window\.__|document\.cookie|URLSearchParams\([^)]*canonical/i, `${f}: no environment, storage or URL override`);
  }
  const reads = ["MobileContactView.tsx", "mobileContactLayout.ts", "mobileGrowInterest.ts"].filter((f) => /MOBILE_LINKING\.contactCanonicalRead|builtRelationshipControlGroup/.test(code(f)));
  assert.deepEqual(reads, [], "only the container reads the flag; the layout and view take the canonical value as an argument");
  assert.equal(/MOBILE_LINKING\s*=\s*\{[^}]*contactCanonicalRead:\s*true/.test(readFileSync(new URL("mobileLinkingConfig.ts", dir), "utf8")), false);
});
