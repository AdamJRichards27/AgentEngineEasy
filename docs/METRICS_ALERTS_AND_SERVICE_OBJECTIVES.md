# Metrics, Alerts, and Service Objectives

Agent Engine 2.0, Step 2. **Nothing in this document is wired to a real metrics backend or
a real paging system.** No metrics collection exists in this codebase (see
`OBSERVABILITY_STANDARD.md` §6); this step's instruction explicitly does not authorise a
real third-party sandbox/production connection, and a real alerting pipeline would require
one. Everything below is a specification — interfaces and target thresholds, not live
infrastructure — for a human team to implement against. As with the observability
document, this step's instruction named eleven SLI/SLO areas and seventeen alert-ready
events verbatim; that exact enumeration was not recoverable from this session's available
context (see `OBSERVABILITY_STANDARD.md`'s opening note on the same issue). The eleven and
seventeen items below are this step's own reasoned equivalent, grounded in this codebase's
actual subsystems, flagged for comparison against the original spec.

## 1. Service Level Indicator areas (target: 11)

| # | Area | Proposed SLI | Why this one |
|---|---|---|---|
| 1 | API availability | % of requests to `GET /api/health` returning 200 | Now meaningful — the check is DB-aware (this step), not a static stub |
| 2 | Auth success rate | successful `/auth/dev-login` responses ÷ attempts | Direct signal of a credential-stuffing attempt or a broken auth path |
| 3 | Session revocation latency | time between `POST /auth/logout` and the next request with the old token being rejected | Should be ~0 given the new epoch mechanism is synchronous — a regression here would be a real security finding |
| 4 | Rate-limit rejection rate | `429`s ÷ total requests, split global vs. `/auth/*` | A spike is either abuse or a misconfigured client |
| 5 | Cross-tenant rejection rate | count of tenant-mismatch errors (`PitCrewPropertyMismatchError`, `CommunicationTenancyError`, the "not found" responses from every chokepoint in the tenant-isolation doc) | A sustained non-zero rate from one account is a strong IDOR-probing signal — see alert #6 below |
| 6 | Webhook processing success rate | processed ÷ received, per provider (comms/financial/integrations) | Direct signal of provider-mock (later: real-provider) integration health |
| 7 | Integration outbox delivery | successful outbox deliveries ÷ attempts, and dead-letter rate | This system already has the domain concept (`INTEGRATION_COMMAND_DEAD_LETTERED`, existing exception rule H01) — an SLO should track the rate that feeds that rule |
| 8 | Exception-engine scan success rate | scheduled scans completing without `EVALUATION_FAILED` ÷ total scheduled scans | Existing test coverage already proves a single rule's failure doesn't block siblings (`lib/exceptions/__tests__/engine.test.ts`) — the SLO is whether that stays rare in aggregate |
| 9 | Payment charge/refund success rate | successful ÷ attempted, excluding expected business-rule rejections (e.g. already-refunded) | Financial-integrity signal |
| 10 | Import job success rate | jobs completing ÷ jobs submitted, and rejected-at-validation rate (`fileValidation.ts`) | Surfaces both pipeline health and upload-abuse patterns |
| 11 | Build/test health (a process SLI, not a runtime one) | full regression suite pass rate over time, typecheck pass/fail | The one SLI already measurable today without any new instrumentation — see the completion report's test evidence for the current value (609/609 non-skipped passing) |

## 2. Alert-ready conditions (target: 17)

Each entry is a condition and threshold a real alerting system should evaluate — **none of
these page anyone today**; this is the specification only.

1. `GET /api/health` returns non-200 for ≥ 2 consecutive checks (suggested interval: 30s) →
   database connectivity incident (Runbook: DB outage).
2. Boot-time failure of `assertSessionSecretConfigured()` or `assertCorsConfigured()` in a
   production-classified environment → deploy-blocking, should never reach "alert" in a
   healthy pipeline (it prevents boot), but the deploy system should surface it loudly.
3. Auth failure rate (`/auth/*`, 401/403) exceeds a sustained threshold (e.g. > 20/min from
   a single IP, i.e. hitting `authRateLimiter`'s own ceiling repeatedly) → credential-
   stuffing suspicion (Runbook: rate-limit bypass/credential stuffing).
4. Global rate-limit rejections (`429`) exceed a sustained threshold from a single IP →
   scripted abuse (same runbook as #3).
5. Any cross-tenant rejection (SLI #5 above) exceeding a small non-zero baseline from a
   single authenticated account within a short window → active IDOR-probing suspicion
   (Runbook: suspected cross-tenant exposure).
6. A webhook signature-verification failure rate spike, any of the three webhook routers →
   forged-callback suspicion (Runbook: webhook signature bypass suspected).
7. `INTEGRATION_COMMAND_DEAD_LETTERED` rate exceeds baseline → already has a domain-level
   handler (exception rule H01); this alert is the operational-visibility counterpart.
8. Exception-engine `EVALUATION_FAILED` rate exceeds baseline → rule regression.
9. A `pnpm audit` run (see §3, dependency-scan cadence) reports a new `high` or `critical`
   finding → dependency vulnerability disclosed (Runbook: dependency vulnerability
   disclosed).
10. Payment charge/refund failure rate exceeds baseline → financial-integrity incident.
11. Import job rejection-at-validation rate spikes → either an upstream data-quality
    problem or file-upload abuse (Runbook: import-pipeline abuse).
12. `sessionEpoch` bump rate (logout events) for a single user exceeds a small threshold in
    a short window → possible session-compromise-and-recovery cycle in progress (Runbook:
    session token compromise).
13. Any 500-level response rate exceeds baseline, aggregated by route — general regression
    signal.
14. p95/p99 request latency exceeds a threshold, aggregated by route — performance
    regression signal (not currently measurable — no request-duration metric exists yet,
    see §3).
15. `isDevAuthEnabled()` evaluating true in any environment where `NODE_ENV==="production"`
    — should be structurally impossible (`lib/env.ts`'s own hard-off check), but a
    boot-time assertion mirroring `assertSessionSecretConfigured()` firing here would be a
    severe configuration-drift alert (Runbook: dev-login surface exposed in production).
16. CORS rejection rate spike (an unexpected origin repeatedly denied) → either a
    legitimate new frontend deployment nobody added to `CORS_ALLOWED_ORIGINS`, or
    reconnaissance.
17. Audit-log write failure (a `logAudit` call itself throwing/being swallowed) → the audit
    trail's own integrity is at risk (Runbook: audit-log gap or tampering suspected).

## 3. What it would take to make §1/§2 real

1. A metrics library (e.g. `prom-client`) exporting the counters/histograms the SLIs above
   need, scraped by a collector — none of this exists today, and this step did not add it
   (it would be new infrastructure, not a hardening of something existing, and this step's
   instruction scopes to closing verified gaps in existing engines rather than standing up
   a new subsystem without a specific verified need driving it beyond "the doc asked for
   it").
2. A scheduled `pnpm audit` (or equivalent) run wired into whatever CI eventually exists —
   there is currently no CI configuration in this repository at all (`.github/workflows/`
   absent — confirmed, disclosed, not fabricated; see the completion report's entry-gate
   evidence). `pnpm audit` was run manually this session as a one-time record (see
   `SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md` §8), not as a recurring check.
3. A real alerting/paging destination — explicitly out of scope this step.

This document exists so that when metrics infrastructure is added, the target shape is
already specified and doesn't need to be re-derived from scratch.
