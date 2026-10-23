import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MINIMAL_MARKETING_SOON,
  buildClassicNavLinks,
  buildMinimalNavLinks,
  buildMinimalSidebar,
  minimalSidebarIsCurrent,
  minimalSidebarLinks,
  type MinimalSidebarGroup,
  type MinimalSidebarItem,
} from "../../minimal/minimalNav";
import { buildProductNavLinks } from "../productNav";
import { minimalBreadcrumb } from "../minimalUx";

// AE Minimal v1.0 V1 (Owner t457u): grouped sidebar and labels.

const GROW_ONLY = ["grow.access"];
const GROW_RUN = ["grow.access", "run.access"];
const off = { marketActivityAvailable: false, momentumAvailable: false };
const on = { marketActivityAvailable: true, momentumAvailable: true };

function labels(items: readonly MinimalSidebarItem[]): string[] {
  return items.map((i) => (i.kind === "soon" ? `${i.label} (Soon)` : i.label));
}
function group(groups: MinimalSidebarGroup[], key: string): MinimalSidebarItem[] {
  return groups.find((g) => g.key === key)?.items ?? [];
}

test("three labelled groups in order", () => {
  const groups = buildMinimalSidebar({ role: "Brokerage Administrator", entitlements: GROW_RUN, ...off });
  assert.deepEqual(groups.map((g) => g.label), ["Grow", "Operations", "Workspace"]);
});

test("Grow group with run.access, flags off", () => {
  const g = group(buildMinimalSidebar({ role: "Brokerage Administrator", entitlements: GROW_RUN, ...off }), "grow");
  assert.deepEqual(labels(g), ["Today", "Relationships", "Opportunities", "Appraisals", "Properties", "Marketing (Soon)"]);
  const hrefs = g.filter((i) => i.kind === "link").map((i) => (i.kind === "link" ? i.href : ""));
  assert.deepEqual(hrefs, ["/grow", "/grow?tab=contacts", "/grow/opportunities", "/grow/appraisals", "/properties"]);
});

test("Market Activity and My Momentum only when their queries succeed", () => {
  const g = group(buildMinimalSidebar({ role: "Agent", entitlements: GROW_ONLY, ...on }), "grow");
  assert.deepEqual(labels(g), ["Today", "Relationships", "Opportunities", "Appraisals", "Market Activity", "My Momentum", "Marketing (Soon)"]);
  const onlyMarket = group(buildMinimalSidebar({ role: "Agent", entitlements: GROW_ONLY, marketActivityAvailable: true, momentumAvailable: false }), "grow");
  assert.equal(labels(onlyMarket).includes("My Momentum"), false);
  assert.equal(labels(onlyMarket).includes("Market Activity"), true);
});

test("Marketing sub-items are non-link Soon placeholders", () => {
  const g = group(buildMinimalSidebar({ role: "Agent", entitlements: GROW_ONLY, ...off }), "grow");
  const marketing = g.find((i) => i.label === "Marketing");
  assert.ok(marketing && marketing.kind === "soon");
  assert.deepEqual(marketing.children?.map((c) => [c.kind, c.label]), MINIMAL_MARKETING_SOON.map((l) => ["soon", l]));
});

test("Operations with run.access follows role rules", () => {
  const admin = group(buildMinimalSidebar({ role: "Brokerage Administrator", entitlements: GROW_RUN, ...off }), "operations");
  assert.deepEqual(labels(admin), ["Run home", "Run today", "Exceptions", "Financial", "Start property", "Pit Crew"]);
  const agent = group(buildMinimalSidebar({ role: "Agent", entitlements: GROW_RUN, ...off }), "operations");
  assert.deepEqual(labels(agent), ["Run home", "Run today", "Exceptions", "Start property"]);
  const crew = group(buildMinimalSidebar({ role: "Pit Crew", entitlements: GROW_RUN, ...off }), "operations");
  assert.equal(labels(crew).includes("Pit Crew"), true);
  assert.equal(labels(crew).includes("Financial"), false);
});

