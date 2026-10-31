import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildMobileNav, RUN_UPGRADE_HREF } from "../../minimal/mobile/mobileNavModel";
import { mobilePermissions } from "../../minimal/mobile/mobilePermissions";
import { selectGrowView } from "../../minimal/minimalGrowNav";
import { growTabLabel } from "../growWorkspace";

// Owner t222u (31 Oct 2026): People opens contacts (not Today); the AI "Performance" entry is
// "Business Coach" and opens the real coach screen; My Momentum stays separate; "Add Run" only
// for Grow subscribers (not unsubscribed, not Run) and never the mock checkout.

const GROW = ["grow.access", "grow.contacts.read", "grow.ai.use"];
const appSrc = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");

test("t222u: People tab and desktop Relationships (/grow?tab=contacts) select the Minimal contacts screen", () => {
  assert.equal(selectGrowView(true, "?tab=contacts"), "minimal-contacts");
  assert.equal(selectGrowView(true, ""), "minimal-today");
  assert.equal(selectGrowView(true, "?tab=performance"), "classic");
  const nav = buildMobileNav({ role: "Agent", entitlements: GROW });
  assert.equal(nav.tabs.find((t) => t.key === "people")?.href, "/grow?tab=contacts");
});

test("t222u: the /grow route in App.tsx mounts MinimalContacts via selectGrowView (not always MinimalToday)", () => {
  const route = appSrc.match(/<Route path="\/grow">[\s\S]*?<\/Route>/)?.[0] ?? "";
  assert.ok(route.includes("selectGrowView"), route);
  assert.ok(route.includes("<MinimalContacts />"), route);
  assert.ok(route.includes("<MinimalToday />"), route);
  assert.ok(route.includes("<Grow />"), route);
  assert.match(appSrc, /const MinimalContacts = lazy\(\(\) => import\("\.\/minimal\/MinimalContacts"\)\)/);
});

test("t222u: the AI Performance entry is renamed Business Coach and routes to the coach tab", () => {
  assert.equal(growTabLabel("performance"), "Business Coach");
  const nav = buildMobileNav({ role: "Agent", entitlements: GROW, momentumAvailable: true });
  const coach = nav.more.filter((m) => m.label === "Business Coach");
  assert.equal(coach.length, 1);
  assert.equal(coach[0]!.href, "/grow?tab=performance");
  assert.equal(nav.more.filter((m) => m.label === "My Momentum").length, 1, "My Momentum stays a separate entry");
  assert.ok(!nav.more.some((m) => m.label === "Performance"));
  // Without grow.ai.use the coach is not offered (UI only; the API enforces grow.ai.use).
  const noAi = buildMobileNav({ role: "Agent", entitlements: ["grow.access", "grow.contacts.read"] });
  assert.ok(!noAi.more.some((m) => m.label === "Business Coach"));
});

test("t222u: Add Run only for Grow subscribers; not unsubscribed, not Run; never the mock checkout", () => {
  assert.equal(mobilePermissions(["grow.access"], "Agent").upgradeToRun, true);
  assert.equal(mobilePermissions([], "Agent").upgradeToRun, false, "unsubscribed");
  assert.equal(mobilePermissions(["run.access", ...GROW], "Agent").upgradeToRun, false, "Run");
  assert.equal(mobilePermissions(["run.access"], "Agent").upgradeToRun, false, "Run (pre-backfill)");
  assert.equal(buildMobileNav({ role: "Agent", entitlements: [] }).upgrade, null);
  assert.ok(buildMobileNav({ role: "Agent", entitlements: GROW }).upgrade);
  assert.ok(!/checkout|mockCheckout|billing/i.test(RUN_UPGRADE_HREF), RUN_UPGRADE_HREF);
});
