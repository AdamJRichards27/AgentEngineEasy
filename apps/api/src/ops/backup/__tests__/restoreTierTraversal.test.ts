import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreBackup } from "../engine.js";
import { tierKey } from "../artifacts.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

const ARTIFACT = "aee-protected-20260101T000000Z-0123456789ab.tar.enc";

const BAD_TIERS: Array<[string, unknown]> = [
  ["parent traversal", "../../outside"],
  ["single parent", ".."],
  ["dot", "."],
  ["nested", "daily/../weekly"],
  ["trailing slash", "daily/"],
  ["leading slash", "/daily"],
  ["subfolder", "daily/x"],
  ["encoded dots", "%2e%2e"],
  ["encoded traversal", "%2e%2e%2f%2e%2e%2foutside"],
  ["encoded slash", "daily%2f.."],
  ["backslash", "..\\..\\outside"],
  ["backslash suffix", "daily\\x"],
  ["null byte", "daily\0"],
  ["null byte mid", "dai\0ly"],
  ["empty string", ""],
  ["uppercase", "DAILY"],
  ["title case", "Weekly"],
  ["leading space", " daily"],
  ["trailing space", "daily "],
  ["newline", "daily\n"],
  ["tab", "\tmonthly"],
  ["unsupported yearly", "yearly"],
  ["unsupported hourly", "hourly"],
  ["prototype name", "__proto__"],
  ["constructor", "constructor"],
  ["null", null],
  ["number", 1],
  ["object", { toString: () => "daily" }],
  ["array", ["daily"]],
];

for (const [label, tier] of BAD_TIERS) {
  test(`TT1 restoreBackup rejects invalid tier (${label}) before any remote or filesystem access`, async () => {
    const remote = await createFakeRemote({});
    const calls: string[] = [];
    try {
      const cfg = { ...remote.config, restoreDatabaseUrl: "postgresql://restore.invalid/other" };
      const error = await restoreBackup(cfg, { artifact: ARTIFACT, confirmDisposable: true, tier: tier as never }, {
        run: (async (command: { executable: string }) => {
          calls.push(command.executable);
          return { stdout: "", stderr: "" };
        }) as never,
        log: () => undefined,
      }).then(() => undefined, (e: unknown) => e as Error);
      assert.ok(error, "must throw");
      assert.match(error.message, /Restore tier must be daily, weekly or monthly/);
      assert.deepEqual(calls.filter((c) => c === "download"), [], "no download may be attempted");
      assert.deepEqual(calls, [], "no command at all (including alerts) may run for a rejected tier");
    } finally {
      await remote.cleanup();
    }
  });

  test(`TT2 tierKey refuses invalid tier (${label})`, () => {
    assert.throws(() => tierKey(tier as never, ARTIFACT), /Invalid backup tier/);
  });
}

test("TT3 tierKey keeps legitimate tiers inside their namespace", () => {
  for (const tier of ["daily", "weekly", "monthly"] as const) {
    assert.equal(tierKey(tier, ARTIFACT), `${tier}/${ARTIFACT}`);
  }
});

test("TT4 legitimate tiers and the legacy flat path still reach the download of the right object", async () => {
  for (const tier of ["daily", "weekly", "monthly", undefined] as const) {
    const remote = await createFakeRemote({});
    const objects: string[] = [];
    try {
      const cfg = { ...remote.config, restoreDatabaseUrl: "postgresql://restore.invalid/other" };
      await restoreBackup(cfg, { artifact: ARTIFACT, confirmDisposable: true, ...(tier ? { tier } : {}) }, {
        run: (async (command: { executable: string }, r: Record<string, string> = {}) => {
          if (command.executable === "download") {
            objects.push(r.object!);
            throw new Error("stop-after-download");
          }
          return { stdout: "", stderr: "" };
        }) as never,
        log: () => undefined,
      }).catch(() => undefined);
      assert.deepEqual(objects, [tier ? `${tier}/${ARTIFACT}` : ARTIFACT]);
    } finally {
      await remote.cleanup();
    }
  }
});

test("TT5 'tier' present but undefined is treated as legacy; explicit empty string is NOT (no silent legacy fallback)", async () => {
  const remote = await createFakeRemote({});
  try {
    const cfg = { ...remote.config, restoreDatabaseUrl: "postgresql://restore.invalid/other" };
    const e = await restoreBackup(cfg, { artifact: ARTIFACT, confirmDisposable: true, tier: "" as never }, {
      run: (async () => ({ stdout: "", stderr: "" })) as never, log: () => undefined,
    }).then(() => undefined, (x: unknown) => x as Error);
    assert.match(e?.message ?? "", /Restore tier must be/);
  } finally {
    await remote.cleanup();
  }
});
