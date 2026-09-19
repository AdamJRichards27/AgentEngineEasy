import assert from "node:assert/strict";
import { mock } from "node:test";

/**
 * F4.1 test-only module mocks (same mechanism as f3ForbiddenCalls.ts),
 * installed before importing the F4 service or createApp(). Unlike the F3
 * set, Stage D proposal/approval/execution and the commitment creator are
 * deliberately NOT forbidden here: F4.1 exists to call proposeAIAction, and
 * the test drives the human approve/execute path itself. Everything else a
 * follow-up must never trigger — messaging, outbox, automation tasks/
 * reminders/attention items, the AI model gateway, the F3 AI draft gateway,
 * and NBA — throws and is counted.
 */
const targets = [
  { category: "communications", path: "communications/messages",
    functions: ["createDraftMessage", "sendMessageNow", "requeueMessage"] },
  { category: "communications", path: "communications/outbox",
    functions: ["queueMessage", "evaluateAndDispatchQueuedMessage", "dispatchMessage", "dispatchDueMessages"] },
  { category: "automation", path: "automation/tasks", functions: ["createAutomationTask", "assignAutomationTaskToRole"] },
  { category: "automation", path: "automation/attentionItems", functions: ["raiseAttentionItem"] },
  { category: "ai-gateway", path: "ai/gateway", functions: ["generateWithGateway"] },
  { category: "ai-draft-gateway", path: "telephony/callTranscriptionDrafts", functions: ["generateCallTranscriptionDrafts"] },
  { category: "next-best-action", path: "growToday", functions: ["getGrowTodaySummary"] },
] as const;

export async function installF4ForbiddenCalls() {
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
        throw new Error(`F4.1 forbidden call: ${label}`);
      };
      probes.push({
        name: label,
        async invoke() {
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
      assert.deepEqual(calls, [], "F4.1 invoked a forbidden side-effect function");
    },
    resetForNegativeControl() { calls.length = 0; },
    restore() { for (const context of contexts.reverse()) context.restore(); },
  };
}
