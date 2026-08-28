import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";

interface AskAgentEngineProps {
  contextType: "property" | "transaction" | "business" | null;
  contextId: number | null;
}

interface AiStructuredResponse {
  kind: "fact" | "inference" | "recommendation" | "unknown";
  summary: string;
  details: string[];
  toolsUsed: string[];
  riskLevel: number;
  disclaimer?: string;
}

interface AskCopilotResult {
  requestId: string;
  response: AiStructuredResponse;
}

interface AiCapabilities {
  tier: string;
  copilotEnabled: boolean;
}

const KIND_LABEL: Record<string, string> = {
  fact: "Fact",
  inference: "Inference",
  recommendation: "Suggestion",
  unknown: "Unknown",
};

// Minimal contextual "Ask Agent Engine" UI - the one real role implementation
// this build ships (Copilot, Level 0/read-only only, see ARCHITECTURE.md
// "Phase 9: Contextual AI Architecture"). Deliberately not chat-styled: one
// question in, one structured answer out, always labelled with what kind of
// answer it is so the agent never mistakes a suggestion for a fact.
export function AskAgentEngine({ contextType, contextId }: AskAgentEngineProps) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskCopilotResult | null>(null);

  const { data: capabilities } = useQuery({
    queryKey: ["ai-capabilities"],
    queryFn: () => apiFetch<AiCapabilities>("/ai/capabilities"),
  });

  const ask = useMutation({
    mutationFn: () =>
      apiFetch<AskCopilotResult>("/ai/ask", {
        method: "POST",
        body: JSON.stringify({ question, contextType, contextId }),
      }),
    onSuccess: (data) => setResult(data),
  });

  if (capabilities !== undefined && capabilities.copilotEnabled === false) {
    return null;
  }

  return (
    <section className="card ai-copilot">
      <h2>Ask Agent Engine</h2>
      <p className="muted">
        Read-only. Copilot can only describe information already on this record - it cannot send anything or change anything.
      </p>
      <div className="ai-copilot-input">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. What's the AML status on this property?"
          onKeyDown={(e) => {
            if (e.key === "Enter" && question.trim().length > 0) {
              ask.mutate();
            }
          }}
        />
        <button
          className="btn btn-secondary"
          disabled={question.trim().length === 0 || ask.isPending}
          onClick={() => ask.mutate()}
        >
          {ask.isPending ? "Asking..." : "Ask"}
        </button>
      </div>
      {ask.isError && <p className="error-text">{(ask.error as ApiError).friendly}</p>}
      {result !== null && (
        <div className="ai-copilot-answer">
          <div className="eyebrow">{KIND_LABEL[result.response.kind] ?? result.response.kind}</div>
          <p>{result.response.summary}</p>
          {result.response.disclaimer !== undefined && <p className="muted">{result.response.disclaimer}</p>}
        </div>
      )}
    </section>
  );
}
