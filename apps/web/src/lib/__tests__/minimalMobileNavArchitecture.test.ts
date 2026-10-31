import { test } from "node:test";
import assert from "node:assert/strict";
import { mobilePermissions } from "../../minimal/mobile/mobilePermissions";
import {
  MOBILE_MORE_GROUP_MAX_ITEMS,
  RUN_UPGRADE_HREF,
  buildMobileNav,
  type MobileNav,
  type MobileNavInput,
} from "../../minimal/mobile/mobileNavModel";
import { buildSearchResults, mobileSearchOptions, planSearch, propertyResultHref } from "../../minimal/mobile/mobileSearchModel";

// Owner t217u (31 Oct 2026): Grow is the entry point and always visible; Run is an optional
// upgrade gated by the run.access subscription entitlement AND a brokerage role permission;
// Run subscribers keep all of Grow; Grow-only users see one "Upgrade to Run" entry.
// UI model only: the server still enforces entitlements, roles and brokerage isolation.

const off = { marketActivityAvailable: false, momentumAvailable: false };
const on = { marketActivityAvailable: true, momentumAvailable: true };
const RUN_PATHS = ["/", "/today", "/exceptions", "/financial", "/pit-crew", "/properties/start"];
const PRIMARY = ["/grow", "/grow?tab=contacts", "/properties"];
const ROLES = ["Agent", "Brokerage Administrator", "Pit Crew"] as const;

function nav(input: Partial<MobileNavInput> & Pick<MobileNavInput, "entitlements">): MobileNav {
  return buildMobileNav({ role: "Agent", ...off, ...input });
}
const tabKeys = (n: MobileNav) => n.tabs.map((t) => t.key);
const hrefs = (n: MobileNav) => n.more.map((m) => m.href);
const groupKeys = (n: MobileNav) => n.moreGroups.map((g) => g.key);
const groupLabels = (n: MobileNav, key: string) => n.moreGroups.find((g) => g.key === key)?.items.map((i) => i.label) ?? null;

test("t217u-1 empty entitlements: Grow tabs visible, no Run, Upgrade to Run shown", () => {
  for (const role of ROLES) {
    const n = nav({ role, entitlements: [] });
    assert.deepEqual(tabKeys(n), ["today", "people", "properties", "search"], role);
    for (const p of RUN_PATHS) assert.equal(hrefs(n).includes(p), false, `${role} ${p}`);
    assert.deepEqual(groupKeys(n), ["grow", "account"], role);
    assert.deepEqual(groupLabels(n, "grow"), ["Opportunities", "Appraisals", "Communications"], role);
    assert.deepEqual(groupLabels(n, "account"), ["Settings", "Upgrade to Run"], role);
    assert.equal(n.upgrade?.href, RUN_UPGRADE_HREF, role);
    assert.equal(n.more.filter((m) => m.label === "Upgrade to Run").length, 1, `${role}: exactly one upgrade entry`);
  }
});

test("t217u-2 Grow-only subscriber: all Grow features discoverable (flags respected), no Run, upgrade shown", () => {
  const n = nav({ entitlements: ["grow.access", "grow.contacts.read"], ...on });
  assert.deepEqual(tabKeys(n), ["today", "people", "properties", "search"]);
  assert.deepEqual(groupLabels(n, "grow"), ["Opportunities", "Appraisals", "Market Activity", "My Momentum", "Communications"]);
  assert.equal(groupLabels(n, "run"), null);
  assert.ok(n.upgrade);
  const flagsOff = nav({ entitlements: ["grow.access"], ...off });
  assert.deepEqual(groupLabels(flagsOff, "grow"), ["Opportunities", "Appraisals", "Communications"]);
});

test("t217u-3 Run subscriber WITH a role permission: Run group by role, Grow kept, no upgrade", () => {
  const agent = nav({ role: "Agent", entitlements: ["run.access"] });
  assert.deepEqual(tabKeys(agent), ["today", "people", "properties", "search"]);
  assert.deepEqual(groupLabels(agent, "run"), ["Run home", "Run today", "Exceptions"]);
  assert.deepEqual(groupLabels(agent, "grow"), ["Opportunities", "Appraisals", "Communications"]);
  assert.equal(agent.upgrade, null);
  const pitCrew = nav({ role: "Pit Crew", entitlements: ["run.access", "grow.access"] });
  assert.deepEqual(groupLabels(pitCrew, "run"), ["Run home", "Run today", "Exceptions", "Pit Crew"]);
});

test("t217u-4 Run subscriber WITHOUT a role permission: no Run items, and no upgrade (already subscribed)", () => {
  for (const role of [undefined, "Platform Owner", "Unknown role"]) {
    const n = nav({ role, entitlements: ["run.access", "grow.access"] });
    assert.deepEqual(tabKeys(n), ["today", "people", "properties", "search"], String(role));
    for (const p of RUN_PATHS) assert.equal(hrefs(n).includes(p), false, `${role} ${p}`);
    assert.equal(n.upgrade, null, String(role));
    assert.equal(mobilePermissions(["run.access"], role).run, false, String(role));
  }
});

