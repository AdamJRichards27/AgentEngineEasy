// C-10 — a logAiInteraction insert failure must not throw, and must be observable.
import { randomUUID } from "node:crypto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { logAiInteraction } from "../audit.js";

beforeEach(() => {
  resetMetricsForTesting();
});

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

test("logAiInteraction surfaces an insert failure on the error log and the failure counter, and returns null", async () => {
  let returned: number | null = 1;
  const stderr = await captureStderr(async () => {
    returned = await logAiInteraction({
      requestId: randomUUID(),
      brokerageId: 2147483646,
      userId: 2147483646,
      aiRole: "copilot",
      riskLevel: 0,
      status: "success",
    });
  });
  assert.equal(returned, null);
  assert.match(stderr, /log_ai_interaction_failed/);
  const line = stderr.split("\n").find((entry) => entry.includes("log_ai_interaction_failed"));
  assert.ok(line);
  const parsed = JSON.parse(line) as { message: string; level: string; brokerageId: number; status: string; question?: string };
  assert.equal(parsed.level, "error");
  assert.equal(parsed.message, "log_ai_interaction_failed");
  assert.equal(parsed.brokerageId, 2147483646);
  assert.equal(parsed.status, "success");
  assert.equal(parsed.question, undefined);
  const metrics = renderMetricsText();
  assert.match(metrics, /ai_interaction_log_failure_total\{operation="insert"\} 1/);
});
