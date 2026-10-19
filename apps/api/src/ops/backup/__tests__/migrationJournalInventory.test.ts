import assert from "node:assert/strict";
import { test } from "node:test";
import { readDatabaseInventory, validateDatabaseInventory } from "../database.js";
import type { DatabaseInventory } from "../types.js";

function inventory(extra: Partial<DatabaseInventory> = {}): DatabaseInventory {
  return { tenantCount: 2, recordCounts: { users: 3 }, documentKeys: ["a"], ...extra };
}

const journal = { count: 37, digest: "0123456789abcdef0123456789abcdef" };

test("restore validation passes when the migration journal is identical", () => {
  validateDatabaseInventory(inventory({ migrationJournal: journal }), inventory({ migrationJournal: { ...journal } }));
});

test("restore validation fails when the restored journal has fewer rows", () => {
  assert.throws(
    () => validateDatabaseInventory(inventory({ migrationJournal: journal }), inventory({ migrationJournal: { ...journal, count: 36 } })),
    /Migration journal validation failed: expected 37 rows, restored 36 rows/,
  );
});

test("restore validation fails on a same-count journal with a different digest", () => {
  assert.throws(
    () => validateDatabaseInventory(inventory({ migrationJournal: journal }), inventory({ migrationJournal: { ...journal, digest: "f".repeat(32) } })),
    /different journal digest/,
  );
});

test("restore validation fails when the journal is missing after restore", () => {
  assert.throws(
    () => validateDatabaseInventory(inventory({ migrationJournal: journal }), inventory({ migrationJournal: null })),
    /restored no journal/,
  );
  assert.throws(() => validateDatabaseInventory(inventory({ migrationJournal: journal }), inventory()), /restored no journal/);
});

test("a push-managed source (no journal table) must restore with no journal", () => {
  validateDatabaseInventory(inventory({ migrationJournal: null }), inventory({ migrationJournal: null }));
  assert.throws(
    () => validateDatabaseInventory(inventory({ migrationJournal: null }), inventory({ migrationJournal: journal })),
    /expected no journal, restored 37 rows/,
  );
});

test("legacy artifacts without journal evidence are not rejected (backward compatible)", () => {
  validateDatabaseInventory(inventory(), inventory({ migrationJournal: journal }));
  validateDatabaseInventory(inventory(), inventory());
});

test("readDatabaseInventory accepts a journal, null, or absent field and rejects a malformed one", async () => {
  const run = (payload: unknown) => async () => ({ stdout: JSON.stringify(payload) + "\n", stderr: "" });
  const base = { tenantCount: 1, recordCounts: {}, documentKeys: [] };
  assert.deepEqual((await readDatabaseInventory(run({ ...base, migrationJournal: journal }), "postgresql://x/y")).migrationJournal, journal);
  assert.equal((await readDatabaseInventory(run({ ...base, migrationJournal: null }), "postgresql://x/y")).migrationJournal, null);
  assert.equal((await readDatabaseInventory(run(base), "postgresql://x/y")).migrationJournal, undefined);
  await assert.rejects(
    readDatabaseInventory(run({ ...base, migrationJournal: { count: "37", digest: 1 } }), "postgresql://x/y"),
    /invalid shape/,
  );
});
