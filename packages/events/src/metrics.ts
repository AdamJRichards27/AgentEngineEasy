// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// A minimal in-process metrics registry (counters + histograms), exposed
// in Prometheus text format by a secured endpoint (see
// apps/api/src/routes/metrics.ts). No new dependency (no prom-client) —
// the surface area needed here (a handful of named counters/histograms
// with small, fixed label sets) is small enough to implement directly and
// keeps this landing without touching package.json/pnpm-lock.yaml again.
//
// Cardinality discipline (Step 2's explicit requirement) is enforced at
// the type level, not just by convention: every metric below is declared
// with its full set of allowed label VALUES up front (METRIC_DEFINITIONS),
// and recordCounter/observeHistogram throw in development/test if called
// with a label value outside that set — so a future call site that (say)
// tries to label a metric with a raw brokerageId, email, or correlationId
// fails fast in tests rather than silently exploding a Prometheus
// timeseries cardinality in production. In production the same
// out-of-set value is coerced to "other" and a one-time warning is logged,
// rather than crashing a request path over an observability bug.

import { logger } from "./logger.js";

type LabelValues = Record<string, string>;

interface MetricDefinition {
  readonly help: string;
  /** Every label name this metric accepts, mapped to its full set of allowed values. A label value not in this set is coerced to "other" (see recordCounter/observeHistogram) — this is what keeps cardinality bounded no matter what a call site passes in. */
  readonly labels: Record<string, readonly string[]>;
}

const HTTP_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
const OUTCOME = ["success", "failure"] as const;
// Mirrors apps/api/src/lib/integrations/types.ts's INTEGRATION_CAPABILITIES
// values exactly (this package can't import from apps/api — wrong
// direction of the dependency graph — so the values are duplicated here;
// a capability added there without a matching entry here safely falls
// back to "other" rather than throwing, since new integration proofs are
// expected to ship ahead of a metrics-catalogue update).
const INTEGRATION_CAPABILITIES = ["portal.publishListing", "portal.updateListingStatus", "comms.sendSms", "payments.statusSync", "other"] as const;
const WEBHOOK_OUTCOMES = ["processed", "rejected", "duplicate", "failed"] as const;
const READINESS_STATUS = ["ok", "degraded", "unavailable"] as const;
// AE Step 2 closure — Part B: the funnel every inbound domain-webhook HTTP
// router (communications, financial) is tracked through. "received"/
// "accepted" are non-terminal funnel counters (every request that reaches
// the handler, then every request that clears signature+schema
// validation); the rest are terminal outcomes. Deliberately just ONE
// bounded label — never a providerEventId, brokerageId, phone/email, or
// raw provider error string — so this can never become a cardinality or
// PII leak no matter how many distinct providers/tenants send webhooks.
const WEBHOOK_ROUTER_OUTCOMES = ["received", "accepted", "invalid_signature", "schema_rejected", "replay_rejected", "success", "failure"] as const;

