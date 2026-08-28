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
  const previousFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
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
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  }
});

test("gateway throws when the primary provider errors and there is no distinct fallback configured", async () => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
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
