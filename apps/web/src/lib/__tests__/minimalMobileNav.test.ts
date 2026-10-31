import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOBILE_MORE_LABEL,
  MOBILE_PEOPLE_LABEL,
  buildMobileNav,
  mobileMoreIsCurrent,
  mobileTabIsCurrent,
  type MobileNav,
  type MobileNavInput,
} from "../../minimal/mobile/mobileNavModel";
import { buildMinimalSidebar, minimalSidebarLinks } from "../../minimal/minimalNav";

// AE Mobile (CC Task #64, M1): four primary tabs, secondary functions under More.

const GROW_ONLY = ["grow.access", "grow.contacts.read"];
const RUN_ONLY = ["run.access"];
const GROW_RUN = ["grow.access", "grow.contacts.read", "run.access"];
const off = { marketActivityAvailable: false, momentumAvailable: false };
const on = { marketActivityAvailable: true, momentumAvailable: true };

function nav(input: Partial<MobileNavInput> & Pick<MobileNavInput, "entitlements">): MobileNav {
  return buildMobileNav({ role: "Agent", ...off, ...input });
}
const tabKeys = (n: MobileNav) => n.tabs.map((t) => t.key);
const moreLabels = (n: MobileNav) => n.more.map((m) => m.label);

test("1. Brokerage Administrator with Grow and Run: four tabs in fixed order, full More", () => {
  const n = nav({ role: "Brokerage Administrator", entitlements: GROW_RUN });
  assert.deepEqual(tabKeys(n), ["today", "people", "properties", "search"]);
  assert.deepEqual(n.tabs.map((t) => t.label), ["Today", "People", "Properties", "Search"]);
  assert.deepEqual(n.tabs.map((t) => t.href), ["/grow", "/grow?tab=contacts", "/properties", null]);
  assert.deepEqual(n.tabs.map((t) => t.action), [null, null, null, "open-search"]);
  // t217u: grouped Grow, Run, Account (Communications is a Grow feature).
  assert.deepEqual(moreLabels(n), [
    "Opportunities",
    "Appraisals",
    "Communications",
    "Run home",
    "Run today",
    "Exceptions",
    "Financial",
    "Pit Crew",
    "Settings",
  ]);
});

test("2. Grow-only agent: four tabs, no Run links in More", () => {
  const n = nav({ entitlements: GROW_ONLY, ...on });
  assert.deepEqual(tabKeys(n), ["today", "people", "properties", "search"]);
  assert.deepEqual(moreLabels(n), ["Opportunities", "Appraisals", "Market Activity", "My Momentum", "Communications", "Settings", "Upgrade to Run"]); // t217u
  const hrefs = n.more.map((m) => m.href);
  for (const runOnly of ["/", "/today", "/exceptions", "/financial", "/pit-crew", "/properties/start"]) {
    assert.equal(hrefs.includes(runOnly), false, runOnly);
  }
});

test("3. Run subscriber without grow.access: keeps all four tabs and Grow (t217u)", () => {
  const n = nav({ entitlements: RUN_ONLY });
  assert.deepEqual(tabKeys(n), ["today", "people", "properties", "search"]);
  assert.deepEqual(moreLabels(n), ["Opportunities", "Appraisals", "Communications", "Run home", "Run today", "Exceptions", "Settings"]);
});

test("4. grow.access without grow.contacts.read: People tab still shown (t217u); the page enforces the action", () => {
  const n = nav({ entitlements: ["grow.access"] });
  assert.deepEqual(tabKeys(n), ["today", "people", "properties", "search"]);
});

test("5. fails closed: loading, null, undefined, and owner without brokerage return nothing", () => {
  const empty = { tabs: [], more: [], moreGroups: [], upgrade: null };
  assert.deepEqual(nav({ entitlements: GROW_RUN, entitlementsLoading: true }), empty);
  assert.deepEqual(nav({ entitlements: null }), empty);
  assert.deepEqual(nav({ entitlements: undefined }), empty);
  assert.deepEqual(nav({ entitlements: GROW_RUN, ownerWithoutContext: true }), empty);
});

test("5b. loaded but empty entitlement list: Grow tabs, Grow More, upgrade offered (t217u)", () => {
  const n = nav({ entitlements: [] });
  assert.deepEqual(tabKeys(n), ["today", "people", "properties", "search"]);
  assert.deepEqual(moreLabels(n), ["Opportunities", "Appraisals", "Communications", "Settings", "Upgrade to Run"]);
});