/** The authoritative, bounded-cardinality metric catalogue for this process. Adding a new metric means adding an entry here with its full label-value sets — never adding a recordCounter/observeHistogram call for a name that isn't declared. */
export const METRIC_DEFINITIONS = {
  http_requests_total: {
    help: "Total HTTP requests handled, by method and response status class.",
    labels: { method: ["GET", "POST", "PUT", "PATCH", "DELETE", "other"], status_class: HTTP_STATUS_CLASSES },
  },
  http_request_duration_ms: {
    help: "HTTP request duration in milliseconds, by method and response status class.",
    labels: { method: ["GET", "POST", "PUT", "PATCH", "DELETE", "other"], status_class: HTTP_STATUS_CLASSES },
  },
  integration_outbox_dispatch_total: {
    help: "Integration outbox dispatch attempts, by capability and outcome.",
    labels: { capability: INTEGRATION_CAPABILITIES, outcome: [...OUTCOME, "retry_scheduled", "reconciled"] },
  },
  integration_webhook_total: {
    help: "Inbound integration webhook deliveries, by provider-agnostic outcome.",
    labels: { outcome: WEBHOOK_OUTCOMES },
  },
  integration_dead_letter_total: {
    help: "Items written to the integration dead-letter store, by source.",
    labels: { source_type: ["OUTBOX", "INBOX"] },
  },
  integration_replay_total: {
    help: "Authorised dead-letter replay attempts, by outcome.",
    labels: { outcome: OUTCOME },
  },
  exceptions_scan_total: {
    help: "Risk exception scan passes completed, by trigger.",
    labels: { trigger: ["SCHEDULED", "MANUAL", "EVENT_DRIVEN"] },
  },
  health_check_duration_ms: {
    help: "Readiness health check duration in milliseconds, by resulting status.",
    labels: { status: READINESS_STATUS },
  },
  domain_event_publish_total: {
    help: "Domain events published, by dispatch outcome.",
    labels: { outcome: ["ok", "partial_failure"] },
  },
  communications_webhook_total: {
    help: "Inbound communications provider webhook requests at the HTTP router boundary (routes/communicationsWebhooks.ts), by outcome.",
    labels: { outcome: WEBHOOK_ROUTER_OUTCOMES },
  },
  communications_webhook_duration_ms: {
    help: "Inbound communications provider webhook request handling duration in milliseconds, by terminal outcome.",
    labels: { outcome: WEBHOOK_ROUTER_OUTCOMES },
  },
  financial_webhook_total: {
    help: "Inbound financial mandate-payment provider webhook requests at the HTTP router boundary (routes/financialWebhooks.ts), by outcome.",
    labels: { outcome: WEBHOOK_ROUTER_OUTCOMES },
  },
  financial_webhook_duration_ms: {
    help: "Inbound financial mandate-payment provider webhook request handling duration in milliseconds, by terminal outcome.",
    labels: { outcome: WEBHOOK_ROUTER_OUTCOMES },
  },
  // AE Step 2 closure — Part B critical metric gaps. Every label set below
  // is as small and non-identifying as the existing catalogue above —
  // never a userId/brokerageId/email/correlationId. See
  // docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md for the SLI/alert definition that goes
  // with each of these (this process has no deployed Prometheus/Grafana —
  // the alert rules are documented as the design contract a real
  // Alertmanager/Grafana deployment would consume, not wired to a live
  // alerting backend that doesn't exist in this build).
  auth_security_event_total: {
    help: "Security-relevant authentication events (never successful logins) — a proxy for credential-stuffing / session-replay / dev-auth-probing attack patterns.",
    labels: { event: ["invalid_session_token", "revoked_session_reused", "dev_login_disabled_attempt", "auth_rate_limited"] },
  },
  tenant_isolation_rejection_total: {
    help: "A request or lookup was rejected because the resolved record belongs to a different brokerage than the caller's — every occurrence is a cross-tenant access attempt, whether malicious or a stale/incorrect id.",
    labels: { boundary: ["property", "party", "transaction", "financial", "communications", "integrations", "pit_crew", "grow", "other"] },
  },
  queue_backlog_size: {
    help: "Current count of not-yet-dispatched items in a background processing queue, sampled at read time.",
    labels: { queue: ["integration_outbox", "financial_payment_outbox", "communications_outbox"] },
  },
  queue_oldest_item_age_ms: {
    help: "Age in milliseconds of the oldest not-yet-dispatched item in a background processing queue, sampled at read time.",
    labels: { queue: ["integration_outbox", "financial_payment_outbox", "communications_outbox"] },
  },
  job_repeated_failure_total: {
    help: "A background job/command exhausted its retry budget and was dead-lettered (a repeated, non-transient failure) — see integration_dead_letter_total for the integration-specific version this generalises.",
    labels: { job: ["integration_outbox_command", "financial_payment_outbox_command", "communications_outbox_message"] },
  },
  ai_action_decision_total: {
    help: "AI action policy decisions, by allow/deny outcome — a sustained shift toward denied is a signal of either a misconfigured entitlement or an AI attempting actions outside its granted scope.",
    labels: { outcome: ["allowed", "denied"] },
  },
  workflow_execution_failure_total: {
    help: "A workflow step or automation-engine rule execution failed (threw or could not complete), by workflow family.",
    labels: { workflow: ["ready_to_list", "automation_rule", "launch_plan", "other"] },
  },
  unresolved_critical_risk_gauge: {
    help: "Current count of OPEN risk_exceptions rows at CRITICAL severity, sampled at read time — the Exception & Risk Engine's own definition of a critical unresolved risk.",
    labels: { status: ["open"] },
  },
  integration_connection_degraded_total: {
    help: "An integration connection's health check or dispatch path reported degraded/unavailable provider behaviour (distinct from a single failed webhook/outbox item — this tracks sustained provider-side degradation).",
    labels: { provider: ["mock_portal_v1", "mock_sms_v1", "mock_payment_status_v1", "other"] },
  },
  // AE GROW "Brokerage-wide Signal Sweep" stage 1. Three metrics, all with
  // tiny closed label sets — never a brokerageId, partyId, propertyId,
  // dedupeKey or rule name, so a tenant with a million contacts adds exactly
  // zero series. Per-brokerage detail belongs in the structured run log and
  // the grow_signal_sweep_runs row, not in a metric label.
  property_signal_sweep_total: {
    help: "Brokerage-wide Property Intelligence signal sweeps attempted, by trigger and terminal outcome. `skipped_locked` means another sweep already held the single-flight advisory lock (expected, not an error).",
    labels: { trigger: ["SCHEDULED", "MANUAL"], outcome: ["completed", "failed", "skipped_locked"] },
  },
  property_signal_sweep_duration_ms: {
    help: "Duration in milliseconds of a completed or failed brokerage-wide Property Intelligence signal sweep, by trigger.",
    labels: { trigger: ["SCHEDULED", "MANUAL"] },
  },
  property_signal_outcome_total: {
    help: "Property Intelligence signals written by a sweep, by outcome. `re_raised` counts human-decided signals returned to Active under the bounded re-review policy; `suppressed` counts candidates withheld by the contactability filter (never raised, never surfaced, never contacted); `rule_truncated` counts rules that had more candidates than their share of the per-brokerage cap and paused, to be resumed from a stored cursor on the next run. Which rule paused, for which brokerage, and where, are in the structured property_signal_rule_truncated log line — deliberately not in a label, per this block's own rule.",
    labels: { outcome: ["created", "updated", "re_raised", "expired", "suppressed", "rule_truncated"] },
  },
  property_signal_sweep_lock_orphaned_total: {
    help:
      "A sweep was refused the single-flight advisory lock while NO grow_signal_sweep_runs row was RUNNING. `race` is the ordinary case — the holder takes the lock a moment before it inserts its run row, so a refusal in that window is expected and harmless. `suspected_leak` means the refusal has repeated to LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS, i.e. something holds (0x41455351, 1) and is not sweeping — sweeping is silently dead. Deliberately NOT folded into property_signal_sweep_total: `skipped_locked` there must keep counting only expected refusals, and `failed` would corrupt the completed/failed ratio with refusals that are usually a race. Which process held the lock is in the structured log line, never a label.",
    labels: { trigger: ["SCHEDULED", "MANUAL"], kind: ["race", "suspected_leak"] },
  },
  property_signal_sweep_brokerage_failure_total: {
    help:
      "One brokerage's pass inside a sweep failed while the run itself continued (see sweep.ts's considerBrokerage: one bad tenant is never a dead sweep). `evaluation` is the brokerage's own sweep throwing; `cursor_touch` is the follow-up failure to stamp that brokerage's last_evaluated_at, which is worse — the tenant can then starve every tenant behind it in the durable ordering. This is the only counter that distinguishes 'one tenant is broken' from 'the sweep is broken'. WHICH brokerage failed stays in the structured property_signal_sweep_brokerage_failed log line, never a label, per this block's own rule.",
    labels: { kind: ["evaluation", "cursor_touch"] },
  },
  financial_reconciliation_variance_total: {
    help: "A financial_reconciliations row was recorded with status VARIANCE — reported evidence (e.g. a mock payment-status webhook) disagrees with the payment request's expected amount/currency and needs human review (see FIN05_RECONCILIATION_VARIANCE_UNRESOLVED).",
    labels: { source: ["mock_integration_payment_status", "other"] },
  },
  // AE GROW C-10 — AI provider and voice transcription observability.
  // Process-level only. Provider labels are closed sets with an "other"
  // fallback, so an unrecognised adapter name cannot open a series. Outcomes
  // below have no "other" value: a bad call site throws in test/development
  // (and becomes "unlabelled" in production) rather than inventing a series.
  // Never a brokerageId, userId, raw model string, or correlationId.
  ai_provider_call_total: {
    help: "One attempt inside generateWithGateway (lib/ai/gateway.ts), by the adapter that was called and whether that attempt returned. Retries are separate attempts. Provider is mock, anthropic, or other — never a model id.",
    labels: { provider: ["mock", "anthropic", "other"], outcome: ["success", "failure"] },
  },
  ai_provider_call_duration_ms: {
    help: "Duration in milliseconds of one generateWithGateway attempt, by adapter and outcome.",
    labels: { provider: ["mock", "anthropic", "other"], outcome: ["success", "failure"] },
  },
  ai_gateway_result_total: {
    help: "Terminal result of one generateWithGateway call: the primary adapter answered, the fallback adapter answered after the primary's attempts failed, or the call failed. One series per call, not per attempt.",
    labels: { result: ["primary_success", "fallback_success", "failed"] },
  },
  ai_provider_tokens_total: {
    help: "Prompt and completion tokens reported by a successful generateWithGateway attempt, by adapter. Not a dollar amount and not a ceiling — estimated cost stays on the admin-only usage snapshot.",
    labels: { provider: ["mock", "anthropic", "other"], kind: ["prompt", "completion"] },
  },
  voice_transcription_total: {
    help: "A POST /api/ai/voice/transcribe request that reached provider.transcribe, by adapter and terminal outcome. Requests refused before the provider (entitlement, upload validation, rate limit, daily cap) are not counted. Provider is mock, deepgram, or other.",
    labels: {
      provider: ["mock", "deepgram", "other"],
      outcome: ["success", "provider_error", "rejected_after_provider", "empty_transcript"],
    },
  },
  voice_transcription_duration_ms: {
    help: "Duration in milliseconds from the provider.transcribe call to its terminal outcome, for requests that reached the provider.",
    labels: {
      provider: ["mock", "deepgram", "other"],
      outcome: ["success", "provider_error", "rejected_after_provider", "empty_transcript"],
    },
  },
  voice_transcription_audio_seconds_total: {
    help: "Sum of provider-reported audio durationSeconds on successful voice transcriptions. Process-level speech-to-text meter. Durable per-request metadata is an audit_logs row (AI_VOICE_TRANSCRIBED), not a dedicated table, and stores no audio or transcript. Not recorded on failure, and not recorded when the provider reports no duration.",
    labels: { provider: ["mock", "deepgram", "other"] },
  },
  voice_meter_write_failure_total: {
    help: "A durable voice-meter insert into audit_logs failed after a transcription that reached the provider. The transcription response is still returned. This counter is the observable signal for that best-effort failure.",
    labels: {},
  },
  ai_interaction_log_failure_total: {
    help: "logAiInteraction insert or updateAiInteraction update failed. The user response is still returned. operation is insert or update.",
    labels: { operation: ["insert", "update"] },
  },
  // R-F6 — Pit Crew WAITING_ON detection sweep. Scheduled path only
  // (runScheduledWaitingOnSweep in lib/pitCrew/waitingOnSweepBootstrap.ts),
  // not the human POST /pit-crew/ops/waiting-on/sweep route. Closed label
  // sets with no "other" fallback, so a bad call site throws in test.
  // Never a brokerageId, assignmentId, propertyId, userId, or a per-item
  // tier. This path never returns, reassigns, or contacts anyone.
  pit_crew_waiting_on_sweep_tick_total: {
    help: "Scheduled Pit Crew WAITING_ON detection ticks only (runScheduledWaitingOnSweep, not POST /pit-crew/ops/waiting-on/sweep), by outcome. completed includes a tick that finished with some brokerage failures. failed means the tick threw. skipped_overlap means the in-process overlap guard skipped the tick, and no duration is recorded for it. This path never returns, reassigns, or contacts anyone.",
    labels: { outcome: ["completed", "failed", "skipped_overlap"] },
  },
  pit_crew_waiting_on_sweep_tick_duration_ms: {
    help: "Duration in milliseconds of a scheduled Pit Crew WAITING_ON detection tick (runScheduledWaitingOnSweep only, not POST /pit-crew/ops/waiting-on/sweep), by outcome. completed is a tick that finished, including one with some brokerage failures. failed is a tick that threw. An overlap skip is not observed. This path never returns, reassigns, or contacts anyone.",
    labels: { outcome: ["completed", "failed"] },
  },
  pit_crew_waiting_on_sweep_brokerage_total: {
    help: "Brokerages considered by one scheduled Pit Crew WAITING_ON detection tick (runScheduledWaitingOnSweep only, not POST /pit-crew/ops/waiting-on/sweep), one increment per brokerage. detected ran detection. skipped_window was outside the operating window. skipped_cadence was inside the cadence. failed threw. This path never returns, reassigns, or contacts anyone.",
    labels: { outcome: ["detected", "skipped_window", "skipped_cadence", "failed"] },
  },
  pit_crew_waiting_on_sweep_item_total: {
    help: "WAITING_ON items classified by the scheduled detection path only (runScheduledWaitingOnSweep, not POST /pit-crew/ops/waiting-on/sweep). surfaced is a new or materially changed sighting. deduped is an unchanged sighting suppressed by the fingerprint. Incremented by the per-brokerage counts. This path never returns, reassigns, or contacts anyone.",
    labels: { outcome: ["surfaced", "deduped"] },
  },
  platform_owner_guard_total: {
    help: "Platform Owner privilege checks that failed closed. tables_missing means platform_owners was absent so nobody is an owner. audit_unavailable means a confirmed owner was refused because the mandatory audit write failed. write_denied means a cross-brokerage write was outside the allowlist. session_expired means an owner session exceeded the 12 hour absolute cap. No user, brokerage, or path labels.",
    labels: { event: ["tables_missing", "audit_unavailable", "write_denied", "session_expired"] },
  },
  outbound_recovery_manual_review_total: {
    help: "An outbound send whose outcome was unknown (lease expired or stale SENDING) was moved to MANUAL_REVIEW instead of being re-sent.",
    labels: { queue: ["integration_outbox", "financial_payment_outbox", "communications_outbox"] },
  },
  outbound_in_flight_gauge: {
    help: "Current count of outbound items mid-dispatch (DISPATCHING/SENDING), split by whether the claim lease is still live or has expired (expired = outcome unknown, awaiting recovery), sampled at read time.",
    labels: { queue: ["integration_outbox", "financial_payment_outbox", "communications_outbox"], lease: ["live", "expired"] },
  },
  outbound_manual_review_gauge: {
    help: "Current count of outbound items waiting in MANUAL_REVIEW for an operator decision, sampled at read time.",
    labels: { queue: ["integration_outbox", "financial_payment_outbox", "communications_outbox"] },
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRIC_DEFINITIONS;

function seriesKey(name: string, labels: LabelValues): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`);
  return `${name}{${parts.join(",")}}`;
}

/** Coerces a label value to a member of its declared allowed set, falling back to "other" (logged once) if the metric declares an "other" fallback and the value isn't recognised — this is the actual cardinality bound. Throws instead in test/development so a bad call site is caught immediately rather than silently degrading. */
const warnedOnce = new Set<string>();
function sanitiseLabels(metric: MetricName, labels: LabelValues): LabelValues {
  const def = METRIC_DEFINITIONS[metric];
  const out: LabelValues = {};
  for (const [key, allowed] of Object.entries(def.labels)) {
    const value = labels[key];
    if (value !== undefined && (allowed as readonly string[]).includes(value)) {
      out[key] = value;
      continue;
    }
    if ((allowed as readonly string[]).includes("other")) {
      out[key] = "other";
      const warnKey = `${metric}.${key}.${value}`;
      if (!warnedOnce.has(warnKey)) {
        warnedOnce.add(warnKey);
        logger.warn("metrics_label_out_of_bounds_coerced", { metric, label: key, value: value ?? "(missing)" });
      }
      continue;
    }
    if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
      throw new Error(`metrics: label "${key}"="${value}" is not in the declared allowed set for ${metric} and has no "other" fallback — fix the call site or extend METRIC_DEFINITIONS.`);
    }
    out[key] = "unlabelled";
  }
  return out;
}

interface CounterSeries { value: number; labels: LabelValues }
interface HistogramSeries { count: number; sum: number; labels: LabelValues }
interface GaugeSeries { value: number; labels: LabelValues }

const counters = new Map<string, CounterSeries>();
const histograms = new Map<string, HistogramSeries>();
const gauges = new Map<string, GaugeSeries>();

// Explicit shape classification — deliberately NOT inferred from the
// metric's name (a suffix-guessing scheme silently misclassifies the next
// metric someone adds with an unexpected name). A metric not listed in
// either set below is a counter, the default and most common shape.
const HISTOGRAM_METRICS = new Set<MetricName>([
  "http_request_duration_ms",
  "health_check_duration_ms",
  "communications_webhook_duration_ms",
  "financial_webhook_duration_ms",
  "ai_provider_call_duration_ms",
  "voice_transcription_duration_ms",
  "pit_crew_waiting_on_sweep_tick_duration_ms",
]);
const GAUGE_METRICS = new Set<MetricName>(["queue_backlog_size", "queue_oldest_item_age_ms", "unresolved_critical_risk_gauge", "outbound_in_flight_gauge", "outbound_manual_review_gauge"]);

export function incrementCounter(metric: MetricName, labels: LabelValues = {}, by = 1): void {
  const safeLabels = sanitiseLabels(metric, labels);
  const key = seriesKey(metric, safeLabels);
  const existing = counters.get(key);
  if (existing) existing.value += by;
  else counters.set(key, { value: by, labels: safeLabels });
}

/** Overwrites (never accumulates) a gauge's current sampled value — for a metric in GAUGE_METRICS only (e.g. a queue depth or an open-risk-count sampled at read time), where the caller re-derives the true current value each time rather than tracking a running total. */
export function setGauge(metric: MetricName, value: number, labels: LabelValues = {}): void {
  if (!GAUGE_METRICS.has(metric)) {
    throw new Error(`metrics: setGauge() called for "${metric}", which is not declared in GAUGE_METRICS — use incrementCounter or observeHistogram instead, or add it to GAUGE_METRICS if it's genuinely a sampled current value.`);
  }
  const safeLabels = sanitiseLabels(metric, labels);
  const key = seriesKey(metric, safeLabels);
  gauges.set(key, { value, labels: safeLabels });
}

