import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWithGateway } from "../gateway.js";

const baseRequest = {
  systemPrompt: "system",
  userPrompt: "user",
  model: "test-model",
  temperature: 0.2,
  maxOutputTokens: 100,
  timeoutMs: 5000,
};

test("gateway falls back to the fallback provider when the primary provider errors, and labels the result", async () => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousApproval = process.env.LIVE_AI_PROVIDER_APPROVED;
  const previousFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  // WP2a: a real provider is only constructed with explicit approval.
  process.env.LIVE_AI_PROVIDER_APPROVED = "true";
  global.fetch = (async () => {
    throw new Error("simulated network failure");
  }) as typeof fetch;

  try {
    const result = await generateWithGateway(baseRequest, {
      provider: "anthropic",
      fallbackProvider: "mock",
      model: "test-model",
      temperature: 0.2,
      maxOutputTokens: 100,
      timeoutMs: 5000,
      retryLimit: 0,
    });
    assert.equal(result.usedFallback, true);
    assert.equal(result.response.provider, "mock");
    assert.equal(typeof result.primaryError, "string");
  } finally {
    global.fetch = previousFetch;
    if (previousApproval === undefined) delete process.env.LIVE_AI_PROVIDER_APPROVED;
    else process.env.LIVE_AI_PROVIDER_APPROVED = previousApproval;
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  }
});

test("gateway throws when the primary provider errors and there is no distinct fallback configured", async () => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousApproval = process.env.LIVE_AI_PROVIDER_APPROVED;
  const previousFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  // WP2a: a real provider is only constructed with explicit approval.
  process.env.LIVE_AI_PROVIDER_APPROVED = "true";
  global.fetch = (async () => {
    throw new Error("simulated network failure");
  }) as typeof fetch;

  try {
    await assert.rejects(() =>
      generateWithGateway(baseRequest, {
        provider: "anthropic",
        fallbackProvider: "anthropic",
        model: "test-model",
        temperature: 0.2,
        maxOutputTokens: 100,
        timeoutMs: 5000,
        retryLimit: 0,
      })
    );
  } finally {
    global.fetch = previousFetch;
    if (previousApproval === undefined) delete process.env.LIVE_AI_PROVIDER_APPROVED;
    else process.env.LIVE_AI_PROVIDER_APPROVED = previousApproval;
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  }
});

test("the mock provider succeeds directly with no fallback needed", async () => {
  const result = await generateWithGateway(baseRequest, {
    provider: "mock",
    fallbackProvider: "mock",
    model: "test-model",
    temperature: 0.2,
    maxOutputTokens: 100,
    timeoutMs: 5000,
    retryLimit: 0,
  });
  assert.equal(result.usedFallback, false);
  assert.equal(result.response.provider, "mock");
});

// AE GROW Pilot Readiness WP2a — LIVE_AI_PROVIDER_APPROVED gate.

async function withAiEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const anthropicConfig = {
  provider: "anthropic",
  fallbackProvider: "anthropic",
  model: "test-model",
  temperature: 0.2,
  maxOutputTokens: 100,
  timeoutMs: 5000,
  retryLimit: 0,
};

for (const approval of [undefined, "", "1", "TRUE", "yes", "false"]) {
  for (const nodeEnv of ["test", "development", "production"]) {
    test(`an unapproved real AI provider (LIVE_AI_PROVIDER_APPROVED=${JSON.stringify(approval)}, NODE_ENV=${nodeEnv}) never reaches the network and answers via the mock`, async () => {
      const previousFetch = global.fetch;
      let fetchCalls = 0;
      global.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      }) as typeof fetch;
      try {
        await withAiEnv(
          { LIVE_AI_PROVIDER_APPROVED: approval, NODE_ENV: nodeEnv, ANTHROPIC_API_KEY: "test-key-not-real" },
          async () => {
            const result = await generateWithGateway(baseRequest, anthropicConfig);
            assert.equal(result.usedFallback, false);
            assert.equal(result.response.provider, "mock", "the response is honestly labelled as the mock provider");
            assert.equal(fetchCalls, 0, "no request may be sent to the real provider without approval");
          },
        );
      } finally {
        global.fetch = previousFetch;
      }
    });
  }
}

test("an approved real AI provider with a key IS used (the gate opens only on the literal 'true')", async () => {
  const previousFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("simulated network failure");
  }) as typeof fetch;
  try {
    await withAiEnv({ LIVE_AI_PROVIDER_APPROVED: "true", ANTHROPIC_API_KEY: "test-key-not-real" }, async () => {
      await assert.rejects(() => generateWithGateway(baseRequest, anthropicConfig));
      assert.ok(fetchCalls >= 1, "the real provider was attempted once approved");
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test("mock remains the default provider when AI_PROVIDER is unset", async () => {
  const { loadAiGatewayConfig } = await import("../gateway.js");
  await withAiEnv({ AI_PROVIDER: undefined, AI_FALLBACK_PROVIDER: undefined }, async () => {
    const config = loadAiGatewayConfig();
    assert.equal(config.provider, "mock");
    assert.equal(config.fallbackProvider, "mock");
  });
});
