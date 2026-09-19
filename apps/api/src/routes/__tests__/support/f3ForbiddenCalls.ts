import assert from "node:assert/strict";
import { mock } from "node:test";

/**
 * Test-only module mocks, installed before importing F3 or createApp().
 * Counters are incremented BEFORE throwing, so catching a forbidden call
 * inside best-effort drafting/reconciliation cannot hide a violation.
 */
const targets = [
  { category: "commitments", path: "growCommitmentActions", functions: ["createApprovedGrowCommitment"] },
  { category: "proposals", path: "ai/actionRequests", functions: ["proposeAIAction"] },
  { category: "proposals", path: "ai/executionGateway", functions: ["executeAIAction", "executeAIActionAsSystem"] },
  { category: "communications", path: "communications/messages",
    functions: ["createDraftMessage", "sendMessageNow", "requeueMessage"] },
  { category: "communications", path: "communications/outbox",
    functions: ["queueMessage", "evaluateAndDispatchQueuedMessage", "dispatchMessage", "dispatchDueMessages"] },
  { category: "tasks", path: "automation/tasks", functions: ["createAutomationTask"] },
  // NBA is computed rather than persisted: row-count checks cannot cover it.
  { category: "next-best-action", path: "growToday", functions: ["getGrowTodaySummary"] },
] as const;

export async function installForbiddenCalls() {
  const calls: string[] = [];
  const contexts: Array<{ restore(): void }> = [];
  const probes: Array<{ name: string; invoke(): Promise<unknown> }> = [];
  for (const target of targets) {
    const url = new URL(`../../../lib/${target.path}.ts`, import.meta.url).href;
    const original = await import(url) as Record<string, unknown>;
    const namedExports = { ...original };
    for (const name of target.functions) {
      assert.equal(typeof original[name], "function", `Boundary target missing: ${target.path}:${name}`);
      const label = `${target.category}:${target.path}:${name}`;
      namedExports[name] = () => {
        calls.push(label);
        throw new Error(`F4 forbidden call: ${label}`);
      };
      probes.push({
        name: label,
        async invoke() {
          // Use the same .js -> .ts resolution as production callers, not
          // a detached fake or a test-only alternate module identity.
          const exports = await import(url.replace(/\.ts$/, ".js")) as Record<string, () => unknown>;
          return exports[name]!();
        },
      });
    }
    contexts.push(mock.module(url, { cache: true, namedExports }));
  }
  return {
    calls,
    probes,
    assertUntouched() {
      assert.deepEqual(calls, [], "F3 invoked an F4-owned function");
    },
    resetForNegativeControl() { calls.length = 0; },
    restore() { for (const context of contexts.reverse()) context.restore(); },
  };
}