export function observeHistogram(metric: MetricName, valueMs: number, labels: LabelValues = {}): void {
  const safeLabels = sanitiseLabels(metric, labels);
  const key = seriesKey(metric, safeLabels);
  const existing = histograms.get(key);
  if (existing) {
    existing.count += 1;
    existing.sum += valueMs;
  } else {
    histograms.set(key, { count: 1, sum: valueMs, labels: safeLabels });
  }
}

/** Prometheus text exposition format (the plain, dependency-free subset: HELP/TYPE plus one line per label combination — no quantiles/buckets, just count+sum for histograms, which is sufficient for computing an average server-side and is honest about what this lightweight implementation actually tracks). */
export function renderMetricsText(): string {
  const lines: string[] = [];
  for (const [name, def] of Object.entries(METRIC_DEFINITIONS)) {
    const metricName = name as MetricName;
    const isHistogram = HISTOGRAM_METRICS.has(metricName);
    const isGauge = GAUGE_METRICS.has(metricName);
    lines.push(`# HELP ${name} ${def.help}`);
    lines.push(`# TYPE ${name} ${isHistogram ? "summary" : isGauge ? "gauge" : "counter"}`);
    if (isHistogram) {
      for (const [key, series] of histograms) {
        if (!key.startsWith(`${name}{`)) continue;
        const labelStr = Object.entries(series.labels).map(([k, v]) => `${k}="${v}"`).join(",");
        lines.push(`${name}_count{${labelStr}} ${series.count}`);
        lines.push(`${name}_sum{${labelStr}} ${series.sum}`);
      }
    } else if (isGauge) {
      for (const [key, series] of gauges) {
        if (!key.startsWith(`${name}{`)) continue;
        const labelStr = Object.entries(series.labels).map(([k, v]) => `${k}="${v}"`).join(",");
        lines.push(`${name}{${labelStr}} ${series.value}`);
      }
    } else {
      for (const [key, series] of counters) {
        if (!key.startsWith(`${name}{`)) continue;
        const labelStr = Object.entries(series.labels).map(([k, v]) => `${k}="${v}"`).join(",");
        lines.push(`${name}{${labelStr}} ${series.value}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/** Test-only: clears all recorded series so tests don't leak state into each other. Never call from production code. */
export function resetMetricsForTesting(): void {
  counters.clear();
  histograms.clear();
  gauges.clear();
  warnedOnce.clear();
}

export function httpStatusClass(statusCode: number): (typeof HTTP_STATUS_CLASSES)[number] {
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  return "5xx";
}
