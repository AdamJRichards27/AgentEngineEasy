import { test } from "node:test";
import assert from "node:assert/strict";
import { Link } from "wouter";
import { MobileBottomBar } from "../../minimal/mobile/MobileBottomBar";
import { MobileMoreView } from "../../minimal/mobile/MobileMoreView";
import { buildMobileNav, type MobileNav, type MobileNavInput } from "../../minimal/mobile/mobileNavModel";
import { all, byClass, hrefs, links, text, type El } from "./mobileTreeHelpers";

// AE Mobile (CC Task #64, M2): the bottom bar and the More screen, drawn from the corrected
// PR #280 navigation model (v2). Grow is always visible; Run is an optional upgrade.

const off = { marketActivityAvailable: false, momentumAvailable: false };
const nav = (input: Partial<MobileNavInput> & Pick<MobileNavInput, "entitlements">): MobileNav => buildMobileNav({ role: "Agent", ...off, ...input });
const GROW_ONLY = ["grow.access", "grow.contacts.read"];
const GROW_RUN = ["grow.access", "grow.contacts.read", "run.access"];
const RUN_ONLY = ["run.access"];

function bar(n: MobileNav, location: string, search = "") {
  return MobileBottomBar({ nav: n, location, search });
}
const currentLabels = (tree: unknown) => links(tree).filter((l) => l.props?.["aria-current"] === "page").map((l) => text(l));

test("the bar: Today, People, Properties, Search, then More, for every user", () => {
  for (const entitlements of [[], RUN_ONLY, GROW_ONLY, GROW_RUN]) {
    const tree = bar(nav({ entitlements }), "/grow");
    assert.deepEqual(links(tree).map((l) => text(l)), ["Today", "People", "Properties", "Search", "More"], entitlements.join(",") || "(empty)");
    assert.deepEqual(hrefs(tree), ["/grow", "/grow?tab=contacts", "/properties", "/search", "/more"]);
  }
});

test("the bar is one labelled navigation landmark", () => {
  const tree = bar(nav({ entitlements: GROW_RUN }), "/grow") as El;
  assert.equal(tree.type, "nav");
  assert.equal(tree.props?.["aria-label"], "Primary");
});

test("exactly one item is current, following the desktop sidebar's rules", () => {
  const n = nav({ role: "Brokerage Administrator", entitlements: GROW_RUN });
  const cases: Array<[string, string, string]> = [
    ["/grow", "", "Today"],
    ["/grow", "?tab=contacts", "People"],
    ["/grow/contacts/12", "", "People"],
    ["/properties", "", "Properties"],
    ["/properties/9", "", "Properties"],
    ["/grow/properties/5", "", "Properties"],
    ["/search", "?q=smith", "Search"],
    ["/more", "", "More"],
    ["/grow/opportunities/4", "", "More"],
    ["/settings", "", "More"],
  ];
  for (const [location, search, expected] of cases) {
    assert.deepEqual(currentLabels(bar(n, location, search)), [expected], `${location}${search}`);
  }
  assert.deepEqual(currentLabels(bar(n, "/properties/start")), [], "Start property is no tab; nothing is current");
});

test("nothing is drawn while there is no navigation (platform owner with no brokerage)", () => {
  assert.equal(bar(nav({ entitlements: GROW_RUN, ownerWithoutContext: true }), "/grow"), null);
});

test("while entitlements load, the real model fails closed: no tabs, so the bar draws nothing", () => {
  assert.equal(bar(nav({ entitlements: GROW_RUN, entitlementsLoading: true }), "/grow"), null);
});

