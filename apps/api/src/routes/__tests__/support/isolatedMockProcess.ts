// Test-only helper for suites that re-execute themselves in an isolated Node
// process with --experimental-test-module-mocks (callTranscriptionBoundary,
// growCallFollowups).
//
// Why: the parent wrapper test used to inherit the runner's --test-timeout
// (120 s) for the WHOLE child suite, while every child case also gets 120 s.
// Under full-suite load the child (normally 12-17 s) could pass the 120 s mark
// as a whole, and the parent then failed with "test timed out after 120000ms"
// and dropped the child's output, so the slow or stuck case was never named.
// Now the parent gets an explicit budget above the child's own per-case limit,
// streams the child's TAP to stderr as it arrives, and on budget expiry kills
// the child and fails with everything captured so far.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Each child case still times out at 120 s on its own; the parent budget only bounds the whole child. */
export const CHILD_CASE_TIMEOUT_MS = 120_000;
export const PARENT_BUDGET_MS = 600_000;
const KILL_MARGIN_MS = 10_000;

export interface ChildRun { exit: number | null; output: string; killedAtBudget: boolean; elapsedMs: number }

export async function runIsolatedMockChild(testFileUrl: string, label: string): Promise<ChildRun> {
  const childEnv = { ...process.env };
  // Node otherwise detects a recursive test runner, skips every child test,
  // and exits zero. A zero exit alone must never count as coverage.
  delete childEnv.NODE_TEST_CONTEXT;
  const started = Date.now();
  const child = spawn(process.execPath, [
    "--experimental-test-module-mocks",
    "--import", fileURLToPath(new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    "--test", "--test-reporter=tap", `--test-timeout=${CHILD_CASE_TIMEOUT_MS}`, fileURLToPath(testFileUrl),
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const take = (chunk: Buffer) => {
    const s = chunk.toString();
    output += s;
    // Live TAP progress (not the JSON log lines) so a stuck case is visible even if the parent is torn down.
    const tap = s.split("\n").filter((l) => /^\s*(ok|not ok|# Subtest|# (tests|pass|fail|cancelled|duration_ms))\b/.test(l)).join("\n");
    if (tap) process.stderr.write(`[${label} child +${Date.now() - started}ms]\n${tap}\n`);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  let killedAtBudget = false;
  const timer = setTimeout(() => { killedAtBudget = true; child.kill("SIGKILL"); }, PARENT_BUDGET_MS - KILL_MARGIN_MS);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { exit, output, killedAtBudget, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
