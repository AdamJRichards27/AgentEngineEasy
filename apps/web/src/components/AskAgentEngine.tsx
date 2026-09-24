import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";
// AE GROW Priority 6 Stage F4.3 — the Stage D proposal review card now lives
// in its own module so the call follow-up and Contact 360 surfaces reuse
// exactly the same governed approve/reject/execute behaviour.
import { GrowCommitmentProposalCard } from "./GrowCommitmentProposalCard";
import { viewFromAskAgentProposal, type AskAgentCommitmentProposal } from "../lib/commitmentProposals";
import { ASK_DUE_FOLLOW_UPS_QUESTION } from "../lib/growTerms";
// AE GROW Pilot Readiness WP6b (P3-b) — the feature-flag gate below, extracted
// so "a disabled Grow tab still says something" is unit-testable.
import { aiSurfaceAvailability, aiSurfaceUnavailableCopy } from "../lib/aiCapability";
// AE GROW Priority 6 Stage E — Voice as Input. The recording lifecycle
// itself (permission/MIME/duration/error handling, the state machine) is
// extracted into lib/voiceRecording.ts so it can be unit tested without a
// browser — see that module's own header comment. This component is a
// thin, mostly-declarative renderer of the state it produces.
import {
  createVoiceRecordingController,
  createBrowserVoiceRecordingDeps,
  formatElapsedTime,
  MAX_RECORDING_SECONDS,
  type VoiceRecordingState,
  type VoiceRecordingController,
} from "../lib/voiceRecording";

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

