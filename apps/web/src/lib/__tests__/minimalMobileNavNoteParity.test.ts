import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildMobileNav, RUN_UPGRADE_HREF, RUN_UPGRADE_LABEL, type MobileNav } from "../../minimal/mobile/mobileNavModel";

// t220u: parity of the t217u model with the CC Task #64 v2 change note (Grok verifies; zip not received).
// v2 requirements: four tabs; Grow always visible; Run gated by run.access + role; one "Add Run" offer
// (words only) in the Run group for users without Run; no "Performance", "Nurture" or "Ask AE" item
// (their /grow?tab= links open Today); "My Momentum" once at /grow/momentum, only when available;
// More grouped Grow, Run, Workspace (Communications, Settings); no duplicate labels or links.

const GROW = ["grow.access", "grow.contacts.read"];
const ROLES = ["Agent", "Brokerage Administrator", "Pit Crew"];
const PERSONAS: Array<[string, string[]]> = [["empty", []], ["grow-only", GROW], ["run-only", ["run.access"]], ["run+grow", ["run.access", ...GROW]]];
const all = (): Array<[string, MobileNav]> => {
  const out: Array<[string, MobileNav]> = [];
  for (const [p, e] of PERSONAS) for (const role of ROLES) for (const m of [true, false]) for (const a of [true, false])
    out.push([`${p}/${role}/momentum=${m}/market=${a}`, buildMobileNav({ role, entitlements: e, momentumAvailable: m, marketActivityAvailable: a })]);
  return out;
};
const group = (n: MobileNav, key: string) => n.moreGroups.find((g) => g.key === key)?.items.map((i) => i.label) ?? null;

test("note: four primary tabs for every persona and role", () => {
  for (const [label, n] of all()) assert.deepEqual(n.tabs.map((t) => t.label), ["Today", "People", "Properties", "Search"], label);
});

test("note (t222u: Performance renamed Business Coach): no Performance, Nurture or Ask AE anywhere; My Momentum once, at /grow/momentum, only when available", () => {
  for (const [label, n] of all()) {
    const labels = [...n.tabs.map((t) => t.label), ...n.more.map((m) => m.label)];
    for (const banned of ["Performance", "Nurture", "Ask AE"]) assert.ok(!labels.includes(banned), `${label}: ${banned}`);
    const mm = n.more.filter((m) => m.label === "My Momentum");
    assert.equal(mm.length, label.includes("momentum=true") ? 1 : 0, label);
    if (mm[0]) assert.equal(mm[0].href, "/grow/momentum");
    for (const m of n.more) assert.ok(!/^\/grow\?tab=(nurture|ask)/.test(m.href), `${label}: ${m.href}`);
  }
});

test("note: More grouped Grow, Run, Workspace; Workspace = Communications, Settings; no duplicate labels or links", () => {
  for (const [label, n] of all()) {
    const keys = label.startsWith("empty") ? ["grow", "workspace"] : ["grow", "run", "workspace"]; // t222u: unsubscribed has no Run group (no Add Run)
    assert.deepEqual(n.moreGroups.map((g) => g.key), keys, label);
    assert.deepEqual(n.moreGroups.map((g) => g.label), keys.map((k) => k[0]!.toUpperCase() + k.slice(1)), label);
    assert.deepEqual(group(n, "workspace"), ["Communications", "Settings"], label);
    const labels = [...n.tabs.map((t) => t.label), ...n.more.map((m) => m.label)];
    assert.equal(new Set(labels).size, labels.length, `${label}: duplicate label`);
    const hrefs = [...n.tabs.flatMap((t) => (t.href ? [t.href] : [])), ...n.more.map((m) => m.href)];
    assert.equal(new Set(hrefs).size, hrefs.length, `${label}: duplicate link`);
  }
});

test("note: Run links only with run.access (by role); otherwise the Run group holds exactly one 'Add Run' offer", () => {
  assert.equal(RUN_UPGRADE_LABEL, "Add Run");
  for (const [label, n] of all()) {
    const run = group(n, "run") ?? [];
    if (label.startsWith("empty")) {
      assert.deepEqual(run, [], label); // t222u: unsubscribed: no Add Run
      assert.equal(n.upgrade, null, label);
    } else if (label.startsWith("run")) {
      assert.ok(!run.includes("Add Run"), label);
      assert.deepEqual(run.slice(0, 3), ["Run home", "Run today", "Exceptions"], label);
      assert.equal(run.includes("Financial"), label.includes("/Brokerage Administrator/"), label);
      assert.equal(run.includes("Pit Crew"), !label.includes("/Agent/"), label);
      assert.equal(n.upgrade, null, label);
    } else {
      assert.deepEqual(run, ["Add Run"], label);
      assert.equal(n.upgrade?.href, RUN_UPGRADE_HREF, label);
    }
    assert.ok(group(n, "grow")!.includes("Opportunities") && group(n, "grow")!.includes("Appraisals"), label);
  }
});

test("routing: every nav and More destination path is a declared route in App.tsx", () => {
  const app = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
  const routes = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]!);
  const matches = (path: string) => routes.some((r) => new RegExp(`^${r.replace(/:[^/]+/g, "[^/]+")}$`).test(path));
  const seen = new Set<string>();
  for (const [, n] of all()) for (const h of [...n.tabs.flatMap((t) => (t.href ? [t.href] : [])), ...n.more.map((m) => m.href)]) seen.add(h);
  for (const h of seen) assert.ok(matches(h.split("?")[0]!), `${h} has no route`);
});
