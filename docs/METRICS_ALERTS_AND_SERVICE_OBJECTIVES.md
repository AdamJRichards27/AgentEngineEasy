# Metrics, Alerts, and Service Objectives

Agent Engine 2.0, Step 2. This revision reflects the bounded closure pass that extended
`packages/events/src/metrics.ts` from nine to **twenty-three** declared metrics, each with a
fully bounded label-value set enforced at call time (an out-of-set label value throws in
test/development and coerces to `"other"` in production — see that file's own comment),
exposed in Prometheus text format at `GET /api/internal/metrics` (`routes/metrics.ts`,
guarded by `requireMetricsAuth` — `lib/metricsAuth.ts` — a bearer token, fail-closed at boot
in production via `assertMetricsAuthConfigured()`). What is still genuinely absent, and
disclosed as such below rather than implied: a real scrape target (Prometheus/Datadog/
CloudWatch or equivalent), a real alerting/paging pipeline, and a scheduled `pnpm audit` job
— none of that infrastructure exists in this repository. Everything below that references a
real metric name is grounded in the actual registry and can be scraped today; everything
that describes an alert firing or a page going out describes the specification a real
alerting system should implement against, not a live behaviour.

The Step 2 closure pass stopped at twenty-three metrics. Five signal-sweep metrics were
added after that. **C-10 (2026-09-26)** added seven more for AI provider calls and voice
transcription. The catalogue now declares **thirty-nine** metrics. Alert-ready conditions
are **thirty-seven** (§2, including §2a, §2b, and §2c).

As with the rest of this step's documentation, the original governing instruction's exact
verbatim enumerated lists were not recoverable across an earlier context compaction. This
revision keeps the same eleven SLI areas from the prior revision (they still hold up) and
updates several of them, plus the alert list, to reflect the ten metrics this pass added and
the four it wired at existing gap points. Flagged for a human reviewer to diff against the
original spec if that text becomes available.

## 0. What this closure pass added

The prior revision of this document named four concrete gaps in §4 (numbered 1–4 in that
revision). This pass closed three of them and made a bounded start on the fourth:

1. **Closed (partially).** A dedicated `tenant_isolation_rejection_total{boundary}` counter
   now exists, wired at three of several possible chokepoints: the `CommunicationTenancyError`,
   `PitCrewPropertyMismatchError`/`PitCrewAssigneeMismatchError`, and `IntegrationError`
   (for `NOT_FOUND`/`TENANT_MISMATCH` reasons) constructors. **Still not wired**: the many
   other domains whose tenant check is an inline `res.status(404)` with no dedicated error
   class (properties, parties, transactions, financial payments, grow, documents, AML,
   pit-crew work-item overlays outside the two classes above) — each of those still relies on
   the log-based detection this document's prior revision described. Wiring every remaining
   inline check was judged out of this bounded pass's scope (it would mean touching ~28 route
   files individually, which the original instruction's own "do not conduct another
   whole-of-app audit" constraint weighs against); it is named explicitly as remaining scope
   in §4 below rather than implied closed.
2. **Closed.** `communicationsWebhooks.ts` and `financialWebhooks.ts` now emit
   `communications_webhook_total`/`communications_webhook_duration_ms` and
   `financial_webhook_total`/`financial_webhook_duration_ms` respectively, using the same
   bounded `WEBHOOK_ROUTER_OUTCOMES` funnel (`received → accepted → {invalid_signature |
   schema_rejected | replay_rejected | success | failure}`). Proven by 7 new tests
   (`communicationsWebhooksMetrics.test.ts`, `financialWebhooksMetrics.test.ts`) that also
   assert a rejected webhook never mutates state. Fixing this metric gap surfaced a real
   production bug: `financialWebhooks.ts` had no try/catch around
   `mandatePaymentProvider.parseWebhook()`, which throws on a malformed payload — an uncaught
   throw inside an async Express 4 handler never sends a response, so a malformed webhook
   delivery hung the request forever. Now caught, mapped to `schema_rejected`, and returns
   400. Note: the sandbox mandate-payments provider's `verifyWebhookSignature()` always
   returns `true` ("no real webhook traffic reaches the sandbox provider"), so
   `financial_webhook_total{outcome="invalid_signature"}` cannot be exercised against this
   build's only provider — the label stays declared for when a real provider adapter ships.
3. **Not closed, superseded.** The prior revision's item 3 asked for dedicated payment/
   import-job metrics. This pass instead added the broader `job_repeated_failure_total{job}`
   counter (wired at all three domains' exhausted-retry chokepoints — integration outbox,
   financial payment outbox, communications outbox) and
   `integration_connection_degraded_total{provider}` (wired at the transient-provider-error
   classification point in `lib/integrations/outbox.ts`), which cover the "repeated job
   failure" and "integration degradation" ground more generally than a payment-specific
   metric would. A dedicated `import_job_total` remains unadded — imports still have no
   metric, only the log-based detection alert #21 already named.
4. **Not applicable this pass** — no per-rule exception-engine failure metric was added
   (still scan-level only, see §4 item 2 below, carried over unchanged).

Beyond those four, this pass added ten metrics the governing instruction named as critical
gaps, none of which the prior revision's four-item list covered at all:
`auth_security_event_total`, `queue_backlog_size`, `queue_oldest_item_age_ms`,
`ai_action_decision_total`, `workflow_execution_failure_total`,
`unresolved_critical_risk_gauge`, `financial_reconciliation_variance_total` (wired at
`lib/financial/mockPaymentStatusSync.ts`'s single VARIANCE-recording chokepoint), plus the
`job_repeated_failure_total` and `integration_connection_degraded_total` already described
above, and `tenant_isolation_rejection_total` already described above. See §5 for the full
cross-check against the instruction's named list.

## 1. Service Level Indicator areas

| # | Area | SLI | Backing metric / mechanism |
|---|---|---|---|
| 1 | API availability | % of `GET /api/health` (and, per-instance, `GET /api/health/ready`) checks returning 200 | `health_check_duration_ms{status}` — a non-"ok" series appearing at all is the signal; `routes/health.ts` |
| 2 | Request latency | p50/avg request duration by method and status class | `http_request_duration_ms{method,status_class}` — `middlewares/httpMetrics.ts`, mounted ahead of every route including ones later rejected by CORS/rate-limiting |
| 3 | Request volume and error rate | request count and 5xx share, by method and status class | `http_requests_total{method,status_class}` — same middleware |
| 4 | Integration outbox delivery health | successful outbox dispatches ÷ attempts, dead-letter rate, repeated-failure rate, and provider degradation | `integration_outbox_dispatch_total{capability,outcome}` / `integration_dead_letter_total{source_type="OUTBOX"}` / `job_repeated_failure_total{job="integration_outbox_command"}` / `integration_connection_degraded_total{provider}` — `lib/integrations/outbox.ts` |
| 5 | Inbound webhook processing health | processed ÷ received, per outcome, across all three webhook surfaces (communications, financial, integrations) | `integration_webhook_total{outcome}` — `lib/integrations/webhooks.ts`; **now also** `communications_webhook_total{outcome}` / `financial_webhook_total{outcome}` — the funnel gap the prior revision's §4 item 3 named is closed |
| 6 | Dead-letter and replay health | dead-letters written vs. successfully replayed | `integration_dead_letter_total{source_type}` / `integration_replay_total{outcome}` — `lib/integrations/outbox.ts` and `lib/integrations/webhooks.ts` |
| 7 | Exception-engine scan health and unresolved critical risk | scheduled scans completing, by trigger; current count of OPEN CRITICAL risk exceptions | `exceptions_scan_total{trigger}` — `lib/exceptions/engine.ts`; **new:** `unresolved_critical_risk_gauge{status="open"}` — `lib/observability/queueGauges.ts`, sampled fresh at every metrics scrape |
| 8 | Domain-event publish reliability | events published successfully vs. with at least one handler failure | `domain_event_publish_total{outcome}` — `packages/events/src/publisher.ts`, incremented on every `publishDomainEvent` call regardless of caller |
| 9 | Readiness latency distribution | the same `select 1` health probe's own duration, bucketed by resulting status | `health_check_duration_ms{status}` — doubles as SLI #1's supporting distribution and the source for the "degraded" alert (§2, #2) |
| 10 | Auth and tenant-isolation signal | cross-tenant rejection / auth-attack patterns | **now partially metric-backed**: `auth_security_event_total{event}` (invalid session token, revoked-session reuse, dev-login-disabled probing, auth rate-limiting — `middlewares/auth.ts`, `routes/auth.ts`, `middlewares/rateLimit.ts`) and `tenant_isolation_rejection_total{boundary}` for the boundaries named in §4 item 1; the remaining inline-404 tenant checks are still log-based only, see §4 |
| 11 | Build/test health (a process SLI, not a runtime one) | full regression suite pass rate over time, typecheck pass/fail | Measured manually per run today — see the completion report's test-evidence section for the current value; not exported as a runtime metric (it isn't a runtime signal) |
| 12 | Background queue health | current backlog depth and oldest-item age per queue, distinct from the per-attempt dispatch counters in #4/#6 | **new:** `queue_backlog_size{queue}` / `queue_oldest_item_age_ms{queue}` — `lib/observability/queueGauges.ts`, covering `integration_outbox`, `financial_payment_outbox`, `communications_outbox`, sampled fresh (never accumulated) immediately before every `GET /api/internal/metrics` render |
| 13 | AI action governance and provider observability | allow/deny split of every AI action policy decision; provider-call attempts, latency, gateway fallback, and tokens; voice transcription attempts, latency, and transcribed audio seconds | `ai_action_decision_total{outcome}` — `lib/ai/policyEngine.ts`. **C-10:** `ai_provider_call_total{provider,outcome}`, `ai_provider_call_duration_ms{provider,outcome}`, `ai_gateway_result_total{result}`, `ai_provider_tokens_total{provider,kind}` recorded inside `generateWithGateway` (`lib/ai/gateway.ts`), which is the one text-generation call site. `voice_transcription_total{provider,outcome}`, `voice_transcription_duration_ms{provider,outcome}`, `voice_transcription_audio_seconds_total{provider}` recorded in `routes/aiVoice.ts` only after `provider.transcribe`. Provider is `mock`, `anthropic`, or `other` for text, and `mock`, `deepgram`, or `other` for voice. No brokerage, user, model, or correlation id label. Dollars stay on the admin-only usage snapshot, not a metric. |
| 14 | Workflow/automation execution health | automation-rule (and, by label, other workflow-family) execution failures | **new:** `workflow_execution_failure_total{workflow}` — wired at `lib/automation/engine.ts`'s rule-evaluation catch site; `ready_to_list`/`launch_plan`/`other` labels are declared but not yet wired at a throw site (see §4) |
| 15 | Signal-sweep liveness and lock health | sweeps completing on schedule; refusals that are a leaked lock rather than an ordinary race; per-tenant failures isolated from whole-sweep failures | `property_signal_sweep_total{trigger,outcome}` / `property_signal_sweep_duration_ms{trigger}` — `lib/propertyIntelligence/sweep.ts`; **new in W1-D:** `property_signal_sweep_lock_orphaned_total{trigger,kind}` and `property_signal_sweep_brokerage_failure_total{kind}`. The same judgement is available on demand, without a scrape target, at `GET /api/grow/property-intelligence/ops/health` (Brokerage Administrator only). See §2a |
| 16 | Pit Crew WAITING_ON detection sweep liveness | scheduled detection ticks completing; a tick that threw, or every brokerage failing, distinguished from a tick where only some brokerages failed; items surfaced versus deduped | `pit_crew_waiting_on_sweep_tick_total{outcome}` / `pit_crew_waiting_on_sweep_tick_duration_ms{outcome}` / `pit_crew_waiting_on_sweep_brokerage_total{outcome}` / `pit_crew_waiting_on_sweep_item_total{outcome}` — `lib/pitCrew/waitingOnSweepBootstrap.ts`, scheduled path only (not `POST /pit-crew/ops/waiting-on/sweep`). See §2c |

## 2. Alert-ready conditions (37)

Every condition below names the real metric or log signal it evaluates. **None of these
page anyone today** — there is no alerting/paging pipeline in this repository — but each is
phrased as a concrete threshold a real system (Prometheus Alertmanager, Datadog Monitors, or
equivalent) could implement directly against `GET /api/internal/metrics` without
re-deriving what to watch. Conditions 1–21 carry over from the prior revision (renumbered
where a metric referenced there is now more precisely named); 22–27 were new in that pass;
28–31 are new in AE GROW Completion Wave 1 (slice W1-D) and are grouped in §2a below.

1. `health_check_duration_ms{status="unavailable"}` recorded (i.e. `GET /api/health/ready`
   returns 503) for ≥ 2 consecutive scrape intervals → database connectivity incident
   (Runbook: Database connectivity/outage).
2. `health_check_duration_ms{status="degraded"}` recorded for ≥ 5 consecutive scrape
   intervals (sustained > 500 ms query latency without outright failure) → database
   performance degradation, distinct from #1.
3. Boot-time failure of `assertSessionSecretConfigured()`, `assertCorsConfigured()`, or
   `assertMetricsAuthConfigured()` in a production-classified environment → deploy-blocking.
4. `http_requests_total{status_class="5xx"}` share of total requests exceeds a sustained
   threshold (e.g. > 1% over 5 minutes) — general regression signal, not tied to one route.
5. `http_request_duration_ms` average (sum ÷ count) for any `{method,status_class}` series
   exceeds a threshold (e.g. 1000 ms) sustained over 5 minutes → latency regression signal.
6. `auth_security_event_total{event="auth_rate_limited"}` exceeds a sustained threshold
   (e.g. > 20/min) → credential-stuffing suspicion (Runbook: rate-limit bypass/credential
   stuffing). **Now metric-backed** — the prior revision's equivalent condition was log-based.
7. Global rate-limit rejections (`429`) exceed a sustained threshold from a single IP →
   scripted abuse (same runbook as #6). Still detected via `globalRateLimiter`'s own response
   codes (`http_requests_total{status_class="4xx"}` combined with access logs), not a
   dedicated metric — the global limiter's `handler` was not given its own counter this pass.
8. `auth_security_event_total{event="invalid_session_token"}` or
   `{event="revoked_session_reused"}` sustained above a small baseline from what correlates
   (via logs, not the metric itself — no per-account label exists, by design) to a single
   account → active session-token-abuse suspicion (Runbook: session token compromise).
9. `tenant_isolation_rejection_total{boundary}` any non-zero sustained rate → active
   IDOR-probing suspicion (Runbook: suspected cross-tenant exposure). **Metric-backed for
   the `communications`, `pit_crew`, `integrations`, `transaction`, `financial`, `property`,
   and `party` boundaries** (offers emit `transaction`; see §4 item 1). The remaining
   declared boundary (`other`) is unused. A metric reading zero across all
   boundaries is not proof no cross-tenant attempt occurred anywhere in the app; it is
   proof none occurred at the wired chokepoints.
10. `communications_webhook_total{outcome="invalid_signature"}` or
    `financial_webhook_total{outcome="invalid_signature"}` or
    `integration_webhook_total{outcome="rejected"}` rate spikes, any of the three webhook
    routers → forged-callback suspicion (Runbook: webhook signature bypass suspected).
    **Now covers all three routers** — the prior revision's equivalent condition only covered
    the integrations router.
11. `communications_webhook_total{outcome="replay_rejected"}` or
    `financial_webhook_total{outcome="replay_rejected"}` or `integration_replay_total`'s
    inbound-dedup equivalent spikes → either a misbehaving/retrying provider or a genuine
    replay-attack attempt; distinguish via volume and source IP in access logs.
12. `integration_dead_letter_total{source_type="OUTBOX"}` rate exceeds baseline, corroborated
    by `job_repeated_failure_total{job="integration_outbox_command"}` → outbox dispatch is
    failing past its retry budget; already has a domain-level handler (exception rule H01) —
    this alert is the operational-visibility counterpart.
13. `integration_dead_letter_total{source_type="INBOX"}` rate exceeds baseline → inbound
    webhook processing is failing past its retry budget.
14. `integration_replay_total{outcome="failure"}` rate exceeds a small baseline → authorised
    dead-letter replays are themselves failing.
15. `exceptions_scan_total{trigger="SCHEDULED"}` stops incrementing for longer than the
    scheduler's own interval plus a safety margin → the scheduled scan loop has stopped
    running entirely.
16. `domain_event_publish_total{outcome="partial_failure"}` rate exceeds baseline → at least
    one domain-event handler is failing on a sustained basis.
17. A `pnpm audit` run (manual today — see §3) reports a new `high` or `critical` finding →
    dependency vulnerability disclosed (Runbook: dependency vulnerability disclosed).
18. `isDevAuthEnabled()` evaluating true in any environment where `NODE_ENV==="production"`
    → structurally impossible per `lib/env.ts`'s hard-off check, but a boot-time assertion
    firing here would be a severe configuration-drift alert. Corroborating signal: a
    non-zero `auth_security_event_total{event="dev_login_disabled_attempt"}` rate in a
    production-classified environment means someone is actively probing for this surface,
    even though the structural gate is holding.
19. CORS rejection rate spike (an unexpected origin repeatedly denied) → either a
    legitimate new frontend deployment nobody added to `CORS_ALLOWED_ORIGINS`, or
    reconnaissance.
20. Audit-log write failure (a `logAudit` call itself throwing/being swallowed) → the audit
    trail's own integrity is at risk (Runbook: audit-log gap or tampering suspected).
21. Import job rejection-at-validation rate spikes (log-based today — `fileValidation.ts`'s
    own rejection path, no dedicated import metric exists in the registry yet, see §4) →
    either an upstream data-quality problem or file-upload abuse (Runbook: import-pipeline
    abuse).
22. `queue_backlog_size{queue}` exceeds a per-queue threshold sustained over its own
    processing cadence (e.g. > 50 for `integration_outbox`, which dispatches near-
    synchronously in normal operation) → the background processor for that queue has
    stalled or is under-provisioned.
23. `queue_oldest_item_age_ms{queue}` exceeds a threshold matched to that queue's own SLA
    (e.g. > 5 minutes for `financial_payment_outbox`, where a stuck debit has direct
    financial-integrity consequences) → the oldest item is aging out past what any retry
    schedule should allow, distinct from #22 (a queue can have low count but one very old
    stuck item, or high count with everything still fresh).
24. `unresolved_critical_risk_gauge{status="open"}` non-zero for longer than the Exception
    & Risk Engine's own SLA for CRITICAL-severity resolution → an unresolved critical risk
    has sat open past its expected handling window; correlate against the specific
    `risk_exceptions` rows via the admin UI, since the gauge itself carries no per-exception
    detail (by design, to stay bounded-cardinality).
25. `ai_action_decision_total{outcome="denied"}` share of total decisions rises sharply
    against its own recent baseline → either a misconfigured entitlement blocking legitimate
    AI actions, or an AI/automation attempting actions outside its granted policy scope; both
    warrant investigation via `lib/ai/audit.ts`'s decision log for the specific denied
    actions.
26. `job_repeated_failure_total{job}` or `integration_connection_degraded_total{provider}`
    any sustained non-zero rate → a background command exhausted its retry budget (job) or a
    specific provider is showing sustained transient-error behaviour (connection) — both are
    earlier-warning signals than waiting for the corresponding dead-letter/outage to be
    noticed downstream.
27. `financial_reconciliation_variance_total{source}` rate exceeds a small baseline, or any
    single occurrence in a brokerage with no prior history of variances → a payment-status
    provider is disagreeing with the Financial Engine's own expected amount/currency for an
    obligation; correlate against the specific `FIN05_RECONCILIATION_VARIANCE_UNRESOLVED`
    risk exception it opens on the next scan for the affected payment request (Runbook:
    financial-integrity incident, same family as the pre-existing payment failure-rate
    alert #20 in the original numbering this document inherited before this pass renumbered
    condition #6/#9/#10).

### 2a. Brokerage-wide Signal Sweep (conditions 28–31)

Added by the AE GROW Completion Program, Wave 1 slice W1-D. The sweep
(`lib/propertyIntelligence/sweep.ts`) is the first background job in this codebase whose
**silent** failure mode is worse than its loud one: when its single-flight advisory lock
leaks, `property_signal_sweep_total{outcome="skipped_locked"}` keeps incrementing, which is
the same series a perfectly healthy overlapping tick produces. Sweeping is dead and every
existing metric reads normal. Conditions 28 and 29 exist to close exactly that gap.

Unlike every condition above, **28, 29, and 30 page today, via a real code path**.
Conditions 28 and 29 dispatch `GROW_SIGNAL_SWEEP_UNHEALTHY` (`lib/operationalAlerts.ts`;
severity `high`, owner `operations`, runbook `grow-signal-sweep`) to the configured
`OPERATIONAL_ALERTS_WEBHOOK_URL` from two call sites. Condition 30 dispatches
`GROW_SIGNAL_SWEEP_BROKERAGE_FAILED` and `GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED` with that
same policy shape. That does not make the rest of this document live — it makes these
conditions the exception, because `logger.error` is **not** bridged to
`dispatchOperationalAlert()` (`logger.ts` only writes JSON to stderr), so a log-only
treatment of a leaked lock or a brokerage that fails every tick would have been no alert
at all.

28. `property_signal_sweep_lock_orphaned_total{kind="suspected_leak"}` incremented at all →
    something holds the sweep advisory lock `(0x41455351, 1)` and is not sweeping.
    **Already dispatches `GROW_SIGNAL_SWEEP_UNHEALTHY`** (dedup key
    `grow-signal-sweep:lock-leak`) from `sweep.ts`'s orphaned-lock branch, once per
    `OPERATIONAL_ALERTS_COOLDOWN_SECONDS`. Note the deliberate split: `kind="race"` on the
    same counter is the ORDINARY case — the lock holder inserts its run row a moment after
    taking the lock — and must never alert. Only the repeat, at
    `LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS` consecutive refusals, is real.
    (Runbook: `grow-signal-sweep` — confirm via `GET /api/grow/property-intelligence/ops/health`
    that `runningRunId` is null while `staleBy.stale` is true, then restart the API instance:
    Postgres releases a session advisory lock the instant its connection closes.)
29. The scheduled sweep threw → **already dispatches `GROW_SIGNAL_SWEEP_UNHEALTHY`** (dedup
    key `grow-signal-sweep:scheduled-run-failed`) from `sweepBootstrap.ts`'s interval catch.
    Distinct from 28: the job ran and failed, rather than never starting. A sweep failing
    every tick produces one alert per cooldown, not one per tick.
30. `property_signal_sweep_brokerage_failure_total{kind}` rising while
    `property_signal_sweep_total{outcome="completed"}` keeps incrementing normally → ONE
    tenant is broken, and the sweep itself kept running. The run continues, sweeps every
    other brokerage, and is recorded COMPLETED with `errors > 0`. Which brokerage failed is
    in the alert details and in the `property_signal_sweep_brokerage_failed` structured log
    line, never a metric label.
    **Already dispatches an operational alert** from `sweep.ts`'s `considerBrokerage`, once
    per brokerage per `OPERATIONAL_ALERTS_COOLDOWN_SECONDS`:
    - `kind="evaluation"` → `GROW_SIGNAL_SWEEP_BROKERAGE_FAILED` (dedup key
      `grow-signal-sweep:brokerage-evaluation-failed:<brokerageId>`). The pass threw; the
      cursor stamp still runs so the tenant moves to the back of the durable ordering.
    - `kind="cursor_touch"` → `GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED` (dedup key
      `grow-signal-sweep:cursor-touch-failed:<brokerageId>`). The follow-up stamp of
      `last_evaluated_at` also failed, so that brokerage keeps sorting first and can
      starve every tenant behind it on later scheduled runs. This alert is in addition
      to the evaluation alert for the same pass.
    Both use the H-1 policy shape (severity `high`, owner `operations`, runbook
    `grow-signal-sweep`) and are their own types, so they are not collapsed into
    `GROW_SIGNAL_SWEEP_UNHEALTHY` (conditions 28 and 29), which means the sweep as a
    whole is not running. A tenant that fails every tick produces one alert per cooldown
    for that tenant, not one per tick. (Runbook: `grow-signal-sweep` — read
    `errors` and `errorMessage` on `GET /api/grow/property-intelligence/ops/health`, then
    the structured log for that `sweepRunId`.)
31. No `property_signal_sweep_total{outcome="completed"}` increment for longer than
    3 × `GROW_SIGNAL_SWEEP_INTERVAL_MS` → sweeping has stopped without the lock-leak
    or scheduled-run alert firing (e.g. the process is alive but the timer was never
    registered). Per-brokerage alerts (condition 30) do not cover a sweep that never
    starts. This one is
    **not** wired to a dispatch and is the honest gap in this set: it is a
    *rate-of-absence* condition, which needs an external rule engine (§3) rather than an
    in-process call site. Until one exists, the same judgement is available on demand from
    `GET /api/grow/property-intelligence/ops/health` (`staleBy.stale` with
    `staleBy.thresholdMs` being that same 3 × interval). Check `scheduler.enabled` before
    escalating: `GROW_SIGNAL_SWEEP_ENABLED=false` is a deliberate off switch and reports
    `stale: true` correctly, since nothing is sweeping.

**Cardinality note.** All three sweep counters
(`property_signal_sweep_total`, `property_signal_sweep_lock_orphaned_total`,
`property_signal_sweep_brokerage_failure_total`) carry only closed label sets and **no
tenant identifier of any kind** — 2 triggers × 2 kinds = 4 series for the orphaned-lock
counter, and 2 series for the per-brokerage failure counter. A brokerage with a million
contacts adds exactly zero series. Per-brokerage detail lives on the
`grow_signal_sweep_runs` row, in the structured log, and in the H-4 alert `details`
(`brokerageId` only — still never a metric label), per the metrics catalogue's own rule
at `packages/events/src/metrics.ts:150-154`.

**Not added, deliberately.** A stale-sweep check in `GET /api/health/ready` is a pending
Project Owner decision and is out of scope here. The recommendation on the table is
`degraded`, never `unavailable`: failing readiness would pull the single always-on pilot
instance out of rotation over a background job that raises reviewable indicators and
contacts nobody.

### 2b. AI provider calls and voice transcription (conditions 32–34)

Added by AE GROW C-10. These series are process-level and closed. Text-generation
`provider` is `mock`, `anthropic`, or `other`. Voice `provider` is `mock`, `deepgram`,
or `other`. An unrecognised provider name is coerced to `other`. Outcomes have no
`other` value, so a bad call site throws in test and development and does not open a
free-form series. No label is a brokerage id, user id, raw model string, or correlation
id. There is no dollar metric: estimated provider cost stays on the administrator-only
`GET /api/ai/usage` snapshot. Token counters are not a ceiling.

`ai_provider_call_total` and `ai_provider_call_duration_ms` are one observation per
attempt inside `generateWithGateway` (a retry is another attempt). `ai_gateway_result_total`
is one observation per call: `primary_success`, `fallback_success`, or `failed`.
`ai_provider_tokens_total{kind}` (`prompt` or `completion`) increments only when an
attempt returns. `voice_transcription_total` and `voice_transcription_duration_ms` count
only a request that reached `provider.transcribe`, with outcome `success`,
`provider_error`, `rejected_after_provider`, or `empty_transcript`.
`voice_transcription_audio_seconds_total` sums `durationSeconds` on success. That is
the speech-to-text spend meter, and it does not add a table. A refusal before the
provider (entitlement, upload validation, rate limit, daily cap) is absent from these
series. Call-transcription (`buildCallTranscriptionProvider`) is not this route and is
not instrumented here. Both duration metrics are registered in `HISTOGRAM_METRICS`.

32. `ai_gateway_result_total{result="fallback_success"}` share of gateway results
    exceeds a sustained threshold (for example more than 10% over 15 minutes) → the
    primary provider is failing and generation is being served by the fallback.
33. `ai_provider_call_total{outcome="failure"}` share of attempts, or any sustained
    `ai_gateway_result_total{result="failed"}`, rises above a small baseline →
    generation is failing outright: the primary's attempts were exhausted and the
    fallback did not answer.
34. `voice_transcription_total{outcome="provider_error"}` share of transcriptions that
    reached the provider exceeds a sustained threshold → speech-to-text is failing
    after the request was accepted. `voice_transcription_audio_seconds_total` is the
    spend reading for that same traffic. It is not itself an alert.

### 2c. Pit Crew WAITING_ON detection sweep (conditions 35–37)

Added by Run slice R-F6. The scheduled detection sweep
(`lib/pitCrew/waitingOnSweepBootstrap.ts`) is opt-in
(`PIT_CREW_WAITING_ON_SWEEP_ENABLED`, default off). It identifies overdue
WAITING_ON items. It does not return them, reassign them, or contact anyone.
The human `POST /pit-crew/ops/waiting-on/sweep` route is a different path and
is not these metrics. Label sets are closed and have no `other` fallback.
No label is a brokerage id, assignment id, property id, user id, or tier.
`GET /pit-crew/ops/waiting-on/health` (R-F7) is the in-app read of whether this sweep is on and healthy for the caller's brokerage; it adds no metric and no alert.

Like conditions 28–30, **35 and 36 page today, via a real code path**. They
dispatch from `runScheduledWaitingOnSweep` to the configured
`OPERATIONAL_ALERTS_WEBHOOK_URL` (severity `high`, owner `operations`,
runbook `pit-crew-waiting-on-sweep`). `logger.error` is not bridged to
`dispatchOperationalAlert()` (`logger.ts` only writes JSON to stderr), so a
sweep that throws on every tick would otherwise surface only as stderr.
At most one alert is dispatched per tick. The dispatcher's cooldown is what
limits repeats. The setInterval catch logs and does not dispatch a second
alert. The flag stays default off, so nothing can fire until the Owner
enables the sweep.

35. The sweep is unhealthy for ≥ `PIT_CREW_WAITING_ON_SWEEP_ALERT_AFTER_CONSECUTIVE_FAILURES`
    (3) consecutive ticks → **already dispatches `PIT_CREW_WAITING_ON_SWEEP_UNHEALTHY`**
    (dedup key `pit-crew-waiting-on-sweep:unhealthy`). An unhealthy tick is one
    that threw, or one where every considered brokerage failed (`brokerages > 0`
    and `failedBrokerages === brokerages`). A completed tick that is not
    unhealthy resets the streak. An overlap skip does not move it. The
    realistic case is the flag switched on before migration 0031
    (`pit_crew_waiting_on_sweep_settings` and `pit_crew_waiting_on_sweep_sightings`)
    is applied: `loadPitCrewWaitingOnSweepSettings` throws for every brokerage
    on every tick, and this condition pages. One stable dedup key, not one per
    brokerage, so two hundred failing tenants are one page per cooldown.
    `failedBrokerageIds` in the details are ascending and capped at 20. The
    whole-tick error is `err.message` only. Per-brokerage messages stay in
    `pit_crew_waiting_on_sweep_brokerage_failed`. (Runbook:
    `pit-crew-waiting-on-sweep`.)
36. Some brokerages fail on ≥ 3 consecutive completed ticks while the sweep
    itself finishes → **already dispatches `PIT_CREW_WAITING_ON_SWEEP_BROKERAGE_FAILED`**
    (dedup key `pit-crew-waiting-on-sweep:brokerage-failures`, same policy
    shape). This is not condition 35: at least one brokerage in the tick did
    not fail. A tick that threw does not move this counter. A completed tick
    with `failedBrokerages === 0` resets it. When both streaks are at the
    threshold, condition 35 wins and this type is not sent.
37. No `pit_crew_waiting_on_sweep_tick_total{outcome="completed"}` for longer
    than 3 × `PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS` while the sweep is enabled
    → the timer is not running. **Not wired.** This is a rate-of-absence rule
    and needs an external rule engine (§3). The scheduler is off by default,
    so absence is expected until the Owner enables the sweep.

**Cardinality note.** The four series (`pit_crew_waiting_on_sweep_tick_total`,
`pit_crew_waiting_on_sweep_tick_duration_ms`,
`pit_crew_waiting_on_sweep_brokerage_total`,
`pit_crew_waiting_on_sweep_item_total`) carry only closed label sets and no
tenant identifier. 3 + 2 + 4 + 2 = 11 series maximum. A brokerage id in alert
details is never a metric label.

#### Ops health read (R-F7)

`GET /pit-crew/ops/waiting-on/health` answers, for the signed-in Pit Crew user or Brokerage Administrator, whether the scheduled sweep is switched on, when it last ticked in this process, and whether that tick is healthy. It uses the same role gate and `run.access` check as `POST /pit-crew/ops/waiting-on/sweep`. The brokerage id comes only from the session. The handler does not write, sweep, audit, or alert.

`scheduler` is job-level: `enabled`, `started`, `intervalMs`, `lastTick` (`at`, `outcome`, `durationMs`), `health` (`ok`, `degraded`, `unhealthy`, or `not_running`), the two consecutive-failure streaks, and `alertThreshold`. `health` is `not_running` when the flag is off or this process has never ticked; `unhealthy` when either streak has reached the threshold (3); `degraded` when either streak is 1 or 2; otherwise `ok`. `brokerage` is the caller's row only: settings availability, the resolved cadence and window, `lastDetectionAt`, and `failedLastTick` (a boolean, or null when no tick has completed). The response has no other brokerage's id, settings, counts, or failure status, and no platform-wide brokerage aggregate. If migration 0031 is missing, or any settings read throws, the route stays 200 with `brokerage.settingsAvailable` false and the settings fields null.

## 3. What it would take to make alerting real

1. A scrape target and rule engine (Prometheus + Alertmanager, or a hosted equivalent like
   Datadog/Grafana Cloud) pointed at `GET /api/internal/metrics` with `METRICS_TOKEN`
   configured as its bearer credential — the metric names and label sets above are already
   stable and ready to scrape; nothing in the application needs to change to support this.
2. A real paging destination (PagerDuty, Opsgenie, or equivalent) wired to the alert rules
   in §2 — explicitly out of scope this step; no such destination exists or is authorised.
3. A scheduled `pnpm audit` (or equivalent) run wired into CI for alert #17 — see
   `.github/workflows/` for this step's CI addition (Part D), which runs `pnpm audit`
   per-push/PR but is not yet a standalone scheduled job independent of code changes.
4. Route-level and per-tenant granularity for #4/#5/#9 above a certain point would need a
   deliberate cardinality-bounded design (e.g. a fixed allowlist of route *patterns*, never
   raw paths with interpolated ids) — the registry's existing discipline (bounded label sets,
   coercion to `"other"`) is the right foundation for this, but no route-pattern label exists
   in `METRIC_DEFINITIONS` today; adding one is future work, not done this step.

## 4. Known gaps in the metrics registry itself, disclosed rather than glossed over

1. **Cross-tenant rejections (SLI #10, alert #9) are only PARTIALLY a metric.**
   `tenant_isolation_rejection_total{boundary}` is wired at the `communications`, `pit_crew`,
   and `integrations` boundary constructors, because those are the three domains with a
   single shared, dedicated tenant-mismatch error class the Step 2 pass could wire once each.
   **R-F8** also emits it at the Run transaction, financial, and offer boundaries.
   Transactions: `requireTransactionAccess` and the `GET /transactions/by-property/:propertyId`
   property check (`boundary="transaction"`). Financial: `resolveTransactionScope` only
   (`boundary="financial"`), after a rejection-path existence lookup that does not select
   the other brokerage's id. Offers: the authenticated offer routes' property-brokerage
   check. The declared label set has no `offer` value and R-F8 does not change the metrics
   module, so offer rejections use the closest declared value, `boundary="transaction"`.
   The counter increments only when the named row exists in another brokerage. A missing
   row, a role or entitlement 403, and a successful request do not increment it, and the
   response stays the same 404. **R-F9** also emits it at the properties and parties API
   boundaries. Properties: every authenticated `:id` route that rejects a property in
   another brokerage (`GET /:id`, workspace, timeline, ownership-review, listing-details,
   ready-to-list, go-live) uses `boundary="property"`. The timeline route's check still
   lives in `assertPropertyInBrokerage` (`lib/timeline.ts`); the route counts only when
   that function's existing `Property <id> not found` error is a cross-tenant id, and the
   404 body stays that same message. Parties: `POST /`, `GET /by-property/:propertyId`,
   and `DELETE /link/:linkId` use `boundary="party"`. On a miss only, one existence
   lookup that selects no brokerage id and no other tenant columns (no party PII)
   distinguishes a cross-tenant id from a missing one. The counter increments only for
   the former, exactly once, and the response stays the same 404. Still not wired, and
   still on the inline "identical 404" pattern: grow, documents, AML, pit-crew work-item
   overlays outside the two wired classes, and the `IntegrationError` reasons other than
   `NOT_FOUND`/`TENANT_MISMATCH`. The declared `other` boundary is unused. Detected for
   those unwired boundaries by grep-ing/alerting on structured log lines from
   `middlewares/auth.ts`/`middlewares/entitlement.ts` and the individual chokepoints.
2. **Per-rule exception-engine failures are not separately counted.** Unchanged from the
   prior revision: `exceptions_scan_total` records that a scan ran, by trigger, but not
   whether every rule inside that scan pass succeeded.
3. **No dedicated import-job metric.** Alert #21 remains log-based; `job_repeated_failure_total`
   and the other new job/queue metrics this pass added do not cover the import pipeline,
   which has no outbox/queue table of its own.
4. **`workflow_execution_failure_total{workflow}`'s `ready_to_list` and `launch_plan` labels
   are declared but not yet wired at a real throw site** — only `automation_rule` (wired at
   `lib/automation/engine.ts`'s rule-evaluation catch) is live. Adding the other two means
   finding and instrumenting their own failure/catch points, not done this pass.
5. **The global rate limiter's rejections have no dedicated counter** — `authRateLimiter`
   now increments `auth_security_event_total{event="auth_rate_limited"}` via its `handler`,
   but `globalRateLimiter` (the 300/min-per-IP whole-API throttle) was not given an
   equivalent this pass; its rejections are only visible as `http_requests_total`'s
   status-class counters plus access logs (see alert #7).
6. **Sensitive webhook-payload redaction for a future real provider** — unchanged from the
   prior revision: `integration_inbox.payload` stores whatever a webhook sends, in full, for
   audit/replay; today's mock providers never send anything sensitive, but this is a distinct,
   still-open concern for whenever a real (non-mock) provider is connected.

## 5. Cross-check against this pass's thirteen named critical-gap categories

The governing instruction for this closure pass named thirteen specific metric categories to
close. This section states, for each, exactly what backs it now and what (if anything) is
still open — no category is silently marked done without saying which metric/label backs it.

| # | Named category | Status | Backing |
|---|---|---|---|
| 1 | Auth attack patterns | **Closed** | `auth_security_event_total{event: invalid_session_token, revoked_session_reused, dev_login_disabled_attempt, auth_rate_limited}` |
| 2 | Tenant-isolation rejections | **Partially closed** — see §4 item 1 | `tenant_isolation_rejection_total{boundary}`, 7 of 8 declared boundaries actually wired (`other` is unused; offers emit `transaction`) |
| 3 | API failure/latency | **Already closed pre-existing** | `http_requests_total{method,status_class}` / `http_request_duration_ms{method,status_class}` — predates this pass, confirmed still correctly wired via `middlewares/httpMetrics.ts` |
| 4 | Queue backlog | **Closed** | `queue_backlog_size{queue: integration_outbox, financial_payment_outbox, communications_outbox}` |
| 5 | Oldest-item age | **Closed** | `queue_oldest_item_age_ms{queue}` — same three queues |
| 6 | Repeated job failures | **Closed** | `job_repeated_failure_total{job: integration_outbox_command, financial_payment_outbox_command, communications_outbox_message}` |
| 7 | Dead-letter growth | **Already closed pre-existing** | `integration_dead_letter_total{source_type}` — predates this pass; `job_repeated_failure_total` above is the new, more general sibling wired alongside every dead-letter site |
| 8 | Webhook rejection/replay spikes | **Closed** | `communications_webhook_total`/`financial_webhook_total{outcome}` (new, this pass) plus pre-existing `integration_webhook_total{outcome}` — all three routers now covered |
| 9 | Communication processing failure | **Closed via the funnel above** | `communications_webhook_total{outcome="failure"}` covers inbound; outbound communication *dispatch* failure is covered by the pre-existing `job_repeated_failure_total{job="communications_outbox_message"}` (item 6) rather than a separate metric |
| 10 | Financial reconciliation mismatch | **Closed** | `financial_reconciliation_variance_total{source}` — wired at the single chokepoint that ever writes a `financial_reconciliations` row with `status="VARIANCE"` (`lib/financial/mockPaymentStatusSync.ts`'s `applyMockPaymentStatusEvent`, the same event `FIN05_RECONCILIATION_VARIANCE_UNRESOLVED` later escalates to a risk exception if left unresolved) |
| 11 | Workflow execution failure | **Partially closed** — see §4 item 4 | `workflow_execution_failure_total{workflow}`, only `automation_rule` wired of the three declared labels |
| 12 | Critical unresolved risk | **Closed** | `unresolved_critical_risk_gauge{status="open"}` |
| 13 | Integration degradation | **Closed** | `integration_connection_degraded_total{provider}` |
| — | AI action denial/allowance threshold | **Closed** (named separately from the numbered 13 in the governing instruction, included here for completeness) | `ai_action_decision_total{outcome: allowed, denied}` |

**Honest summary of this cross-check:** 10 of 13 named categories are fully closed, and 2 are
partially closed with the exact wired/unwired boundary named (#2 tenant-isolation, 7 of 8
boundaries; #11 workflow execution, 1 of 3 workflow families) — #8/#9's outbound side is
already covered by #6, and the AI-governance category named separately from the numbered 13
is also closed, bringing the total to 11 of 14 fully closed.

Items in this section and §4 are the honest boundary of what the Step 2 closure pass
meant by "operational metrics with strict cardinality bounds": twenty-three metrics
backing fourteen SLIs and twenty-seven alert-ready conditions, with named, scoped-out
extensions rather than a claim of exhaustive coverage. The catalogue has since grown.
C-10 brings it to **thirty-five** metrics and **thirty-four** alert-ready conditions.
R-F6 brings it to thirty-nine metrics and thirty-seven conditions.
SLI #13 now covers provider calls, latency, fallback, tokens, and voice transcription
as well as the policy-decision counter. Token ceilings, dollar ceilings, and a durable
voice-metering table are still out of this registry.
