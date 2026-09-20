import { MockAiProvider } from "./providers/mockProvider.js";
import { AnthropicAiProvider } from "./providers/anthropicProvider.js";
import type { AiProvider } from "./providers/provider.js";
import { AiProviderError } from "./types.js";
import type { AiProviderRequest, AiProviderResponse } from "./types.js";
import { logger } from "@aee/events";
import { mustForceMockAiProvider } from "../env.js";

// AI Gateway: the one place that knows how to reach a model provider. Config is
// env-driven today (AI_PROVIDER, AI_MODEL, ... - see .env.example), mirroring
// <DOMAIN>_PROVIDER for every other integration. packages/db/src/schema/ai.ts's
// aiConfigurations table exists for a future per-brokerage override but is not
// yet read here - DEFERRED, see the completion report.
export interface AiGatewayConfig {
  provider: string;
  fallbackProvider: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  retryLimit: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadAiGatewayConfig(): AiGatewayConfig {
  return {
    provider: process.env.AI_PROVIDER ?? "mock",
    fallbackProvider: process.env.AI_FALLBACK_PROVIDER ?? "mock",
    model: process.env.AI_MODEL ?? "claude-sonnet-4-5",
    temperature: envFloat("AI_TEMPERATURE", 0.2),
    maxOutputTokens: envInt("AI_MAX_OUTPUT_TOKENS", 1024),
    timeoutMs: envInt("AI_TIMEOUT_MS", 20000),
    retryLimit: envInt("AI_RETRY_LIMIT", 2),
  };
}

// AE GROW Pilot Readiness WP2a: a real provider additionally requires
// LIVE_AI_PROVIDER_APPROVED=true, in every environment (lib/env.ts
// mustForceMockAiProvider). Without it the gateway falls back to the mock
// provider with a warning — the same pattern this function already uses for
// a missing ANTHROPIC_API_KEY, and the mustForceMockExternalProvider()
// convention. Chosen over the transcription gates' typed-error pattern
// because an AI response is always labelled with the provider that actually
// answered (AiProviderResponse.provider, recorded in audit/telemetry) and the
// mock's own text says it is a placeholder, so nothing is passed off as real
// model output; failing every AI request instead would break the app for a
// configuration that is simply not yet approved.
const unapprovedProviderWarned = new Set<string>();

function buildProvider(name: string): AiProvider {
  if (name !== "mock" && mustForceMockAiProvider()) {
    // Once per process per requested provider — this runs on every request.
    if (!unapprovedProviderWarned.has(name)) {
      unapprovedProviderWarned.add(name);
      logger.warn("ai_provider_not_approved_fallback_to_mock", {
        requestedProvider: name,
        approvalFlag: "LIVE_AI_PROVIDER_APPROVED",
      });
    }
    return new MockAiProvider();
  }
  if (name === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (typeof apiKey === "string" && apiKey.length > 0) {
      return new AnthropicAiProvider(apiKey);
    }
    logger.warn("ai_provider_anthropic_api_key_missing_fallback_to_mock", {});
    return new MockAiProvider();
  }
  return new MockAiProvider();
}

export interface AiGenerateResult {
  response: AiProviderResponse;
  usedFallback: boolean;
  primaryError?: string;
}

// Retries the primary provider up to retryLimit times, then makes a single
// attempt against the fallback provider. Every AiGenerateResult says which
// provider actually answered so audit/telemetry is never silently blended.
export async function generateWithGateway(request: AiProviderRequest, config: AiGatewayConfig): Promise<AiGenerateResult> {
  const primary = buildProvider(config.provider);
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.retryLimit; attempt++) {
    try {
      const response = await primary.generate(request);
      return { response, usedFallback: false };
    } catch (err) {
      lastError = err;
    }
  }
  const primaryErrorMessage = lastError instanceof Error ? lastError.message : "unknown provider error";
  if (config.fallbackProvider === config.provider) {
    throw new AiProviderError(config.provider, primaryErrorMessage);
  }
  const fallback = buildProvider(config.fallbackProvider);
  const response = await fallback.generate(request);
  return { response, usedFallback: true, primaryError: primaryErrorMessage };
}
