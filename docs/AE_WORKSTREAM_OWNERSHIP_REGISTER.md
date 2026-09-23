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

Current staging: `4a3d48d462fa250fc1064bd2fa8b26f59e5a9cde` (2026-09-23, H-2/H-3/H-6 status / #74 merged).

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
| **E-2** (wire `view_appraisal` / `view_property` on Grow Today `appraisal_follow_up` cards) | `cursor/e2-view-appraisal-7064` (product #75). This docs PR is a separate status claim only (`cursor/e2-status-markers-57c7`); it does not edit the product branch. | Grok (orchestrator) / Cursor cloud agent (implementer) | This docs claim: `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`; `docs/AE_GROW_COMPLETION_ROADMAP.md` (status lines only). Product files `apps/api/src/lib/growToday.ts` and `apps/web/src/pages/Grow.tsx` stay owned by open draft **#75** until that PR merges. Do not claim them here. | **Active** — awaiting Owner merge of product #75. Docs markers describe evidence from #75 (draft). Do not re-implement the product change. | https://github.com/AdamJRichards27/AgentEngineEasy/pull/75. Head at this claim: `72c7ee99102da4567f29aadb6333eb116459ac7b` (parent is staging `4a3d48d462fa250fc1064bd2fa8b26f59e5a9cde`; rebased, so no longer behind). Superseded head `f1db9568789f1ad839a32d622b48fbaeb511541e` was cut from `24336ed` and was 3 commits behind; its CI was SUCCESS. CI on `72c7ee9` was in progress when this claim was written. Tests named in the #75 body, and present on the head: `apps/api/src/lib/__tests__/growTodayAppraisalActions.test.ts` (`view_appraisal` stays first and `view_property` is added when the appraisal has a property; no `view_property` when there is no property; do-not-contact still strips outreach and keeps both view actions) and `apps/web/src/lib/__tests__/growTodayAppraisalActions.behavior.test.ts` (View appraisal + View property → `/properties/{id}`; View property omitted unless the API lists it; no `/properties/null`). E-1 stays Owner-gated (decisions #2/#3, W3-E/W3-F). C-1, G-1, and H-4 stay open. | #76 | — |
| **Performance / Coach** | *none — read-only* | Discovery agent | `lib/ai/coaching/**` (read only until a claim is recorded) | DISCOVERY — **unblocked** after #55 merged | Implementation still **gated** on Owner decisions **#4** and **#5**, plus a file claim in this register before any edit | — | — |

### Known ownership — released and still open

Consolidation gate `234871a` released the domains below. The previous Active collision claims are obsolete.

- **`lib/ai/**`** — released with **#55** (operational W2-C, AI governance). Performance/Coach discovery may read `lib/ai/coaching/**`. Implementation still waits on Owner decisions #4 and #5 and a new file claim.
- **`propertyIntelligence/service.ts`** (with `evaluation.ts`, `evidence.ts`, `signals.ts`, `routes/propertyIntelligence.ts`, `PropertyIntelligencePanel.tsx`, `web/lib/contactAnchoredSignals.ts`) — released with **#59** (operational W2-D, contact-anchored signals).
- **`routes/contacts.ts`** and the **`Grow.tsx` consent panel** (`GrowContactConsentPanel`) — released with **#61** (operational W3-A, contactability completion).
- **`communications/outbox.ts`** and **`communications/providers/**`** (with `telephony/recordingGates.ts` and the `lib/env.ts` flag) — released with **#60** (operational W3-B, connect readiness). The #51 dispatch-time consent re-check stays in force.
- **`docs/`** — released with **#58** (register / roadmap), claimed again by **E-3** and released with **#65**, claimed again by **I-1** and released with **#66**, claimed again by **I-2** and released with **#67**, claimed again by **F-2** and released with **#68**, claimed again by **I-3** and released with **#69**, claimed again by **I-6 / I-8** and released with **#70**, claimed again by **Wave-1 docs re-verification — A-1/A-2/A-3/H-1** and released with **#71**, claimed again by **A-4 / A-5 status reconciliation** and released with **#73**, claimed again by **H-2 / H-3 / H-6 status reconciliation** and released with **#74**. Docs edits still require a claim before a new slice starts. **E-2 status markers** currently claim the two register/roadmap files for status lines only. Product files for E-2 stay with #75 until that PR merges.
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
- **`growToday.ts`** (API) and the Grow Today card in **`pages/Grow.tsx`** were released with **F-1 / #64** (and, for other `Grow.tsx` regions, #61 and #65). F-2, F-3, I-2, I-4, and I-5 are closed on `growToday.ts`. The #68 re-verification is merged and did not hold the file. **E-2 product #75** already claims `apps/api/src/lib/growToday.ts` and `apps/web/src/pages/Grow.tsx` until that PR merges. Do not open a second claim on those files. This docs slice does not claim them.
- **B-1** (messaging fragments in the protected-operations denylist) was closed by **#55**. `OUTBOUND_MESSAGING_FRAGMENTS` is present in `apps/api/src/lib/ai/protectedOperations.ts` and covered by `governance.test.ts`. Do not open a B-1 implementation slice.

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
