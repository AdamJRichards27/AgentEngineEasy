import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROW_CONTACTS_READ, mobilePermissions } from "../../minimal/mobile/mobilePermissions";
import { GROW_ACCESS, RUN_ACCESS } from "../../minimal/minimalNav";

// AE Mobile (CC Task #64, M1): who may see which mobile tab and run which search request.

const NONE = { today: false, people: false, properties: false, search: false, searchContacts: false, searchProperties: false, run: false, upgradeToRun: false };
// t217u: Grow is always visible for a signed-in brokerage user; Run needs run.access AND a brokerage role.
const GROW = { ...NONE, today: true, people: true, properties: true, search: true, searchProperties: true };

test("drift: every entitlement key the mobile model relies on exists in the server catalogue", () => {
  const source = readFileSync(new URL("../../../../../packages/db/src/schema/billing.ts", import.meta.url), "utf8");
  const block = /export const ENTITLEMENT_KEYS = \[([\s\S]*?)\] as const/.exec(source);
  assert.ok(block, "ENTITLEMENT_KEYS block found in packages/db/src/schema/billing.ts");
  const keys = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const key of [GROW_CONTACTS_READ, GROW_ACCESS, RUN_ACCESS]) {
    assert.ok(keys.includes(key), `${key} is in the server catalogue`);
  }
  assert.equal(GROW_CONTACTS_READ, "grow.contacts.read");
});

test("no copies: run.access and grow.access are imported, not redefined", () => {
  const source = readFileSync(new URL("../../minimal/mobile/mobilePermissions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /["']run\.access["']/);
  assert.doesNotMatch(source, /["']grow\.access["']/);
  assert.match(source, /from "\.\.\/minimalNav"/);
  assert.match(source, /from "\.\.\/\.\.\/lib\/productNav"/);
  assert.match(source, /GROW_CONTACTS_READ = "grow\.contacts\.read"/);
});

test("permission matrix", () => {
  const cases: Array<[string, readonly string[] | null | undefined, string | undefined, typeof NONE]> = [
    ["empty list (Grow always visible; t222u: unsubscribed, no upgrade)", [], "Agent", GROW],
    ["null (still loading)", null, "Agent", NONE],
    ["undefined", undefined, "Agent", NONE],
    ["grow.access only", ["grow.access"], "Agent", { ...GROW, upgradeToRun: true }],
    ["grow.contacts.read (action permission for contact search)", ["grow.contacts.read"], "Agent", { ...GROW, searchContacts: true }],
    ["run.access + Agent role", ["run.access"], "Agent", { ...GROW, run: true }],
    ["run.access + Pit Crew role", ["run.access"], "Pit Crew", { ...GROW, run: true }],
    ["run.access without a brokerage role", ["run.access"], undefined, GROW],
    ["run.access + unknown role", ["run.access"], "Platform Owner", GROW],
    ["run + grow + contacts, Brokerage Administrator", ["run.access", "grow.access", "grow.contacts.read"], "Brokerage Administrator", { ...GROW, searchContacts: true, run: true }],
    ["unrelated keys only (no grow.access: not a Grow subscriber)", ["grow.ai.use", "grow.calling.access"], "Agent", GROW],
  ];
  for (const [name, entitlements, role, expected] of cases) {
    assert.deepEqual(mobilePermissions(entitlements, role), expected, name);
  }
});

test("fails closed on a non-array value and does not mutate its input", () => {
  assert.deepEqual(mobilePermissions("grow.access" as unknown as string[]), NONE);
  const frozen = Object.freeze(["grow.access", "grow.contacts.read"]);
  assert.doesNotThrow(() => mobilePermissions(frozen));
  assert.deepEqual([...frozen], ["grow.access", "grow.contacts.read"]);
});
