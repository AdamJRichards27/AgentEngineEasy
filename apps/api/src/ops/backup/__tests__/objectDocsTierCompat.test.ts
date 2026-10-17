import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIER_POLICY } from "../artifacts.js";
import { createBackup } from "../engine.js";
import type { BackupOperation } from "../types.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

// PH-7 integration compatibility (LOCAL): Package C object-storage documents x Package A tiers x
// Package A/#225 verify-before-prune x env-isolation operation tags. Test-only; no engine change.

const KEY = "tenants/b1/documents/d1/11111111-1111-1111-1111-111111111111-v1.pdf";
const SUNDAY_THE_FIRST = new Date("2026-03-01T00:00:00Z");

function provider(objects: Record<string, string>, corrupt: string[] = []) {
  return {
    getObject: async (key: string): Promise<Buffer> => {
      if (corrupt.includes(key)) throw new Error("ObjectIntegrityError: checksum mismatch");
      if (!(key in objects)) throw new Error("ObjectNotFoundError");
      return Buffer.from(objects[key]!);
    },
  };
}

async function remoteFor(keys: string[]) {
  return createFakeRemote({ prune: true,
    seed: [], listIncludesUploads: true, now: SUNDAY_THE_FIRST, documentKeys: keys,
    configOverrides: {
      documentSource: "object-storage", documentDirectory: undefined, tierPolicy: DEFAULT_TIER_POLICY,
      verifyDownload: { executable: "verify-download", args: [] },
    },
  });
}

test("C1 object-storage documents + tiered layout: all three tiers written, every copy verified before list, tags correct", async () => {
  const remote = await remoteFor([KEY]);
  const seen: Array<[string, BackupOperation | undefined]> = [];
  try {
    await createBackup(remote.config, {
      run: (c, r, op) => { seen.push([c.executable, op]); return remote.run(c, r, op); },
      documentProvider: provider({ [KEY]: "bytes" }), now: () => SUNDAY_THE_FIRST, log: () => undefined,
    });
    for (const tier of ["daily", "weekly", "monthly"]) assert.ok([...remote.uploaded.keys()].some((k) => k.startsWith(`${tier}/`) && k.endsWith(".tar.enc")), tier);
    const lastVerify = remote.calls.map((c, i) => (c.startsWith("verify-download") ? i : -1)).reduce((a, b) => Math.max(a, b));
    assert.ok(lastVerify > -1 && remote.calls.indexOf("list") > lastVerify);
    assert.ok(seen.every(([, op]) => op !== undefined));
  } finally {
    await remote.cleanup();
  }
});

test("C2 missing, corrupt or unsafe document keys stop the run before any upload, list or remove", async () => {
  for (const [label, keys, objects, corrupt] of [
    ["missing", [KEY], {}, []],
    ["corrupt", [KEY], { [KEY]: "x" }, [KEY]],
    ["unsafe", ["../escape.pdf"], {}, []],
  ] as const) {
    const remote = await remoteFor([...keys]);
    try {
      await assert.rejects(
        createBackup(remote.config, { run: remote.run, documentProvider: provider({ ...objects }, [...corrupt]), now: () => SUNDAY_THE_FIRST, log: () => undefined }),
        /Document integrity failed before backup/, label,
      );
      assert.equal(remote.uploaded.size, 0, `${label}: nothing uploaded`);
      assert.ok(!remote.calls.includes("list") && remote.removed.length === 0, `${label}: no prune activity`);
    } finally {
      await remote.cleanup();
    }
  }
});
