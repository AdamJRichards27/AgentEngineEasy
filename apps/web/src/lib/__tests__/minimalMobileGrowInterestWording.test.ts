import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LINKING_OFF, MobileContactView, type MobileContactViewProps } from "../../minimal/mobile/MobileContactView";
import { buildMobileContactLayout, propertyRelationshipText } from "../../minimal/mobile/mobileContactLayout";
import { GROW_INTEREST_TITLE } from "../../minimal/mobile/mobileGrowInterest";
import { LINK_ROLE_LABELS } from "../../minimal/mobile/mobileLinkingConfig";
import { PROPERTY_RELATIONSHIP_LABELS } from "../../minimal/mobile/mobilePeopleConfig";
import type { GrowContact360 } from "../growContact360";
import { all, text } from "./mobileTreeHelpers";

// AE 2.0, mobile: PROPERTY-CONTACT RELATIONSHIPS (canonical: Seller, Buyer, Owner ...) are one thing; GROW INTERESTS (Future seller, Prospective buyer ...)
// are another. Both reach the screen in plain words, never as the stored key. Every type the server can store is covered, read from the server's own list.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const SERVER_TYPES = [...read("../../../../../packages/db/src/schema/grow.ts").match(/export const GROW_RELATIONSHIP_TYPES = \[([\s\S]*?)\] as const/)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const SERVER_ROLES = [...read("../../../../../packages/db/src/schema/property.ts").match(/export const PROPERTY_PARTY_ROLES = \[([\s\S]*?)\] as const/)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const base = JSON.parse(read("./fixtures/real-api/e47-grow-contact-over100.json")) as GrowContact360;
const NOW = new Date("2026-11-04T09:00:00Z");

// the approved wording, written out independently of the phone's map
const WORDS: Record<string, string> = {
  owner: "Owner", co_owner: "Co-owner", former_owner: "Former owner", occupier: "Occupier", tenant: "Tenant", landlord: "Landlord", buyer: "Buyer",
  prospective_buyer: "Prospective buyer", seller: "Seller", prospective_seller: "Future seller", appraisal_contact: "Appraisal contact", vendor: "Vendor",
  investor: "Investor", developer: "Developer", referrer: "Referrer", related_party: "Related party", unknown_pending_review: "Unknown, pending review",
};
const row = (id: number, type: string, o: Partial<GrowContact360["properties"][number]> = {}): GrowContact360["properties"][number] =>
  ({ relationshipId: id, propertyId: 1000 + id, propertyAddress: `${id} Wording Street, Paddington QLD 4064`, relationshipType: type, role: null, status: "Active", isPrimary: false, validFrom: "2026-01-01", validTo: null, ...o }) as GrowContact360["properties"][number];
const layoutOf = (rows: GrowContact360["properties"], canonical: Array<{ linkId: number; role: string; propertyId: number; address: string; isPrimary: boolean }> = []) =>
  buildMobileContactLayout({ ...base, properties: rows }, { now: NOW, canLog: true, canonicalLinks: canonical as never, canonicalMeta: { truncated: false, total: canonical.length, skipped: 0 } });
const viewText = (layout: ReturnType<typeof layoutOf>) => text(MobileContactView({ linking: LINKING_OFF, sectionsSlot: null, backHref: "/grow?tab=contacts", layout, historyExpanded: false, onToggleHistory: () => {}, form: null, formError: null, submitting: false, notice: null } as unknown as MobileContactViewProps));
const interestSection = (layout: ReturnType<typeof layoutOf>) => text(all(MobileContactView({ linking: LINKING_OFF, sectionsSlot: null, backHref: "/grow?tab=contacts", layout, historyExpanded: false, onToggleHistory: () => {}, form: null, formError: null, submitting: false, notice: null } as unknown as MobileContactViewProps), (e) => e.type === "section" && e.props?.["aria-label"] === GROW_INTEREST_TITLE)[0]);

test("the test covers EXACTLY the types the server can store (a new server type fails here until it has its words)", () => {
  assert.deepEqual([...SERVER_TYPES].sort(), Object.keys(WORDS).sort());
  for (const type of SERVER_TYPES) assert.ok(PROPERTY_RELATIONSHIP_LABELS[type], `${type} has an explicit label, not just the fallback`);
});

