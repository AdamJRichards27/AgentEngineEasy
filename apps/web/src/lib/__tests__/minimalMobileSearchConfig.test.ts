import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GROW_CONTACTS_MANAGE,
  MOBILE_MORE_ROUTE,
  MOBILE_SEARCH_ROUTE,
  PHONE_SEARCH_SUPPORTED,
  searchHintLine,
  searchPlaceholder,
} from "../../minimal/mobile/mobileSearchConfig";
import { MOBILE_COMING_SOON, MOBILE_TODAY_SEARCH_LABEL, roleLabel } from "../../minimal/mobile/mobileLabels";
import { PHONE_MAX_WIDTH_PX, PHONE_MEDIA_QUERY } from "../../minimal/mobile/useIsPhone";
import { GROW_CONTACT_ROLES } from "../growContactList";

// AE Mobile (CC Task #64, M2): fixed settings, labels and the phone breakpoint.

test("phone-number search stays OFF until the backend supports it and this test is changed with it", () => {
  assert.equal(PHONE_SEARCH_SUPPORTED, false);
  assert.doesNotMatch(searchPlaceholder(false), /mobile/i);
  assert.doesNotMatch(searchHintLine(false), /mobile/i);
  assert.match(searchPlaceholder(true), /mobile/i);
  assert.match(searchHintLine(true), /mobile number/i);
});

test("drift: grow.contacts.manage exists in the server catalogue, and is defined once", () => {
  const catalogue = readFileSync(new URL("../../../../../packages/db/src/schema/billing.ts", import.meta.url), "utf8");
  const block = /export const ENTITLEMENT_KEYS = \[([\s\S]*?)\] as const/.exec(catalogue);
  assert.ok(block, "ENTITLEMENT_KEYS block found");
  const keys = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.includes(GROW_CONTACTS_MANAGE), "grow.contacts.manage is in the catalogue");
  assert.equal(GROW_CONTACTS_MANAGE, "grow.contacts.manage");
  for (const file of ["SearchPage.tsx", "SearchPageView.tsx", "useMobileSearch.ts", "mobileSearchScreen.ts", "MobileBottomBar.tsx", "MobileMoreView.tsx"]) {
    const source = readFileSync(new URL(`../../minimal/mobile/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""), /["']grow\.contacts\.manage["']/, `${file} does not copy the key`);
  }
});

test("routes", () => {
  assert.equal(MOBILE_SEARCH_ROUTE, "/search");
  assert.equal(MOBILE_MORE_ROUTE, "/more");
});

test("the phone breakpoint is the shell's own 760 px, in both directions", () => {
  assert.equal(PHONE_MAX_WIDTH_PX, 760);
  assert.equal(PHONE_MEDIA_QUERY, "(max-width: 760px)");
  const shell = readFileSync(new URL("../../minimal/minimal.css", import.meta.url), "utf8");
  assert.match(shell, /@media \(max-width: 760px\)/, "minimal.css switches the mobile bar at 760 px");
  const mobile = readFileSync(new URL("../../minimal/mobile/mobile.css", import.meta.url), "utf8");
  assert.match(mobile, /@media \(min-width: 761px\)/, "mobile.css hides the bar and search field above it");
});

test("roleLabel makes every stored role read as plain words, without changing the stored value", () => {
  const expected: Record<string, string> = {
    Prospect: "Prospect",
    PastClient: "Past client",
    CurrentClient: "Current client",
    Seller: "Seller",
    Buyer: "Buyer",
    Landlord: "Landlord",
    Tenant: "Tenant",
    Investor: "Investor",
    PropertyOwner: "Property owner",
    AppraisalProspect: "Appraisal prospect",
    ReferralSource: "Referral source",
    ProfessionalPartner: "Professional partner",
    Other: "Other",
  };
  assert.deepEqual([...GROW_CONTACT_ROLES].sort(), Object.keys(expected).sort(), "every stored role has a label");
  for (const role of GROW_CONTACT_ROLES) assert.equal(roleLabel(role), expected[role], role);
  assert.equal(roleLabel(""), "");
  assert.equal(roleLabel("Past client"), "Past client", "already plain");
});

test("labels", () => {
  assert.equal(MOBILE_COMING_SOON, "Coming soon");
  assert.equal(MOBILE_TODAY_SEARCH_LABEL, "Search people or properties");
});
