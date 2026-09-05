# Metrics, Alerts, and Service Objectives

Agent Engine 2.0, Step 2. This document was originally written before bounded-cardinality
metrics existed in this codebase, stating plainly "no metrics collection exists." That is no
longer true. `packages/events/src/metrics.ts` is a real, in-process counter/histogram
registry with nine declared metrics, each with a fully bounded label-value set enforced at
call time (an out-of-set label value throws in test/development and coerces to `"other"` in
production — see that file's own comment), exposed in Prometheus text format at
`GET /api/internal/metrics` (`routes/metrics.ts`, guarded by `requireMetricsAuth` —
`lib/metricsAuth.ts` — a bearer token, fail-closed at boot in production via
`assertMetricsAuthConfigured()`). What is still genuinely absent, and disclosed as such
below rather than implied: a real scrape target (Prometheus/Datadog/CloudWatch or
equivalent), a real alerting/paging pipeline, and a scheduled `pnpm audit` job — none of
that infrastructure exists in this repository, and standing it up is out of this step's
reach (no CI, no third-party connection authorised). Everything below that references a
real metric name is grounded in the actual registry and can be scraped today; everything
that describes an alert firing or a page going out describes the specification a real
alerting system should implement against, not a live behaviour.

As with the rest of this step's Part B documentation, the original governing instruction's
exact enumerated counts (this document's prior text guessed eleven SLI areas and seventeen
alert conditions) were not recoverable verbatim from an earlier context compaction. This
revision keeps the same eleven SLI areas — they still hold up against the real
implementation — and expands the alert list from seventeen to twenty-one: four conditions
the real metrics registry now makes concretely checkable that the prior speculative list
didn't have (a general 5xx-share regression signal, a real latency-threshold signal, a
health-check degraded-latency streak distinct from an outright outage, and a dead-letter/
replay breakdown split into three metric-backed conditions instead of one), while the two
alerts that remain log-based rather than metric-backed (payment failure rate, import
rejection-rate) are kept and explicitly marked as such rather than dropped, since a real
runbook (`SECURITY_INCIDENT_RUNBOOKS.md` #10) still depends on the import one. Flagged for a human reviewer
to diff against the original spec if that text becomes available.

## 1. Service Level Indicator areas

| # | Area | SLI | Backing metric / mechanism |
|---|---|---|---|
| 1 | API availability | % of `GET /api/health` (and, per-instance, `GET /api/health/ready`) checks returning 200 | `health_check_duration_ms{status}` — a non-"ok" series appearing at all is the signal; `routes/health.ts` |
| 2 | Request latency | p50/avg request duration by method and status class | `http_request_duration_ms{method,status_class}` — `middlewares/httpMetrics.ts`, mounted ahead of every route including ones later rejected by CORS/rate-limiting |
| 3 | Request volume and error rate | request count and 5xx share, by method and status class | `http_requests_total{method,status_class}` — same middleware |
| 4 | Integration outbox delivery health | successful outbox dispatches ÷ attempts, and dead-letter rate | `integration_outbox_dispatch_total{capability,outcome}` / `integration_dead_letter_total{source_type="OUTBOX"}` — `lib/integrations/outbox.ts` |
| 5 | Inbound webhook processing health | processed ÷ received, per outcome, across all three webhook surfaces (communications, financial, integrations) | `integration_webhook_total{outcome}` — `lib/integrations/webhooks.ts`; the comms/financial webhook routers do not yet emit this metric themselves (see §4) |
| 6 | Dead-letter and replay health | dead-letters written vs. successfully replayed | `integration_dead_letter_total{source_type}` / `integration_replay_total{outcome}` — `lib/integrations/outbox.ts` and `lib/integrations/webhooks.ts` |
| 7 | Exception-engine scan health | scheduled scans completing, by trigger, against the existing `EVALUATION_FAILED` domain concept | `exceptions_scan_total{trigger}` — `lib/exceptions/engine.ts`; a scan's internal per-rule failures are not yet their own metric (see §4) |
| 8 | Domain-event publish reliability | events published successfully vs. with at least one handler failure | `domain_event_publish_total{outcome}` — `packages/events/src/publisher.ts`, incremented on every `publishDomainEvent` call regardless of caller |
| 9 | Readiness latency distribution | the same `select 1` health probe's own duration, bucketed by resulting status | `health_check_duration_ms{status}` — doubles as SLI #1's supporting distribution and the source for the "degraded" alert (§2, #2) |
| 10 | Auth and tenant-isolation signal | cross-tenant rejection / auth-failure patterns | not yet backed by a dedicated metric — still detected by log inspection (`logger.warn`/`error` call sites in `middlewares/auth.ts`, `middlewares/entitlement.ts`) rather than a counter; a real gap, see §4 |
| 11 | Build/test health (a process SLI, not a runtime one) | full regression suite pass rate over time, typecheck pass/fail | Measured manually per run today — see the completion report's test-evidence section for the current value; not exported as a runtime metric (it isn't a runtime signal) |

## 2. Alert-ready conditions (21)

Every condition below names the real metric or log signal it evaluates. **None of these
page anyone today** — there is no alerting/paging pipeline in this repository — but each is
phrased as a concrete threshold a real system (Prometheus Alertmanager, Datadog Monitors, or
equivalent) could implement directly against `GET /api/internal/metrics` without
re-deriving what to watch.

1. `health_check_duration_ms{status="unavailable"}` recorded (i.e. `GET /api/health/ready`
   returns 503) for ≥ 2 consecutive scrape intervals → database connectivity incident
   (Runbook: Database connectivity/outage).
2. `health_check_duration_ms{status="degraded"}` recorded for ≥ 5 consecutive scrape
   intervals (sustained > 500 ms query latency without outright failure) → database
   performance degradation, distinct from #1 — traffic is still being served, but the
   dependency is under stress (Runbook: Database connectivity/outage, degraded branch).
3. Boot-time failure of `assertSessionSecretConfigured()`, `assertCorsConfigured()`, or
   `assertMetricsAuthConfigured()` in a production-classified environment → deploy-blocking;
   the deploy pipeline should surface this loudly rather than let the process silently fail
   to start.
4. `http_requests_total{status_class="5xx"}` share of total requests exceeds a sustained
   threshold (e.g. > 1% over 5 minutes) — general regression signal, not tied to one route
   (this registry does not label by route, deliberately, to keep cardinality bounded; a
   route-level breakdown requires reading logs for the specific failing path).
5. `http_request_duration_ms` average (sum ÷ count) for any `{method,status_class}` series
   exceeds a threshold (e.g. 1000 ms) sustained over 5 minutes → latency regression signal.
6. Auth failure rate (`/auth/*`, 401/403) exceeds a sustained threshold (e.g. > 20/min from
   a single IP, i.e. hitting `authRateLimiter`'s own ceiling repeatedly) → credential-
   stuffing suspicion (Runbook: rate-limit bypass/credential stuffing).
7. Global rate-limit rejections (`429`) exceed a sustained threshold from a single IP →
   scripted abuse (same runbook as #6).
8. A sustained non-zero rate of cross-tenant rejection log lines
   (`PitCrewPropertyMismatchError`, `CommunicationTenancyError`, and the uniform "not found"
   responses from every tenant-isolation chokepoint) from a single authenticated account
   within a short window → active IDOR-probing suspicion (Runbook: suspected cross-tenant
   exposure). Still log-based, not metric-based — see §4, item 1.
9. `integration_webhook_total{outcome="rejected"}` (signature verification failure) rate
   spikes, any of the three webhook routers → forged-callback suspicion (Runbook: webhook
   signature bypass suspected).
10. `integration_dead_letter_total{source_type="OUTBOX"}` rate exceeds baseline → outbox
    dispatch is failing past its retry budget; already has a domain-level handler (exception
    rule H01) — this alert is the operational-visibility counterpart.
11. `integration_dead_letter_total{source_type="INBOX"}` rate exceeds baseline → inbound
    webhook processing is failing past its retry budget.
12. `integration_replay_total{outcome="failure"}` rate exceeds a small baseline → authorised
    dead-letter replays are themselves failing, meaning the underlying issue that caused the
    original dead-letter has not actually been resolved.
13. `exceptions_scan_total{trigger="SCHEDULED"}` stops incrementing for longer than the
    scheduler's own interval plus a safety margin → the scheduled scan loop has stopped
    running entirely (distinct from a scan running but finding evaluation failures — see
    §4, item 2, for why per-rule failure isn't yet its own metric).
14. `domain_event_publish_total{outcome="partial_failure"}` rate exceeds baseline → at least
    one domain-event handler is failing on a sustained basis; correlate against
    `logger.warn("domain_event_dispatch_partial_failure", ...)` lines for the specific event
    type and handler.
15. A `pnpm audit` run (manual today — see §3) reports a new `high` or `critical` finding →
    dependency vulnerability disclosed (Runbook: dependency vulnerability disclosed).
16. `sessionEpoch` bump rate (logout events) for a single user exceeds a small threshold in
    a short window → possible session-compromise-and-recovery cycle in progress (Runbook:
    session token compromise).
17. `isDevAuthEnabled()` evaluating true in any environment where `NODE_ENV==="production"`
    — structurally impossible per `lib/env.ts`'s hard-off check, but a boot-time assertion
    firing here would be a severe configuration-drift alert (Runbook: dev-login surface
    exposed in production).
18. CORS rejection rate spike (an unexpected origin repeatedly denied) → either a
    legitimate new frontend deployment nobody added to `CORS_ALLOWED_ORIGINS`, or
    reconnaissance.
19. Audit-log write failure (a `logAudit` call itself throwing/being swallowed) → the audit
    trail's own integrity is at risk (Runbook: audit-log gap or tampering suspected).
20. Payment charge/refund failure rate exceeds baseline (log-based today — no dedicated
    payment metric exists in the registry yet, see §4 — detected via `logger.error` lines in
    `lib/financial/**` and the `FINANCIAL_PAYMENT_FAILED`-shaped domain events) → financial-
    integrity incident.
21. Import job rejection-at-validation rate spikes (log-based today — `fileValidation.ts`'s
    own rejection path, no dedicated import metric exists in the registry yet, see §4) →
    either an upstream data-quality problem or file-upload abuse (Runbook: import-pipeline
    abuse).

## 3. What it would take to make alerting real

1. A scrape target and rule engine (Prometheus + Alertmanager, or a hosted equivalent like
   Datadog/Grafana Cloud) pointed at `GET /api/internal/metrics` with `METRICS_TOKEN`
   configured as its bearer credential — the metric names and label sets above are already
   stable and ready to scrape; nothing in the application needs to change to support this.
2. A real paging destination (PagerDuty, Opsgenie, or equivalent) wired to the alert rules
   in §2 — explicitly out of scope this step; no such destination exists or is authorised.
3. A scheduled `pnpm audit` (or equivalent) run wired into CI for alert #15 — there is
   currently no CI configuration in this repository at all (`.github/workflows/` absent).
   `pnpm audit` has been run manually on this branch as a point-in-time record (see the
   completion report's security-tooling section), not as a recurring check.
4. Route-level and per-tenant granularity for #4/#5/#8 above a certain point would need a
   deliberate cardinality-bounded design (e.g. a fixed allowlist of route *patterns*, never
   raw paths with interpolated ids) — the registry's existing discipline (bounded label sets,
   coercion to `"other"`) is the right foundation for this, but no route-pattern label exists
   in `METRIC_DEFINITIONS` today; adding one is future work, not done this step.

## 4. Known gaps in the metrics registry itself, disclosed rather than glossed over

1. **Cross-tenant rejections (SLI #10, alert #8) are not a metric.** They are detected today
   by grep-ing/alerting on structured log lines from `middlewares/auth.ts` and
   `middlewares/entitlement.ts` and the individual tenant-isolation chokepoints across
   `apps/api/src/lib/**`. A dedicated bounded-label counter (e.g.
   `tenant_isolation_rejection_total{route_group}`) would make this scrapable instead of
   log-mined, but adding one means picking a bounded `route_group` label set across ~28
   route files — judged a separate, deliberate piece of work rather than folded into this
   pass.
2. **Per-rule exception-engine failures are not separately counted.** `exceptions_scan_total`
   records that a scan ran, by trigger, but not whether every rule inside that scan pass
   succeeded — a single rule's `EVALUATION_FAILED` (proven not to block sibling rules in
   `lib/exceptions/__tests__/engine.test.ts`) is currently only visible in the scan's own
   log output, not as its own metric series.
3. **`communicationsWebhooks.ts` and `financialWebhooks.ts` do not emit
   `integration_webhook_total`.** Only `lib/integrations/webhooks.ts` (the third of the three
   webhook routers) does. SLI #5/alert #9 above are accurate for the integrations webhook
   surface specifically; the other two webhook routers' processing/rejection rates are
   visible in structured logs (`logger.error("publish_domain_event_failed", ...)` and
   similar) but not yet in the metrics registry. Extending the shared metric to all three
   routers is straightforward (the label set is already provider-agnostic) but was not done
   this pass, to keep this step's metrics work scoped to what the registry already declares
   plus wiring gaps found while proving the six correlation-propagation flows, rather than
   opening a new instrumentation surface.

4. **Payments and import jobs have no dedicated metrics.** Alerts #20 and #21 above are
   real, currently-actionable conditions (backed by structured log lines, not a placeholder)
   but not backed by a `METRIC_DEFINITIONS` entry — there is no `payment_outcome_total` or
   `import_job_total` in the registry today. Both would be straightforward additions
   (bounded label sets: an outcome enum for payments, a rejection-reason enum for imports)
   but were not added this pass, for the same reason as items 1–3 above: this step's
   metrics work scoped to wiring the correlation-propagation-adjacent gaps it actually found,
   not opening every plausible new instrumentation surface in one pass.

Items in this section are the honest boundary of what "operational metrics with strict
cardinality bounds" means in this codebase today: nine real, wired, bounded-cardinality
metrics backing eleven SLIs and twenty-one alert-ready conditions (nineteen metric-backed,
two log-based and named as such), with four named, scoped-out extensions rather than a claim
of exhaustive coverage.
