// AE GROW C-10 — process-level AI provider metrics recorded inside
// generateWithGateway, the one place every text-generation caller goes
// through. Proves the series via renderMetricsText(), with the registry
// cleared between cases. Live providers stay off: the success path uses
// the real mock adapter, and the failure/fallback path uses the test seam
// rather than LIVE_AI_PROVIDER_APPROVED or a credential.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { incrementCounter, renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { generateWithGateway, setAiGatewayProviderForTests } from "../gateway.js";
import type { AiProvider } from "../providers/provider.js";
import type { AiProviderResponse } from "../types.js";

const baseRequest = {
  systemPrompt: "system",
  userPrompt: "user",
  model: "claude-sonnet-4-5",
  temperature: 0.2,
  maxOutputTokens: 100,
  timeoutMs: 5000,
};

const mockConfig = {
  provider: "mock",
  fallbackProvider: "mock",
  model: "claude-sonnet-4-5",
  temperature: 0.2,
  maxOutputTokens: 100,
  timeoutMs: 5000,
  retryLimit: 0,
};

beforeEach(() => {
  resetMetricsForTesting();
  setAiGatewayProviderForTests(null);
});

afterEach(() => {
  setAiGatewayProviderForTests(null);
});

function adapter(name: string, generate: AiProvider["generate"]): AiProvider {
  return { name, generate };
}

function okResponse(name: string, promptTokens: number, completionTokens: number): AiProviderResponse {
  return {
    provider: name,
    model: "should-not-be-a-label",
    text: "ok",
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: 9.99,
    },
    latencyMs: 1,
  };
}

test("a successful mock gateway call increments the success and primary-success series and the token counters", async () => {
  const result = await generateWithGateway(baseRequest, mockConfig);
  assert.equal(result.usedFallback, false);
  assert.equal(result.response.provider, "mock");

  const text = renderMetricsText();
  assert.match(text, /ai_provider_call_total\{provider="mock",outcome="success"\} 1/);
  assert.match(text, /ai_provider_call_duration_ms_count\{provider="mock",outcome="success"\} 1/);
  assert.match(text, /ai_provider_call_duration_ms_sum\{provider="mock",outcome="success"\} \d+/);
  assert.match(text, /# TYPE ai_provider_call_duration_ms summary/);
  assert.match(text, /ai_gateway_result_total\{result="primary_success"\} 1/);
  assert.match(
    text,
    new RegExp(`ai_provider_tokens_total\\{provider="mock",kind="prompt"\\} ${result.response.usage.promptTokens}`),
  );
  assert.match(
    text,
    new RegExp(`ai_provider_tokens_total\\{provider="mock",kind="completion"\\} ${result.response.usage.completionTokens}`),
  );
  assert.doesNotMatch(text, /ai_provider_call_total\{[^}]*outcome="failure"/);
  assert.doesNotMatch(text, /ai_gateway_result_total\{result="fallback_success"\}/);
  assert.doesNotMatch(text, /ai_gateway_result_total\{result="failed"\}/);
  assert.doesNotMatch(text, /should-not-be-a-label|claude-sonnet-4-5|kind="cost"|estimatedCostUsd|brokerageId=|userId=|correlationId=/);
  assert.ok(result.response.usage.promptTokens > 0);
  assert.ok(result.response.usage.completionTokens > 0);
});

test("a primary that fails on every attempt and then falls back records one failure per attempt plus fallback success", async () => {
  let primaryAttempts = 0;
  setAiGatewayProviderForTests((name) => {
    if (name === "primary-slot") {
      return adapter("anthropic", async () => {
        primaryAttempts += 1;
        throw new Error("primary down");
      });
    }
    return adapter("mock", async () => okResponse("mock", 11, 7));
  });

  const result = await generateWithGateway(baseRequest, {
    ...mockConfig,
    provider: "primary-slot",
    fallbackProvider: "fallback-slot",
    retryLimit: 1,
  });
  assert.equal(result.usedFallback, true);
  assert.equal(result.response.provider, "mock");
  assert.equal(primaryAttempts, 2, "retryLimit 1 is two primary attempts, then one fallback");

  const text = renderMetricsText();
  assert.match(text, /ai_provider_call_total\{provider="anthropic",outcome="failure"\} 2/);
  assert.match(text, /ai_provider_call_duration_ms_count\{provider="anthropic",outcome="failure"\} 2/);
  assert.match(text, /ai_provider_call_total\{provider="mock",outcome="success"\} 1/);
  assert.match(text, /ai_gateway_result_total\{result="fallback_success"\} 1/);
  assert.match(text, /ai_provider_tokens_total\{provider="mock",kind="prompt"\} 11/);
  assert.match(text, /ai_provider_tokens_total\{provider="mock",kind="completion"\} 7/);
  assert.doesNotMatch(text, /ai_provider_tokens_total\{provider="anthropic"/);
  assert.doesNotMatch(text, /ai_gateway_result_total\{result="primary_success"\}/);
  assert.doesNotMatch(text, /ai_gateway_result_total\{result="failed"\}/);
  assert.doesNotMatch(text, /9\.99|should-not-be-a-label|primary-slot|fallback-slot/);
});

test("a provider name outside the declared set is coerced to other, and an outcome outside the set throws with no new series", async () => {
  assert.equal(process.env.NODE_ENV, "test");
  const rawName = "claude-sonnet-4-5";
  setAiGatewayProviderForTests(() => adapter(rawName, async () => okResponse(rawName, 3, 4)));

  const result = await generateWithGateway(baseRequest, {
    ...mockConfig,
    provider: "not-a-declared-provider",
    fallbackProvider: "not-a-declared-provider",
  });
  assert.equal(result.usedFallback, false);

  let text = renderMetricsText();
  assert.match(text, /ai_provider_call_total\{provider="other",outcome="success"\} 1/);
  assert.match(text, /ai_provider_tokens_total\{provider="other",kind="prompt"\} 3/);
  assert.match(text, /ai_gateway_result_total\{result="primary_success"\} 1/);
  assert.doesNotMatch(text, new RegExp(rawName));
  assert.doesNotMatch(text, /not-a-declared-provider/);
  assert.doesNotMatch(text, /provider="claude/);

  resetMetricsForTesting();
  assert.throws(
    () => incrementCounter("ai_gateway_result_total", { result: "not-a-result" }),
    /not in the declared allowed set/,
  );
  assert.throws(
    () => incrementCounter("ai_provider_call_total", { provider: "mock", outcome: "nope" }),
    /not in the declared allowed set/,
  );
  text = renderMetricsText();
  assert.doesNotMatch(text, /ai_gateway_result_total\{/);
  assert.doesNotMatch(text, /ai_provider_call_total\{/);
  assert.doesNotMatch(text, /not-a-result|outcome="nope"/);
});
