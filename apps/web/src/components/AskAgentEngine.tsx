import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";

interface AskAgentEngineProps {
  // AE GROW Priority 6 Stage B: "grow" is additive - every existing caller
  // (Property Workspace, Command Centre, wherever "business"/"property"/
  // "transaction" is passed today) keeps compiling and behaving identically.
  contextType: "property" | "transaction" | "business" | "grow" | null;
  contextId: number | null;
  // Only meaningful when contextType is "grow" - a specific Grow Today item
  // id (e.g. "opportunity:123") to ask AE to explain. Optional so every
  // existing call site is unaffected.
  growFocusItemId?: string | null;
}

interface AiSupportingRecord {
  recordType: string;
  recordId: number;
  label: string;
  deepLink: string | null;
}

interface AiStructuredResponse {
  // AE GROW Priority 6 Stage B: "summary" and "indicator" are additive -
  // RUN Copilot never produces them, so every existing kind this component
  // already handled (fact/inference/recommendation/unknown) is unaffected.
  kind: "fact" | "inference" | "recommendation" | "unknown" | "summary" | "indicator";
  summary: string;
  details: string[];
  toolsUsed: string[];
  riskLevel: number;
  disclaimer?: string;
  // AE GROW Priority 6 Stage B — Response Contract additions. undefined for
  // every non-Grow (RUN Copilot) response, exactly as before this stage.
  supportingRecords?: AiSupportingRecord[];
  dataFreshness?: string;
  limitations?: string[];
  suggestedNextStep?: string;
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
  // AE GROW Priority 6 Stage B additions.
  summary: "Summary",
  indicator: "Indicator",
};

// AE GROW Priority 6 Stage B UX gate — Grow's Response Contract kinds must
// "look visually different" from one another, not only carry a different
// text label (accessibility requirement: colour must never be the sole
// differentiator, so the text label above remains the primary signal and
// this is purely a secondary reinforcement). Scoped to isGrow only, below,
// so RUN Copilot's existing, already-shipped plain .eyebrow treatment is
// completely unchanged. Reuses the same colour tokens the rest of the app
// already uses for verified/positive vs. advisory/interpretive states
// (--color-success, --color-warning-text) rather than inventing new ones.
const GROW_KIND_ACCENT_CLASS: Record<string, string> = {
  fact: "ai-copilot-kind-verified",
  summary: "ai-copilot-kind-verified",
  recommendation: "ai-copilot-kind-advisory",
  inference: "ai-copilot-kind-advisory",
  // unknown/indicator also get an explicit (contrast-safe, muted) accent
  // rather than falling through to the base .eyebrow orange - an automated
  // axe-core pass against this exact markup (see the Stage B report) found
  // the base .eyebrow/--color-primary combination fails WCAG AA contrast at
  // this font size; every other kind above already resolves to a token that
  // passes, so "unknown"/"indicator" are covered too rather than left as
  // the one remaining Grow kind still rendered in a failing colour.
  unknown: "ai-copilot-kind-neutral",
  indicator: "ai-copilot-kind-neutral",
};

// AE GROW Priority 6 Stage B — example prompts shown before the agent has
// asked anything, so a Grow-scoped Ask AE never opens to a blank input with
// no sense of what it can answer. Clicking one asks it immediately rather
// than just filling the box, matching how a "suggested question" chip
// behaves elsewhere in this app.
const GROW_EXAMPLE_QUESTIONS = [
  "Who should I call today?",
  "What follow-ups are overdue?",
  "What's my opportunity pipeline look like?",
  "Are there any appraisals that need attention?",
];

