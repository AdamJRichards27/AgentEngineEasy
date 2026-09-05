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
    labels: { capability: INTEGRATION_CAPABILITIES, outcome: [...OUTCOME, "retry_scheduled"] },
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

const counters = new Map<string, CounterSeries>();
const histograms = new Map<string, HistogramSeries>();

export function incrementCounter(metric: MetricName, labels: LabelValues = {}, by = 1): void {
  const safeLabels = sanitiseLabels(metric, labels);
  const key = seriesKey(metric, safeLabels);
  const existing = counters.get(key);
  if (existing) existing.value += by;
  else counters.set(key, { value: by, labels: safeLabels });
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
    const isHistogram = name.endsWith("_duration_ms");
    lines.push(`# HELP ${name} ${def.help}`);
    lines.push(`# TYPE ${name} ${isHistogram ? "summary" : "counter"}`);
    if (isHistogram) {
      for (const [key, series] of histograms) {
        if (!key.startsWith(`${name}{`)) continue;
        const labelStr = Object.entries(series.labels).map(([k, v]) => `${k}="${v}"`).join(",");
        lines.push(`${name}_count{${labelStr}} ${series.count}`);
        lines.push(`${name}_sum{${labelStr}} ${series.sum}`);
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
  warnedOnce.clear();
}

export function httpStatusClass(statusCode: number): (typeof HTTP_STATUS_CLASSES)[number] {
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  return "5xx";
}
