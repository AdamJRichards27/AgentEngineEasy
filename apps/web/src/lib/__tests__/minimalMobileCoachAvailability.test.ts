import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyCoachAvailability } from "../../minimal/mobile/mobileCoachAvailability";
import { BUSINESS_COACH_HREF, BUSINESS_COACH_LABEL, GROW_AI_USE, buildMobileNav } from "../../minimal/mobile/mobileNavModel";

// AE Mobile (CC Task #64, M2): found in the real app: Business Coach was listed for an entitled brokerage whose deployment has the
// coach switched off, and opening it said "isn't enabled for this brokerage". It is listed only where it works.

const GROW = ["grow.access", "grow.contacts.read", GROW_AI_USE];
const nav = (entitlements: string[] = GROW) => buildMobileNav({ role: "Agent", entitlements, momentumAvailable: true, marketActivityAvailable: false });
const labels = (n: ReturnType<typeof nav>) => n.more.map((i) => i.label);

test("an entitled user gets Business Coach only when the capability probe says it is on", () => {
  const base = nav();
  assert.ok(labels(base).includes(BUSINESS_COACH_LABEL), "the model offers it with grow.ai.use");
  assert.equal(applyCoachAvailability(base, true), base, "on: untouched");
  const off = applyCoachAvailability(base, false);
  assert.equal(labels(off).includes(BUSINESS_COACH_LABEL), false);
  assert.equal(off.moreGroups.some((g) => g.items.some((i) => i.href === BUSINESS_COACH_HREF)), false);
  assert.deepEqual(labels(off), labels(base).filter((l) => l !== BUSINESS_COACH_LABEL), "nothing else is removed, order kept");
});

test("a group left empty is dropped, and the Add Run offer is untouched", () => {
  const grow = nav(["grow.access", GROW_AI_USE]);
  const off = applyCoachAvailability(grow, false);
  assert.equal(off.upgrade?.label, "Add Run");
  for (const g of off.moreGroups) assert.ok(g.items.length > 0, g.key);
  assert.deepEqual(off.tabs, grow.tabs, "the bar is not touched");
});

test("a user without the entitlement never had it, whatever the probe says", () => {
  const n = nav(["grow.access"]);
  assert.equal(labels(n).includes(BUSINESS_COACH_LABEL), false);
  assert.equal(applyCoachAvailability(n, true), n);
});

test("the hook fails closed (only a literal true shows it), asks only an entitled user, and shares AskAgentEngine's own probe", () => {
  const src = readFileSync(new URL("../../minimal/mobile/useMobileNav.ts", import.meta.url), "utf8");
  assert.match(src, /queryKey: \["ai-capabilities"\]/);
  assert.match(src, /queryFn: \(\) => apiFetch\("\/ai\/capabilities"\)/);
  assert.match(src, /enabled: !ownerWithoutContext && entitlements\.includes\(GROW_AI_USE\)/);
  assert.match(src, /applyCoachAvailability\(nav, coach\.data\?\.businessCoachEnabled === true\)/);
  const ask = readFileSync(new URL("../../components/AskAgentEngine.tsx", import.meta.url), "utf8");
  assert.match(ask, /queryKey: \["ai-capabilities"\],\s*queryFn: \(\) => apiFetch<AiCapabilities>\("\/ai\/capabilities"\)/, "the same key and route as the existing probe");
  const api = readFileSync(new URL("../../../../api/src/routes/ai.ts", import.meta.url), "utf8");
  assert.match(api, /businessCoachEnabled: isRoleEnabled\("business_coach"\)/);
});