test("More: Grow always, Run links only for Run subscribers by role, one Add Run row for Grow-only", () => {
  const admin = MobileMoreView({ nav: nav({ role: "Brokerage Administrator", entitlements: GROW_RUN }) });
  assert.match(text(admin), /Grow/);
  assert.deepEqual(hrefs(admin).filter((h) => ["/", "/today", "/exceptions", "/financial", "/pit-crew"].includes(h)), ["/", "/today", "/exceptions", "/financial", "/pit-crew"]);
  assert.doesNotMatch(text(admin), /Add Run/);

  const growOnly = MobileMoreView({ nav: nav({ entitlements: GROW_ONLY }) });
  assert.deepEqual(hrefs(growOnly).filter((h) => ["/", "/today", "/exceptions", "/financial", "/pit-crew"].includes(h)), [], "no Run link without Run");
  assert.match(text(growOnly), /Add Run/);
  assert.match(text(growOnly), /A Brokerage Administrator can add it\./);
  const growLinks = hrefs(growOnly);
  assert.equal(growLinks.some((h) => /run|billing|checkout|upgrade/i.test(h)), false, "Add Run is words only: no link, no checkout");

  const agent = MobileMoreView({ nav: nav({ role: "Agent", entitlements: GROW_RUN }) });
  assert.equal(hrefs(agent).includes("/financial"), false);
  assert.equal(hrefs(agent).includes("/pit-crew"), false);
});

test("More: Grow is listed even with no entitlements, and Run is not", () => {
  const empty = MobileMoreView({ nav: nav({ entitlements: [] }) });
  assert.match(text(empty), /Opportunities/);
  assert.match(text(empty), /Appraisals/);
  assert.doesNotMatch(text(empty), /Run home|Add Run/);
});

test("More: Marketing is a Coming soon placeholder, not a link; the groups are Grow, Run, Workspace", () => {
  const view = MobileMoreView({ nav: nav({ role: "Brokerage Administrator", entitlements: GROW_RUN }) });
  const marketing = all(view, (e) => typeof e.props?.className === "string" && /mob-row-static/.test(e.props.className as string) && /Marketing/.test(text(e)))[0];
  assert.ok(marketing, "Marketing row");
  assert.equal(marketing.type === Link, false);
  assert.match(text(marketing), /Coming soon/);
  assert.equal(links(view).some((l) => /Marketing/.test(text(l))), false);
  const groupTitles = byClass(view, "mob-more-group-title").map((e) => text(e));
  assert.deepEqual(groupTitles, ["Grow", "Run", "Workspace"]);
});

test("More: My Momentum appears once and only when its API answers; there is never a Performance item", () => {
  const withMomentum = nav({ entitlements: GROW_ONLY, marketActivityAvailable: true, momentumAvailable: true });
  const view = MobileMoreView({ nav: withMomentum });
  const labels = links(view).map((l) => text(l));
  assert.equal(labels.filter((l) => l === "My Momentum").length, 1);
  assert.deepEqual(hrefs(view).filter((h) => h === "/grow/momentum"), ["/grow/momentum"]);
  assert.doesNotMatch(text(view), /performance/i);
  assert.equal(links(MobileMoreView({ nav: nav({ entitlements: GROW_ONLY }) })).some((l) => text(l) === "My Momentum"), false);
  assert.doesNotMatch(text(bar(withMomentum, "/grow")), /performance/i);
});

test("More: Nurture and Ask AE are not listed until their destinations are verified", () => {
  const labels = links(MobileMoreView({ nav: nav({ entitlements: GROW_RUN }) })).map((l) => text(l));
  assert.equal(labels.includes("Nurture"), false);
  assert.equal(labels.includes("Ask AE"), false);
});

test("More: every model link is drawn, once", () => {
  const n = nav({ role: "Brokerage Administrator", entitlements: GROW_RUN, marketActivityAvailable: true, momentumAvailable: true });
  const view = MobileMoreView({ nav: n });
  assert.deepEqual(hrefs(view), n.more.filter((i) => i.key !== n.upgrade?.key).map((i) => i.href));
});

test("More draws nothing while the navigation has no groups", () => {
  assert.equal(MobileMoreView({ nav: nav({ entitlements: GROW_RUN, entitlementsLoading: true }) }), null);
});

test("the More screen has a heading, so the shell can announce it and move focus to it", () => {
  const view = MobileMoreView({ nav: nav({ entitlements: GROW_RUN }) });
  const headings = all(view, (e) => e.type === "h1");
  assert.equal(headings.length, 1);
  assert.equal(text(headings[0]), "More");
});
