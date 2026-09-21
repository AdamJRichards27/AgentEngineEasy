# AE WORKSTREAM OWNERSHIP REGISTER

**Purpose.** One authoritative record of who owns what while multiple agents work the AE GROW
Completion Program in parallel. Maintained by **OpenClaw**, which is the single authoritative
engineering queue during the Grok integration trial.

**The rule this register exists to enforce:** *no two implementation agents own the same files
simultaneously.* A reviewer and an implementer may look at the same files; two implementers may not.

**Canonical source of truth is `staging` on GitHub.** This file records ownership, not state — for
what remains to be built, see [`AE_GROW_COMPLETION_ROADMAP.md`](./AE_GROW_COMPLETION_ROADMAP.md).

Current staging: `a76c8521516554365c43df06152b6b2b8ee9e76d` (2026-09-21, seven-slice merge wave + PR #56).

---

## Roles

| Role | Holder | Authority |
|---|---|---|
| **Primary orchestrator / integration owner** | OpenClaw | Owns the engineering queue, assigns slices, verifies merges, maintains this register and the roadmap. |
| **Independent engineering review + parallel development** | Grok Bot | Reviews; may recommend work; may later implement assigned slices. **May not** reprioritise the roadmap, create competing branches for owned work, merge, instruct other agents, deploy, or make product decisions. |
| **Implementation / specialist agents** | Claude subagents | Implement explicitly owned slices under OpenClaw orchestration. |
| **Merge authority** | Project Owner | Every merge to `staging` requires explicit approval. |

Grok uses **its own** GitHub credentials. Credentials are never shared between agents, never placed
in prompts, reports, repository files or CI output, and least privilege applies — read-only access
for a read-only task even where the credential permits more.

---

## Active register

| Workstream | Branch | Primary agent | Files / domain | Status | Dependencies | PR | Reviewer |
|---|---|---|---|---|---|---|---|
| **W2-D** Contact-anchored signals | `feat/ae-grow-w2d-contact-anchored-signals` | Claude A | `propertyIntelligence/service.ts`, `evaluation.ts`, `evidence.ts`, `signals.ts`, `routes/propertyIntelligence.ts`, `PropertyIntelligencePanel.tsx`, `web/lib/contactAnchoredSignals.ts` | IMPLEMENTING | #56 **merged** — now plain `staging` | TBD | Grok (when provisioned) |
| **#55 remediation** AI governance | `feat/ae-grow-w2c-ai-governance` | Claude B | `lib/ai/**`, `routes/ai.ts`, `schema/ai.ts`, migration 0029 | REMEDIATING | staging | #55 | OpenClaw (done); Grok to re-review remediated candidate |
| **W3-A** Contactability completion | `feat/ae-grow-w3a-contactability-completion` | Claude C | `routes/contacts.ts`, `pages/Grow.tsx`, new consent panel | IMPLEMENTING | #52 (merged) | TBD | TBD |
| **W3-B** Connect technical readiness | `feat/ae-grow-w3b-connect-readiness` | Claude D | `communications/outbox.ts`, `communications/providers/**`, `telephony/recordingGates.ts`, `lib/env.ts` (flag only) | IMPLEMENTING | #51 (merged) | TBD | TBD |
| **Performance / Coach** | *none — read-only* | Discovery agent | `lib/ai/coaching/**` (read only) | DISCOVERY | **blocked from implementing until #55 merges** | — | — |
| **Register / roadmap** | `docs/ae-workstream-register` | OpenClaw | `docs/` | REVIEW | — | #58 | — |

### Known ownership collisions to respect

- **`lib/ai/**`** is held by the #55 remediation. Performance/Coach is therefore **discovery only** until #55 merges — its implementation slices touch the same surface and must not start early.
- **`propertyIntelligence/service.ts`** is W2-D's alone. W3-A works elsewhere in Contact 360 (`routes/contacts.ts`, `Grow.tsx`) and must not reach into it.
- **`Grow.tsx`** is W3-A's. W2-D owns `PropertyIntelligencePanel.tsx`, a different component rendered inside the same screen — adjacent, not shared.
- **`communications/outbox.ts`** is W3-B's. Its dispatch seam sits *after* the dispatch-time consent re-check that landed in #51; that check must keep working untouched.
- **`growToday.ts`** (API and web) is currently **unowned**. The next slice to claim it records here first.

## Merged — no longer owned

Released back to the pool on 2026-09-21. Any new slice touching these files must claim them here.

| PR | Slice | Domain released |
|---|---|---|
| #49 | Completion Roadmap | `docs/` |
| #54 | Test-env hardening | `scripts/run-api-tests.sh`, root `package.json`, `README.md` |
| #50 | Sweep ops, alerting, metrics, migration 0028 | `propertyIntelligence/sweep.ts`, `sweepBootstrap.ts`, `packages/events/src/metrics.ts`, `operationalAlerts.ts`, `packages/db/migrations/` |
| #51 | Consent security + dispatch re-check | `routes/communications.ts`, `communications/consent.ts`, `communications/outbox.ts`, `communications/types.ts` |
| #52 | F2 consent/DNC write routes | `routes/growConsent.ts` |
| #53 | Tenant-scoped contact reads | `relationshipTimeline.ts`, `contactIntelligence.ts`, `routes/contacts.ts`, `web/src/main.tsx` |
| #57 | Grow Today bounding | `growToday.ts` (API + web), `grow/signalRanking.ts` |
| #56 | UX coherence | `CommandCentre.tsx`, `GrowImport.tsx`, `CommunicationsHub.tsx`, `Home.tsx`, `Settings.tsx`, `web/lib/communications.ts`, `productNav.ts` |

---

## Conventions

1. **Claim before you edit.** A slice is added here with its file list before implementation starts.
2. **One canonical owner per implementation area.** If a slice needs a file another slice owns, it
   stops and reports rather than reaching across.
3. **Branch from the owner, not from staging**, when a slice extends unmerged work — as W2-D does
   from #56. Record the dependency in the PR body as well as here.
4. **Migrations batch.** Index and schema work collects into one migration per wave rather than
   fragmenting across slices.
5. **Merging releases ownership.** Move the row to the merged table and the files return to the pool.
6. **Reviewers do not own files.** A review row exists so the queue is visible, with *no implementer*
   recorded, which is what makes it safe for a reviewer and an implementer to read the same code.

---

## Grok provisioning status

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
