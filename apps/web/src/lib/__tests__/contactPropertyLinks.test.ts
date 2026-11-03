import { MOBILE_LINKING } from "../../minimal/mobile/mobileLinkingConfig";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContactPropertyLinks,
  buildLinkedContacts,
  contactPropertiesPath,
  isPropertyAlreadyLinked,
  linkPath,
  propertySearchPath,
  updateLinkBody,
} from "../../minimal/properties/minimalPropertyContactsModel";

// t228u Priority 2 — contact side of property_parties, and link edit bodies.

test("contact property links: labels, primary, hrefs, fallback address", () => {
  const links = buildContactPropertyLinks([
    { linkId: 1, propertyId: 10, role: "Seller", isPrimary: true, formattedAddress: "1 Synthetic St, Testville" },
    { linkId: 2, propertyId: 11, role: "Buyer", isPrimary: false, formattedAddress: null },
    { linkId: 3, propertyId: 11, role: "Legacy", isPrimary: false, formattedAddress: " " },
  ]);
  assert.equal(links[0].roleLabel, "Seller");
  assert.equal(links[0].isPrimary, true);
  assert.equal(links[0].propertyHref, "/grow/properties/10");
  assert.equal(links[1].label, "Property 11");
  assert.equal(links[2].roleLabel, "Legacy", "unknown roles are shown as stored");
  assert.ok(isPropertyAlreadyLinked(links, 11, "Buyer"));
  assert.ok(!isPropertyAlreadyLinked(links, 10, "Buyer"));
});

test("linked contacts carry isPrimary", () => {
  const [a, b] = buildLinkedContacts([
    { linkId: 1, role: "Seller", isPrimary: true, party: { id: 1, firstName: "A" } },
    { linkId: 2, role: "Seller", party: { id: 2, firstName: "B" } },
  ]);
  assert.equal(a.isPrimary, true);
  assert.equal(b.isPrimary, false);
});

test("updateLinkBody sends only changed, valid fields", () => {
  const cur = { role: "Buyer", isPrimary: false };
  assert.equal(updateLinkBody(cur, { role: "Buyer" }), null);
  assert.equal(updateLinkBody(cur, { role: "NotARole" }), null);
  assert.deepEqual(updateLinkBody(cur, { role: "Seller" }), { role: "Seller" });
  assert.deepEqual(updateLinkBody(cur, { isPrimary: true }), { isPrimary: true });
});

test("paths", () => {
  assert.equal(contactPropertiesPath(5), "/parties/by-contact/5");
  assert.equal(linkPath(9), "/parties/link/9");
  assert.equal(propertySearchPath("  1 Main St "), "/properties?q=1%20Main%20St");
  assert.equal(propertySearchPath(""), "/properties");
});

test("t230u: link controls are feature-flagged off unless VITE_PROPERTY_LINK_CONTROLS=true", async () => {
  const { propertyLinkControlsEnabled } = await import("../../minimal/properties/minimalPropertyContactsModel");
  assert.equal(propertyLinkControlsEnabled(undefined), false);
  assert.equal(propertyLinkControlsEnabled({}), false);
  assert.equal(propertyLinkControlsEnabled({ VITE_PROPERTY_LINK_CONTROLS: "1" }), false);
  // t263u: the desktop flag alone is a MIXED state (mobile relationship flags OFF) and resolves OFF; with the whole group ON it is ON.
  assert.equal(propertyLinkControlsEnabled({ VITE_PROPERTY_LINK_CONTROLS: "true" }), false);
  const allOn = Object.fromEntries(Object.keys(MOBILE_LINKING).map((k) => [k, k !== "contactCanonicalRead"])) as typeof MOBILE_LINKING;
  assert.equal(propertyLinkControlsEnabled({ VITE_PROPERTY_LINK_CONTROLS: "true" }, allOn), true);
  assert.equal(propertyLinkControlsEnabled(), false, "default build: off");
});

test("t234u: PROPERTY_PARTY_PRIMARY_EXISTS maps to the primary message; other 409s stay link-exists; duplicate wording offers Create anyway", async () => {
  const m = await import("../../minimal/properties/minimalPropertyContactsModel");
  assert.equal(m.linkFailureText({ status: 409, code: "PROPERTY_PARTY_PRIMARY_EXISTS" }, "x"), m.PRIMARY_ALREADY_SET);
  assert.notEqual(m.linkFailureText({ status: 409, code: "PROPERTY_PARTY_LINK_EXISTS" }, "x"), m.PRIMARY_ALREADY_SET);
  assert.match(m.POSSIBLE_DUPLICATE_CONTACT, /Create anyway/);
});