test("6. invariants across roles, entitlement sets and flags", () => {
  const roles = ["Agent", "Brokerage Administrator", "Pit Crew", undefined];
  const sets: string[][] = [[], RUN_ONLY, GROW_ONLY, GROW_RUN, ["grow.access"], ["grow.contacts.read"], ["grow.ai.use"]];
  const flags = [off, on, { marketActivityAvailable: true, momentumAvailable: false }];
  const primary = new Set(["/grow", "/grow?tab=contacts", "/properties"]);
  for (const role of roles) {
    for (const entitlements of sets) {
      for (const f of flags) {
        const n = buildMobileNav({ role, entitlements, ...f });
        const label = `${role} ${entitlements.join(",")}`;
        assert.ok(n.tabs.length <= 4, `${label}: at most four tabs`);
        assert.equal(new Set(n.tabs.map((t) => t.key)).size, n.tabs.length, `${label}: unique tab keys`);
        assert.equal(new Set(n.more.map((m) => m.href)).size, n.more.length, `${label}: unique More links`);
        for (const item of n.more) {
          assert.equal(primary.has(item.href), false, `${label}: ${item.href} not in both lists`);
          assert.notEqual(item.href, "/properties/start", `${label}: Start property stays out`);
        }
        const keys = n.tabs.map((t) => t.key);
        assert.deepEqual(keys, ["today", "people", "properties", "search"].filter((k) => keys.includes(k as never)), `${label}: fixed order`);
      }
    }
  }
});

test("7. wording: mobile says People; the desktop sidebar still says Relationships", () => {
  assert.equal(MOBILE_PEOPLE_LABEL, "People");
  assert.equal(MOBILE_MORE_LABEL, "More");
  const n = nav({ role: "Brokerage Administrator", entitlements: GROW_RUN });
  assert.equal(n.tabs.find((t) => t.key === "people")?.label, "People");
  const everyMobileLabel = [...n.tabs.map((t) => t.label), ...n.more.map((m) => m.label)];
  assert.equal(everyMobileLabel.includes("Relationships"), false);
  const desktop = minimalSidebarLinks(buildMinimalSidebar({ role: "Agent", entitlements: GROW_ONLY, ...off })).map((l) => l.label);
  assert.equal(desktop.includes("Relationships"), true);
  assert.equal(desktop.includes("People"), false);
});

test("8. current-tab matching follows the desktop sidebar rules", () => {
  const n = nav({ role: "Brokerage Administrator", entitlements: GROW_RUN });
  const tab = (key: string) => n.tabs.find((t) => t.key === key)!;
  assert.equal(mobileTabIsCurrent(tab("today"), "/grow", ""), true);
  assert.equal(mobileTabIsCurrent(tab("today"), "/grow", "?tab=contacts"), false);
  assert.equal(mobileTabIsCurrent(tab("people"), "/grow", "?tab=contacts"), true);
  assert.equal(mobileTabIsCurrent(tab("people"), "/grow/contacts/12", ""), true);
  assert.equal(mobileTabIsCurrent(tab("today"), "/grow/contacts/12", ""), false);
  assert.equal(mobileTabIsCurrent(tab("properties"), "/grow/properties/5", ""), true);
  assert.equal(mobileTabIsCurrent(tab("properties"), "/properties/9", ""), true);
  assert.equal(mobileTabIsCurrent(tab("properties"), "/properties/start", ""), false);
  assert.equal(mobileTabIsCurrent(tab("search"), "/grow", ""), false);
  assert.equal(mobileTabIsCurrent(tab("search"), "/properties", ""), false);
});

test("9. Market Activity and My Momentum appear in More only when their flags are true", () => {
  const withFlags = nav({ entitlements: GROW_ONLY, marketActivityAvailable: true, momentumAvailable: false });
  assert.equal(moreLabels(withFlags).includes("Market Activity"), true);
  assert.equal(moreLabels(withFlags).includes("My Momentum"), false);
  const none = nav({ entitlements: GROW_ONLY, ...off });
  assert.equal(moreLabels(none).includes("Market Activity"), false);
  assert.equal(moreLabels(none).includes("My Momentum"), false);
});

test("More button shows as current on a More page, not on a primary page", () => {
  const n = nav({ role: "Brokerage Administrator", entitlements: GROW_RUN });
  assert.equal(mobileMoreIsCurrent(n.more, "/grow/opportunities/4", ""), true);
  assert.equal(mobileMoreIsCurrent(n.more, "/settings", ""), true);
  assert.equal(mobileMoreIsCurrent(n.more, "/grow", ""), false);
  assert.equal(mobileMoreIsCurrent(n.more, "/grow/properties/9", ""), false);
});

test("does not mutate a frozen entitlement list", () => {
  const frozen = Object.freeze([...GROW_RUN]);
  assert.doesNotThrow(() => buildMobileNav({ role: "Agent", entitlements: frozen, ...off }));
  assert.deepEqual([...frozen], GROW_RUN);
});

test("existing desktop sidebar output is unchanged (guards accidental edits)", () => {
  const groups = buildMinimalSidebar({ role: "Brokerage Administrator", entitlements: GROW_RUN, ...off });
  assert.deepEqual(groups.map((g) => g.label), ["Grow", "Operations", "Workspace"]);
  assert.deepEqual(
    minimalSidebarLinks(groups).map((l) => l.label),
    ["Today", "Relationships", "Opportunities", "Appraisals", "Properties", "Run home", "Run today", "Exceptions", "Financial", "Start property", "Pit Crew", "Communications", "Settings"],
  );
});
