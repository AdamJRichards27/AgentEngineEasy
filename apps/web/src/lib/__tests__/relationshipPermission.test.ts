import assert from "node:assert/strict";
import test from "node:test";
import { canManageRelationships } from "../relationshipPermission";

const has = (keys: string[]) => (k: string) => keys.includes(k);

test("t246u: explicit grow.relationships.manage allows any role", () => {
  for (const role of ["Agent", "Brokerage Administrator", "Pit Crew"]) assert.equal(canManageRelationships(has(["grow.relationships.manage"]), role), true);
});
test("t246u: legacy Run (run.access only) Agent and Brokerage Administrator may manage", () => {
  assert.equal(canManageRelationships(has(["run.access"]), "Agent"), true);
  assert.equal(canManageRelationships(has(["run.access"]), "Brokerage Administrator"), true);
});
test("t246u: run.access alone does not authorise Pit Crew or an unknown role", () => {
  assert.equal(canManageRelationships(has(["run.access"]), "Pit Crew"), false);
  assert.equal(canManageRelationships(has(["run.access"]), undefined), false);
});
test("t246u: read-only Grow and unsubscribed are refused", () => {
  assert.equal(canManageRelationships(has(["grow.access", "grow.contacts.read"]), "Agent"), false);
  assert.equal(canManageRelationships(has([]), "Brokerage Administrator"), false);
});