function formatDataFreshness(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Minimal contextual "Ask Agent Engine" UI - the one real role implementation
// this build ships (Copilot, Level 0/read-only only, see ARCHITECTURE.md
// "Phase 9: Contextual AI Architecture"). Deliberately not chat-styled: one
// question in, one structured answer out, always labelled with what kind of
// answer it is so the agent never mistakes a suggestion for a fact.
//
// AE GROW Priority 6 Stage B extends this same component for
// contextType="grow" rather than building a second Ask AE surface - see
// pages/Grow.tsx's GrowAskAETab for where "grow" is actually passed in.
export function AskAgentEngine({ contextType, contextId, growFocusItemId }: AskAgentEngineProps) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskCopilotResult | null>(null);
  const isGrow = contextType === "grow";

  const { data: capabilities } = useQuery({
    queryKey: ["ai-capabilities"],
    queryFn: () => apiFetch<AiCapabilities>("/ai/capabilities"),
  });

  const ask = useMutation({
    mutationFn: (askedQuestion: string) =>
      apiFetch<AskCopilotResult>("/ai/ask", {
        method: "POST",
        body: JSON.stringify({ question: askedQuestion, contextType, contextId, growFocusItemId: growFocusItemId ?? null }),
      }),
    onSuccess: (data) => setResult(data),
  });

  if (capabilities !== undefined && capabilities.copilotEnabled === false) {
    return null;
  }

  const askQuestion = (text: string) => {
    if (text.trim().length === 0 || ask.isPending) {
      return;
    }
    setQuestion(text);
    ask.mutate(text);
  };

  return (
    <section className="card ai-copilot">
      <h2>{isGrow ? "Ask AE" : "Ask Agent Engine"}</h2>
      <p className="muted">
        {isGrow
          ? "Read-only. Ask AE can only describe your own Grow relationship data already visible in Grow Today - it cannot contact anyone, send anything, or change any record."
          : "Read-only. Copilot can only describe information already on this record - it cannot send anything or change anything."}
      </p>
      {isGrow && result === null && !ask.isPending && (
        <div className="ai-copilot-examples">
          <p className="muted">Try asking:</p>
          <div className="ai-copilot-example-chips">
            {GROW_EXAMPLE_QUESTIONS.map((example) => (
              <button
                key={example}
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => askQuestion(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="ai-copilot-input">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={isGrow ? "e.g. Who should I follow up with today?" : "e.g. What's the AML status on this property?"}
          aria-label={isGrow ? "Ask AE a question" : "Ask Agent Engine a question"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && question.trim().length > 0) {
              askQuestion(question);
            }
          }}
        />
        <button
          className="btn btn-secondary"
          disabled={question.trim().length === 0 || ask.isPending}
          onClick={() => askQuestion(question)}
        >
          {ask.isPending ? "Asking..." : "Ask"}
        </button>
      </div>
      {/* AE GROW Priority 6 Stage B UX gate — a single live region for every
          dynamic outcome of asking a question (preparing/error/answer) so a
          screen reader announces the *result* once, rather than announcing
          nothing or announcing unrelated static copy above. aria-live is a
          non-visual attribute (no layout/behaviour change for RUN Copilot
          or Grow), so it is applied unconditionally rather than gated on
          isGrow. */}
      <div aria-live="polite" aria-atomic="true">
        {isGrow && ask.isPending && (
          <div className="ai-copilot-loading">
            <span className="ai-copilot-spinner" aria-hidden="true" />
            Preparing your answer…
          </div>
        )}
        {ask.isError &&
          (() => {
            const err = ask.error as ApiError;
            // AE GROW Priority 6 Stage B — distinct empty/permission-denied/
            // provider-unavailable/error states, per the Response Contract's
            // requirement that a denial never looks like a generic failure.
            if (isGrow && err.status === 403) {
              return (
                <p className="error-text">
                  Ask AE for Grow requires a Grow or Pro plan. Ask a Brokerage Administrator if you believe this is
                  wrong.
                </p>
              );
            }
            if (isGrow && err.status === 429) {
              return <p className="error-text">{err.friendly}</p>;
            }
            if (isGrow && err.status >= 500) {
              return <p className="error-text">Ask AE is temporarily unavailable. {err.friendly}</p>;
            }
            return <p className="error-text">{err.friendly}</p>;
          })()}
        {result !== null && (
          <div className="ai-copilot-answer">
            <div
              className={
                isGrow
                  ? `eyebrow ${GROW_KIND_ACCENT_CLASS[result.response.kind] ?? ""}`.trim()
                  : "eyebrow"
              }
            >
              {KIND_LABEL[result.response.kind] ?? result.response.kind}
            </div>
            <p>{result.response.summary}</p>
            {result.response.disclaimer !== undefined && <p className="muted">{result.response.disclaimer}</p>}
            {/* AE GROW Priority 6 Stage B — Response Contract rendering. Every
                field below is undefined for a non-Grow (RUN Copilot) response,
                so none of this renders outside contextType="grow". */}
            {result.response.supportingRecords !== undefined && result.response.supportingRecords.length > 0 && (
              <div className="ai-copilot-supporting-records">
                <p className="muted">Related:</p>
                <ul>
                  {result.response.supportingRecords.map((record) => (
                    <li key={`${record.recordType}-${record.recordId}`}>
                      {record.deepLink !== null ? <Link href={record.deepLink}>{record.label}</Link> : <span>{record.label}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.response.suggestedNextStep !== undefined && (
              <p className="muted">Suggested next step: {result.response.suggestedNextStep}</p>
            )}
            {result.response.dataFreshness !== undefined && (
              <p className="muted ai-copilot-freshness">Data as of {formatDataFreshness(result.response.dataFreshness)}</p>
            )}
            {result.response.limitations !== undefined && result.response.limitations.length > 0 && (
              <ul className="ai-copilot-limitations">
                {result.response.limitations.map((limitation) => (
                  <li key={limitation} className="muted">
                    {limitation}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
