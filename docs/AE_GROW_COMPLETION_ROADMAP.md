# AE GROW COMPLETION ROADMAP

**Status:** ACTIVE — canonical source of truth for remaining AE Grow work.
**Baseline:** staging `ba8790123ea41c9b6be5b3525fc64c80a43939a5` (PR #48, Signal Sweep; post-merge CI #372 PASS).
**Current staging tip (2026-09-22):** `2c6208efec2e33c9eb1b601fc840341b7b9c2821` — A-4 audit durability / #72 merged onto #71 (`f4263c7b9ea175ad69408fb50d971aedc26a43b7`). The Signal Sweep baseline above is unchanged; it is the audit anchor for §2.
**Authority:** Project Owner decision *"MERGE SIGNAL SWEEP + BEGIN GROW COMPLETION PROGRAM"* (2026-09-20).
**Maintenance rule:** this file is updated as each workstream lands. Do not create a second roadmap.

---

## 0. How this roadmap was produced

Nine workstreams (A–I) were audited read-only against the merged staging tree by five independent
agents. Every claim in §2 is anchored to `file:line` in the audit record. **Nothing here was invented
from old notes**; where the repository already implements a requirement, it is listed in §7
(*Already built — do not re-scope*) instead of being scheduled as work.

The headline conclusion is not "Grow is unbuilt". It is:

> **Grow's capability is far ahead of its reachability.** Three major subsystems are implemented to a
> high standard and are unreachable in the shipped product — the F2 consent/DNC model (no write
> route), the Grow Appraisal Workspace (no UI), and the deterministic Business Coach metrics layer
> (no non-AI endpoint). Most remaining work is route/surface work over existing engines, not new
> engines.

---

## 1. Definitions (acceptance gates)

### 1.1 FEATURE COMPLETE
Per Project Owner §12. Tracked as a checklist in §8.

### 1.2 PILOT-READY
FEATURE COMPLETE, plus: entitlement model coherent for a non-calling pilot; `grow.calling.*` disabled;
Grow Today bounded at realistic brokerage size; sweep operable; no P0 open.

### 1.3 TECHNICALLY LIVE-READY
PILOT-READY, plus Project Owner §13 (production-like startup, migrations verified, index deployment
plan, observability, background jobs operational, AI/provider fail-safe, rate/cost controls,
security review, full suite, clean drift, CI green, no P0/P1, pilot results addressed).

**None of these constitute legal, commercial or production approval.**

---

## 2. Workstream status — what exists, what remains

Severity is product/pilot severity. `[V]` = verified against code in the audit.

### A — CONTACTABILITY

**Exists:** three parallel consent models. Model 3 (F2, `packages/db/src/schema/consentControls.ts`)
is the architecturally correct one — append-only, supersession, DB CHECK constraints, evidence,
jurisdiction, a strict fail-closed 28-reason evaluator (`apps/api/src/lib/consentControls.ts:327`).
Enforcement is real and strong on the call path (re-evaluated at create, dial-in-lock, CONNECTED,
recording, mid-call withdrawal) and at signal surfacing (`growToday.ts:569`, `signals.ts:258`).

**Remains:**

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| A-1 | **P0** | F2 consent/DNC/suppression state has **no write route** — all four state writers are test-only. AE has no working Do Not Contact capability, only the mechanism for one. | `consentControlsPersistence.ts:118,250,310,371` |
| A-2 | **P0** | `POST /api/communications/consent` has no entitlement or role guard. Any authenticated user can manufacture marketing consent for any destination. | `routes/communications.ts:709` |
| A-3 | **P0** | `dispatchMessage`/`dispatchDueMessages` bypass the consent gate. A quiet-hours-deferred or retrying message is delivered after withdrawal. | `outbox.ts:461,479` |
| A-4 | P1 | `communication_consent` is mutated in place with no prior-value audit — consent history is unrecoverable in the only model that works today. | `communications/consent.ts:111-126` |
| A-5 | P1 | `partyId` on that write is never validated against the brokerage; a foreign-tenant id is stamped and emitted on the event bus. | `communications/consent.ts:102` |
| A-6 | P1 | Contact 360 exposes zero consent/DNC/contactability fields. | `routes/contacts.ts:230-299` |
| A-7 | P1 | No consent management UI exists anywhere in `apps/web`. | — |
| A-8 | P1 | Three unreconciled consent models; a withdrawal in one is invisible to the other two. | — |
| A-9 | P2 | `GET …/eligibility` calls the **mutating** evaluator — every UI poll takes an advisory lock and appends a decision row. | `growCalls.ts:197,249,298` |
| A-10 | P2 | Open decision B implemented permissively: a human may save a transcription review after withdrawal. | `callTranscriptionReview.ts` |
| A-11 | P3 | Stale comment; duplicate `recordConsent` exports with different semantics. | `growToday.ts:173-176` |

**Architectable now with no legal input:** all of A-1…A-8. Absent policy rows simply keep the
evaluator at `REVIEW_REQUIRED`, which is the correct pilot state.

### B — NURTURE

**Exists:** nothing. `Grow.tsx:531-536` is an honest `GrowComingSoon`. `grow.campaigns.use` /
`grow.automation.use` are reserved keys with zero enforcement sites. The **propose → approve →
execute** governance it must reuse is real and enforced in three independent places
(`policyEngine.ts:194`, `actionRequests.ts:542`, `executionGateway.ts:201`), with
`executionGateway.ts:276` the sole call site of any action's `execute()`.

**Remains:**

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| B-1 | P1 | Protected-operations denylist has **no messaging fragments** (SEND/SMS/EMAIL/MESSAGE/NOTIFY/DIAL). A future `SEND_SMS_TO_CONTACT` at `riskLevel: 0` would pass the startup self-check. | `ai/protectedOperations.ts:37-52` |
| B-2 | P1 | **No signal → nurture path.** Signals are emitted with `dueAt: null`; commitment proposal returns null without a date. No signal can ever ground a proposal. | `growToday.ts:866` + `orchestrator.ts:299` |
| B-3 | P2 | No "relationship outcome" or "intended next touchpoint" concept anywhere. | — |
| B-4 | P2 | `buildNarrative()` has no case for `re_engagement_opportunity` — the flagship nurture signal gets `talkingPoint: null`. | `signalRanking.ts:401-478` |
| B-5 | P2 | `SERVICE`-classified messages require only one human (the sender). | `communications/messages.ts:407-411` |

**Hard constraint to preserve:** *one human decision authorises exactly one outbound message to one
person.* Today this holds **by absence of the feature, not by a rule.** Nurture must not degrade it
to one-approval-per-batch. That is the single decision determining whether Nurture becomes a
bulk-marketing engine.

### C — PERFORMANCE / BUSINESS COACH

**Exists — consolidation is already done.** "Performance" is a tab label whose entire implementation
is the Business Coach (`Grow.tsx:543` → `:1054-1056`). There is no second coaching product and no
`/performance` API. `coaching/metrics.ts` (773 lines) is tenant-scoped, date-windowed, row-capped and
**discloses its own truncation** — it is the reference implementation the rest of Grow should follow.
`responseBuilder.ts` makes zero LLM and zero DB calls.

**Remains:**

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| C-1 | **P0** | Coaching metrics are **brokerage-wide but presented as the agent's own**. `buildBusinessCoachContext` takes no `userId`; UI copy says "your own logged data". In a 10-agent brokerage every agent is shown the office's numbers, including colleagues' `partyId` lists. | `businessCoachContext.ts:70-74`; `AskAgentEngine.tsx:454-455` |
| C-2 | P1 | The deterministic layer is **unreachable without a successful, paid LLM call** — every "show me my numbers" buys a provider round-trip to render figures the server already had. | `orchestrator.ts:717-745` |
| C-3 | P1 | Under the default mock provider the coaching narrative is the first 400 chars of the request's own internal JSON, echoed back at the agent. | `mockProvider.ts:14-18` + `orchestrator.ts:708-713` |
| C-4 | P1 | No conversion metric of any kind, though `Converted`/`lostReason`/`closedAt` are populated. | `metrics.ts:421-443` |
| C-5 | P1 | Seller pipeline not separable from buyer — `opportunityType` never selected. | `grow.ts:238` |
| C-6 | P1 | Communications are invisible to activity metrics; an agent who prospects by email/SMS is scored inactive. The Comms Hub writes no `grow_activities` rows. | `metrics.ts:34-43` |
| C-7 | P1 | **No targets/goals schema exists** — "activity vs target" and "progress against goals" are structurally impossible. Requires a migration. | — |
| C-8 | P2 | Coaching ignores contactability entirely. | `coaching/` — zero hits |
| C-9 | P2 | `fetchRecentActivityByParty` caps at 2000 with **no `orderBy`** — non-deterministic output, undisclosed truncation. Real defect. | `metrics.ts:563-569` |
| C-10 | P2 | `ai_usage` is write-only (zero readers); ceilings count requests, never tokens or dollars; voice/STT spend unmetered; no AI observability. | `audit.ts:64-79`, `dailyUsage.ts:89-112`, `aiVoice.ts:216-228` |
| C-11 | P2 | Unindexed hot-path aggregate on `ai_interactions` per AI request. | `dailyUsage.ts:89-112` |
| C-12 | P3 | Stale comment claims Performance is a "coming soon" placeholder. | `Grow.tsx:378-379` |

### D — CONNECT / COMMUNICATION READINESS

**Exists:** provider neutrality is **genuinely clean** — a leak grep for every major vendor token
across `apps/api` and `apps/web` returns zero hits in code. Real call state machine, AU/NZ E.164
normalisation, HMAC fail-closed webhooks, recording storage/retention/integrity/quarantine, a real
Deepgram adapter behind two flags and a credential, governed human-approved follow-ups, and a full
outbox with consent/cost/quiet-hours/retry. Every live-provider flag requires the literal `"true"`
and defaults off; the gateway **never silently falls back from live to mock**.

**Remains:**

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| D-1 | P1 | No real provider adapter for any channel. *Blocked on provider decision.* | — |
| D-2 | P1 | No recording capture path — `recordingStorage.ts` has no upstream caller. | `recordingStorage.ts:26-30` |
| D-3 | P1 | `outbox.ts` has **no live/sandbox dispatch seam at all**, so there is nowhere to hang an activation gate. This is the real accidental-activation risk: the gate must be built *as part of* the adapter slice, not after it. | `outbox.ts:357-370` |
| D-4 | P2 | Recording-gate evidence drops the decision on a non-eligible outcome — the blocked reason is lost precisely when the call was blocked. | `recordingGates.ts:169-176` |
| D-5 | P2 | Inbound reply threading unimplemented. | `communications/webhooks.ts:156-166` |
| D-6 | P3 | Provider name hardcoded on the row rather than read from the adapter. | `callSessions.ts:241` |

**Highest-value work available while the provider decision is outstanding:** an **adapter conformance
suite** against `TelephonyProvider` / `EmailProvider` / `SmsProvider` codifying idempotency, error
taxonomy, capability reporting and webhook tenancy resolution.

### E — APPRAISAL / CONTACT / SIGNAL INTEGRATION

**Exists:** Grow Today → Contact 360 is a real in-product hop with composer pre-open. Contact 360 is
genuinely a 360. `PropertyIntelligencePanel` is the correct shared-component pattern and the best
entitlement UX in the repo. Sweep output is reachable from both non-Today anchors.

**Remains:**

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| E-1 | **P0** | **The entire Grow Appraisal Workspace — 18 endpoints, built, tested, gated, mounted — has no web client.** The only shipped appraisal UI never sets `partyId`, `status` or `followUpAt`, which Rule E requires. **Rule E can therefore never fire in the shipped product**; the chain is severed at the appraisal node. | `routes/growAppraisals.ts:132-566`; `lib/appraisals.ts:40-43,141-145`; `growToday.ts:548-549,679` |
| E-2 | P1 | `view_appraisal` is emitted by the API as the primary action and silently discarded by the UI; Rule E's actions also omit `view_property`, so the card would offer no way to reach the appraisal at all. | `growToday.ts:705-711`; `Grow.tsx:817-833` |
| E-3 | P1 | The Opportunities tab is a total dead end — plain `<td>` text, no link, no action. The identical record is actionable on Grow Today and inert here. | `Grow.tsx:2156-2181`, `:2102-2132` |
| E-4 | P1 | Contact 360 **silently withholds** party-anchored signals — dropped if `propertyId === null`, and again if no Active relationship row exists. The opposite of the honest withholding notice Today was given. | `propertyIntelligence/service.ts:97-117` |
| E-5 | P2 | Appraisal status ownership split across two subsystems writing one row with no reconciliation. | `lib/appraisals.ts:141-145` vs `lib/growAppraisals.ts:34-45` |
| E-6 | P2 | Comms Hub type-mirror drift: web declares `propertyAddress: string` and omits `partyDisplayName`; contact-first rows link to `/properties/null` → 400. Second live instance of mirror drift. | `web/lib/communications.ts:158-162`; `CommunicationsHub.tsx:96` |
| E-7 | P2 | Import results dead-end: after importing thousands of contacts the only offered action is "Undo this import". | `GrowImport.tsx:713-748` |
| E-8 | P2 | call → follow-up → commitment is joinable only by a parsed `transcriptionId:itemType:itemId` string. | `growCallFollowups.ts:518` |
| E-9 | P1 *(latent)* | `appraisals` has no `brokerage_id`; tenancy is correct-by-discipline across all 18 endpoints. `communication_participants` holds contact PII with no tenant column. | `schema/appraisal.ts:114-120` |

**Structural finding:** `party_id` is the only near-universal spine, yet `appraisals` and
`automation_tasks` are the two nodes where `property_id` is mandatory and `party_id` optional — and
that is precisely where the chain breaks.

### F — DAILY COMMAND CENTRE

**Exists:** six rules (A–F) with banded ranking, itemised `factors`, hedged narrative, a frontend
that refuses to render a bare score, and a two-tier contactability model — *hidden entirely* for
prospecting, *shown with outreach stripped* for the agent's own dated obligations, with contact
fields forced to `null` **in the API response itself**, plus an honesty counter for what was withheld.

**Remains:**

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| F-1 | **P0** | **Commitments are absent from Grow Today.** `growCommitments` is never imported or queried. *"What have I already committed to?"* is unanswerable on the principal operational surface. | `growToday.ts:2` |
| F-2 | **P0** | **No cap on non-`Emerging` signals.** The only cap in the pipeline protects the *weakest* band. A 5,000-contact brokerage importing a dormant database yields **thousands of uncapped DoToday cards on day one** (StrongIndicator re-engagement scores 68 ≥ 55). | `growToday.ts:334` |
| F-3 | P1 | No per-party de-duplication **among signals** — this is the real DECISION 3 gap. A long-tenure owner dormant 200 days gets two cards for one person. Signal-vs-cold de-dup already works and is tested; signal-vs-signal does not exist. | `growToday.ts:786-882` |
| F-4 | P1 | DECISION A unimplemented on all 21 commitment surfaces (13 API, 8 web) — zero contactability hits across every one. | — |
| F-5 | P2 | Rule D loses signal evidence when it wins — the surviving cold card cannot explain why AE chose it. | `growToday.ts:952` |
| F-6 | P2 | AI tool `get_due_commitments` returns **zero commitment rows** — it returns Grow Today follow-ups. | `ai/tools/registry.ts:152-160` |
| F-7 | P3 | `COLD_CONTACT_THRESHOLD_DAYS` duplicated across two modules, kept in sync by comment only. | `growToday.ts:312`, `signalRanking.ts:250` |

**On DECISION 3 (Owner §3):** the Owner's core requirements — *"no open opportunity, active commitment
or stronger signal"* and *"surface ONE best item"* — are **already implemented and tested** for the
signal-vs-cold case (`evaluation.ts:1223-1224`; `growToday.ts:832`/`:902`; tests at
`growToday.test.ts:590-598`). The genuine gap is narrower than the brief assumed: **duplication among
signals**. Recommended fix is read-path consolidation in `growToday.ts` (group by party after
ranking, keep best, attach losers as evidence, move the `Emerging` cap after grouping so it counts
*cards* not *rows*). Tightening the write path is rejected — it would risk the
one-statement-per-rule invariant and hide rows a review surface legitimately wants.

**On DECISION A (Owner §2):** the treatment pattern the Owner describes **already exists** for
opportunity/appraisal cards (`growToday.ts:630-667`). DECISION A is therefore three pieces of work:
(i) add commitments to Grow Today [F-1]; (ii) apply the existing pattern to them; (iii) extend it to
the other 20 surfaces via **one shared helper** — doing it per-surface invites exactly the drift the
`growToday.ts` ↔ `web/growToday.ts` mirror pair already suffered.

### G — GROW UX / PRODUCT COHERENCE

**Exists:** top-level IA is disciplined, not accreted — nine sidebar links, centrally defined with
documented rationale, and Scale deliberately given no placeholder. The prior placeholder pass was
thorough: **only one stale user-facing placeholder and one stale comment remain.**

**Remains:**

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| G-1 | P1 | **Pilot users see a promise followed by an unexplained refusal on every calling surface.** The frontend has zero awareness of `grow.calling.*`. A pilot sees a branded "Call Jane Smith" card containing one sentence — *"You don't have permission to do that."* — twice, stacked. The correct copy already exists but is unreachable because the 403 fires before the gates evaluate. | `Grow.tsx:1752-1753`, `:1401-1408`; `lib/api.ts:145` |
| G-2 | P1 | Every 403 collapses to one generic sentence, discarding a well-designed contract: the middleware returns `entitlementKey` + `upgrade:{action,productCode}` across nine denial reasons; the client never reads either. "Your plan doesn't include this", "your subscription lapsed" and "wrong role" are indistinguishable. | `middlewares/entitlement.ts:19-27`; `web/lib/api.ts:145,199-201` |
| G-3 | P2 | **Two "Today" screens, no relationship between them** — near-identical copy, disjoint data, zero cross-links, both internally called "Daily Command Centre". | `CommandCentre.tsx:45-50`; `Grow.tsx:611` |
| G-4 | P2 | Import history has the exact D6 silent-blank defect that `growDataRegionState` was written to eliminate. Six surfaces still lack error/retry. | `GrowImport.tsx:332-368` |
| G-5 | P2 | Unsafe `as ApiError` casts render `undefined` on non-API failures, in seven places; `Grow.tsx` correctly uses `instanceof` — two idioms for one job. | — |
| G-6 | P2 | "Follow-up" means five different things in the UI, and the UI contradicts itself on whether commitments and follow-ups are the same. | — |
| G-7 | P2 | `grow.properties.link` is sold in the catalogue and enforced at zero call sites. | `billing.ts:113`; `catalogue.ts:31` |
| G-8 | P3 | Stale placeholder claiming Pit Crew "isn't tracked in the schema yet" — it is, and the section is populated. Stale comments in `Grow.tsx:378-379` and `productNav.ts:15-21` (the latter dangerous: it is the file an engineer reads to decide whether hiding a nav link is safe). | `CommandCentre.tsx:94` |

### H — OBSERVABILITY / OPERATIONS

**Exists:** eight Grow background processes. The sweep's advisory-lock single-flight with crash
recovery by lock ownership, per-brokerage error isolation with cursor stamping, and the metrics
registry's closed label sets are all well built and must not be "fixed". Exceptions and Automation
already have `ops/health` + `ops/scan` surfaces to copy.

**Remains:**

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| H-1 | **P0** | **A suspected sweep lock leak is silent.** Sweeping is entirely dead while the metric reads `skipped_locked`, which looks healthy. Log line only — `logger.error` is never bridged to alerting. | `sweep.ts:320`; `operationalAlerts.ts:113` |
| H-2 | P1 | **Sweep state is unreachable over HTTP by any means.** `listRecentSweepRuns` and `countActiveSignals` have **zero callers anywhere, including tests**; there is no manual-trigger endpoint. Last run, success/failure, `truncated`, `errors` and per-brokerage staleness exist as durable rows and reach nobody. | `sweep.ts:864,869,250` |
| H-3 | P1 | Scheduler-disabled state is invisible after boot — `GROW_SIGNAL_SWEEP_ENABLED=false` looks identical to healthy-but-idle. | `sweepBootstrap.ts:44` |
| H-4 | P1 | Per-brokerage sweep failure and cursor-touch failure are silent; a scheduled run can fail forever with no alert. | `sweep.ts:467,469-474`; `sweepBootstrap.ts:49` |
| H-5 | P1 | **Both reconcilers use an in-process `running` boolean and a module-level cursor with no advisory lock** — the identical defect the sweep just fixed, still live one directory away. Rate limiters use `MemoryStore`, so the 20/min credential-surface budget becomes N × 20. | `documentStorageReconciler.ts:10,12`; `callTranscriptionReconciler.ts:10,12`; `middlewares/rateLimit.ts:47,68,106` |
| H-6 | P2 | `property_signal_outcome_total{outcome="expired"}` declared but never incremented; sweep metrics absent from the metrics doc; `GROW_SIGNAL_SWEEP_*` absent from `.env.example`; no index supports either sweep-run query; no retention on run tables. | `metrics.ts:165`; `sweep.ts:287-292,403-406` |

### I — SCALE / PERFORMANCE

Sized against a mid-to-large AU brokerage at 3 years: 20k contacts, 5k properties, 25k relationships,
**250k activities**, 100k messages, 200k `ai_interactions`.

| ID | Sev | Finding | Anchor |
|---|---|---|---|
| I-1 | **P0** | Contact 360 issues `SELECT id, formatted_address FROM properties` **with no WHERE clause at all**, then filters in JS — reading every property row of every tenant on the instance on every contact open. | `relationshipTimeline.ts:328-331` |
| I-2 | **P0** | Grow Today pulls **whole-brokerage activity history (250k rows)** into Node to compute a max-per-party, on every load, re-running on every window focus. | `growToday.ts:527-530` |
| I-3 | **P0** | Five `db.select()` filtered by `partyId` **alone**, brokerage applied in JS afterwards. Every index is `brokerage_id`-leading, so these are **five seq scans per contact open**. Adding the predicate is zero behaviour change. | `contactIntelligence.ts:42-45`; `relationshipTimeline.ts:232-236` |
| I-4 | P1 | Four more unbounded tenant reads in Grow Today's `Promise.all`, each joined to carry name/email/mobile/address strings — several MB of heap per request. | `growToday.ts:463-549` |
| I-5 | P1 | `priorityActions` returned entirely uncapped (see F-2). | `growToday.ts:1008` |
| I-6 | P1 | Contacts list computes `partyIds` then never uses it; both enrichment queries load the whole brokerage to decorate 200 displayed contacts. | `routes/contacts.ts:100-107` |
| I-7 | P1 | **Correctness:** `.limit(200)` applied *before* the role filter — a contact with that role silently vanishes from the picker once the brokerage exceeds 200 parties. | `routes/contacts.ts:88` vs `:91-96` |
| I-8 | P1 | `QueryClient` config is `{ retry: false }` and nothing else → `staleTime: 0`, refetch on window focus and on mount; Grow tabs unmount on switch. **Every alt-tab re-runs I-1/I-2/I-4 in full.** One line; largest single win. | `web/src/main.tsx:14` |
| I-9 | P1 | Server caps every Grow list at 200 with no offset or cursor and the client never sends one — at 20k contacts the UI shows the 200 newest with no indication the rest exist. | `routes/contacts.ts:88`; `routes/grow.ts:134,310,390` |
| I-10 | P1 | No virtualization and **zero `useMemo`/`React.memo`/`useCallback` in the entire web app**; ~2,500 cards ≈ 10,000 `useState`. Survivable only because of the accidental 200 caps. **I-9 and I-10 are coupled and must ship together.** | `Grow.tsx:653-1241` |
| I-11 | P1 | Seq scan of 200k `ai_interactions` rows on **every AI request** — the limiter becomes the slowest part of the request it guards. | `dailyUsage.ts:94-112` |
| I-12 | P1 | Every Grow Ask AE question pays the full Grow Today cost (~275k rows) before a single token is sent. Fixed by I-2/I-4. | `growContext.ts:137-144` |
| I-13 | P2 | Import: ~80,000 serial round trips for a 20k-row import; `import_records` has only a PK. | `lib/import/execute.ts:432-441,148-156` |
| I-14 | P2 | Command Centre materialises all properties then reuses the ids as an unbounded `inArray` bind list across 8 queries; `automation_tasks` read twice. | `commandCentre/queries.ts:83` |
| I-15 | P2 | Property timeline: `domain_events` and `audit_logs` predicates unindexed; O(N²) `Array.find` inside `.map()`. | `lib/timeline.ts:433-448,480-576` |
| I-16 | P2 | Contactability filter runs 2 statements per 5,000-id chunk **serially**, over un-deduped concatenated ids. | `contactability.ts:134-191`; `growToday.ts:563-568` |
| I-17 | P2 | `dispatchDueMessages` selects **all** due messages with no LIMIT, then dispatches serially while the next 60s tick re-selects the same backlog. | `outbox.ts:466-487` |
| I-18 | P3 | No route-level code splitting; `Grow.tsx` (2,184 lines) ships with `PropertyWorkspace.tsx` (3,038 lines) in one chunk. Dependencies are genuinely light — the problem is entirely first-party. | `App.tsx:2-19` |

**First real problem as size grows:** I-2. `grow_activities` is the only Grow table that grows with
*usage* rather than *inventory*, `GET /grow/today` is the surface every agent hits every morning, and
`main.tsx:14` makes it re-run on every window focus — (fastest-growing table) × (most-loaded surface)
× (highest refetch rate).

---

## 3. Dependency graph

```
                    ┌─────────────────────────────────────────────┐
TRACK 1  SECURITY   │ W1 consent security + outbox re-check       │  A-2 A-3 A-4 A-5
  & CONSENT         │   └─> W2 F2 consent/DNC write routes  ──┐   │  A-1
                    │         └─> W4 Contact 360 read model   │   │  A-6
                    │               └─> W7 Contact 360 UI ────┼───┤  A-7
                    │         └─> W9 model reconciliation ────┘   │  A-8
                    └─────────────────────────────────────────────┘
TRACK 2  SCALE      │ W1 four one-line server wins (independent)  │  I-1 I-3 I-6 I-8
                    │ W1 index batch (one migration)              │  I-11 I-13 I-15
                    │   └─> W3 Grow Today query rewrite ──────────┼──> blocks C, B
                    │         └─> W8 pagination + virtualization  │  I-9 + I-10 (one slice)
TRACK 3  OPS        │ W1 sweep ops surface + metrics ─> alerting  │  H-1 H-2 H-3 H-6
                    │ W5 reconciler durability + limiter store    │  H-5
TRACK 4  DCC        │ W3 signal de-dup + cap ─> W6 commitments ───┼──> W6b DECISION A
TRACK 5  COACH      │ W4 per-agent scoping ─> W5 /grow/performance┼──> W7 Performance tab
TRACK 6  APPRAISAL  │ W2 make Rule E reachable ─> W6 workspace UI ┼──> W8 view_appraisal
TRACK 7  UX         │ W1 stale copy ─> W3 403 reason-aware ───────┼──> W5 calling honesty
TRACK 8  CONNECT    │ W2 dispatch seam + gate ─> W4 conformance   │  D-3, D-4, D-5
```

**Hard couplings to respect**

- `outbox.ts` is touched by A-3, D-3 and A-8 → **sequence them**, do not rebase it three times.
- `growToday.ts` is touched by F-2, F-3, I-2, I-4, E-2 → **one canonical owner**, serialise. F-2, F-3, I-2, I-4, and I-5 closed in #57 (re-verified on `e703e7b`); do not re-open them. E-2 is the remaining collision on this file.
- `Grow.tsx` (~2,184 lines) is simultaneously DCC, Contact 360 and the call panel → extract panels
  into components *before* parallel UI work, or three agents will collide in one file.
- `routes/contacts.ts` is touched by A-6 and I-6 → serialise. A-6 closed in #61. I-6 and I-7 closed in #53 (re-verified on `736118d`); do not re-open them.
- `web/src/main.tsx` holds I-8. Closed in #53 (re-verified on `736118d`); do not re-open it.
- `contactIntelligence.ts` and `relationshipTimeline.ts` hold I-1 and I-3. Both closed in #53 (I-3 re-verified on `09f3bb5`); do not re-open them.
- I-9 and I-10 must ship as **one slice**: lifting the 200-row caps without virtualization makes the
  page worse; virtualizing without pagination fixes nothing.
- `growContext.ts:137` makes Coach/Ask AE sit **underneath** Grow Today's fix.
- All index work is **one migration** — batch it, do not open four migration PRs.

---

## 4. Execution plan — PR sequence

Each wave is parallel-safe by file ownership. One canonical owner per implementation area.

### WAVE 1 — unblocked, no Owner decision required (in flight)

| PR | Scope | Files owned | Sev |
|---|---|---|---|
| **W1-A** Consent write-path security + dispatch re-check | `routes/communications.ts`, `lib/communications/consent.ts`, `lib/communications/outbox.ts` | A-2 ✅#51, A-3 ✅#51, A-4 ✅#51+#72, A-5 ✅#51 | **P0** |
| **W1-B** F2 consent/DNC/suppression write routes | new `routes/growConsent.ts` + 1 line in `routes/index.ts` | A-1 ✅#52 | **P0** |
| **W1-C** Four one-line server wins | `relationshipTimeline.ts`, `contactIntelligence.ts`, `routes/contacts.ts`, `web/src/main.tsx` | I-1, I-3 ✅#53, I-6 ✅#53, I-8 ✅#53 | **P0** |
| **W1-D** Sweep ops surface, metrics, alerting + index batch | `propertyIntelligence` ops routes, `sweep.ts`, `packages/events/src/metrics.ts`, `operationalAlerts.ts`, `.env.example`, metrics doc, **one migration** | H-1 ✅#50, H-2 H-3 H-6, I-11 I-13 I-15 | **P0** |

**W1 acceptance (all four):** CI green on the exact head; tenant isolation tests unchanged; no new
metric series carries a tenant id; `grep consentControlsPersistence apps/api/src/routes` no longer
empty; a suppression written via the route is observed by `contactability.ts` on the next Grow Today
read; a quiet-hours-deferred message with withdrawn consent ends `BLOCKED_BY_CONSENT` and the
provider is never called; `EXPLAIN` shows index scans for each cited query.

**WAVE 1 OUTCOME — all four delivered as draft PRs.**

| PR | Slice | Notes |
|---|---|---|
| **#51** | W1-A | A-2, A-3, and A-5 closed. A-4's prior-value audit landed here; the durable audit (transactional strict `logAudit`, consent event only after commit) closed in #72. Also completed the `RETRY_SCHEDULED → BLOCKED_BY_CONSENT` transition edge, without which a withdrawn retry was fail-closed but never settled and the 60s sweep re-failed it every pass. |
| **#52** | W1-B | A-1 closed. `grep consentControlsPersistence apps/api/src/routes` now resolves. The suppression → `contactability` → Grow Today path is asserted end-to-end over real HTTP, proving the DNC control is no longer inert. |
| **#53** | W1-C | I-1/I-3/I-6/I-7/I-8 closed. Two audit corrections recorded: I-3 is **eight** reads, not five; and `grow_contact_roles` was never one of the scans — it already had a usable `(party_id, role)` index. |
| **#50** | W1-D | H-1/H-2/H-3/H-6 and the index batch, as migration **0028**, 14 indexes. Caught a real defect in its own work: drizzle's `.desc()` emits `DESC NULLS LAST`, which does not satisfy Postgres's `ORDER BY … DESC` (`NULLS FIRST`), so the index was inert for the query it existed for. |
| **#54** | Test-env | Canonical API test runner. CI sets `NODE_ENV=test`, `ALLOW_DEV_AUTH=true` and a placeholder `SESSION_SECRET` at job level; a fresh worktree has none, and each absence fails in a way indistinguishable from a real regression. Three Wave 1 slices independently lost time to this. |

`appraisals(party_id)`, the one index dependency W1-C could not fix in code (`appraisals` has **no
`brokerage_id` column at all** — it is tenant-scoped transitively via `propertyId → properties`), is
already present in migration 0028. No index work is fragmented across slices.

**Known, pre-existing, not introduced by Wave 1:** the full 166-file API suite is order- and
state-dependent when runs share one database. The staging baseline and a clean branch fail *disjoint*
sets — 22 failures in `growCalls.test.ts` on baseline versus 4 in `callTranscriptions.test.ts` on a
branch, all green in isolation. This is a test-infrastructure property, not a product defect, and is
the reason candidate judgement rests on targeted suites repeated for stability plus GitHub CI.

### WAVE 2 — unblocked, depends on Wave 1

| PR | Scope | Depends on | Sev |
|---|---|---|---|
| **W2-A** Grow Today: per-party signal consolidation + cap non-`Emerging` + query rewrite | W1-C | F-2 ✅#57, F-3 ✅#57, I-2 ✅#57, I-4 ✅#57, I-5 ✅#57, I-16 | **P0** |
| **W2-B** Commitments on Grow Today (Rule G) + DECISION A on those cards | W2-A | F-1 | **P0** |
| **W2-C** Contact 360 contactability read model (read-only evaluator, no writes on a GET) | W1-B, W1-C | A-6 A-9 | P1 |
| **W2-D** Messaging fragments in the protected-operations denylist | — | B-1 | P1 |
| **W2-E** Stale copy, terminology, mirror drift, empty/error-state parity | — | G-4 G-5 G-8 E-6 F-7 A-11 C-12 | P2 |
| **W2-F** Reconciler durability + rate-limiter store | Owner decision #6 | H-5 | P1 |
| **W2-G** Dispatch seam + `LIVE_*_APPROVED` gate; adapter conformance suite; recording-gate evidence fix | W1-A | D-3 D-4 | P1 |

### WAVE 3 — larger, some gated

| PR | Scope | Gate | Sev |
|---|---|---|---|
| **W3-A** DECISION A across the remaining 20 commitment surfaces (one shared helper) | Owner decision #1 (per-surface ruling) | F-4 | P1 |
| **W3-B** Contact 360 consent UI | W2-C; extract panel from `Grow.tsx` first | A-7 | P1 |
| **W3-C** Per-agent scoping of coaching metrics | **Owner decision #4** | C-1 | **P0** |
| **W3-D** `GET /api/grow/performance` (no provider call) + Performance tab renders metrics | W3-C, **Owner decision #5** | C-2 C-3 | P1 |
| **W3-E** Make Rule E reachable (`partyId` on the RUN appraisal path) | **Owner decision #3** | E-1 | **P0** |
| **W3-F** Grow Appraisal Workspace UI (18 endpoints) | **Owner decision #2** | E-1 | **P0** |
| **W3-G** Reason-aware 403s + honest calling surfaces for pilots | Owner decision #8 | G-1 G-2 | P1 |
| **W3-H** Opportunities actionable; contact-signal withholding notice | — | E-3 ✅#65 (navigation/follow-up #56; Add note / Ask AE #65), E-4 ✅#59 | P1 |
| **W3-I** Conversion + buyer/seller segmentation; consent awareness in coaching; comms as activity | C-6 needs Owner decision #7 | C-4 C-5 C-8 C-9 | P1 |
| **W3-J** Consent model reconciliation | W2-C, W2-G | A-8 | P1 |
| **W3-K** Cost observability: read back `ai_usage`, token/cost ceilings, AI metrics, voice metering | — | C-10 C-11 | P2 |

### WAVE 4 — completion

| PR | Scope | Gate |
|---|---|---|
| **W4-A** Pagination + virtualization (one slice) | Owner decision #9 (page size) |
| **W4-B** Nurture architecture: signal → dated proposal path, relationship outcome, next touchpoint, `re_engagement` narrative | **Owner decision #10** (outbound posture) |
| **W4-C** Targets / goals schema + activity-vs-target + progress-against-goals | **Owner decision #6** (targets) |
| **W4-D** Command Centre / import / outbox bounding; code splitting; "Today" reconciliation | Owner decision #11 |
| **W4-E** Ownership-start coverage surface (Owner §4) | — |

### Operational labels ↔ original §4 labels

Later queue language and the ownership register use an **operational name + PR#** as the primary identifier. Those operational labels are **not** always the same slice as the original §4 row with the same W-number. Historical W-numbers below are secondary.

| Operational label | Original §4 label | PR |
|---|---|---|
| **W2-A** Grow Today bounding | §4 **W2-A** | #57 |
| **W2-B** UX coherence | not §4 W2-B; ≈ **W2-E** / **W3-H** | #56 |
| **W2-C** AI governance | not §4 W2-C; ≈ **W2-D** + **W3-K** | #55 |
| **W2-D** contact-anchored | post gate 19; not §4 W2-D | #59 |
| **W3-A** contactability completion | §4 **W2-C** + **W3-B** | #61 |
| **W3-B** connect readiness | §4 **W2-G** | #60 |

---

## 5. Owner decision gates

Work continues in parallel on everything not listed here. These block only the slices named.

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| 1 | Does DECISION A's "null contact fields" apply to **Contact 360 itself**, or only to system-initiated suggestion cards? | W3-A | Nulling on a commitment *card* is clearly right; nulling on the contact's own record the agent deliberately navigated to is likely wrong. Needs a per-surface ruling. |
| 2 | **Where does the Grow Appraisal Workspace live** — new top-level route, seventh Grow tab, or a section inside Contact 360? | W3-F | Genuine product-IA call. Nothing should be built until answered. |
| 3 | Do RUN and Grow appraisals remain **one row**? | W3-E, E-5 | Reconcile `isFinalised` with the Grow status graph, or make the RUN section a read-only view. |
| 4 | **Personal coach or brokerage coach?** | W3-C | The current state is indefensible either way — the copy and the computation disagree. Not shippable to a multi-agent pilot as-is. |
| 5 | Are **deterministic metrics gated behind AI entitlements**? They are not AI. | W3-D | If `grow.ai.use` + `AI_BUSINESS_COACH_ENABLED` keep gating them, the Performance tab stays an excuse card by default. |
| 6 | **Do targets/goals get built?** Who sets them, what period, which metrics, is missing one shown as failure? | W4-C | Only slice here requiring a new schema. Two of the nine expected outcomes are impossible without it. |
| 7 | Should **email/SMS count as prospecting activity**? Comms Hub writes `grow_activities`, or `metrics.ts` reads `communication_messages`? | C-6 | Two different data models; joint decision with Connect. |
| 8 | **What should an unentitled pilot see** — calling surfaces hidden, or shown with "not in your plan" + upgrade path? | W3-G | The entitlement contract already carries `upgrade:{action:"grow.checkout"}` to support the latter. |
| 9 | **Page size** for Grow lists, and whether total counts are shown. | W4-A | User-visible contract change across contacts, relationships, activities, opportunities. |
| 10 | **Nurture's outbound posture** — may nurture ever queue a message, and is approval per-person or per-batch? | W4-B | The single decision determining whether Nurture becomes a bulk-marketing engine. |
| 11 | Should **"Today" be one screen or two**? | W4-D | Affects Grow, RUN Command Centre and the sidebar. |
| 12 | Is `grow.properties.link` a product or a mistake? | G-7 | Enforce it, or remove it from the catalogue so it stops being sold. |
| 13 | **Ops surface: Brokerage Administrator only, or also Pit Crew?** | W1-D | **Proceeding BA-only**, matching both existing ops surfaces. Reversible; flag only. |
| 14 | Should a **stale sweep make `/ready` report `degraded`**? | H | Recommend yes-degraded / never-unavailable — failing readiness would pull the single pilot instance out of rotation over a background job. |
| 15 | **Retention** for `grow_signal_sweep_runs`, `risk_exception_scan_runs`, `ai_interactions`. | — | `ai_interactions` is both the AI audit record and the metering source — a compliance decision. No number should be chosen without the Owner. |
| 16 | Does the pilot run **one instance or two**? | W2-F severity | At one instance H-5 is latent; at two, the reconcilers are P1 immediately. |
| 17 | **Consent open decisions A and B** (contact-wide withdrawal; save after withdrawal), plus: **is re-consent after withdrawal permitted at all?** | A-10, W3-J | Code has silently implemented the narrow answer to A and the *permissive* answer to B. A withdrawn F2 stream is currently permanently dead — a contact who withdraws can never opt back in. That is a significant product decision made in a step-1 guard clause. |
| 18 | Should per-property signal reads honour contactability? | — | Flagged in-repo as a deliberate product decision. |
| 19 | ~~On Contact 360, should a suppressed contact's signals be hidden entirely, or shown as intelligence with outreach stripped?~~ | — | **RESOLVED 2026-09-21 — see §11.** A contactability restriction must not erase legitimate intelligence from authorised internal users. Signals may remain visible; outreach must be suppressed. |

---

## 6. Legal / provider gates

Per Owner §11, these must not freeze development. Provider-neutral groundwork proceeds.

| Gate | Blocks | Note |
|---|---|---|
| **AU/NZ operating timezone + permitted contact-hours window** | All outbound eligibility | Until approved, `evaluateConsentDecision` returns `POLICY_INVALID_WINDOW` → `REVIEW_REQUIRED` and **no contact can ever be `ELIGIBLE`**. This is the correct pilot state and blocks nothing in Waves 1–3. |
| **Whether inferred consent is lawful**, and on what evidence | — | Defaults `false`. |
| **Whether "consent not required" is ever available** | — | Defaults `false`. |
| **DNCR washing** — obligation, cadence, validity, and register provider/credential/cost | Real DNC data | `dncrRequired` defaults `true`; a `CLEARED` status needs a register reference. **PHONE_CALL can therefore never be `ELIGIBLE` in AU or NZ today** — a structural, deliberate block on the calling pilot. |
| **Recording legality per jurisdiction; recording retention period** | D-2, live recording | Retention class is `legal-pending`, an application label claiming no statutory period. |
| **Telephony / SMS / email vendor; Deepgram production confirmation** | D-1 | A real Deepgram adapter already exists behind two flags and a credential. |
| **Live AI provider** | Live AI | `assertAiUsageLimitsConfigured` already refuses to start a live-provider process until a human sets both per-user and per-brokerage limits. That gate is correct and stays. |

**Standing deployment safeguards (Owner §5), retained:** the 13 indexes requiring out-of-band
`CONCURRENTLY` builds on persistent databases; the **migration 0025 duplicate pre-check**, which must
return no rows before 0025 runs on any persistent DB; and the rule that **merge implies no production
migration authority**.

---

## 7. Already built — do not re-scope

Listed so no agent invents work the repository already contains.

**Consent/Connect:** the F2 schema, append-only event model with supersession and CHECK-enforced
withdrawal metadata, the 28-reason fail-closed evaluator, AU/NZ policy-version model, the
contactability filter with correct serial-id ordering, the full call state machine, AU/NZ E.164
normalisation, the five-gate recording conjunction, HMAC-verified fail-closed webhook ingress on both
telephony and communications, the transcription pipeline with reconciler and human review, the
governed follow-up proposal flow, the provider-neutral interfaces, the entitlement resolver and the
three calling keys, the outbox with cost control and quiet hours, and the Communications Hub UI.

**Governance:** propose → approve → execute enforced in three independent places, with a single
`execute()` call site and a three-way approval re-derivation that a hand-edited column cannot defeat;
`CREATE_GROW_COMMITMENT` permanently non-auto-eligible; proposals grounded only in context, never in
model output (injection-inert); the CI forbidden-call guard on every messaging function.

**Coach:** Performance/Business Coach consolidation (already done — `Grow.tsx:543`); shared rate
limiter and tool registry; deterministic no-model-arithmetic response construction; timezone-correct
period resolution with disclosure; brokerage-level tenant scoping on every coaching query; the
read-only Level-0 ceiling; the per-user + per-brokerage durable daily-limit architecture.

**DCC:** the six rules, banded ranking with itemised factors and hedged narrative, the frontend's
refusal to render a bare score, the two-tier contactability model with API-side field nulling, the
`withheldDoNotContact` honesty counter, signal-vs-cold de-duplication (tested), and the write-time
exclusion of parties with an open opportunity or active commitment.

**Sweep/Ops:** advisory-lock single-flight with crash recovery by lock ownership, per-brokerage error
isolation with cursor stamping, the `truncated` flag suppressing the non-authoritative expire pass,
closed metric label sets, and the liveness/readiness split.

**Scale, done right:** `coaching/metrics.ts` — tenant-scoped, date-windowed, row-capped, **with
truncation surfaced to the user as a stated limitation**. This is the reference implementation. Also:
no AI call fires on page load anywhere; AI context is capped before reaching a provider; daily AI
metering is durable and shared across processes and correctly excludes blocked requests; queue gauges
are aggregate-only; polling stops on terminal states.

---

## 8. FEATURE COMPLETE checklist (Owner §12)

**As of staging tip `2c6208e` (2026-09-22).** Status text is updated only where a later merge changed the audit reading. Blocking IDs are kept; ✅ marks an ID that has since landed. Unmarked IDs are still open. The §2 finding tables above are the original audit and are not rewritten here.

| Criterion | Status | Blocking IDs |
|---|---|---|
| Core navigation has no unexplained "coming soon" placeholders | ⚠️ one stale placeholder + two stale comments; Nurture placeholder is honest | G-8, W4-B |
| Contact Intelligence operates coherently | ⚠️ as of `09f3bb5`: I-3 (#53, re-verified) — Contact 360 selects on `grow_relationships`, `grow_activities`, `grow_opportunities`, and `grow_commitments` include `brokerage_id` in SQL. `grow_contact_roles` carries the same predicate and was never one of the scans. E-4 contact-anchored / DNC-visible signals (#59) landed; coherence still partial | I-3 ✅#53, E-4 ✅#59 |
| Signal Sweep surfaces future-seller opportunities | ✅ *(merged #48)*. Grow Today presentation of those signals is bounded and consolidated per party as of #57, re-verified on `e703e7b` | F-2 ✅#57, F-3 ✅#57 |
| Contactability controls are integrated | ⚠️ as of `e9337bd`: A-1 F2 write routes (#52, re-verified) — `growConsentRouter` mounted under `/grow` with consent/DNCR/suppression/policy writers; A-6/A-7 Contact 360 read + consent UI (#61) landed; model reconciliation still open | A-1 ✅#52, A-6 ✅#61, A-7 ✅#61, A-8 |
| Nurture exists as a coherent relationship workflow | ❌ the workflow does not exist. B-1 messaging denylist landed in #55 (`OUTBOUND_MESSAGING_FRAGMENTS`); do not re-open it | B-1 ✅#55, B-2, W4-B |
| Performance/Business Coach consolidated and usable | ⚠️ consolidated; **numbers are wrong per-agent**. Discovery unblocked after #55; implementation still gated on Owner decisions #4 and #5 | C-1, C-2 |
| Daily Command Centre ties the experience together | ✅ as of `e703e7b` for the listed blockers: F-1 commitments on Grow Today landed (#64). Non-`Emerging` cards and the whole `priorityActions` list are capped by `MAX_PRIORITY_ACTIONS` (200) after the sort (#57, re-verified); Emerging stays at 10 | F-1 ✅#64, F-2 ✅#57 |
| Appraisal workflow is integrated | ❌ **workspace unreachable; Rule E can never fire** | E-1, E-2 |
| Communication architecture is integrated | ⚠️ as of `e9337bd`: D-3 dispatch seam + activation gate landed (#60); A-3 dispatch-time consent re-check (#51, re-verified) fail-closes withdrawn messages to `BLOCKED_BY_CONSENT`; inbound still incomplete | D-3 ✅#60, A-3 ✅#51, D-5, E-6 |
| Voice/call/transcription/follow-up complete enough for later activation | ✅ | D-2 (capture) |
| Entitlements are coherent | ⚠️ as of `e9337bd`: A-2 (#51, re-verified) — `POST /communications/consent` requires `grow.contacts.manage`; calling honesty and catalogue keys still open | A-2 ✅#51, G-1, G-2, G-7 |
| Tenant isolation is verified | ⚠️ as of `23ff952`: the unfiltered cross-tenant properties read is closed (I-1 ✅#53, re-verified — `relationshipTimeline.ts` labels with `id IN (…) AND brokerage_id =`). Two tables still have no tenant column | I-1 ✅#53, E-9 |
| Audit coverage is appropriate | ✅ as of `2c6208e`: A-4 prior-value audit landed in #51; #72 commits the legacy consent mutation with strict `logAudit` in one transaction and publishes `COMMUNICATION_CONSENT_UPDATED` only after that commit | A-4 ✅#51+#72 |
| Major workflows operate end-to-end | ❌ appraisal chain severed | E-1 |
| No known P0/P1 product defect remains | ❌ **11 P0** at the Signal Sweep audit; later landings are annotated on the rows above and are not deleted from this list. E-3 Opportunities actionability landed in #65. B-1 was closed by #55. I-1 was closed by #53 and re-verified in #66 (no remaining unscoped properties read on the Contact 360 timeline path). I-2 was closed by #57 and re-verified on tip `6d3d87d`: Grow Today last-activity is `max(occurred_at) group by party_id` with a `brokerage_id` predicate in `fetchLastActivityByParty`, not a whole-brokerage activity scan reduced in Node. F-2, F-3, I-4, and I-5 were closed by #57 and re-verified on tip `e703e7b`: `priorityActions` is sliced to `MAX_PRIORITY_ACTIONS` (200) after the sort and the cut is `withheldByActionCap`; Emerging stays on `MAX_EMERGING_SIGNAL_ACTIONS` (10); one signal card per party, with losers kept as `relatedSignals`; each Grow Today rule read is limited by a `GROW_TODAY_*_ROW_CAP` and ordered. I-3 was closed by #53 and re-verified on tip `09f3bb5`: the eight party-id-only selects (four in `contactIntelligence.ts`, four in `relationshipTimeline.ts`) include `brokerage_id` in SQL, locked by `contactReadScoping.test.ts`. I-6 was closed by #53 and re-verified on tip `736118d`: contacts-list enrichment is `party_id in (…)` on the rendered party ids and `brokerage_id =` for `grow_contact_roles` and `grow_relationships`, locked by `contactReadScoping.test.ts`. I-8 was closed by #53 and re-verified on the same tip: `QueryClient` defaults are `staleTime: 30_000` and `refetchOnWindowFocus: false` (`apps/web/src/main.tsx`); there is no automated lock on those defaults. I-7, the same #53 contacts-list landing, applies the role filter in SQL before `limit(200)`, locked by the same test. A-1 was closed by #52 and re-verified on tip `e9337bd`: `growConsentRouter` (`growConsent.ts:101`) mounts under `/grow` (`routes/index.ts`), with `POST /contacts/:partyId/consent` gated by `requireEntitlement("grow.contacts.manage")` and writers for consent, DNCR, and suppression. A-2 and A-3 were closed by #51 and re-verified on the same tip: `POST /communications/consent` requires `grow.contacts.manage` (`communications.ts`); `dispatchMessage` re-checks via `checkConsent` and transitions denial to `BLOCKED_BY_CONSENT` (`outbox.ts`). H-1 was closed by #50 and re-verified on the same tip: `GROW_SIGNAL_SWEEP_UNHEALTHY` is in `OperationalAlertType` / `OPERATIONAL_ALERT_POLICIES` and is raised from the suspected lock-leak path in `sweep.ts` and the scheduled-run catch in `sweepBootstrap.ts`. A-4 was not closed by the #71 re-verification. #51 recorded the prior consent value; #72 (head `e803ca7067d2b75612394be17ff3fb03d9e79e83`, merge `2c6208efec2e33c9eb1b601fc840341b7b9c2821`) commits the legacy consent mutation and strict `logAudit` in one transaction and publishes `COMMUNICATION_CONSENT_UPDATED` only after commit. A-5 was closed by #51 only (merge `8ac9b30dc8cd2ddc3b36b119dfb04202c4286a99`; `partyId` checked against the caller's brokerage; a foreign-tenant id returns 400). #72 did not change that validation. A-8 stays open | A-1 ✅#52, A-2 ✅#51, A-3 ✅#51, A-4 ✅#51+#72, A-5 ✅#51, C-1, E-1, F-1 ✅#64, F-2 ✅#57, F-3 ✅#57, H-1 ✅#50, I-1 ✅#53, I-2 ✅#57, I-3 ✅#53, I-4 ✅#57, I-5 ✅#57, I-6 ✅#53, I-7 ✅#53, I-8 ✅#53 |

---

## 9. Change log

| Date | Change |
|---|---|
| 2026-09-21 | Created from the nine-workstream audit of staging `ba87901`. Wave 1 dispatched. |
| 2026-09-21 | Wave 1 delivered as PRs #50–#53, plus #54 (test-env hardening). Wave 2 dispatched: **W2-A** Grow Today bounding, per-party signal consolidation (DECISION 3) and the activity-aggregation rewrite; **W2-B** UX coherence and integration honesty; **W2-C** AI governance and cost observability. Wave 2 branches from `ba87901` and does not contain Wave 1, by design — file ownership is disjoint. |
| 2026-09-21 | Wave 2 delivered: **#55** (W2-C), **#56** (W2-B); **#57** (W2-A) in CI. Project Owner ruled on contact-anchored signals (below); **W2-D** dispatched as PR-to-follow, branched from #56 because it extends that PR's `service.ts` work. Bundle verification found and fixed a flaky assertion in #50's own test suite — see below. |

---

## 10. Contact-anchored signals — Project Owner decision, 2026-09-21

**Decision.** A signal with `partyId` present and `propertyId` null must **not** be discarded for lack
of a property anchor. Three-way hierarchy: **property-anchored** (verified relevant property exists) →
**contact-anchored** (intelligence legitimately relates to the person, no verified property
association) → **invalid/unusable** (neither valid anchor, or tenant/evidence integrity cannot be
established). **Never fabricate or infer a property association to make a UI work.**

**What discovery established before any code was written:**

| Rule | Anchor behaviour | Evidence |
|---|---|---|
| `re_engagement_opportunity` | **Always** contact-anchored | `evaluation.ts:1290` sets `propertyId: null` with the comment *"Always null: the subject of this signal is the PERSON."* Only `propertyScopable: false` rule (`:1448`). |
| `agent_recorded_motivation` | Optionally contact-anchored | `:929` passes `r.propertyId` through; explanation already branches — *"no property is linked to it yet"* (`:925`). |
| `past_buyer_interest` | Optionally contact-anchored | `:645`; explanation branches at `:640`. |
| `long_ownership_tenure`, `stale_previous_appraisal`, `lease_tenancy_milestone`, all provider observations | **Property-dependent — anchor still required** | Provider observations are the mirror case: `:853` sets `partyId: null`. |

**The gap was one line, and only in Contact 360.** `service.ts:135` did `if (s.propertyId === null) continue`.
Because `re_engagement_opportunity` is *always* contact-anchored, **every re-engagement signal was
invisible on the contact's own record** — the flagship future-seller signal, unreachable on the
surface built to show it.

**Three requirements were already satisfied and must not be "fixed":**

- **Grow Today already handles it correctly.** `growToday.ts:462` left-joins properties so null-property
  signals survive; `:838` pushes `view_property` only `if (s.propertyId)`; `:860` passes the null
  through honestly. No DCC change is needed — which is also why W2-D must not touch that file while
  W2-A owns it.
- **Ranking is already property-agnostic.** `signalRanking.ts` contains **zero** `propertyId`
  references, so contact-anchored signals are not ranked below property signals by construction. Pin
  it with a test rather than changing it. Signals still cannot reach `DoNow` merely for being signals.
- **The party read is already tenant-scoped and contactability-gated.** `listActiveSignalsForParty`
  (`signals.ts:252-265`) validates the party against the brokerage and returns `[]` for a suppressed
  contact *before* loading any signal row.

**The contactability question this raised was escalated, and has been resolved — see §11.**


---

## 11. Decision gate 19 — RESOLVED, 2026-09-21

**Project Owner decision.** A contactability restriction must **not** erase legitimate intelligence
from authorised internal Grow users.

> SIGNAL EXISTS ≠ CONTACT MAY BE CONTACTED.

For a DNC or otherwise suppressed contact, legitimate signals **may remain visible** to appropriately
authorised users, provided every one of the following holds:

- the contact/outreach restriction is displayed **unmistakably**;
- calling, SMS and email are suppressed or disabled;
- automated outreach and generated outreach actions are suppressed;
- no communication activity is created automatically;
- signal evidence and history are preserved;
- tenant and entitlement controls are preserved.

DNC is **not** permission to delete or hide legitimate relationship intelligence merely because
outreach is prohibited.

**Scope of the ruling.** This is a product and technical architecture decision, **not** an AU/NZ legal
conclusion. Live activation remains subject to legal and compliance review, and every gate in §6
still stands.

**Consequence for implementation.** `listActiveSignalsForParty` (`signals.ts:252-265`) currently
returns `[]` for a suppressed contact — hiding the intelligence rather than only the outreach — and is
therefore now **in scope** for change under W2-D, conditional on: explicit tests, security review,
entitlement checks, the restriction being unmistakable, and **a proven absence of any pathway to
actual outreach**. The existing fail-closed rationale in that file is to be replaced with the new
invariant, not silently deleted: *rows may be read for display; no outreach affordance may be derived
from them.*

---

## 12. Change log (continued)

| Date | Change |
|---|---|
| 2026-09-21 | **Seven-slice merge wave.** PRs #49, #54, #50, #51, #52, #53, #57 merged sequentially to staging, each pinned to its approved SHA with a normal merge commit. Base `ba87901` → final **`e774494f6c4e8e9bd99793d108c741c97925f444`**. All seven approved heads verified contained; merge parents verified; 25 commits added. #50 carries migration 0028 (14 indexes) — merge grants **no** production migration authority, the `CONCURRENTLY` deployment requirement and the migration-0025 duplicate pre-check both still apply. |
| 2026-09-21 | PRs **#55** and **#56** held from merge pending independent review, assigned to Grok Bot as its first AE assignment, with an OpenClaw-side cross-check in parallel. Both verified still to merge cleanly onto the new staging. |
| 2026-09-21 | Grok Bot introduced as independent reviewer and parallel development agent under OpenClaw orchestration. Ownership now tracked in [`AE_WORKSTREAM_OWNERSHIP_REGISTER.md`](./AE_WORKSTREAM_OWNERSHIP_REGISTER.md). |
| 2026-09-21 | Decision gate 19 resolved (§11). W2-D scope expanded accordingly. |
| 2026-09-22 | **Consolidation gate.** PRs **#58 → #55 → #59 → #61 → #60** merged sequentially to staging. Tip **`234871ab1f9e415c0e9600f4d5290daa17aefc7b`**. #58 register/roadmap; #55 operational W2-C AI governance (≈ §4 W2-D + W3-K); #59 operational W2-D contact-anchored signals (post gate 19); #61 operational W3-A contactability completion (§4 W2-C + W3-B; A-6/A-7); #60 operational W3-B connect readiness (§4 W2-G; D-3). Domains released — see the ownership register. `growToday.ts` remains available to claim for F-1. Performance/Coach discovery is unblocked after #55; implementation stays gated on Owner decisions #4 and #5 plus a file claim. Naming rule from this entry forward: **operational name + PR#** is the primary identifier; historical §4 W-numbers are secondary (alias table under §4). |
| 2026-09-22 | **F-1 claimed.** Commitments on Grow Today is Active in the ownership register (branch `cursor/f1-commitments-on-grow-today-33a9`, base `36f43ce`). Not merged. |
| 2026-09-22 | **F-1 landed.** #64 merged. Staging tip **`11cd01f0e3a2bf10fde2def1817a6c29e6d6a2b3`**. Open commitments due today or overdue appear on Grow Today. `growToday.ts` released back to the pool. |
| 2026-09-22 | **B-1 closed by #55.** Messaging fragments are in the protected-operations denylist (`OUTBOUND_MESSAGING_FRAGMENTS` in `protectedOperations.ts`, asserted by `governance.test.ts`). Not re-opened. |
| 2026-09-22 | **E-3 in progress.** PR **#65** (`cursor/e3-opportunities-actionable-0599`, base `11cd01f`). View contact, View property, and Create follow-up on the Opportunities tab already landed in #56. This slice adds Add note and Ask AE on those rows, reusing Grow Today's note write and tab switch. Email/SMS stay on Grow Today and Contact 360, where contactability is known. Not merged. |
| 2026-09-22 | **E-3 landed.** #65 merged. Staging tip **`23ff95200fbca12ec155ec6868db60f3a31d8d73`**. Opportunities tab rows have Add note and Ask AE, reusing Grow Today's handlers. `Grow.tsx` opportunity actions and `growOpportunityActions.behavior.test.ts` are back in the pool. |
| 2026-09-22 | **I-1 re-verified, not re-opened.** PR **#66** (`cursor/i1-contact-360-properties-scope-2304`). On tip `23ff952`, `getRelationshipTimeline` labels properties with `WHERE id IN (…) AND brokerage_id =` (`relationshipTimeline.ts`, the lookup that used to be the unscoped `SELECT id, formatted_address FROM properties`). `contactReadScoping.test.ts` already locks that predicate. No query change in this slice. The §2 finding row is left as the original audit. I-2 and I-4 were not touched. Merged. Staging tip **`6d3d87d6bb4fa3e65192f14ebe35099177c865cb`**. |
| 2026-09-22 | **I-2 re-verified, not re-opened.** PR **#67** (`cursor/i2-grow-today-activity-aggregate-cb11`). On tip `6d3d87d`, `fetchLastActivityByParty` (`growToday.ts`) is `max(occurred_at) group by party_id` where `brokerage_id =` and `party_id = any(…)` — the party ids the other Grow Today rules already returned. That replaced the audit's whole-brokerage `select party_id, occurred_at` reduced in Node. The §2 anchor `growToday.ts:527-530` is the pre-rewrite line; on this tip those lines are the I-4 cap comment, and the aggregate is about lines 816–826. `growTodayQueryShape.test.ts` locks the SQL shape (`max`, `group by`, `brokerage_id`, `party_id = any`) and `growTodayConsolidation.test.ts` locks the most-recent day count. No query change in this slice. The §2 finding row is left as the original audit. F-2, F-3, I-4, and I-5 were not touched. Merged. Staging tip **`e703e7b422a6ef688c81f6901590b98d6fa439f1`**. |
| 2026-09-22 | **F-2 re-verified, not re-opened.** PR **#68** (`cursor/f2-grow-today-action-cap-a94d`). On tip `e703e7b`, `priorityActions` is `actions.slice(0, MAX_PRIORITY_ACTIONS)` after the deterministic sort. `MAX_PRIORITY_ACTIONS` is 200 and is commented as a technical safety bound, not a commercial daily cap. The cut is `signalSummary.withheldByActionCap`, and the web mirror states it. Emerging still uses `MAX_EMERGING_SIGNAL_ACTIONS` (10), applied after per-party consolidation, and `emergingWithheld` still reports that cut. The §2 anchor `growToday.ts:334` is the pre-cap line; on this tip the constant is about line 577 and the slice is about lines 1669–1670. `growTodayConsolidation.test.ts` locks a StrongIndicator population over the cap, and `growSignalSurface.test.ts` locks Emerging at 10 surfaced / 4 withheld. No product change in this slice. The §2 finding rows are left as the original audit. **F-3**, **I-4**, and **I-5** are the same #57 landing and are marked here: one signal card per party with losers kept as `relatedSignals` (`growTodayConsolidation.test.ts`; party-less signals are not collapsed), each rule read limited and ordered by a `GROW_TODAY_*_ROW_CAP` with stated `limitations` (`growTodayQueryShape.test.ts`), and the uncapped `priorityActions` return, which is the same slice as F-2. I-16 was not re-audited and stays unmarked. Merged. Staging tip **`09f3bb5be2c1abbee7ded95005495f8605a49037`**. |
| 2026-09-22 | **I-3 re-verified, not re-opened.** PR **#69** (`cursor/i3-contact-360-brokerage-predicate-3727`). On tip `09f3bb5`, `getContactIntelligenceSummary` and `getRelationshipTimeline` filter `grow_relationships`, `grow_activities`, `grow_opportunities`, and `grow_commitments` with `party_id =` and `brokerage_id =` in SQL. The audit counted five selects; #53 recorded eight (those four tables in each file). `grow_contact_roles` was never one of the scans — it already had a `(party_id, role)` index — and carries the brokerage predicate for consistency. The §2 anchors `contactIntelligence.ts:42-45` and `relationshipTimeline.ts:232-236` are the pre-fix lines; on this tip the predicates are about lines 53–74 and 246–261. `contactReadScoping.test.ts` locks the emitted `brokerage_id` predicate and the EXPLAIN Index Cond. No query change in this slice. The §2 finding row is left as the original audit. `appraisals` and `communication_participants` still have no `brokerage_id` column and stay party-id lookups; that is outside this finding. F-2, F-3, I-1, I-2, I-4, and I-5 were not re-opened. Merged. Staging tip **`736118d5323657ee617e5f0086d2fe63eec37060`**. |
| 2026-09-22 | **I-6 and I-8 re-verified, not re-opened.** PR **#70** (`cursor/i6-i8-contacts-queryclient-reverify-0ca9`). On tip `736118d`, `GET /grow/contacts` computes `partyIds` from the page it is about to render and uses them: both enrichment selects (`grow_contact_roles`, `grow_relationships`) are `brokerage_id =` and `party_id in (…)` (`routes/contacts.ts`, about lines 126–135). The §2 anchor `routes/contacts.ts:100-107` is the pre-fix line; on this tip those lines are the I-7 role-filter comment. `contactReadScoping.test.ts` locks the emitted `party_id in` and `brokerage_id =` predicates, and that roles and related-property counts still land on the right contact. `QueryClient` defaults in `apps/web/src/main.tsx` are `retry: false, staleTime: 30_000, refetchOnWindowFocus: false` (about line 41). The §2 anchor `web/src/main.tsx:14` is the pre-fix line; the config is the `new QueryClient` call, and the comment above it records that freshness stays mutation-driven (`invalidateQueries` short-circuits `staleTime`). No product change in this slice. The §2 finding rows are left as the original audit. **I-7** is the same #53 contacts-list landing and is marked here: the role filter is an `inArray` subquery on `grow_contact_roles` applied before `limit(200)`, locked by `contactReadScoping.test.ts`. There is no automated lock on the QueryClient defaults. I-1, I-2, I-3, I-4, I-5, F-2, and F-3 were not re-opened. Merged. Staging tip **`e9337bd3d3cc7bd43e86d3f43a649e97a880db2d`**. |
| 2026-09-22 | **A-1, A-2, A-3, and H-1 re-verified, not re-opened.** PR **#71** (`cursor/wave1-consent-sweep-docs-reverify-232c`). Docs-only slice on tip `e9337bd` (post-#70). **A-1** (#52): `export const growConsentRouter` at `apps/api/src/routes/growConsent.ts:101`; mounted under `/grow` in `routes/index.ts`; `POST /contacts/:partyId/consent` at `:312-328` with `requireEntitlement("grow.contacts.manage")` and `captureConsentState`; DNCR/suppression/policy writers at `:390-409` / `:447-463` / `:512-525`. **A-2** (#51): `POST /communications/consent` in `routes/communications.ts:724-730` requires `requireEntitlement("grow.contacts.manage")`. **A-3** (#51): `dispatchMessage` in `lib/communications/outbox.ts:364-410` calls `checkConsent` immediately before provider dispatch and transitions denial to `BLOCKED_BY_CONSENT`. **H-1** (#50): `GROW_SIGNAL_SWEEP_UNHEALTHY` in `lib/operationalAlerts.ts:4-27` / policies `:35-48`; raised from `propertyIntelligence/sweep.ts:326-339` (suspected lock leak) and `sweepBootstrap.ts:49-66` (scheduled-run failure). No product change in this slice. The §2 finding rows are left as the original audit. Technical completeness on these four IDs does **not** grant legal, provider, pilot, merge, or production authorization. A-4/A-5/A-8 and remaining H-2+ blockers stay open. Merged. Staging tip **`f4263c7b9ea175ad69408fb50d971aedc26a43b7`**. |
| 2026-09-22 | **A-4 and A-5 status reconciled, not re-implemented.** Docs-only slice on staging tip `2c6208efec2e33c9eb1b601fc840341b7b9c2821` (merge of #72, onto #71 `f4263c7b9ea175ad69408fb50d971aedc26a43b7`). **A-4** closed by #51 plus #72: #51 recorded `previousValue` beside `updatedValue` on the legacy consent audit; #72 (head `e803ca7067d2b75612394be17ff3fb03d9e79e83`, merge `2c6208efec2e33c9eb1b601fc840341b7b9c2821`) commits the consent mutation and strict `logAudit` in one transaction and publishes `COMMUNICATION_CONSENT_UPDATED` only after commit. **A-5** closed by #51 only (merge `8ac9b30dc8cd2ddc3b36b119dfb04202c4286a99`): `partyId` is validated against the caller's brokerage before write or publish, and a foreign-tenant id is rejected with 400. #72 states that A-5 party validation and the 400 mapping are unchanged. The Wave 1 outcome cell that said #51 alone closed A-4 is corrected. §2 finding rows are left as the original audit. A-8 and Owner-decision-gated items are unchanged. No product change in this slice. Not merged — Active claim remains on the ownership register until this PR merges. |
