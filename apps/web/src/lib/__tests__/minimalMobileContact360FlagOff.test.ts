import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LINKING_OFF, MobileContactView, type MobileContactViewProps } from "../../minimal/mobile/MobileContactView";
import { buildMobileContactLayout } from "../../minimal/mobile/mobileContactLayout";
import { ALSO_LISTED_LABEL, GROW_INTEREST_TITLE } from "../../minimal/mobile/mobileGrowInterest";
import { linkingCapabilities, NOT_AVAILABLE_YET } from "../../minimal/mobile/mobileLinking";
import { MOBILE_LINKING } from "../../minimal/mobile/mobileLinkingConfig";
import type { GrowContact360 } from "../growContact360";
import { all, hrefs, text } from "./mobileTreeHelpers";

// AE 2.0, mobile Contact 360 with contactCanonicalRead OFF (as shipped): the existing Grow-only screen, unchanged in layout, and NOTHING that suggests a
// canonical property relationship exists or can be changed: no canonical heading count, no "Grow interest & history" split, no "Also listed under
// Properties", no relationship actions, no explanation of unavailable features. The flag is never bypassed.
const grow = JSON.parse(readFileSync(new URL("./fixtures/real-api/e47-grow-contact-over100.json", import.meta.url), "utf8")) as GrowContact360;
const NOW = new Date("2026-11-04T09:00:00Z");
const layout = buildMobileContactLayout(grow, { now: NOW, canLog: true }); // no canonicalLinks: the read is OFF
const tree = MobileContactView({ linking: LINKING_OFF, sectionsSlot: null, backHref: "/grow?tab=contacts", layout, historyExpanded: false, onToggleHistory: () => {}, form: null, formError: null, submitting: false, notice: null, pendingCommitmentId: null, onOpenForm: () => {}, onCloseForm: () => {}, onField: () => {}, onSubmit: () => {}, onComplete: () => {} } as unknown as MobileContactViewProps);
const props = all(tree, (e) => e.type === "section" && e.props?.["aria-label"] === "Properties")[0];

test("the flag is OFF in the shipped configuration, and the container asks for canonical links only when it is on", () => {
  assert.equal(MOBILE_LINKING.contactCanonicalRead, false);
  assert.deepEqual(Object.values(MOBILE_LINKING).filter(Boolean), [], "all nine flags are OFF");
  const src = readFileSync(new URL("../../minimal/mobile/MobileContact.tsx", import.meta.url), "utf8");
  assert.match(src, /enabled: partyId !== null && canonicalOn,|enabled: partyId !== null && MOBILE_LINKING\.contactCanonicalRead/, "the by-contact request is gated by the flag");
  assert.match(src, /const canonicalResult = canonicalOn && canonical\.isSuccess/, "no canonical result is used while the flag is off");
});

test("flag OFF: the Grow-only state is shown as before, read-only, in the same place", () => {
  assert.equal(layout.propertiesState, "legacy");
  assert.ok(props, "the Properties section is still there (the approved layout)");
  assert.deepEqual(hrefs(props), grow.properties.filter((r) => r.status === "Active" && r.propertyId !== null).map((r) => `/grow/properties/${r.propertyId}`), "the Grow rows, one tap each");
});

test("flag OFF: nothing implies a canonical property relationship", () => {
  const whole = text(tree);
  assert.equal(whole.includes(GROW_INTEREST_TITLE), false, "no 'Grow interest & history' split: that exists only with canonical links");
  assert.equal(whole.includes(ALSO_LISTED_LABEL), false);
  assert.equal(layout.interest.length, 0);
  assert.equal(layout.propertiesCount, null, "no canonical count");
  assert.equal(layout.propertiesNotice, null);
  assert.equal(whole.includes("Open full record") && /Showing \d+ of/.test(whole), false);
  for (const word of ["Edit role", "Unlink", "Make primary", "Link a property"]) assert.equal(whole.includes(word), false, `${word} is not drawn`);
  assert.equal(whole.includes(NOT_AVAILABLE_YET), false, "no 'not available' explanation either");
});

test("flag OFF: even a user with every permission sees no relationship control, because the flags are what make them available", () => {
  const ALL = ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.activities.manage", "grow.relationships.manage", "grow.properties.link", "grow.ai.use", "run.access"];
  const caps = linkingCapabilities(ALL, MOBILE_LINKING, "Agent");
  assert.deepEqual(Object.entries(caps).filter(([, c]) => c.enabled).map(([k]) => k), [], "nothing is enabled while the flags are OFF");
});