test("without run.access: Run and Pit Crew are non-clickable Soon, no Run links anywhere", () => {
  for (const role of ["Agent", "Brokerage Administrator", "Pit Crew"]) {
    const groups = buildMinimalSidebar({ role, entitlements: GROW_ONLY, ...on });
    assert.deepEqual(labels(group(groups, "operations")), ["Run (Soon)", "Pit Crew (Soon)"]);
    const paths = minimalSidebarLinks(groups).map((l) => l.path);
    for (const p of ["/", "/today", "/properties", "/properties/start", "/exceptions", "/financial", "/pit-crew"]) {
      assert.equal(paths.includes(p), false, `${role} ${p}`);
    }
  }
  assert.deepEqual(buildMinimalSidebar({ role: "Agent", entitlements: [], ...off }).length, 3);
});

test("Workspace group is Communications then Settings", () => {
  const w = group(buildMinimalSidebar({ role: "Agent", entitlements: GROW_ONLY, ...off }), "workspace");
  assert.deepEqual(labels(w), ["Communications", "Settings"]);
});

test("active matcher: Today only on /grow, properties detail highlights Opportunities", () => {
  assert.equal(minimalSidebarIsCurrent("/grow", "", "/grow"), true);
  assert.equal(minimalSidebarIsCurrent("/grow", "?tab=contacts", "/grow"), false);
  assert.equal(minimalSidebarIsCurrent("/grow", "?tab=contacts", "/grow?tab=contacts"), true);
  assert.equal(minimalSidebarIsCurrent("/grow/contacts/7", "", "/grow?tab=contacts"), true);
  assert.equal(minimalSidebarIsCurrent("/grow/opportunities", "", "/grow"), false);
  assert.equal(minimalSidebarIsCurrent("/grow/opportunities/4", "", "/grow/opportunities"), true);
  assert.equal(minimalSidebarIsCurrent("/grow/properties/9", "", "/grow/opportunities"), true);
  assert.equal(minimalSidebarIsCurrent("/grow/properties/9", "", "/grow"), false);
  assert.equal(minimalSidebarIsCurrent("/grow/appraisals/3/build", "", "/grow/appraisals"), true);
  assert.equal(minimalSidebarIsCurrent("/grow/momentum", "", "/grow/momentum"), true);
  assert.equal(minimalSidebarIsCurrent("/", "", "/today"), false);
  assert.equal(minimalSidebarIsCurrent("/properties/start", "", "/properties"), false);
});

test("breadcrumb reads Grow / Today on /grow", () => {
  const links = minimalSidebarLinks(buildMinimalSidebar({ role: "Agent", entitlements: GROW_RUN, ...off }));
  assert.deepEqual(minimalBreadcrumb("/grow", links), { section: "Grow", page: "Today" });
  assert.deepEqual(minimalBreadcrumb("/today", links), { section: "Agent Engine", page: "Run today" });
});

test("legacy builders and classic nav unchanged", () => {
  const ctx = { role: "Brokerage Administrator", entitlements: GROW_RUN };
  assert.deepEqual(buildClassicNavLinks(ctx), buildProductNavLinks(ctx));
  assert.deepEqual(buildMinimalNavLinks(ctx).map((l) => l.path), [...buildProductNavLinks(ctx).map((l) => l.path), "/properties/start"]);
});

test("shell renders one Primary nav from buildMinimalSidebar and reuses the cached flag queries", () => {
  const shell = readFileSync(new URL("../../minimal/MinimalShell.tsx", import.meta.url), "utf8");
  assert.equal((shell.match(/aria-label="Primary"/g) ?? []).length, 1);
  assert.match(shell, /queryKey: \["grow-market-activity", "week", null\]/);
  assert.match(shell, /queryKey: \["grow-momentum", "week"\]/);
  assert.match(shell, /retry: noRetryWhenHidden/);
  assert.match(shell, /marketActivityAvailable: market\.isSuccess/);
  assert.match(shell, /momentumAvailable: momentum\.isSuccess/);
  assert.doesNotMatch(shell, /buildMinimalNavLinks/);
});
