import { writeFile } from "node:fs/promises";
import { createBackup } from "../../engine.js";
import { createFakeRemote } from "./fakeBackupRemote.js";

// Test-only child process: runs the REAL createBackup() and SIGKILLs itself (no finally blocks run) the
// first time the given command executable is invoked. Simulates an OOM-kill / power loss mid-run.
const crashAt = process.env.CRASH_AT!;
const out = process.env.CRASH_OUT!;
const remote = await createFakeRemote({ prune: true, listIncludesUploads: true, now: new Date("2026-03-01T00:00:00Z") });
await writeFile(out, JSON.stringify({ staging: remote.config.stagingDirectory, root: remote.config.restoreRoot.replace(/restore-root$/, "") }));
await createBackup(remote.config, {
  run: async (command, replacements, operation) => {
    if (command.executable === crashAt) process.kill(process.pid, "SIGKILL");
    return remote.run(command, replacements, operation);
  },
  now: () => new Date("2026-03-01T00:00:00Z"),
  log: () => undefined,
});