test("t217u-5 Brokerage Administrator with Grow and Run: grouped More, Financial and Pit Crew present", () => {
  const n = nav({ role: "Brokerage Administrator", entitlements: ["grow.access", "grow.contacts.read", "run.access"], ...on });
  assert.deepEqual(groupKeys(n), ["grow", "run", "account"]);
  assert.deepEqual(groupLabels(n, "run"), ["Run home", "Run today", "Exceptions", "Financial", "Pit Crew"]);
  assert.deepEqual(groupLabels(n, "account"), ["Settings"]);
  assert.equal(n.upgrade, null);
});

test("t217u-6 loading, missing list and owner without a brokerage: no tabs, no More, no upgrade", () => {
  const empty = { tabs: [], more: [], moreGroups: [], upgrade: null };
  assert.deepEqual(nav({ entitlements: ["run.access"], entitlementsLoading: true }), empty);
  assert.deepEqual(nav({ entitlements: null }), empty);
  assert.deepEqual(nav({ entitlements: undefined }), empty);
  assert.deepEqual(nav({ entitlements: ["run.access"], ownerWithoutContext: true }), empty);
});

test("t217u-7 More is grouped, short, and never duplicates a primary tab", () => {
  const sets = [[], ["grow.access"], ["grow.access", "grow.contacts.read"], ["run.access"], ["grow.access", "grow.contacts.read", "run.access"], ["grow.ai.use"]];
  for (const role of [...ROLES, undefined]) {
    for (const entitlements of sets) {
      for (const f of [off, on]) {
        const n = nav({ role, entitlements, ...f });
        const label = `${role} ${entitlements.join(",")}`;
        assert.deepEqual(n.more, n.moreGroups.flatMap((g) => g.items), `${label}: flat More = groups in order`);
        for (const g of n.moreGroups) {
          assert.ok(g.items.length > 0, `${label}: no empty group ${g.key}`);
          assert.ok(g.items.length <= MOBILE_MORE_GROUP_MAX_ITEMS, `${label}: ${g.key} within cap`);
        }
        assert.ok(n.moreGroups.length <= 3, `${label}: at most three groups`);
        assert.ok(n.more.length <= 3 * MOBILE_MORE_GROUP_MAX_ITEMS, `${label}: More bounded`);
        assert.equal(new Set(hrefs(n)).size, n.more.length, `${label}: unique`);
        for (const p of [...PRIMARY, "/properties/start"]) assert.equal(hrefs(n).includes(p), false, `${label}: ${p}`);
        assert.deepEqual(n.moreGroups.map((g) => g.key), ["grow", "run", "account"].filter((k) => n.moreGroups.some((g) => g.key === k)), `${label}: group order`);
      }
    }
  }
  assert.equal(MOBILE_MORE_GROUP_MAX_ITEMS, 5);
});

test("t217u-8 search gating: permissions come from the shared helper; contacts need grow.contacts.read", () => {
  const growOnly = mobileSearchOptions(mobilePermissions(["grow.access"], "Agent"));
  assert.equal(planSearch("smith", growOnly).contacts, null, "no grow.contacts.read: no contacts request");
  assert.ok(planSearch("smith", growOnly).properties, "Properties search is Grow: always allowed when signed in");
  const reader = mobileSearchOptions(mobilePermissions(["grow.contacts.read"], "Agent"));
  assert.ok(planSearch("smith", reader).contacts);
  const signedOut = mobileSearchOptions(mobilePermissions(null, "Agent"));
  const plan = planSearch("smith", signedOut);
  assert.equal(plan.contacts, null);
  assert.equal(plan.properties, null);
});

test("t217u-9 search can never surface Run data without Run access", () => {
  const row = { id: 7, formattedAddress: "7 Given Terrace", suburb: "Paddington", state: "QLD", postcode: "4064", workflowStage: "Live", listingStatus: "Listed" };
  const grow = planSearch("given", mobileSearchOptions(mobilePermissions(["grow.access"], "Agent")));
  assert.equal(grow.runData, false);
  const out = buildSearchResults({ plan: grow, properties: { status: "ok", data: { properties: [row] } } });
  const item = out.properties!.items[0];
  assert.deepEqual(Object.keys(item).sort(), ["address", "href", "id", "location"]);
  assert.equal(item.href, "/grow/properties/7");
  assert.equal(JSON.stringify(out).includes("Live"), false);
  assert.equal(JSON.stringify(out).includes("Listed"), false);
  const noRole = planSearch("given", mobileSearchOptions(mobilePermissions(["run.access"], undefined)));
  assert.equal(noRole.runData, false, "run.access without a role permission is not Run access");
  const run = planSearch("given", mobileSearchOptions(mobilePermissions(["run.access"], "Agent")));
  assert.equal(run.runData, true);
  const runItem = buildSearchResults({ plan: run, properties: { status: "ok", data: { properties: [row] } } }).properties!.items[0];
  assert.equal(runItem.stage, "Live");
  assert.equal(runItem.listingStatus, "Listed");
  assert.equal(runItem.href, "/grow/properties/7", "Grow property detail for everyone; it offers Open in Run itself");
  assert.equal(propertyResultHref(7), "/grow/properties/7");
});
