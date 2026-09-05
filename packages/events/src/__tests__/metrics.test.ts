// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Proves the metrics registry's actual cardinality-bounding contract
// (metrics.ts's own module comment): an out-of-set label value throws in
// test/development (fail fast, catch a bad call site immediately) rather
// than silently degrading — and separately proves the counter/histogram
// accumulation and Prometheus text rendering are correct, since those are
// the parts a future refactor is most likely to quietly break.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  incrementCounter,
  observeHistogram,
  renderMetricsText,
  resetMetricsForTesting,
  httpStatusClass,
  METRIC_DEFINITIONS,
} from "../metrics.js";

beforeEach(() => {
  resetMetricsForTesting();
});

test("NODE_ENV is 'test' for this suite — a precondition the throw-on-bad-label assertions below depend on", () => {
  assert.equal(process.env.NODE_ENV, "test");
});

test("incrementCounter throws on a label value outside the declared set with no 'other' fallback (fail-fast in test)", () => {
  assert.throws(
    () => incrementCounter("exceptions_scan_total", { trigger: "NOT_A_REAL_TRIGGER" }),
    /not in the declared allowed set/,
  );
});

test("incrementCounter coerces an out-of-set value to 'other' when the metric declares an 'other' fallback, even in test — 'other' is itself a declared allowed value, not a bypass of the throw", () => {
  incrementCounter("integration_outbox_dispatch_total", { capability: "some.brand.new.capability", outcome: "success" });
  const text = renderMetricsText();
  assert.match(text, /integration_outbox_dispatch_total\{capability="other",outcome="success"\} 1/);
});

test("incrementCounter accepts every declared allowed value without throwing", () => {
  for (const status_class of METRIC_DEFINITIONS.http_requests_total.labels.status_class) {
    assert.doesNotThrow(() => incrementCounter("http_requests_total", { method: "GET", status_class }));
  }
});

test("incrementCounter accumulates repeated calls with identical labels into one series", () => {
  incrementCounter("http_requests_total", { method: "GET", status_class: "2xx" });
  incrementCounter("http_requests_total", { method: "GET", status_class: "2xx" });
  incrementCounter("http_requests_total", { method: "GET", status_class: "2xx" });
  const text = renderMetricsText();
  assert.match(text, /http_requests_total\{method="GET",status_class="2xx"\} 3/);
});

test("incrementCounter keeps distinct label combinations as separate series", () => {
  incrementCounter("http_requests_total", { method: "GET", status_class: "2xx" });
  incrementCounter("http_requests_total", { method: "POST", status_class: "5xx" });
  const text = renderMetricsText();
  assert.match(text, /http_requests_total\{method="GET",status_class="2xx"\} 1/);
  assert.match(text, /http_requests_total\{method="POST",status_class="5xx"\} 1/);
});

test("incrementCounter's 'by' parameter increments by an arbitrary amount, not just 1", () => {
  incrementCounter("domain_event_publish_total", { outcome: "ok" }, 5);
  const text = renderMetricsText();
  assert.match(text, /domain_event_publish_total\{outcome="ok"\} 5/);
});

test("observeHistogram throws on a label value outside the declared set", () => {
  assert.throws(
    () => observeHistogram("health_check_duration_ms", 42, { status: "not_a_real_status" }),
    /not in the declared allowed set/,
  );
});

test("observeHistogram accumulates count and sum across repeated observations", () => {
  observeHistogram("health_check_duration_ms", 10, { status: "ok" });
  observeHistogram("health_check_duration_ms", 20, { status: "ok" });
  observeHistogram("health_check_duration_ms", 30, { status: "ok" });
  const text = renderMetricsText();
  assert.match(text, /health_check_duration_ms_count\{status="ok"\} 3/);
  assert.match(text, /health_check_duration_ms_sum\{status="ok"\} 60/);
});

test("renderMetricsText emits HELP and TYPE lines for every declared metric, even ones with zero recorded series", () => {
  const text = renderMetricsText();
  for (const name of Object.keys(METRIC_DEFINITIONS)) {
    assert.match(text, new RegExp(`# HELP ${name} `));
    assert.match(text, new RegExp(`# TYPE ${name} `));
  }
});

test("renderMetricsText marks duration metrics as 'summary' and counters as 'counter'", () => {
  const text = renderMetricsText();
  assert.match(text, /# TYPE health_check_duration_ms summary/);
  assert.match(text, /# TYPE http_request_duration_ms summary/);
  assert.match(text, /# TYPE http_requests_total counter/);
  assert.match(text, /# TYPE domain_event_publish_total counter/);
});

test("renderMetricsText output is valid Prometheus-shaped text: no series line before its HELP/TYPE header", () => {
  incrementCounter("http_requests_total", { method: "GET", status_class: "2xx" });
  const lines = renderMetricsText().split("\n").filter(Boolean);
  const headerIndex = lines.findIndex((l) => l === "# TYPE http_requests_total counter");
  const seriesIndex = lines.findIndex((l) => l.startsWith("http_requests_total{"));
  assert.ok(headerIndex >= 0 && seriesIndex > headerIndex);
});

test("resetMetricsForTesting clears all recorded series between tests", () => {
  incrementCounter("http_requests_total", { method: "GET", status_class: "2xx" });
  resetMetricsForTesting();
  const text = renderMetricsText();
  assert.doesNotMatch(text, /http_requests_total\{/);
});

test("httpStatusClass buckets status codes into the four declared classes", () => {
  assert.equal(httpStatusClass(200), "2xx");
  assert.equal(httpStatusClass(201), "2xx");
  assert.equal(httpStatusClass(301), "3xx");
  assert.equal(httpStatusClass(404), "4xx");
  assert.equal(httpStatusClass(500), "5xx");
  assert.equal(httpStatusClass(503), "5xx");
});

test("every metric's label value sets are non-empty (a metric declared with no allowed values could never record anything)", () => {
  for (const [name, def] of Object.entries(METRIC_DEFINITIONS)) {
    for (const [label, allowed] of Object.entries(def.labels)) {
      assert.ok(allowed.length > 0, `${name}.${label} must declare at least one allowed value`);
    }
  }
});