// AE GROW Priority 6 Stage C timezone remediation: `timeZone` is additive -
// the backend's PeriodView (coaching/period.ts) now always includes it
// (the IANA identifier the period's calendar boundaries were actually
// resolved against, e.g. "Australia/Brisbane"), shown directly in the
// period pill below per the Project Owner's UI disclosure requirement
// ("Last 7 days · Australia/Brisbane").
interface CoachingPeriodView {
  key: string;
  label: string;
  start: string;
  end: string;
  isComplete: boolean;
  durationDays: number;
  timeZone: string;
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

// AE GROW Priority 6 Stage D — mirrors the backend's
// GrowCommitmentProposalSummary (apps/api/src/lib/ai/types.ts) exactly.
// Undefined for every response that never grounded a proposal (every
// non-Grow response, and most Grow/Coach responses too — this is the
// exception, not the rule). Deliberately excludes the internal tamper
// hash/authority fields the backend's own Response Contract comment says
// never to return to a client — this UI only ever needs enough to show a
// human what is being proposed and to call the existing, unmodified
// governance endpoints (`/ai/actions/requests/:id/{approve,reject,execute}`)
// by id. Since Stage F4.3 the shape itself lives in lib/commitmentProposals.ts
// alongside the shared card's pure logic.
type GrowCommitmentProposalSummary = AskAgentCommitmentProposal;

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
  // AE GROW Priority 6 Stage D — additive. Set on either a plain Grow Ask
  // AE response or a Business Coach response (never on a RUN Copilot
  // response) only when the orchestrator actually grounded and created (or
  // found an already-open) CREATE_GROW_COMMITMENT proposal for this
  // request. Rendered by GrowCommitmentProposalCard below, regardless of
  // isCoach — the same review surface serves both, since both are just
  // this one shared component.
  proposedCommitment?: GrowCommitmentProposalSummary;
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
  ASK_DUE_FOLLOW_UPS_QUESTION,
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

// AE GROW Priority 6 Stage E — a small, self-contained mic glyph so the
// voice control needs no new icon-font/asset dependency. Defined once at
// module scope (never recreated per render).
const MIC_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

// AE GROW Priority 6 Stage E — the voice states that mean "something the
// agent should be told about went wrong", each rendered with its own
// dismissible error strip. "cancelled" and "transcript_ready" are
// deliberately excluded: cancellation is a silent, deliberate no-op (it
// must never look like a failure), and a ready transcript's own feedback
// is the populated text input, not a banner.
const VOICE_ERROR_STATES: readonly VoiceRecordingState[] = [
  "permission_denied",
  "no_microphone",
  "upload_too_large",
  "rate_limited",
  "provider_unavailable",
  "transcription_failed",
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
//
// AE GROW Priority 6 Stage D extends it a third time: when a response
// (from either the plain Grow Ask AE path or the Business Coach path)
// carries a proposedCommitment, this component also renders
// GrowCommitmentProposalCard immediately below the answer — the required
// "review surface within the existing Grow Ask AE / Business Coach
// experience", not a fourth, separate screen. The read-only answer itself
// is completely unaffected either way: proposedCommitment is additive, and
// nothing about asking a question ever becomes not-read-only merely
// because a proposal was also attached to the answer.
//
// AE GROW Priority 6 Stage E extends it a fourth time: a small mic control
// beside the existing text input lets the agent speak their question
// instead of typing it. Voice is always Grow-scoped (there is no non-Grow
// voice surface — see apps/api/src/routes/aiVoice.ts's own header
// comment), so the control only ever renders when isGrow, covering both
// plain Ask AE (isCoach false) and the Business Coach (isCoach true). A
// transcript only ever populates the existing `question` state below —
// exactly as if the agent had typed it — and is never submitted
// automatically; the agent still has to press the existing Ask button.
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

  // AE GROW Priority 6 Stage E — voice input state, driven entirely by the
  // controller's own callbacks (see the effect below). Kept as plain local
  // state, matching every other piece of UI state in this component,
  // rather than introducing a second state-management approach for one
  // control.
  const voiceControllerRef = useRef<VoiceRecordingController | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceRecordingState>("idle");
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = useState(0);
  const [voiceErrorMessage, setVoiceErrorMessage] = useState<string | null>(null);

  // Created once per (isGrow, isCoach) combination — recreated only if
  // this same mounted component's mode ever changes, which disposes the
  // previous controller first (releasing any held microphone) rather than
  // leaking it. Never created at all outside Grow, since voice has no
  // non-Grow surface.
  useEffect(() => {
    if (!isGrow) {
      voiceControllerRef.current = null;
      return;
    }
    const controller = createVoiceRecordingController(createBrowserVoiceRecordingDeps(isCoach ? "coach" : "ask"), {
      onStateChange: (next) => setVoiceState(next),
      onElapsedSecondsChange: (seconds) => setVoiceElapsedSeconds(seconds),
      onTranscript: (transcript) => {
        // The ENTIRE effect of a completed transcription: populate the
        // same, already-existing question textbox a typed question would
        // use. Never calls ask.mutate — the agent must still press Ask.
        setQuestion(transcript);
      },
      onErrorMessage: (message) => setVoiceErrorMessage(message),
    });
    voiceControllerRef.current = controller;
    setVoiceState(controller.getState());
    setVoiceElapsedSeconds(0);
    setVoiceErrorMessage(null);
    return () => {
      // Ensures the microphone is never left active, no timer keeps
      // running, and no in-flight upload keeps waiting, once this
      // component unmounts (e.g. the agent navigates away mid-recording).
      controller.dispose();
      voiceControllerRef.current = null;
    };
  }, [isGrow, isCoach]);

  const handleVoiceMicClick = () => {
    void voiceControllerRef.current?.start();
  };
  const handleVoiceStopClick = () => {
    voiceControllerRef.current?.stop();
  };
  const handleVoiceCancelClick = () => {
    voiceControllerRef.current?.cancel();
  };
  const handleVoiceDismiss = () => {
    voiceControllerRef.current?.reset();
    setVoiceErrorMessage(null);
  };

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

  // AE GROW Pilot Readiness WP6b (P3-b) — when the surface's own feature flag
  // is off, a Grow tab (Performance/Ask AE) now says so instead of rendering
  // nothing at all: those tabs are destinations, and a blank one is
  // indistinguishable from a broken screen. RUN Copilot's embedded panel on a
  // property/transaction record keeps its existing behaviour (hidden
  // entirely), since there the panel is one optional block on an otherwise
  // full page. See lib/aiCapability.ts.
  const availability = aiSurfaceAvailability(capabilities, { isGrow, isCoach });
  if (availability === "hidden") {
    return null;
  }
  if (availability === "unavailable") {
    const copy = aiSurfaceUnavailableCopy(isCoach);
    return (
      <section className="card ai-copilot">
        <h2>{copy.title}</h2>
        <p className="muted">{copy.body}</p>
      </section>
    );
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
            ? "Read-only. Ask AE can only describe your own Grow relationship data already visible in Grow Today - it cannot contact anyone, send anything, or change any record. It may occasionally propose a commitment for you to review, but nothing is ever created until you explicitly approve it. A commitment is a recorded promise, not a due follow-up on an opportunity or appraisal."
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
        {/* AE GROW Priority 6 Stage E — the voice control. Only ever
            rendered for Grow (both plain Ask AE and the Business Coach) —
            voice has no non-Grow surface, matching the server's own
            always-Grow-scoped entitlement gate (aiVoice.ts). Text entry
            above remains fully available and unaffected in every voice
            state. */}
        {isGrow && voiceState === "unsupported" && (
          <button
            type="button"
            className="btn btn-secondary btn-small ai-copilot-voice-button"
            disabled
            aria-disabled="true"
            title="Voice input isn't supported in this browser — you can still type your question."
          >
            {MIC_ICON} Voice
          </button>
        )}
        {isGrow && voiceState === "requesting_permission" && (
          <span className="ai-copilot-voice-active">
            <span className="ai-copilot-loading">
              <span className="ai-copilot-spinner" aria-hidden="true" />
              Requesting microphone access…
            </span>
            <button type="button" className="btn btn-link btn-small" onClick={handleVoiceCancelClick}>
              Cancel
            </button>
          </span>
        )}
        {isGrow && (voiceState === "recording" || voiceState === "duration_limit_reached") && (
          <span className="ai-copilot-voice-active">
            <span aria-live="polite" aria-atomic="true">
              Recording… {formatElapsedTime(voiceElapsedSeconds)} / {formatElapsedTime(MAX_RECORDING_SECONDS)}
            </span>
            <button type="button" className="btn btn-primary btn-small" onClick={handleVoiceStopClick}>
              Stop
            </button>
            <button type="button" className="btn btn-link btn-small" onClick={handleVoiceCancelClick}>
              Cancel
            </button>
          </span>
        )}
        {isGrow && (voiceState === "stopping" || voiceState === "transcribing") && (
          <span className="ai-copilot-voice-active">
            <span className="ai-copilot-loading">
              <span className="ai-copilot-spinner" aria-hidden="true" />
              {voiceState === "stopping" ? "Finishing recording…" : "Transcribing…"}
            </span>
            <button type="button" className="btn btn-link btn-small" onClick={handleVoiceCancelClick}>
              Cancel
            </button>
          </span>
        )}
        {isGrow &&
          voiceState !== "unsupported" &&
          voiceState !== "requesting_permission" &&
          voiceState !== "recording" &&
          voiceState !== "duration_limit_reached" &&
          voiceState !== "stopping" &&
          voiceState !== "transcribing" && (
            <button
              type="button"
              className="btn btn-secondary btn-small ai-copilot-voice-button"
              onClick={handleVoiceMicClick}
              aria-label={isCoach ? "Ask the Business Coach with your voice" : "Ask AE with your voice"}
            >
              {MIC_ICON} Voice
            </button>
          )}
      </div>
      {isGrow && voiceErrorMessage !== null && VOICE_ERROR_STATES.includes(voiceState) && (
        <p className="error-text" role="alert">
          {voiceErrorMessage}{" "}
          <button type="button" className="btn btn-link btn-small" onClick={handleVoiceDismiss}>
            Dismiss
          </button>
        </p>
      )}
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
            const err = ask.error instanceof ApiError ? ask.error : null;
            // A non-ApiError (dropped connection, thrown string, plain Error)
            // has no status and no friendly sentence. The cast used to render
            // the word "undefined".
            if (!err) {
              return (
                <p className="error-text">
                  {isCoach
                    ? "The Business Coach is temporarily unavailable. Try again."
                    : isGrow
                      ? "Ask AE is temporarily unavailable. Try again."
                      : "Something went wrong. Try again."}
                </p>
              );
            }
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
                {/* AE GROW Priority 6 Stage C timezone remediation — the pill
                    now always names the resolved timezone alongside the
                    period label (e.g. "Last 7 days · Australia/Brisbane"),
                    per the Project Owner's UI disclosure requirement; the
                    fuller disclosure sentence (which brokerage/application
                    default was used) is available as a hover tooltip via
                    the existing `title=` pattern already used for
                    supportingMetrics below, rather than adding new visible
                    clutter. */}
                {result.response.period !== undefined && (
                  <span className="pill" title={result.response.period.timeBasis}>
                    {result.response.period.label} · {result.response.period.timeZone}
                  </span>
                )}
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
        {/* AE GROW Priority 6 Stage D — the proposed-commitment review
            surface. Shared between the plain Ask AE answer block and the
            Business Coach answer block above (both just set
            result.response.proposedCommitment the same way), so this
            renders once, right after whichever answer was shown, rather
            than being duplicated inside each block above. */}
        {result !== null && result.response.proposedCommitment !== undefined && (
          <GrowCommitmentProposalCard proposal={viewFromAskAgentProposal(result.response.proposedCommitment)} />
        )}
      </div>
    </section>
  );
}
