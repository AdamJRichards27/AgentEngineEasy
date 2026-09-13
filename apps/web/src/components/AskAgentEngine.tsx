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
  // AE GROW Priority 6 Stage C: "coach" switches this same shared component
  // into the read-only AI Business Coach (mode: "coach" on the shared
  // POST /ai/ask endpoint) instead of Grow's own Ask AE. Defaults to "ask"
  // so every existing call site (which never passes this prop) is
  // completely unaffected. Only meaningful together with contextType
  // "grow" - the same restriction routes/ai.ts's own schema enforces
  // server-side; this component never sends "coach" for any other
  // contextType.
  mode?: "ask" | "coach";
}

interface AiSupportingRecord {
  recordType: string;
  recordId: number;
  label: string;
  deepLink: string | null;
}

// AE GROW Priority 6 Stage C — the coaching period keys this UI actually
// offers (see COACH_PERIOD_TABS/COACH_STARTING_OPTIONS below). The backend's
// own CoachingPeriodKey (coaching/period.ts) also accepts "previousPeriod"
// and "custom" - neither is needed here because every starting option and
// period tab this UI exposes is fully covered by these three, and a custom
// date-range picker is not part of this stage's scope.
type CoachingPeriodKey = "last7days" | "last30days" | "currentMonth";

type CoachingEvidenceStrength = "Preliminary" | "Moderate" | "Strong";

interface CoachingPeriodView {
  key: string;
  label: string;
  start: string;
  end: string;
  isComplete: boolean;
  durationDays: number;
  timeBasis: string;
}

interface CoachingRecommendation {
  action: string;
  reason: string;
  relatedMetric?: string;
  relatedRecordLabel?: string;
  suggestedTimeframe?: string;
  progressMeasure?: string;
  evidenceStrength?: CoachingEvidenceStrength;
}

interface CoachingSupportingMetric {
  key: string;
  label: string;
  value: string;
  definition: string;
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
  // AE GROW Priority 6 Stage C — Business Coach Response Contract
  // additions. undefined for every non-coach (RUN Copilot and plain Grow
  // Ask AE) response, mirroring apps/api/src/lib/ai/types.ts's
  // AiStructuredResponse exactly - only set when mode is "coach".
  headline?: string;
  period?: CoachingPeriodView;
  performanceSummary?: string;
  observations?: string[];
  strengths?: string[];
  focusAreas?: string[];
  recommendations?: CoachingRecommendation[];
  supportingMetrics?: CoachingSupportingMetric[];
  suggestedReviewDate?: string;
}

interface AskCopilotResult {
  requestId: string;
  response: AiStructuredResponse;
}

