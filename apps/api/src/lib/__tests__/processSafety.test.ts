// AE GROW Pilot Readiness WP2a (P0-1) — process-level safety handlers.
//
// Child-process tests (node:test itself intercepts unhandled rejections in
// the test process, so the real process behaviour must be observed in a
// separate process):
//   - with installProcessSafetyHandlers(), an unhandled rejection is logged
//     and the process KEEPS RUNNING;
//   - an uncaught exception is logged and the process exits 1;
//   - control: without the handlers, an unhandled rejection exits the process.
// Plus direct unit tests of the handler functions with an injected exit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleUncaughtException, handleUnhandledRejection } from "../processSafety.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "..", "..", "..");

function runChild(script: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: API_ROOT,
    env: { ...process.env, NODE_ENV: "test", OPERATIONAL_ALERTS_ENABLED: "false" },
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("control: without the handlers, an unhandled rejection terminates the process", () => {
  const child = runChild(`
Promise.reject(new Error("background failure"));
setTimeout(() => { console.log("STILL_ALIVE"); }, 300);
`);
  assert.notEqual(child.status, 0);
  assert.doesNotMatch(child.stdout, /STILL_ALIVE/);
});

test("with the handlers installed, an unhandled rejection is logged and the process keeps running", () => {
  const child = runChild(`
const { installProcessSafetyHandlers } = await import("./src/lib/processSafety.ts");
installProcessSafetyHandlers();
installProcessSafetyHandlers(); // idempotent
Promise.reject(new Error("background failure"));
setTimeout(() => { console.log("STILL_ALIVE"); process.exit(0); }, 300);
`);
  assert.equal(child.status, 0, child.stderr.slice(0, 2000));
  assert.match(child.stdout, /STILL_ALIVE/);
  assert.match(child.stdout + child.stderr, /process_unhandled_rejection/);
  assert.equal(
    (child.stdout + child.stderr).split("process_unhandled_rejection").length - 1,
    1,
    "installing twice must not double-register the listener",
  );
});

test("with the handlers installed, an uncaught exception is logged and the process exits 1", () => {
  const child = runChild(`
const { installProcessSafetyHandlers } = await import("./src/lib/processSafety.ts");
installProcessSafetyHandlers();
setTimeout(() => { throw new Error("synchronous escape"); }, 10);
setTimeout(() => { console.log("SHOULD_NOT_CONTINUE"); }, 5000);
`);
  assert.equal(child.status, 1);
  assert.match(child.stdout + child.stderr, /process_uncaught_exception/);
  assert.doesNotMatch(child.stdout, /SHOULD_NOT_CONTINUE/);
});

test("handleUncaughtException exits with code 1 exactly once, after the alert attempt", async () => {
  const codes: number[] = [];
  await handleUncaughtException(new Error("boom"), (code) => codes.push(code), 1_000);
  assert.deepEqual(codes, [1]);
});

test("handleUnhandledRejection resolves (never throws) for Error and non-Error reasons", async () => {
  await handleUnhandledRejection(new Error("x"));
  await handleUnhandledRejection("a string reason");
  await handleUnhandledRejection(undefined);
});
