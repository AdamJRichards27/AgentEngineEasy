import type { AiProviderRequest, AiProviderResponse } from "../types.js";

// The provider-abstraction pattern used by every integration package in this repo
// (packages/integrations/{aml,esign,object-storage,payments,property-data}): a
// small interface plus a Mock implementation as the safe default, selected by an
// env var (AI_PROVIDER=mock|anthropic, see .env.example). Swapping in a real
// provider later never touches gateway.ts, orchestrator.ts, or any route.
export interface AiProvider {
  readonly name: string;
  generate(request: AiProviderRequest): Promise<AiProviderResponse>;
}