test("every Grow relationship type is shown in its approved words, never as the stored key (incl. Future seller and Prospective buyer)", () => {
  for (const type of SERVER_TYPES) assert.equal(propertyRelationshipText(type, null), WORDS[type], type);
  assert.equal(propertyRelationshipText("prospective_seller", null), "Future seller");
  assert.equal(propertyRelationshipText("prospective_buyer", null), "Prospective buyer");
});

test("on the screen: the Grow interest section carries those words for every type, and no stored key or underscore reaches the user", () => {
  const rows = SERVER_TYPES.map((t, i) => row(i + 1, t));
  const l = layoutOf(rows, [{ linkId: 1, role: "Seller", propertyId: 5, address: "5 Canon Street", isPrimary: false }]);
  const section = interestSection(l);
  for (const type of SERVER_TYPES) {
    assert.ok(section.includes(WORDS[type]), `${type} -> "${WORDS[type]}"`);
    if (type.includes("_")) assert.equal(section.includes(type), false, `the stored key ${type} is never shown`);
  }
  assert.deepEqual(l.interest.map((r) => r.relationship).sort(), SERVER_TYPES.map((t) => WORDS[t]).sort(), "each row carries exactly its words, whatever order the screen puts them in (a bare key such as 'owner' would not equal 'Owner')");
  assert.equal(section.includes("_"), false, "no underscore anywhere in the section");
  assert.equal(l.interest.length, SERVER_TYPES.length, "nothing is left out");
});

test("an unknown or future type is humanised, never shown as its stored key, and goes to review", () => {
  assert.equal(propertyRelationshipText("next_generation_type", null), "Next generation type");
  const l = layoutOf([row(1, "next_generation_type")]);
  const section = interestSection(l);
  assert.ok(section.includes("Next generation type"));
  assert.equal(section.includes("next_generation_type"), false);
  assert.equal(l.interest[0].kindLabel, "To review");
});

test("a free-text role refines the words and is preserved", () => {
  assert.equal(propertyRelationshipText("related_party", "Executor"), "Related party · Executor");
  assert.equal(propertyRelationshipText("owner", "Owner"), "Owner", "a role that repeats the type is not doubled");
});

test("the two kinds stay distinct: canonical roles are property-contact relationships in their own words; Grow interests are separate and labelled as Grow", () => {
  for (const role of SERVER_ROLES) assert.ok(LINK_ROLE_LABELS[role as keyof typeof LINK_ROLE_LABELS], `${role} has words`);
  assert.equal(LINK_ROLE_LABELS.PowerOfAttorney, "Power of attorney");
  const canonical = SERVER_ROLES.map((role, i) => ({ linkId: 100 + i, role, propertyId: 500 + i, address: `${500 + i} Canon Street`, isPrimary: false }));
  const l = layoutOf([row(1, "prospective_seller"), row(2, "prospective_buyer")], canonical);
  assert.deepEqual(l.properties.map((p) => p.relationship), SERVER_ROLES.map((r) => LINK_ROLE_LABELS[r as keyof typeof LINK_ROLE_LABELS]), "Properties: the canonical roles, in words");
  assert.deepEqual(l.interest.map((r) => r.relationship), ["Future seller", "Prospective buyer"], "Grow interest: the interests, in words");
  assert.deepEqual([l.propertiesCount, l.interestCount], [SERVER_ROLES.length, 2], "two separate counts, never added together");
  const all_ = viewText(l);
  assert.match(all_, new RegExp(GROW_INTEREST_TITLE));
  assert.equal(/Future seller|Prospective buyer/.test(text(all(MobileContactView({ linking: LINKING_OFF, sectionsSlot: null, backHref: "/g", layout: l, historyExpanded: false, onToggleHistory: () => {}, form: null, formError: null, submitting: false, notice: null } as unknown as MobileContactViewProps), (e) => e.type === "section" && e.props?.["aria-label"] === "Properties")[0])), false, "a Grow interest never appears under Properties");
});

test("no duplicate relationship actions: a Grow interest row offers no Edit role, Unlink or Make primary (those belong to the canonical links only)", () => {
  const l = layoutOf(SERVER_TYPES.map((t, i) => row(i + 1, t)));
  const t = interestSection(l);
  for (const word of ["Edit role", "Unlink", "Make primary", "Link a property"]) assert.equal(t.includes(word), false, word);
});
