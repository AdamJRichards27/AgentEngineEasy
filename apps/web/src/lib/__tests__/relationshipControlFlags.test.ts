import { test } from "node:test";
import assert from "node:assert/strict";
import { MOBILE_LINKING, type LinkingFlags } from "../../minimal/mobile/mobileLinkingConfig";
import { builtRelationshipControlGroup, MOBILE_RELATIONSHIP_CONTROL_FLAGS, resolveRelationshipControlGroup } from "../relationshipControlFlags";
import { linkingCapabilities } from "../../minimal/mobile/mobileLinking";
import { propertyLinkControlsEnabled } from "../../minimal/properties/minimalPropertyContactsModel";

// t263u (3): the desktop link-controls flag and the 8 mobile relationship-control flags activate together or not at all.
const OFF = { ...MOBILE_LINKING };
const with_ = (keys: readonly string[], base: LinkingFlags = OFF): LinkingFlags => ({ ...base, ...Object.fromEntries(keys.map((k) => [k, true])) });
const ALL = with_(MOBILE_RELATIONSHIP_CONTROL_FLAGS);

test("as built on this base: every flag OFF, group ALL_OFF, desktop controls OFF", () => {
  assert.deepEqual(Object.entries(MOBILE_LINKING).filter(([, v]) => v), []);
  const g = builtRelationshipControlGroup({});
  assert.equal(g.state, "ALL_OFF");
  assert.equal(g.desktop, false);
  assert.equal(propertyLinkControlsEnabled({}), false);
});

test("the whole group ON is the only way to enable it", () => {
  const g = resolveRelationshipControlGroup(true, ALL);
  assert.equal(g.state, "ALL_ON");
  assert.equal(g.desktop, true);
  for (const k of MOBILE_RELATIONSHIP_CONTROL_FLAGS) assert.equal(g.mobile[k], true);
});

test("every single-member partial state is refused and forces the whole group OFF", () => {
  const members = ["VITE_PROPERTY_LINK_CONTROLS", ...MOBILE_RELATIONSHIP_CONTROL_FLAGS];
  for (const only of members) {
    const g = only === "VITE_PROPERTY_LINK_CONTROLS" ? resolveRelationshipControlGroup(true, OFF) : resolveRelationshipControlGroup(false, with_([only]));
    assert.equal(g.state, "MIXED_REFUSED", only);
    assert.equal(g.desktop, false, only);
    for (const k of MOBILE_RELATIONSHIP_CONTROL_FLAGS) assert.equal(g.mobile[k], false, `${only} -> ${k}`);
    assert.deepEqual(g.onWhenRefused, [only]);
  }
});

test("all-but-one states are refused too (desktop missing; one mobile twin missing)", () => {
  assert.equal(resolveRelationshipControlGroup(false, ALL).state, "MIXED_REFUSED");
  for (const k of MOBILE_RELATIONSHIP_CONTROL_FLAGS) {
    const g = resolveRelationshipControlGroup(true, { ...ALL, [k]: false });
    assert.equal(g.state, "MIXED_REFUSED", k);
    assert.equal(g.desktop, false);
  }
});

test("contactCanonicalRead is not a member and is passed through unchanged", () => {
  const g = resolveRelationshipControlGroup(false, { ...OFF, contactCanonicalRead: true });
  assert.equal(g.state, "ALL_OFF");
  assert.equal(g.mobile.contactCanonicalRead, true);
});

test("effective mobile flags of a refused state give no enabled phone capability", () => {
  const g = resolveRelationshipControlGroup(true, with_(["propertyLinkContact"]));
  const caps = linkingCapabilities(["grow.relationships.manage", "grow.properties.link"], g.mobile);
  assert.deepEqual(Object.entries(caps).filter(([, c]) => c.enabled).map(([k]) => k), []);
});
