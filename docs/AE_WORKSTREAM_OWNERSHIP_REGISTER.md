# AE WORKSTREAM OWNERSHIP REGISTER

**Purpose.** One authoritative record of who owns what while multiple agents work the AE GROW
Completion Program in parallel.

**Naming rule.** Use the **operational name + PR#** as the primary identifier. Historical W-numbers
(the original §4 labels in the roadmap) are secondary. Where an operational label and a §4 label
diverge, the operational name and the PR number win. The alias map is in the roadmap under §4.

**The rule this register exists to enforce:** *no two implementation agents own the same files
simultaneously.* A reviewer and an implementer may look at the same files; two implementers may not.

**Canonical source of truth is `staging` on GitHub.** This file records ownership, not state — for
what remains to be built, see [`AE_GROW_COMPLETION_ROADMAP.md`](./AE_GROW_COMPLETION_ROADMAP.md).
Run lane status lives in [`AE_RUN_COMPLETION_ROADMAP.md`](./AE_RUN_COMPLETION_ROADMAP.md).

Current staging: `a0d01f988c7b323102bcfe311a4c756bf3246b0e` (2026-09-26, C-10 #107 merged). I-18 is this claim and is not yet a staging landing.

---

## Roles

| Role | Holder | Authority |
|---|---|---|
| **Primary AE Development Orchestrator** | Grok | Owns the engineering queue, assigns slices, verifies candidate merges, and maintains this register and the roadmap. **PO-mandated 2026-09-22.** |
| **Independent Assurance / Watchdog / Infrastructure / Recovery** | OpenClaw | Independent assurance, watchdog, infrastructure, and recovery. **Historical:** OpenClaw was the primary orchestrator and the single authoritative engineering queue during the Grok integration trial. That trial role is closed; OpenClaw does not own the queue. |
| **Implementation** | Claude | Implements explicitly owned slices under Grok orchestration. |
| **Merge / main / prod / provider gates** | Project Owner | Retains merge to `staging` and `main`, production migration and deploy authority, and provider-credential gates. Every merge requires explicit Project Owner approval. |

Grok uses **its own** GitHub credentials. Credentials are never shared between agents, never placed
in prompts, reports, repository files or CI output, and least privilege applies — read-only access
for a read-only task even where the credential permits more.

---

## Active register

| Workstream | Branch | Primary agent | Files / domain | Status | Dependencies | PR | Reviewer |
|---|---|---|---|---|---|---|---|
| **R-F22** (Pit Crew LAUNCH_ITEM source, API only) | `cursor/rf22-pitcrew-launch-item-source-b33a` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/api/src/lib/pitCrew/launchItemSource.ts`; `apps/api/src/lib/pitCrew/assignment.ts` (LAUNCH_ITEM tenant branch only); `apps/api/src/lib/pitCrew/queries.ts` (`getPitCrewWorkspace` launch-item read only); `apps/api/src/lib/pitCrew/types.ts` (workspace source union only); `apps/api/src/routes/__tests__/pitCrewLaunchItemSource.test.ts`; `apps/api/src/routes/__tests__/pitCrewLaunchItemImportLock.test.ts`; `apps/api/src/routes/__tests__/support/pitCrewForbiddenSourceWriters.ts`; `apps/api/src/lib/pitCrew/__tests__/launchItemWorkspace.test.ts`; `docs/AE_RUN_COMPLETION_ROADMAP.md`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`. Does not claim `apps/api/src/routes/launch.ts`, `apps/api/src/lib/commandCentre/**`, `apps/web/src/lib/commandCentre.ts`, `apps/web/src/pages/CommandCentre.tsx`, `apps/web/src/lib/todaySurfaces.ts`, `apps/api/src/lib/grow/**`, `apps/api/src/lib/communications/**`, `apps/api/src/lib/propertyIntelligence/**`, `docs/AE_GROW_*`, or any web file. Does not change hand-back, escalate, the inbox, recipients, `itemParamsSchema`, or the WAITING_ON sweep. Does not enable `PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED` or `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED`. No migration and no schema change. | **Ready for review** — API-only LAUNCH_ITEM source, flag default off. Do not merge without Owner approval. | Base `6f104398ed0caf689af271c7e40f8ed0d9a4c445` (staging tip, R-F21 #131). | #132 | — |
| **R-F21** (Pit Crew source-type guard) | `cursor/rf21-pitcrew-source-type-guard-54ed` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/api/src/lib/pitCrew/assignment.ts` (`assertSourceRecordOnPropertyInBrokerage` only); `apps/api/src/routes/__tests__/pitCrewSourceTypeGuard.test.ts`; `docs/AE_RUN_COMPLETION_ROADMAP.md`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`. Does not claim `apps/api/src/lib/commandCentre/**`, `apps/web/src/lib/commandCentre.ts`, `apps/web/src/pages/CommandCentre.tsx`, `apps/web/src/lib/todaySurfaces.ts`, `apps/api/src/lib/grow/**`, `apps/api/src/lib/communications/**`, `apps/api/src/lib/propertyIntelligence/**`, `docs/AE_GROW_*`, or `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`. Does not change `itemParamsSchema`, responsibility actions, the inbox, recipients, the WAITING_ON sweep, or the web app. No migration and no schema change. Does not add a second source type. | **Merged #131** — released. Not an active claim. Squash `6f104398ed0caf689af271c7e40f8ed0d9a4c445`. | Base `3c369d87bac2ac552b1a7cc43acddb8f447c9bdf` (staging tip, R-F19 #129). | #131 | — |
| **R-F20** (Pit Crew second source type design) | `cursor/pit-crew-second-source-design-bcf0` | Grok (orchestrator) / Cursor cloud agent (implementer) | `docs/design/PIT_CREW_SECOND_SOURCE_TYPE_DESIGN.md` only. No schema, route, or behaviour change. | **Merged #130** — released. Not an active claim. Design only. Squash `9a851e9222dcba9dc69737e30bb80450ec33c611`. | Base `3c369d87bac2ac552b1a7cc43acddb8f447c9bdf` (R-F19 #129). | #130 | — |
| **R-F19** (stale comments and flag-off responsibility route lock) | `cursor/rf19-stale-comments-flag-off-lock-ba97` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/web/src/pages/PitCrewCommandCentre.tsx` (header comment only); `apps/api/src/lib/financial/legacyReconciliation.ts` (comments only); `apps/api/src/lib/financial/__tests__/legacyReconciliation.test.ts` (comments only); `packages/db/src/schema/financial.ts` (index comments only; the `legacyCommissionUniqueIdx` declaration stays byte-identical); `apps/api/src/lib/pitCrew/__tests__/queries.test.ts` (header comment only); `docs/design/PIT_CREW_HANDBACK_ESCALATE_DESIGN.md` (open question 6 only); `apps/api/src/routes/__tests__/pitCrewResponsibilityFlagOffLock.test.ts`; `docs/AE_RUN_COMPLETION_ROADMAP.md`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`. Does not claim `apps/api/src/lib/commandCentre/**`, `apps/web/src/lib/commandCentre.ts`, `apps/web/src/pages/CommandCentre.tsx`, `apps/web/src/lib/todaySurfaces.ts`, `apps/api/src/lib/grow/**`, `apps/api/src/lib/communications/**`, `apps/api/src/lib/propertyIntelligence/**`, `docs/AE_GROW_*`, or `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`. Does not enable `PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED` or `PIT_CREW_WAITING_ON_SWEEP_ENABLED`. No migration and no schema change. | **Merged #129** — released. Not an active claim. Squash `3c369d87bac2ac552b1a7cc43acddb8f447c9bdf`. | Base `368cbc50d0010df9449f55db023146060d1ce286` (R-F18 #128 landed). | #129 | — |
| **R-F8** (tenant-isolation rejection metric at Run boundaries) | `cursor/rf8-tenant-isolation-metric-578a` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/api/src/routes/transactions.ts` (tenant checks only); `apps/api/src/lib/financial/queries.ts` (`resolveTransactionScope` only); `apps/api/src/routes/offers.ts` (tenant checks only); `apps/api/src/routes/__tests__/runTenantIsolationRejection.test.ts`; `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` (§4 item 1 only); `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`. Does not claim commandCentre, web, index.ts, packages/db, or Owner-gated items (C-1, E-1, G-1, H-5, F-4, Performance/Coach, B-2/W4-B, A-8, Owner #15). | **Ready for review** — metric-only. No response, access-control, or schema change. Do not merge without Owner approval. | Base `43b5aafff78c39f8d4561733fbd7bfc8c98ac069` (R-F7 #113 landed). | #114 | — |
| **R-F7** (WAITING_ON sweep ops health read) | `cursor/rf7-waiting-on-sweep-health-a45d` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/api/src/lib/pitCrew/waitingOnSweepBootstrap.ts`; `apps/api/src/routes/pitCrew.ts` (GET `/pit-crew/ops/waiting-on/health` only); `apps/api/src/routes/__tests__/pitCrewWaitingOnSweepHealth.test.ts`; `apps/api/src/lib/pitCrew/__tests__/waitingOnSweepOperability.test.ts` (snapshot assertions only); `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`. Does not claim commandCentre, web, index.ts, packages/db, or Owner-gated items (C-1, E-1, G-1, H-5, F-4, Performance/Coach, B-2/W4-B, A-8, Owner #15). Does not enable the sweep, does not apply migration 0031, and does not add an environment variable. | **Ready for merge** — read-only tenant-scoped sweep health. No migration. Flag stays default off. | Base `51b9f26e07ddfe412a51391ceaee6bd02cc106bd` (R-F6 #112 landed). | #113 | — |
| **R-F6** (WAITING_ON sweep failure alert and metrics) | `cursor/rf6-waiting-on-sweep-alerts-b2ab` | Grok (orchestrator) / Cursor cloud agent (implementer) | `packages/events/src/metrics.ts`; `packages/events/src/__tests__/metrics.test.ts`; `apps/api/src/lib/operationalAlerts.ts`; `apps/api/src/lib/__tests__/operationalAlerts.test.ts`; `apps/api/src/lib/pitCrew/waitingOnSweepBootstrap.ts`; `apps/api/src/lib/pitCrew/__tests__/waitingOnSweepOperability.test.ts`; `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`. Does not claim commandCentre, routes/**, index.ts, web, packages/db, or Owner-gated items (C-1, E-1, G-1, H-5, F-4, Performance/Coach, B-2/W4-B, A-8, Owner #15). Does not enable the sweep, does not apply migration 0031, and does not add an environment variable. | **In review** — scheduled WAITING_ON sweep metrics and repeated-failure alerts. No migration. Flag stays default off. | Base `cdb86b34d69d88c01223c90f1840998d636e4e73`. | #112 | — |
| **I-18** (route-level code splitting) | `cursor/i18-route-code-splitting-b49c` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/web/src/App.tsx`; `apps/web/src/lib/__tests__/routeCodeSplitting.test.ts`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`; `docs/AE_GROW_COMPLETION_ROADMAP.md`. Does not claim any page file under `apps/web/src/pages/**` (in particular not `CommandCentre.tsx` or `PitCrewCommandCentre.tsx`). Does not claim the API, Run/pitCrew (`apps/api/src/index.ts`, `apps/api/src/lib/pitCrew/**`, `apps/api/src/routes/pitCrew.ts`, `.env.example`), commandCentre (`apps/web/src/lib/commandCentre.ts`, `apps/api/src/lib/commandCentre/**`), or Owner-gated items (C-1, E-1, G-1, A-8, H-5, F-4, Performance/Coach, B-2/W4-B, Owner #15). Does not implement I-9 or I-10. | **Ready for merge** — authenticated pages load as route chunks. No migration. Not yet a staging landing. | Base `a0d01f988c7b323102bcfe311a4c756bf3246b0e` (#107 C-10 merged). Disjoint from Run R-F4. | #108 | — |
| **C-10** (AI provider and voice transcription metrics) | `cursor/c10-ai-provider-voice-metrics-6e7a` | Grok (orchestrator) / Cursor cloud agent (implementer) | `packages/events/src/metrics.ts`; `apps/api/src/lib/ai/gateway.ts`; `apps/api/src/routes/aiVoice.ts`; `apps/api/src/lib/ai/__tests__/aiProviderMetrics.test.ts`; `apps/api/src/routes/__tests__/aiVoiceMetrics.test.ts`; `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`; `docs/AE_GROW_COMPLETION_ROADMAP.md`. Does not claim Run/pitCrew (`apps/api/src/routes/pitCrew.ts`, `apps/api/src/lib/pitCrew/**`, `apps/api/src/routes/__tests__/pitCrew*.test.ts`, `apps/web/src/pages/PitCrewCommandCentre.tsx`, `apps/web/src/lib/pitCrew.ts`), commandCentre, orchestrator/coaching (`apps/api/src/lib/ai/orchestrator.ts`, `apps/api/src/lib/ai/coaching/**`, `apps/api/src/lib/ai/context/**`), `dailyUsage.ts`, `usageLimits.ts`, `audit.ts`, `routes/ai.ts`, or Owner-gated items (C-1, E-1, G-1, A-8, H-5, F-4, Performance/Coach, B-2/W4-B, Owner #15). Does not change token or dollar ceilings, does not add a voice metering table, and does not add an index. | **Merged #107** — released. Not an active claim. Process-level AI provider and voice metrics. `ai_usage` read-back stays #55 / 0029. C-10 is partially landed, not closed. No migration. I-18 does not reopen C-10. | Landed on staging at `a0d01f988c7b323102bcfe311a4c756bf3246b0e`. | #107 | — |
| **I-15** (timeline label Maps, code-path only) | `cursor/i15-timeline-lookup-maps-9dbf` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/api/src/lib/timeline.ts`; `apps/api/src/lib/__tests__/timelineLookupMaps.test.ts`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`; `docs/AE_GROW_COMPLETION_ROADMAP.md`. Does not add `domain_events` / `audit_logs` indexes (those stay with W1-D, alongside I-11 and I-13). Does not claim command centre, Run/pitCrew, Grow Today, or Owner-gated items (C-1, E-1, G-1, H-5, F-4, Performance/Coach, B-2/W4-B, A-8, Owner #15). Does not implement G-7, B-3, E-5, or A-10. Does not reopen I-14. | **Ready for merge** — related timeline rows are indexed by id before label assembly. No migration. Not yet a staging landing. | Base `3708c8dfc3acc044281ab03d5a21dc094369b4a1` (#101 I-14 merged). | #103 | — |
| **I-14** (bound Command Centre property-id fan-out) | `cursor/i14-command-centre-id-chunk-a0df` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/api/src/lib/commandCentre/queries.ts`; `apps/api/src/lib/commandCentre/__tests__/propertyIdChunk.test.ts`; `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`; `docs/AE_GROW_COMPLETION_ROADMAP.md`. Does not claim exception-engine rules, Grow Today, contactability, the web Command Centre, or Owner-gated items (C-1, E-1, G-1, A-8, H-5, F-4, Performance/Coach product, B-2/W4-B, Owner #15). Does not implement G-7, B-3, E-5, or A-10. B-5, E-8, G-6, G-3, F-5, D-5, I-16, and I-17 stay closed. | **Merged #101** — released. Not an active claim. I-15 does not reopen I-14. | Landed on staging at `3708c8dfc3acc044281ab03d5a21dc094369b4a1`. | #101 | — |
| **G-3** (relate Grow Today and the RUN Command Centre) | `cursor/g3-relate-today-screens-5cf5` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/web/src/lib/todaySurfaces.ts`; `apps/web/src/components/TodaySurfaceCrossLink.tsx`; Grow Today header in `apps/web/src/pages/Grow.tsx`; RUN header in `apps/web/src/pages/CommandCentre.tsx`; the opening comments in `apps/web/src/lib/growToday.ts` and `apps/web/src/lib/commandCentre.ts`; `apps/web/src/lib/__tests__/todaySurfaces.behavior.test.ts`; the E-2 href assertions in `apps/web/src/lib/__tests__/growTodayAppraisalActions.behavior.test.ts` (property links unchanged; `/today` is the only added href); `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`; `docs/AE_GROW_COMPLETION_ROADMAP.md`. Does not claim the API reads, Nurture, entitlement gates, or Owner-gated items (C-1, E-1, G-1, A-8, H-5, F-4, Performance/Coach product, B-2/W4-B, Owner #15). F-5, D-5, G-4, G-5, and G-8 stay closed. | **Merged #97** — released. Not an active claim. I-14 does not reopen G-3. | Landed on staging. | #97 | — |
| **Performance / Coach** | *none — read-only* | Discovery agent | `lib/ai/coaching/**` (read only until a claim is recorded) | DISCOVERY — **unblocked** after #55 merged | Implementation still **gated** on Owner decisions **#4** and **#5**, plus a file claim in this register before any edit. C-9 released `recentActivityQueryShape.test.ts` with #89. | — | — |

### Known ownership — released and still open

Consolidation gate `234871a` released the domains below. The previous Active collision claims are obsolete.

- **`lib/ai/**`** — released with **#55** (operational W2-C, AI governance). Performance/Coach discovery may read `lib/ai/coaching/**`. **C-9** released `recentActivityQueryShape.test.ts` with **#89** and did not edit `metrics.ts`. Implementation still waits on Owner decisions #4 and #5 and a new file claim. **C-10** claims `apps/api/src/lib/ai/gateway.ts` and `apps/api/src/lib/ai/__tests__/aiProviderMetrics.test.ts` only. It does not claim orchestrator, coaching, context, `dailyUsage.ts`, `usageLimits.ts`, or `audit.ts`.
- **`propertyIntelligence/service.ts`** (with `evaluation.ts`, `evidence.ts`, `signals.ts`, `routes/propertyIntelligence.ts`, `PropertyIntelligencePanel.tsx`, `web/lib/contactAnchoredSignals.ts`) — released with **#59** (operational W2-D, contact-anchored signals). **E-4** claimed `service.ts`, `PropertyIntelligencePanel.tsx`, `contactSignalVisibility.test.ts`, and `contactAnchoredSignals.behavior.test.ts`, and released them with **#79**. It did not claim `evaluation.ts`, `signals.ts`, `evidence.ts`, `routes/propertyIntelligence.ts`, or `web/lib/contactAnchoredSignals.ts`. Gate 19 stays as #59/#79 left it.
- **`routes/contacts.ts`** and the **`Grow.tsx` consent panel** (`GrowContactConsentPanel`) — released with **#61** (operational W3-A, contactability completion). **A-6** re-verified that read model on tip `753b72c` and docs **#80** recorded the closure. Those files stay in the pool. A-7's capture/withdraw controls in that panel are unchanged. **A-9** released `routes/growCalls.ts` and `routes/__tests__/growCalls.test.ts` with **#82**. `routes/contacts.ts` stays in the pool.
- **`communications/outbox.ts`** and **`communications/providers/**`** (with `telephony/recordingGates.ts` and the `lib/env.ts` flag) — released with **#60** (operational W3-B, connect readiness). The #51 dispatch-time consent re-check stays in force. **I-17** claimed `communications/outbox.ts` and the sweep tests in `routes/__tests__/communicationsDispatchConsentRecheck.test.ts` and released them with **#83**. Providers, the activation gate, and `bootstrap.ts` stay in the pool. Do not reopen I-17. **E-7** closed via **#84** and did not claim `outbox.ts`. **I-16** does not claim `outbox.ts`. **D-4** released `telephony/recordingGates.ts` and `telephony/__tests__/recordingGateEvidence.test.ts` with **#94**. It did not claim `outbox.ts`, providers, or `lib/env.ts`. **D-5** released `communications/webhooks.ts` and `communications/__tests__/inboundReplyThreading.test.ts` with **#95**. It did not claim `outbox.ts`, providers, `recordingGates.ts`, or `lib/env.ts`.
- **`docs/`** — released with **#58** (register / roadmap), claimed again by **E-3** and released with **#65**, claimed again by **I-1** and released with **#66**, claimed again by **I-2** and released with **#67**, claimed again by **F-2** and released with **#68**, claimed again by **I-3** and released with **#69**, claimed again by **I-6 / I-8** and released with **#70**, claimed again by **Wave-1 docs re-verification — A-1/A-2/A-3/H-1** and released with **#71**, claimed again by **A-4 / A-5 status reconciliation** and released with **#73**, claimed again by **H-2 / H-3 / H-6 status reconciliation** and released with **#74**, claimed again by **E-2 status markers** and released with **#76**, claimed again by **G-2** and released with **#77**. Docs edits still require a claim before a new slice starts. **H-4** released the register, the roadmap, and `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` with **#78**. **E-4** claimed the register and the roadmap and released them with **#79**. **A-6** claimed the register and the roadmap and released them with **#80**. **E-6** claimed the register and the roadmap and released them with **#81**. **A-9** claimed the register and the roadmap and released them with **#82**. **I-17** claimed the register and the roadmap and released them with **#83**. **E-7** claimed the register and the roadmap and released them with **#84**. **I-16** claimed the register and the roadmap and released them with **#85**. **F-6** claimed the register and the roadmap and released them with **#86**. **B-4** claimed the register and the roadmap and released them with **#87**. **C-9** claimed the register and the roadmap and released them with **#89**. **G-4** claimed the register and the roadmap and released them with **#88**. **G-5** claimed the register and the roadmap and released them with **#90**. **G-8** claimed the register and the roadmap and released them with **#91**. C-12 is the same `Grow.tsx` comment and closed with G-8. **F-7** released the register and the roadmap with **#92**. **A-11** released them with **#93**. **D-4** released them with **#94**. **D-5** released them with **#95**. **F-5** released them with **#96**. **G-3** claimed them for the two Today screens and released them with **#97**. **I-14** claimed them and released them with **#101**. **I-15** claims the register and the roadmap for this code-path note. **C-10** claimed the register, the roadmap, and `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` and released them with **#107**. **I-18** claims the register and the roadmap. **R-F6** claims the register and docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md. **R-F7** claims the register and `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` for the sweep health read. **R-F19** claims the register and `docs/AE_RUN_COMPLETION_ROADMAP.md` for the stale-comment correction and the flag-off route lock. It does not claim `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`. **R-F21** claims the register and `docs/AE_RUN_COMPLETION_ROADMAP.md` for the Pit Crew source-type guard. It does not claim `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`.
- **I-1** (`relationshipTimeline.ts` property-label lookup) is already in the pool via **#53**, and the #66 re-verification is merged. The predicate is `id IN (…) AND brokerage_id =`, covered by `contactReadScoping.test.ts`. Do not open another I-1 implementation slice.
- **I-2** (`growToday.ts` `fetchLastActivityByParty`) is already in the pool via **#57**, and the #67 re-verification is merged. The read is `max(occurred_at) group by party_id`, filtered by `brokerage_id` and the party ids already in play, covered by `growTodayQueryShape.test.ts`. Do not open another I-2 implementation slice.
- **I-3** (`contactIntelligence.ts` and `relationshipTimeline.ts` brokerage predicates) is already in the pool via **#53**, and the #69 re-verification is merged. The SQL predicate is `brokerage_id =` and `party_id =` on `grow_relationships`, `grow_activities`, `grow_opportunities`, and `grow_commitments` (and `grow_contact_roles`), covered by `contactReadScoping.test.ts`. Do not open another I-3 implementation slice.
- **I-6** (`routes/contacts.ts` enrichment `party_id in (…)` on the rendered party ids, plus `brokerage_id`) is already in the pool via **#53**, and the #70 re-verification is merged. Locked by `contactReadScoping.test.ts`. Do not open another I-6 implementation slice.
- **I-7** (role filter in SQL before `limit(200)`, same file) is already in the pool via **#53**. Locked by `contactReadScoping.test.ts`. Do not re-implement.
- **I-8** (`QueryClient` `staleTime: 30_000`, `refetchOnWindowFocus: false` in `apps/web/src/main.tsx`) is already in the pool via **#53**, and the #70 re-verification is merged. Do not open another I-8 implementation slice.
- **A-1** (`routes/growConsent.ts` F2 consent/DNC/suppression/policy writers, mounted in `routes/index.ts`) is already in the pool via **#52**. This verification does not re-claim those routes. Do not open another A-1 implementation slice.
- **A-2** (`POST /communications/consent` with `requireEntitlement("grow.contacts.manage")` in `routes/communications.ts`) is already in the pool via **#51**. Do not open another A-2 implementation slice.
- **A-3** (`dispatchMessage` consent re-check → `BLOCKED_BY_CONSENT` in `communications/outbox.ts`) is already in the pool via **#51**. Do not open another A-3 implementation slice.
- **H-1** (`GROW_SIGNAL_SWEEP_UNHEALTHY` in `operationalAlerts.ts`, raised from `sweep.ts` and `sweepBootstrap.ts`) is already in the pool via **#50**. Do not open another H-1 implementation slice.
- **H-2** (`GET/POST /api/grow/property-intelligence/ops/{health,sweep,signals/count}`, BA-only `requireRole(...BROKERAGE_ADMIN_ROLES)`; `listRecentSweepRuns` and `countActiveSignals` have callers) is already in the pool via **#50**. Locked by `propertyIntelligenceOps.test.ts` and `sweepOps.test.ts`. Do not open another H-2 implementation slice.
- **H-3** (`scheduler.enabled` on sweep ops health, so `GROW_SIGNAL_SWEEP_ENABLED=false` is visible after boot) is already in the pool via **#50**. Locked by `sweepOps.test.ts`. Do not open another H-3 implementation slice.
- **H-6** (`property_signal_outcome_total{outcome="expired"}` incremented; sweep metrics in the metrics doc; `GROW_SIGNAL_SWEEP_*` in `.env.example`; sweep-run indexes in migration 0028) is already in the pool via **#50**. Locked by `sweepOps.test.ts`. Do not open another H-6 implementation slice. Run-table retention stays Owner decision #15.
- **A-4** (legacy `communication_consent` prior-value audit, made durable) is already in the pool via **#51** (`previousValue` beside `updatedValue`) and **#72** (consent mutation and strict `logAudit` in one transaction; `COMMUNICATION_CONSENT_UPDATED` only after commit). Do not open another A-4 implementation slice.
- **A-5** (`partyId` validated against the caller's brokerage before write or publish; a foreign-tenant id returns 400) is already in the pool via **#51**. #72 did not change that validation. Do not open another A-5 implementation slice.
- **F-2** (`MAX_PRIORITY_ACTIONS` after the sort, `withheldByActionCap`) is already in the pool via **#57**, and the #68 re-verification is merged. Emerging stays on `MAX_EMERGING_SIGNAL_ACTIONS` (10). Do not open another F-2 implementation slice.
- **F-3** (one signal card per party; losing signals ride as `relatedSignals`) is already in the pool via **#57**, locked by `growTodayConsolidation.test.ts`. Do not re-implement.
- **I-4** (`GROW_TODAY_*_ROW_CAP` on each rule read, ordered, with stated `limitations`) is already in the pool via **#57**, locked by `growTodayQueryShape.test.ts`. Do not re-implement.
- **I-5** (uncapped `priorityActions`) is the same response bound as F-2. Already in the pool via **#57**. Do not re-implement.
- **`growToday.ts`** (API) and the Grow Today card in **`pages/Grow.tsx`** were released with **F-1 / #64** (and, for other `Grow.tsx` regions, #61 and #65). F-2, F-3, I-2, I-4, and I-5 are closed on `growToday.ts`. The #68 re-verification is merged and did not hold the file. **E-2** closed on tip `6f5b749` via product **#75** and docs **#76**; `apps/api/src/lib/growToday.ts` and the Grow Today card in `apps/web/src/pages/Grow.tsx` are back in the pool. Do not re-open E-2. **G-2** closed on tip `0748f5d` via **#77** and did not claim those files or the Grow calling panels. **H-4** closed on tip `fa7a0a9` via **#78** and did not claim them either. **E-4** closed on tip `753b72c` via **#79** and did not claim them. **A-6** closed via product **#61** and docs **#80** and did not claim them. **E-6** does not claim them. **A-9** closed via **#82** and did not claim them. **I-17** closed via **#83** and did not claim them. **E-7** closed via **#84** and did not claim them. **I-16** claimed `apps/api/src/lib/growToday.ts` for the party-id set passed into the contactability filter and released it with **#85**. It did not rewrite the rules. **F-6** does not claim `growToday.ts`. **F-7** does not edit `growToday.ts` or `signalRanking.ts`. The single `COLD_CONTACT_THRESHOLD_DAYS` landed in **#57** and is locked by `growSignalRanking.test.ts`. **F-5** released `apps/api/src/lib/growToday.ts` and `ruleDWinsOverSignal` in `apps/api/src/lib/grow/signalRanking.ts` with **#96** (tip `a1e5df0`). Do not open another F-5 implementation slice. **G-3** does not claim those API files. It claims the web Today headers, `apps/web/src/lib/todaySurfaces.ts`, and `TodaySurfaceCrossLink.tsx`.
- **B-1** (messaging fragments in the protected-operations denylist) was closed by **#55**. `OUTBOUND_MESSAGING_FRAGMENTS` is present in `apps/api/src/lib/ai/protectedOperations.ts` and covered by `governance.test.ts`. Do not open a B-1 implementation slice.
- **A-6** (Contact 360 read-only contactability) is already in the pool via **#61**. Docs **#80** recorded that closure on tip `0f04235`. `GET /grow/contacts/:partyId` returns `contactability` from `evaluateConsentDecisionReadOnly` (no decision row, no consent advisory lock). Do not open another A-6 implementation slice.
- **E-6** (Comms Hub `RecentCommunicationRow` mirror and contact-first links) is already in the pool via **#56** (`6cc44ec`). Verified on tip `0f04235` (post-#80): web `propertyAddress` is `string | null`, `partyDisplayName` is present, a contact-first row links to `/grow?tab=contacts&contact={partyId}`, and a property-anchored row still links to `/properties/{propertyId}`. Locked by `communicationsHub.behavior.test.ts`. Do not open another E-6 implementation slice. The product files stay in the pool. Docs **#81** recorded that closure on tip `9082867` and released the register and the roadmap.
- **E-7** (import results next actions) is **closed** via **#84** (tip `7d4a9cf`). It released `apps/web/src/pages/GrowImport.tsx` (previously released with **#56**) and `apps/web/src/lib/__tests__/growImportResults.behavior.test.ts`. A completed import offers See these contacts in Grow (`/grow?tab=contacts`) and Go to Grow Today (`/grow`). Undo stays on the existing rollback route. It did not claim `Grow.tsx`. Do not open another E-7 implementation slice.
- **A-9** (read-only `GET /grow/calls/contacts/:partyId/eligibility`) is already in the pool via **#82** (tip `162cfc8`). The poll uses `evaluateOutboundCallEligibilityReadOnly`. It does not append `grow_consent_decisions` and does not take the consent advisory lock. Create and confirm still record the authoritative decision. Do not reopen A-6, A-7, or A-9. A-8 stays open and unclaimed. **I-17** did not claim `growCalls.ts`. **E-7** closed via **#84** and did not claim it. **I-16** did not claim it. **F-6** does not claim it.
- **I-16** (contactability party-id dedupe before the 5,000-id chunk) is already in the pool via **#85** (tip `78abb5b`). `loadContactabilityFilter` evaluates a repeated id once. Fail-closed DNCR and suppression outcomes are unchanged. Locked by `contactabilityFilterDedupe.test.ts`. Do not open another I-16 implementation slice. **F-6** closed via **#86** and did not claim `contactability.ts` or `growToday.ts`. **B-4** did not claim them. **C-9** did not claim them. **G-4** does not claim them.
- **F-6** (`get_due_commitments` returns Open `grow_commitments` due today or overdue) is already in the pool via **#86** (tip `33ac02b`). `get_grow_today_due_items` stays the follow-up view. Locked by `registry.test.ts` and `growAskAeContext.test.ts`. Do not open another F-6 implementation slice. **B-4** did not claim `lib/ai/**`. **C-9** did not claim the AI tool files. **G-4** does not claim the AI tool files.
- **B-4** (`re_engagement_opportunity` talking point) is already in the pool via **#87** (tip `4d451d0`). Product behaviour landed in **#57** (`78d0e4c`): `buildNarrative()` returns a question talking point for that signal type. Locked by `apps/api/src/lib/__tests__/growSignalRanking.test.ts`. #87 did not edit `signalRanking.ts`. Do not open another B-4 implementation slice. B-2 and W4-B stay open. **G-4** does not claim `signalRanking.ts`.
- **C-9** (`fetchRecentActivityByParty` ordered and capped) is already in the pool via **#89** (tip `78e510e`). Product behaviour landed in **#55** (`deff17d`): most recent first, `id` ascending as the tiebreak, `ACTIVITY_ROW_CAP` (2000), truncation disclosed. #89 did not edit `metrics.ts`. Locked by `recentActivityQueryShape.test.ts`. Do not open another C-9 implementation slice. Performance/Coach implementation (decisions #4 and #5) stays open. **G-4** does not claim `metrics.ts` or that test.
- **G-4** (import history empty/error/retry) is already in the pool via **#88** (tip `f6afaaaa`). Product behaviour landed in **#56** (`GrowDataRegionStatus` on the import-history card). The lock is `growImportHistory.behavior.test.ts`. It did not edit `GrowImport.tsx`. Do not open another G-4 implementation slice. **G-5** (safe ApiError narrowing) is already in the pool via **#90** (tip `e1cf167`). A non-ApiError failure shows a defined fallback. An ApiError keeps its friendly sentence. Locked by `apiErrorMessage.test.ts`. Do not open another G-5 implementation slice. **G-8** and **C-12** are already in the pool via **#91** (tip `e92707b`). Product copy landed in **#56**. The Pit Crew comment names the command-centre filter. Do not open another G-8 or C-12 implementation slice. **F-7** is already in the pool via **#92** (tip `171b6bdf`). **A-11** is already in the pool via **#93** (tip `eca8fefc`). **D-4** is already in the pool via **#94** (tip `7e69c46`). **D-5** is already in the pool via **#95** (tip `cfac59d`). **F-5** is already in the pool via **#96** (tip `a1e5df0`). A Rule D cold card keeps the losing signal as `relatedSignals`. Do not open another F-5 implementation slice. **G-3** landed in **#97** and released its files. **G-6**, **E-8**, and **B-5** landed after that register row was written (#98, #99, #100). **I-14** landed in **#101** (`apps/api/src/lib/commandCentre/queries.ts` and `apps/api/src/lib/commandCentre/__tests__/propertyIdChunk.test.ts`). Do not open another I-14 implementation slice. **I-15** (timeline label Maps, code-path only) is this claim: `apps/api/src/lib/timeline.ts` and `apps/api/src/lib/__tests__/timelineLookupMaps.test.ts`. Indexes on `domain_events` / `audit_logs` stay with W1-D. No migration. Do not open another I-15 code-path slice.

## Merged — no longer owned

Any new slice touching these files must claim them here. Identifiers below use **operational name + PR#**; historical W-numbers are secondary and mapped in the roadmap §4 alias table.

Released back to the pool on 2026-09-21 (seven-slice wave + #56):

| PR | Slice | Domain released |
|---|---|---|
| #49 | Completion Roadmap | `docs/` |
| #54 | Test-env hardening | `scripts/run-api-tests.sh`, root `package.json`, `README.md` |
| #50 | Sweep ops, alerting, metrics, migration 0028 | `propertyIntelligence/sweep.ts`, `sweepBootstrap.ts`, `packages/events/src/metrics.ts`, `operationalAlerts.ts`, `packages/db/migrations/` |
| #51 | Consent security + dispatch re-check | `routes/communications.ts`, `communications/consent.ts`, `communications/outbox.ts`, `communications/types.ts` |
| #52 | F2 consent/DNC write routes | `routes/growConsent.ts` |
| #53 | Tenant-scoped contact reads | `relationshipTimeline.ts`, `contactIntelligence.ts`, `routes/contacts.ts`, `web/src/main.tsx` |
| #57 | Grow Today bounding (operational W2-A) | `growToday.ts` (API + web), `grow/signalRanking.ts` |
| #56 | UX coherence (operational W2-B) | `CommandCentre.tsx`, `GrowImport.tsx`, `CommunicationsHub.tsx`, `Home.tsx`, `Settings.tsx`, `web/lib/communications.ts`, `productNav.ts` |

Released back to the pool on 2026-09-22 (consolidation gate, merge order #58→#55→#59→#61→#60, tip `234871ab1f9e415c0e9600f4d5290daa17aefc7b`):

| PR | Slice | Domain released |
|---|---|---|
| #58 | Register / roadmap | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |
| #55 | AI governance (operational W2-C) | `lib/ai/**`, `routes/ai.ts`, `packages/db/src/schema/ai.ts`, migration 0029 |
| #59 | Contact-anchored signals (operational W2-D) | `propertyIntelligence/service.ts`, `evaluation.ts`, `evidence.ts`, `signals.ts`, `routes/propertyIntelligence.ts`, `PropertyIntelligencePanel.tsx`, `web/lib/contactAnchoredSignals.ts` |
| #61 | Contactability completion (operational W3-A) | `routes/contacts.ts`, `pages/Grow.tsx`, `GrowContactConsentPanel`, `web/lib/contactability.ts` |
| #60 | Connect readiness (operational W3-B) | `communications/outbox.ts`, `communications/providers/**`, `telephony/recordingGates.ts`, `lib/env.ts` (flag only) |

Released back to the pool on 2026-09-22 (F-1, tip `11cd01f0e3a2bf10fde2def1817a6c29e6d6a2b3`):

| PR | Slice | Domain released |
|---|---|---|
| #64 | F-1 Commitments on Grow Today | `growToday.ts` (API + web), Grow Today commitment card in `pages/Grow.tsx`, `growTodayCommitments.test.ts`, `growTodayQueryShape.test.ts`, `web/lib/__tests__/growToday.test.ts`, `growTodayConsolidation.test.ts` |

Released back to the pool on 2026-09-22 (E-3, tip `23ff95200fbca12ec155ec6868db60f3a31d8d73`):

| PR | Slice | Domain released |
|---|---|---|
| #65 | E-3 Opportunities actionable | `pages/Grow.tsx` (opportunity row actions and the shared Add note write), `web/lib/__tests__/growOpportunityActions.behavior.test.ts`, `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-22 (I-1 re-verification, tip `6d3d87d6bb4fa3e65192f14ebe35099177c865cb`):

| PR | Slice | Domain released |
|---|---|---|
| #66 | I-1 Contact 360 properties scoping (re-verification) | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-22 (I-2 re-verification, tip `e703e7b422a6ef688c81f6901590b98d6fa439f1`):

| PR | Slice | Domain released |
|---|---|---|
| #67 | I-2 Grow Today activity aggregate (re-verification) | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-22 (F-2 re-verification, tip `09f3bb5be2c1abbee7ded95005495f8605a49037`):

| PR | Slice | Domain released |
|---|---|---|
| #68 | F-2 Grow Today non-Emerging signal cap (re-verification) | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-22 (I-3 re-verification, tip `736118d5323657ee617e5f0086d2fe63eec37060`):

| PR | Slice | Domain released |
|---|---|---|
| #69 | I-3 Contact 360 brokerage predicates (re-verification) | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-22 (I-6 / I-8 re-verification, tip `e9337bd3d3cc7bd43e86d3f43a649e97a880db2d`):

| PR | Slice | Domain released |
|---|---|---|
| #70 | I-6 / I-8 contacts enrichment and QueryClient freshness (re-verification) | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-22 (Wave-1 docs re-verification — A-1/A-2/A-3/H-1, tip `f4263c7b9ea175ad69408fb50d971aedc26a43b7`):

| PR | Slice | Domain released |
|---|---|---|
| #71 | Wave-1 docs re-verification — A-1/A-2/A-3/H-1 | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-22 (A-4 / A-5 status reconciliation, tip `24336ed9ee36cee0b2bb5e4d08095e37b2c59655`):

| PR | Slice | Domain released |
|---|---|---|
| #73 | A-4 / A-5 status reconciliation | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-23 (H-2 / H-3 / H-6 status reconciliation, tip `4a3d48d462fa250fc1064bd2fa8b26f59e5a9cde`):

| PR | Slice | Domain released |
|---|---|---|
| #74 | H-2 / H-3 / H-6 status reconciliation | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-23 (E-2, tip `6f5b7497d92feae8f4cd65b2b0a2040a6a9c79fa`):

| PR | Slice | Domain released |
|---|---|---|
| #75 | E-2 `view_appraisal` / `view_property` on Grow Today `appraisal_follow_up` cards | `apps/api/src/lib/growToday.ts`, Grow Today card in `apps/web/src/pages/Grow.tsx`, `apps/api/src/lib/__tests__/growTodayAppraisalActions.test.ts`, `apps/web/src/lib/__tests__/growTodayAppraisalActions.behavior.test.ts` |
| #76 | E-2 status markers (written while #75 was still a draft; the closed status is recorded by the G-2 claim) | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` |

Released back to the pool on 2026-09-23 (G-2, tip `0748f5df2d162e8abc867cb9adc5e9faa7a93531`):

| PR | Slice | Domain released |
|---|---|---|
| #77 | G-2 reason-aware entitlement 403s | `apps/web/src/lib/api.ts`, `apps/web/src/lib/__tests__/entitlementForbidden.test.ts`. Register and roadmap were claimed with this slice and were claimed again by **H-4**, now released. |
| #78 | H-4 per-brokerage sweep and cursor-touch alerts | `apps/api/src/lib/operationalAlerts.ts`, `apps/api/src/lib/propertyIntelligence/sweep.ts`, `apps/api/src/lib/propertyIntelligence/__tests__/sweepOps.test.ts`, `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`. Register and roadmap were claimed with this slice and were claimed again by **E-4**, now released. Tip `fa7a0a93b83b59cf8164802e855ae883b8bea4ad`. |

Released back to the pool on 2026-09-23 (E-4, tip `753b72c050094c36747e424158a28f44a5658dd3`):

| PR | Slice | Domain released |
|---|---|---|
| #79 | E-4 Contact 360 party-anchored signal honesty | `apps/api/src/lib/propertyIntelligence/service.ts`, `apps/api/src/lib/propertyIntelligence/__tests__/contactSignalVisibility.test.ts`, `apps/web/src/components/PropertyIntelligencePanel.tsx`, `apps/web/src/lib/__tests__/contactAnchoredSignals.behavior.test.ts`. Register and roadmap were claimed with this slice and were claimed again by **A-6**, now released. Tip `753b72c050094c36747e424158a28f44a5658dd3`. |

Released back to the pool on 2026-09-23 (A-6, tip `0f0423574090c6c929d079dc36979f005f31906e`):

| PR | Slice | Domain released |
|---|---|---|
| #80 | A-6 Contact 360 contactability status (product #61) | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md`. Register and roadmap were claimed with this slice and were claimed again by **E-6**, now released. Tip `0f0423574090c6c929d079dc36979f005f31906e`. |

Released back to the pool on 2026-09-23 (E-6, tip `908286729252d48e9de6a987ce49db3b0d1766f6`):

| PR | Slice | Domain released |
|---|---|---|
| #81 | E-6 Comms Hub type-mirror verification (product #56) | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md`. Register and roadmap were claimed with this slice and were claimed again by **A-9**, now released. Tip `908286729252d48e9de6a987ce49db3b0d1766f6`. |

Released back to the pool on 2026-09-23 (A-9, tip `162cfc80b61823a9957601e5f89f56d8ff9642d2`):

| PR | Slice | Domain released |
|---|---|---|
| #82 | A-9 read-only call eligibility on GET | `apps/api/src/routes/growCalls.ts`, `apps/api/src/routes/__tests__/growCalls.test.ts`. Register and roadmap were claimed with this slice and were claimed again by **I-17**, now released. Tip `162cfc80b61823a9957601e5f89f56d8ff9642d2`. |

Released back to the pool on 2026-09-23 (I-17, tip `56d892235e8d5edb12ef60724d329d57b2783bfe`):

| PR | Slice | Domain released |
|---|---|---|
| #83 | I-17 bounded due-message select | `apps/api/src/lib/communications/outbox.ts`, `apps/api/src/routes/__tests__/communicationsDispatchConsentRecheck.test.ts`. Register and roadmap were claimed with this slice and were claimed again by **E-7**, now released. Tip `56d892235e8d5edb12ef60724d329d57b2783bfe`. |

Released back to the pool on 2026-09-23 (E-7, tip `7d4a9cfc38bbed984e0b3dfe5248af768c1ad3af`):

| PR | Slice | Domain released |
|---|---|---|
| #84 | E-7 import results next actions | `apps/web/src/pages/GrowImport.tsx`, `apps/web/src/lib/__tests__/growImportResults.behavior.test.ts`. Register and roadmap were claimed with this slice and were claimed again by **I-16**, now released. Tip `7d4a9cfc38bbed984e0b3dfe5248af768c1ad3af`. |

Released back to the pool on 2026-09-23 (I-16, tip `78abb5b715d30b376c95674765418544eb16bb8a`):

| PR | Slice | Domain released |
|---|---|---|
| #85 | I-16 contactability id dedupe before chunking | `apps/api/src/lib/propertyIntelligence/contactability.ts`, `apps/api/src/lib/growToday.ts` (party-id set passed into the filter), `apps/api/src/lib/propertyIntelligence/__tests__/contactabilityFilterDedupe.test.ts`. Register and roadmap were claimed with this slice and were claimed again by **F-6**, now released with **#86**. Tip `78abb5b715d30b376c95674765418544eb16bb8a`. |

Released back to the pool on 2026-09-23 (F-6, tip `33ac02be083aa0dc638d954c34a6ec950a500126`):

| PR | Slice | Domain released |
|---|---|---|
| #86 | F-6 `get_due_commitments` returns Open `grow_commitments` | `apps/api/src/lib/ai/tools/registry.ts`, `apps/api/src/lib/ai/context/growContext.ts`, `apps/api/src/lib/ai/types.ts`, `apps/api/src/lib/ai/tools/__tests__/registry.test.ts`, `apps/api/src/routes/__tests__/growAskAeContext.test.ts`, GrowContext fixture field only in the listed AI tests. Register and roadmap were claimed with this slice and were claimed again by **B-4**, now released with **#87**. Tip `33ac02be083aa0dc638d954c34a6ec950a500126`. |

Released back to the pool on 2026-09-23 (B-4, tip `4d451d0fae66159fb37686ad213c65a1ac139ec5`):

| PR | Slice | Domain released |
|---|---|---|
| #87 | B-4 re-engagement talking point recorded closed | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md`. Product behaviour stayed in #57 (`signalRanking.ts` was not edited). Register and roadmap were claimed with this slice and were claimed again by **C-9**, now released with **#89**, and are claimed again by **G-4**. Tip `4d451d0fae66159fb37686ad213c65a1ac139ec5`. |

Released back to the pool on 2026-09-23 (C-9, tip `78e510e6f7fce1f3f4f462cbd68e7873c4544290`):

| PR | Slice | Domain released |
|---|---|---|
| #89 | C-9 recent-activity order and cap lock (product #55) | `apps/api/src/lib/ai/coaching/__tests__/recentActivityQueryShape.test.ts`; `apps/api/package.json` (that test path on the API test script only). `metrics.ts` was not edited. Register and roadmap were claimed with this slice and were claimed again by **G-4**, now released with **#88**. Tip `78e510e6f7fce1f3f4f462cbd68e7873c4544290`. |

Released back to the pool on 2026-09-23 (G-4, tip `f6afaaaaec0b96cdd9b62b2ca014ee67bf7ab582`):

| PR | Slice | Domain released |
|---|---|---|
| #88 | G-4 import history empty/error/retry lock (product #56) | `apps/web/src/lib/__tests__/growImportHistory.behavior.test.ts`. `GrowImport.tsx` was not edited. Register and roadmap were claimed with this slice and were claimed again by **G-5**, now released with **#90**. Tip `f6afaaaaec0b96cdd9b62b2ca014ee67bf7ab582`. |

Released back to the pool on 2026-09-24 (G-5, tip `e1cf16720c55d246b0ea7cce933fa75ea359e65f`):

| PR | Slice | Domain released |
|---|---|---|
| #90 | G-5 safe ApiError narrowing | `apps/web/src/lib/api.ts` (`apiErrorMessage`); `apps/web/src/lib/__tests__/apiErrorMessage.test.ts`; the remaining executable `as ApiError` reads of `.friendly` listed on the G-5 row before this release. Register and roadmap were claimed with this slice and were claimed again by **G-8**, now released with **#91**. Tip `e1cf16720c55d246b0ea7cce933fa75ea359e65f`. |

Released back to the pool on 2026-09-24 (G-8 / C-12, tip `e92707b6c63866120d80ff6c854a52a4824dc74f`):

| PR | Slice | Domain released |
|---|---|---|
| #91 | G-8 Pit Crew comment and C-12 recorded closed | `apps/web/src/pages/CommandCentre.tsx` (Pit Crew Activity comment). `Grow.tsx` and `productNav.ts` were not edited. Register and roadmap were claimed with this slice and were claimed again by **F-7**, now released with **#92**. Tip `e92707b6c63866120d80ff6c854a52a4824dc74f`. |

Released back to the pool on 2026-09-24 (F-7, tip `171b6bdf100e26ca0f53b528aae047c4e160c481`):

| PR | Slice | Domain released |
|---|---|---|
| #92 | F-7 single `COLD_CONTACT_THRESHOLD_DAYS` (product #57) | `apps/api/src/lib/__tests__/growSignalRanking.test.ts` (lock only). `signalRanking.ts` and `growToday.ts` were not edited. Register and roadmap were claimed with this slice and were claimed again by **A-11**, now released with **#93**. Tip `171b6bdf100e26ca0f53b528aae047c4e160c481`. |

Released back to the pool on 2026-09-24 (A-11, tip `eca8fefc24ee531314f8808e2b98287c7974e327`):

| PR | Slice | Domain released |
|---|---|---|
| #93 | A-11 drop the duplicate `recordConsent` alias | `apps/api/src/lib/consentControlsPersistence.ts`; `apps/api/src/lib/__tests__/recordConsentExportLock.test.ts`; the writer-comment sentences in `growToday.ts`, `contactability.ts`, and the pathway test. `communications/consent.ts` keeps `recordConsent`. Register and roadmap were claimed with this slice and were claimed again by **D-4**, now released with **#94**. Tip `eca8fefc24ee531314f8808e2b98287c7974e327`. |

Released back to the pool on 2026-09-24 (D-4, tip `7e69c46d930d46a0eb7e7fb2a428eb867c650c17`):

| PR | Slice | Domain released |
|---|---|---|
| #94 | D-4 keep the blocked recording-gate reason | `apps/api/src/lib/telephony/recordingGates.ts`; `apps/api/src/lib/telephony/__tests__/recordingGateEvidence.test.ts`. The legalPolicy gate was not widened. Register and roadmap were claimed with this slice and were claimed again by **D-5**, now released with **#95**. Tip `7e69c46d930d46a0eb7e7fb2a428eb867c650c17`. |

Released back to the pool on 2026-09-24 (D-5, tip `cfac59d266af2b87b7913496ca74a23b1202f68c`):

| PR | Slice | Domain released |
|---|---|---|
| #95 | D-5 record inbound replies on the resolved thread | `apps/api/src/lib/communications/webhooks.ts`; `apps/api/src/lib/communications/__tests__/inboundReplyThreading.test.ts`. Register and roadmap were claimed with this slice and were claimed again by **F-5**, now released with **#96**. Tip `cfac59d266af2b87b7913496ca74a23b1202f68c`. |

Released back to the pool on 2026-09-24 (F-5, tip `a1e5df0068fc2a7a70878eb70bdb82706c5b4787`):

| PR | Slice | Domain released |
|---|---|---|
| #96 | F-5 cold card keeps the signal it beat | `apps/api/src/lib/growToday.ts`; `apps/api/src/lib/grow/signalRanking.ts` (`ruleDWinsOverSignal` only); `apps/api/src/routes/__tests__/growTodayConsolidation.test.ts`; `apps/api/src/lib/__tests__/growSignalRanking.test.ts`; `apps/web/src/lib/__tests__/growTodayConsolidation.test.ts`. Register and roadmap were claimed with this slice and are claimed again by **G-3**. Tip `a1e5df0068fc2a7a70878eb70bdb82706c5b4787`. |

---

## Conventions

1. **Claim before you edit.** A slice is added here with its file list before implementation starts.
2. **One canonical owner per implementation area.** If a slice needs a file another slice owns, it
   stops and reports rather than reaching across.
3. **Branch from the owner, not from staging**, when a slice extends unmerged work. Record the
   dependency in the PR body as well as here. Historical example: operational W2-D (#59) branched
   from #56 while that PR was still open. Both are merged; new slices branch from current `staging`
   unless a register row says otherwise.
4. **Migrations batch.** Index and schema work collects into one migration per wave rather than
   fragmenting across slices.
5. **Merging releases ownership.** Move the row to the merged table and the files return to the pool.
6. **Reviewers do not own files.** A review row exists so the queue is visible, with *no implementer*
   recorded, which is what makes it safe for a reviewer and an implementer to read the same code.
7. **Name slices by operational name + PR#.** Historical W-numbers from roadmap §4 are secondary.
   Do not treat an operational W2-C as the same slice as §4 W2-C; use the alias table.

---

## Grok provisioning status

This section records OpenClaw-side xAI provider provisioning from the integration trial. It is not
the orchestration assignment in **Roles** (Grok is Primary AE Development Orchestrator as of
2026-09-22).

**Prepared, not yet operable.** OpenClaw **2026.9.4**. The xAI provider is supported (`xai`, default model `xai/grok-4.6`), authenticating via **SuperGrok/X Premium OAuth or `XAI_API_KEY`**.

Done without any credential:

- agent `grok` created with its **own** workspace (`~/.openclaw/workspaces/grok`) and its **own** agent directory;
- model **pinned to `xai/grok-4.6`**, so the agent can never silently fall back to Claude and appear to be Grok;
- **no routing bindings**, so it receives no channel traffic until deliberately bound;
- heartbeat, system-agent and talk roles verified still pinned to `bopper`;
- config backed up before the change; the diff is additive only.

**Remaining step requires the Project Owner**, because provider credentials must be entered where prompts mask them and `/models add` from chat is deprecated for exactly this reason. Note this is a *second, separate* credential from Grok's GitHub PAT — a PAT alone does not make the agent operable.

Credential placement matters: provider keys belong in the process environment, `~/.openclaw/.env`, or config `env.vars`. Keys such as `XAI_API_KEY` are **deliberately ignored** from a workspace `.env`.

No agent's credentials are ever copied to another. OpenClaw does not handle Grok's GitHub PAT.
