import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildProductNavLinks } from "../productNav";
import { MINIMAL_RUN_PATHS, buildClassicNavLinks } from "../../minimal/minimalNav";

// Owner D5 on the classic sidebar: Grow-only users are not offered Home,
// Today, Properties, Exceptions, Financial, Pit Crew or Start Property.

const GROW_ONLY = ["grow.access", "grow.contacts.read"];
const GROW_RUN = [...GROW_ONLY, "run.access"];
const paths = (links: { path: string }[]) => links.map((l) => l.path);

test("without run.access the classic nav shows no Run link, for every role", () => {
  for (const role of ["Agent", "Brokerage Administrator", "Pit Crew", undefined]) {
    const links = paths(buildClassicNavLinks({ role, entitlements: GROW_ONLY }));
    for (const p of MINIMAL_RUN_PATHS) assert.equal(links.includes(p), false, `${role}: ${p}`);
    assert.deepEqual(links, ["/grow", "/communications", "/settings"]);
  }
});

test("with run.access the classic nav is unchanged from the product nav", () => {
  for (const role of ["Agent", "Brokerage Administrator", "Pit Crew", undefined]) {
    const ctx = { role, entitlements: GROW_RUN };
    assert.deepEqual(paths(buildClassicNavLinks(ctx)), paths(buildProductNavLinks(ctx)));
  }
  const runOnly = { role: "Agent", entitlements: ["run.access"] };
  assert.deepEqual(paths(buildClassicNavLinks(runOnly)), paths(buildProductNavLinks(runOnly)));
});

test("App.tsx builds the classic sidebar from the gated list and gates Start Property", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  assert.match(app, /buildClassicNavLinks\(\{ role: user\?\.role, entitlements \}\)/);
  assert.doesNotMatch(app, /buildProductNavLinks\(/);
  assert.match(app, /canStartProperty = !ownerWithoutContext && minimalHasRunAccess\(entitlements\)/);
  assert.match(app, /\{canStartProperty && <Link href="\/properties\/start"/);
});
