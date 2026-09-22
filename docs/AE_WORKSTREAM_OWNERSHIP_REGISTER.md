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

Current staging: `234871ab1f9e415c0e9600f4d5290daa17aefc7b` (2026-09-22, consolidation gate complete: #58→#55→#59→#61→#60).

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
| **F-1 / Commitments on Grow Today** | `cursor/f1-commitments-on-grow-today-33a9` | Grok (orchestrator) / Cursor cloud agent (implementer) | `apps/api/src/lib/growToday.ts`; `apps/api/src/routes/__tests__/growTodayQueryShape.test.ts`; `apps/api/src/routes/__tests__/growTodayCommitments.test.ts`; `apps/web/src/lib/growToday.ts`; `apps/web/src/lib/__tests__/growToday.test.ts`; `apps/web/src/lib/__tests__/growTodayConsolidation.test.ts`; `apps/web/src/pages/Grow.tsx` (Grow Today action card only); `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`; `docs/AE_GROW_COMPLETION_ROADMAP.md` (status line only). Read-only reuse of `growCommitments` and `loadContactabilityFilter` — commitment admin routes are not claimed. | **Active — in progress** | Branch from staging `36f43ce13f593f906d07ecc8eeb7337eb3fbc217`. F-4 / W3-A (DECISION A on the other commitment surfaces) is out of scope. | — | — |
| **Performance / Coach** | *none — read-only* | Discovery agent | `lib/ai/coaching/**` (read only until a claim is recorded) | DISCOVERY — **unblocked** after #55 merged | Implementation still **gated** on Owner decisions **#4** and **#5**, plus a file claim in this register before any edit | — | — |

### Known ownership — released and still open

Consolidation gate `234871a` released the domains below. The previous Active collision claims are obsolete.

- **`lib/ai/**`** — released with **#55** (operational W2-C, AI governance). Performance/Coach discovery may read `lib/ai/coaching/**`. Implementation still waits on Owner decisions #4 and #5 and a new file claim.
- **`propertyIntelligence/service.ts`** (with `evaluation.ts`, `evidence.ts`, `signals.ts`, `routes/propertyIntelligence.ts`, `PropertyIntelligencePanel.tsx`, `web/lib/contactAnchoredSignals.ts`) — released with **#59** (operational W2-D, contact-anchored signals).
- **`routes/contacts.ts`** and the **`Grow.tsx` consent panel** (`GrowContactConsentPanel`) — released with **#61** (operational W3-A, contactability completion).
- **`communications/outbox.ts`** and **`communications/providers/**`** (with `telephony/recordingGates.ts` and the `lib/env.ts` flag) — released with **#60** (operational W3-B, connect readiness). The #51 dispatch-time consent re-check stays in force.
- **`docs/`** — released with **#58** (register / roadmap). Docs edits still require a claim before a new slice starts.
- **`growToday.ts`** (API and web) is **claimed for F-1** (commitments on Grow Today) — see the Active row. Do not edit it from another slice until that claim is released.

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
