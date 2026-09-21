# AE WORKSTREAM OWNERSHIP REGISTER

**Purpose.** One authoritative record of who owns what while multiple agents work the AE GROW
Completion Program in parallel. Maintained by **OpenClaw**, which is the single authoritative
engineering queue during the Grok integration trial.

**The rule this register exists to enforce:** *no two implementation agents own the same files
simultaneously.* A reviewer and an implementer may look at the same files; two implementers may not.

**Canonical source of truth is `staging` on GitHub.** This file records ownership, not state — for
what remains to be built, see [`AE_GROW_COMPLETION_ROADMAP.md`](./AE_GROW_COMPLETION_ROADMAP.md).

Current staging: `e774494f6c4e8e9bd99793d108c741c97925f444` (2026-09-21, seven-slice merge wave).

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
| **W2-D** Contact-anchored signals | `feat/ae-grow-w2d-contact-anchored-signals` | Claude | `propertyIntelligence/service.ts`, `evaluation.ts`, `evidence.ts`, `routes/propertyIntelligence.ts`, `signals.ts`, `PropertyIntelligencePanel.tsx`, `web/lib/contactAnchoredSignals.ts` | IMPLEMENTING | Based on PR #56 (unmerged) | TBD | TBD |
| **PR #55 review** AI governance | `feat/ae-grow-w2c-ai-governance` | *no implementer* | `lib/ai/**`, `routes/ai.ts` | REVIEW | — | #55 | Grok (primary) + OpenClaw cross-check |
| **PR #56 review** Grow UX | `feat/ae-grow-w2b-ux-coherence` | *no implementer* | `pages/Grow.tsx`, `CommandCentre.tsx`, `GrowImport.tsx`, `CommunicationsHub.tsx`, `Home.tsx`, `Settings.tsx`, `web/lib/communications.ts`, `productNav.ts`, `propertyIntelligence/service.ts` | REVIEW | — | #56 | Grok (primary) + OpenClaw cross-check |
| **Register / roadmap** | `docs/ae-workstream-register` | OpenClaw | `docs/AE_WORKSTREAM_OWNERSHIP_REGISTER.md`, `docs/AE_GROW_COMPLETION_ROADMAP.md` | IMPLEMENTING | — | TBD | — |

### Known ownership collisions to respect

- **`propertyIntelligence/service.ts`** is touched by both W2-D (implementing) and PR #56 (in review).
  W2-D is branched **from** #56 precisely so there is one writer. Nothing else may edit that file
  until both land.
- **`growToday.ts` (API and web)** landed with PR #57 and is currently **unowned**. The next slice to
  claim it must be recorded here first.
- **`outbox.ts`** landed with PR #51. The Connect dispatch-seam work (roadmap W2-G) will claim it;
  do not start that concurrently with any other communications slice.

---

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
