import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import {
  generateCallTranscriptionDrafts,
  setCallTranscriptionDraftGatewayForTests,
} from "../callTranscriptionDrafts.js";

process.env.NODE_ENV = "test";

const input = {
  transcriptionId: 42,
  brokerageId: 7,
  transcript: "The buyer will send the signed offer tomorrow.",
};

const validResponse = {
  draft_summary: "The buyer will send a signed offer tomorrow.",
  draft_key_points: ["Buyer is preparing an offer."],
  draft_commitments: [{ text: "Send the signed offer.", dueAt: "2026-01-02T00:00:00.000Z" }],
  draft_followups: [{ text: "Check for the signed offer." }],
};

const envKeys = ["AI_ENABLED", "AI_GROW_CALL_SUMMARY_ENABLED", "AI_TIMEOUT_MS"] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of envKeys) savedEnv.set(key, process.env[key]);

function enabled(): void {
  process.env.AI_ENABLED = "true";
  process.env.AI_GROW_CALL_SUMMARY_ENABLED = "true";
}

afterEach(() => {
  setCallTranscriptionDraftGatewayForTests(null);
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("returns null fields and does not call the gateway when the Grow flag is off", async () => {
  process.env.AI_ENABLED = "true";
  process.env.AI_GROW_CALL_SUMMARY_ENABLED = "false";
  let calls = 0;
  setCallTranscriptionDraftGatewayForTests(async () => {
    calls++;
    throw new Error("must not call");
  });
  assert.deepEqual(await generateCallTranscriptionDrafts(input), {
    draftSummary: null,
    draftKeyPoints: null,
    draftCommitments: null,
    draftFollowups: null,
  });
  assert.equal(calls, 0);
});

test("master AI off wins over the Grow summary flag", async () => {
  process.env.AI_ENABLED = "false";
  process.env.AI_GROW_CALL_SUMMARY_ENABLED = "true";
  let calls = 0;
  setCallTranscriptionDraftGatewayForTests(async () => {
    calls++;
    throw new Error("must not call");
  });
  assert.equal((await generateCallTranscriptionDrafts(input)).draftSummary, null);
  assert.equal(calls, 0);
});

test("maps a valid response and assigns deterministic server-owned IDs", async () => {
  enabled();
  setCallTranscriptionDraftGatewayForTests(async (request, config) => {
    assert.match(request.userPrompt, /UNTRUSTED TRANSCRIPT CONTEXT/);
    assert.match(request.userPrompt, /signed offer/);
    assert.equal(config.retryLimit, 0);
    assert.equal(config.fallbackProvider, config.provider);
    return { response: { provider: "test", model: config.model, text: JSON.stringify(validResponse), usage: {
      promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0,
    }, latencyMs: 1 }, usedFallback: false };
  });
  assert.deepEqual(await generateCallTranscriptionDrafts(input), {
    draftSummary: validResponse.draft_summary,
    draftKeyPoints: [{ id: "kp-1", text: "Buyer is preparing an offer." }],
    draftCommitments: [{ id: "commitment-1", text: "Send the signed offer.", dueAt: "2026-01-02T00:00:00.000Z" }],
    draftFollowups: [{ id: "followup-1", text: "Check for the signed offer." }],
  });
});

test("returns all null fields for provider failures", async () => {
  enabled();
  setCallTranscriptionDraftGatewayForTests(async () => {
    throw new Error("provider failure");
  });
  assert.equal((await generateCallTranscriptionDrafts(input)).draftKeyPoints, null);
});

test("returns on the bounded deadline even when a fake gateway never resolves", async () => {
  enabled();
  process.env.AI_TIMEOUT_MS = "10";
  setCallTranscriptionDraftGatewayForTests(() => new Promise<never>(() => undefined));
  const started = Date.now();
  assert.equal((await generateCallTranscriptionDrafts(input)).draftSummary, null);
  assert.ok(Date.now() - started < 500);
});

test("a late provider settlement cannot change the timeout result or reject the test", async () => {
  enabled();
  process.env.AI_TIMEOUT_MS = "10";
  let resolveLate!: (value: never) => void;
  const late = new Promise<never>((resolve) => { resolveLate = resolve; });
  setCallTranscriptionDraftGatewayForTests(() => late);
  assert.equal((await generateCallTranscriptionDrafts(input)).draftSummary, null);
  resolveLate(undefined as never);
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("rejects malformed JSON, wrong arrays, oversized values, and model-owned IDs atomically", async () => {
  enabled();
  const cases: unknown[] = [
    "{not-json",
    { ...validResponse, draft_key_points: "not-an-array" },
    { ...validResponse, draft_summary: "x".repeat(5001) },
    { ...validResponse, draft_key_points: [{ text: "x".repeat(1001) }] },
    { ...validResponse, draft_key_points: Array.from({ length: 21 }, () => "too many") },
    { ...validResponse, draft_key_points: [{ id: "model-authority", text: "x" }] },
  ];
  for (const response of cases) {
    setCallTranscriptionDraftGatewayForTests(async () => ({
      response: { provider: "test", model: "test", text: typeof response === "string" ? response : JSON.stringify(response), usage: {
        promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
      }, latencyMs: 0 }, usedFallback: false,
    }));
    assert.deepEqual(await generateCallTranscriptionDrafts(input), {
      draftSummary: null,
      draftKeyPoints: null,
      draftCommitments: null,
      draftFollowups: null,
    });
  }
});

test("duplicate transcript items remain drafts but still receive unique index IDs", async () => {
  enabled();
  setCallTranscriptionDraftGatewayForTests(async () => ({
    response: { provider: "test", model: "test", text: JSON.stringify({
      ...validResponse,
      draft_key_points: ["same point", "same point"],
    }), usage: {
      promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
    }, latencyMs: 0 }, usedFallback: false,
  }));
  const result = await generateCallTranscriptionDrafts(input);
  assert.deepEqual(result.draftKeyPoints, [
    { id: "kp-1", text: "same point" },
    { id: "kp-2", text: "same point" },
  ]);
});