interface AiCapabilities {
  tier: string;
  copilotEnabled: boolean;
  // AE GROW Priority 6 Stage C — additive. Reported alongside
  // copilotEnabled so this component can gate the Business Coach on its own
  // feature flag/entitlement without a second request.
  businessCoachEnabled: boolean;
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

// AE GROW Priority 6 Stage C — the period selector shown for the Business
// Coach only. Deliberately a small, fixed set (see the CoachingPeriodKey
// comment above) rather than a free-form date-range picker.
const COACH_PERIOD_TABS: Array<{ key: CoachingPeriodKey; label: string }> = [
  { key: "last7days", label: "Last 7 days" },
  { key: "last30days", label: "Last 30 days" },
  { key: "currentMonth", label: "This month" },
];

// AE GROW Priority 6 Stage C — the Business Coach's own starting prompts,
// mirroring GROW_EXAMPLE_QUESTIONS' role for Ask AE above but each one also
// carrying the coaching period it makes sense to ask against, so clicking a
// chip both fills the question and selects the matching period tab in one
// action. None of these imply AE will do anything on the agent's behalf -
// every one is a read-only question about the agent's own already-recorded
// Grow data, consistent with this stage's read-only-analysis-only scope.
const COACH_STARTING_OPTIONS: Array<{ label: string; period: CoachingPeriodKey }> = [
  { label: "Review my last 7 days", period: "last7days" },
  { label: "Review my last 30 days", period: "last30days" },
  { label: "Where is my pipeline stalling?", period: "last30days" },
  { label: "What should I focus on this week?", period: "last7days" },
  { label: "How consistent is my follow-up?", period: "last30days" },
  { label: "Which appraisals need attention?", period: "last30days" },
  { label: "Compare this month with last month", period: "currentMonth" },
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
//
// AE GROW Priority 6 Stage C extends it again for mode="coach" (the AI
// Business Coach) rather than building a second read-only AI surface - see
// pages/Grow.tsx's GrowBusinessCoachTab for where mode="coach" is passed
// in. Both extensions share this one component because they are the same
// kind of thing (a single question in, one structured, labelled, read-only
// answer out) - only the request payload, the shape of the structured
// answer, and the starting prompts differ.
export function AskAgentEngine({ contextType, contextId, growFocusItemId, mode }: AskAgentEngineProps) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskCopilotResult | null>(null);
  const isGrow = contextType === "grow";
  const isCoach = mode === "coach";
  // AE GROW Priority 6 Stage C — which coaching period the next question
  // (whether a starting option or a freely typed follow-up) is asked
  // against. Only ever read/sent when isCoach; harmless, inert state for
  // every existing (non-coach) call site.
  const [coachPeriod, setCoachPeriod] = useState<CoachingPeriodKey>("last7days");

  const { data: capabilities } = useQuery({
    queryKey: ["ai-capabilities"],
    queryFn: () => apiFetch<AiCapabilities>("/ai/capabilities"),
  });

  const ask = useMutation({
    mutationFn: (input: { question: string; period?: CoachingPeriodKey }) =>
      apiFetch<AskCopilotResult>("/ai/ask", {
        method: "POST",
        body: JSON.stringify(
          isCoach
            ? { question: input.question, contextType, contextId, mode: "coach", period: input.period }
            : { question: input.question, contextType, contextId, growFocusItemId: growFocusItemId ?? null },
        ),
      }),
    onSuccess: (data) => setResult(data),
  });

  const capabilityEnabled = isCoach ? capabilities?.businessCoachEnabled : capabilities?.copilotEnabled;
  if (capabilities !== undefined && capabilityEnabled === false) {
    return null;
  }

  const askQuestion = (text: string) => {
    if (text.trim().length === 0 || ask.isPending) {
      return;
    }
    setQuestion(text);
    ask.mutate(isCoach ? { question: text, period: coachPeriod } : { question: text });
  };

  // AE GROW Priority 6 Stage C — a Business Coach starting option carries
  // its own period alongside its question text, so selecting one asks
  // immediately against the right period rather than requiring a second,
  // separate period-tab click first.
  const askCoachOption = (option: { label: string; period: CoachingPeriodKey }) => {
    if (ask.isPending) {
      return;
    }
    setCoachPeriod(option.period);
    setQuestion(option.label);
    ask.mutate({ question: option.label, period: option.period });
  };

  return (
    <section className="card ai-copilot">
      <h2>{isCoach ? "Business Coach" : isGrow ? "Ask AE" : "Ask Agent Engine"}</h2>
      <p className="muted">
        {isCoach
          ? "Read-only. The Business Coach looks at your own Grow activity, commitments, opportunities, and appraisals already recorded and summarises how things are going and what you might focus on next - it cannot contact anyone, send anything, or change any record, and every figure comes from your own logged data, never a prediction."
          : isGrow
            ? "Read-only. Ask AE can only describe your own Grow relationship data already visible in Grow Today - it cannot contact anyone, send anything, or change any record."
            : "Read-only. Copilot can only describe information already on this record - it cannot send anything or change anything."}
      </p>
      {isCoach && (
        <nav className="pc-tabs ai-coach-period-tabs" aria-label="Coaching period">
          {COACH_PERIOD_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`pc-tab${coachPeriod === t.key ? " active" : ""}`}
              aria-current={coachPeriod === t.key ? "true" : undefined}
              onClick={() => setCoachPeriod(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
      {isGrow && !isCoach && result === null && !ask.isPending && (
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
      {isCoach && result === null && !ask.isPending && (
        <div className="ai-copilot-examples">
          <p className="muted">Try asking:</p>
          <div className="ai-copilot-example-chips">
            {COACH_STARTING_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => askCoachOption(option)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="ai-copilot-input">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            isCoach
              ? "e.g. What should I focus on this week?"
              : isGrow
                ? "e.g. Who should I follow up with today?"
                : "e.g. What's the AML status on this property?"
          }
          aria-label={isCoach ? "Ask the Business Coach a question" : isGrow ? "Ask AE a question" : "Ask Agent Engine a question"}
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
            // AE GROW Priority 6 Stage C — the Business Coach's own 403/5xx
            // copy names the Coach specifically, checked ahead of the plain
            // Grow branches below (isCoach implies isGrow, so the order here
            // matters) rather than reusing Ask AE's "Ask AE for Grow..."
            // wording for a surface that was never Ask AE.
            if (isCoach && err.status === 403) {
              return (
                <p className="error-text">
                  The Business Coach requires a Grow or Pro plan. Ask a Brokerage Administrator if you believe this
                  is wrong.
                </p>
              );
            }
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
            if (isCoach && err.status >= 500) {
              return <p className="error-text">The Business Coach is temporarily unavailable. {err.friendly}</p>;
            }
            if (isGrow && err.status >= 500) {
              return <p className="error-text">Ask AE is temporarily unavailable. {err.friendly}</p>;
            }
            return <p className="error-text">{err.friendly}</p>;
          })()}
        {!isCoach && result !== null && (
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
        {/* AE GROW Priority 6 Stage C — the Business Coach's own response
            layout: visually separate sections for the performance snapshot,
            what's working, what needs attention, the top priorities, the
            evidence behind them, the standing limitations, and the
            suggested next review date - never a single undifferentiated
            paragraph. A section renders only when it has content (e.g. a
            brokerage with nothing currently stalling has no "what needs
            attention" section at all) rather than showing an empty
            "nothing to report" heading. */}
        {isCoach && result !== null && (
          <div className="ai-copilot-answer">
            <div className="eyebrow ai-copilot-kind-advisory">Business Coach</div>
            {result.response.headline !== undefined && (
              <h3>
                {result.response.headline}
                {result.response.period !== undefined && <span className="pill">{result.response.period.label}</span>}
              </h3>
            )}
            <p>{result.response.summary}</p>
            {result.response.performanceSummary !== undefined && (
              <section className="ai-coach-section">
                <h4>Performance snapshot</h4>
                <p>{result.response.performanceSummary}</p>
                {result.response.observations !== undefined && result.response.observations.length > 0 && (
                  <ul>
                    {result.response.observations.map((observation) => (
                      <li key={observation}>{observation}</li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            {result.response.strengths !== undefined && result.response.strengths.length > 0 && (
              <section className="ai-coach-section">
                <h4>What&rsquo;s working</h4>
                <ul>
                  {result.response.strengths.map((strength) => (
                    <li key={strength}>{strength}</li>
                  ))}
                </ul>
              </section>
            )}
            {result.response.focusAreas !== undefined && result.response.focusAreas.length > 0 && (
              <section className="ai-coach-section">
                <h4>What needs attention</h4>
                <ul>
                  {result.response.focusAreas.map((focusArea) => (
                    <li key={focusArea}>{focusArea}</li>
                  ))}
                </ul>
              </section>
            )}
            {result.response.recommendations !== undefined && result.response.recommendations.length > 0 && (
              <section className="ai-coach-section">
                <h4>Top priorities</h4>
                <ol className="ai-coach-recommendations">
                  {result.response.recommendations.map((recommendation, index) => (
                    <li className="ai-coach-recommendation" key={index}>
                      <p className="ai-coach-recommendation-action">{recommendation.action}</p>
                      <p className="muted">{recommendation.reason}</p>
                      {(recommendation.suggestedTimeframe !== undefined || recommendation.evidenceStrength !== undefined) && (
                        <p className="muted">
                          {[
                            recommendation.suggestedTimeframe,
                            recommendation.evidenceStrength !== undefined ? `${recommendation.evidenceStrength} evidence` : undefined,
                          ]
                            .filter((part): part is string => part !== undefined)
                            .join(" · ")}
                        </p>
                      )}
                      {recommendation.progressMeasure !== undefined && <p className="muted">{recommendation.progressMeasure}</p>}
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {result.response.supportingMetrics !== undefined && result.response.supportingMetrics.length > 0 && (
              <section className="ai-coach-section">
                <h4>Evidence</h4>
                <div className="stat-tiles">
                  {result.response.supportingMetrics.map((metric) => (
                    <div className="stat-tile" key={metric.key} title={metric.definition}>
                      <div className="stat-tile-label">{metric.label}</div>
                      <div className="stat-tile-value">{metric.value}</div>
                    </div>
                  ))}
                </div>
              </section>
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
            {(result.response.dataFreshness !== undefined || result.response.suggestedReviewDate !== undefined) && (
              <p className="muted ai-copilot-freshness">
                {result.response.dataFreshness !== undefined && `Data as of ${formatDataFreshness(result.response.dataFreshness)}`}
                {result.response.dataFreshness !== undefined && result.response.suggestedReviewDate !== undefined && " — "}
                {result.response.suggestedReviewDate !== undefined &&
                  `Suggested next review: ${formatDataFreshness(result.response.suggestedReviewDate)}`}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
