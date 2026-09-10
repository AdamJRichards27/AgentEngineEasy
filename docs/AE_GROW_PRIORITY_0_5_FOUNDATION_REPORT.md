# AE GROW — Priority 0.5 — Product Boundary, Entitlements & Grow-First Foundation

**Branch:** `feat/ae-grow-priority-0-5-foundation`
**Starting SHA (base of branch, tip of `staging` at task start):** `390cbd0fdbf0e80eb98fb7dcd478420759bc747b`
**Final SHA (branch tip at completion of this report):** `cf6e25e50a66c983b06f66bb4a5c04da82eb4206`
**Scope:** Priority 0.5 foundation only. Priority 1 (Daily Command Centre, Opportunity Engine, Contact Intelligence, AI Performance Coach, Nurture Engine, voice assistant, call recording/transcription) is explicitly **not** started.

---

## 1. Decision

**COMPLETE WITH DEFERRED ITEMS — READY FOR GROW PRIORITY 1**

All ten workstreams were implemented within their authorized bounds. Two items are transparently deferred rather than silently skipped — the drizzle-kit snapshot regeneration (§13, §15) and execution of the real automated suite in this sandbox (§13) — both are explained in detail below, neither blocks Priority 1, and both are cheap for a developer environment or CI to close out. No stop condition was triggered. No Priority 1 feature surface was built. Existing Run functionality was not degraded; every change to Run-adjacent code (Pit Crew, Financial, AI tier resolution) was additive-gate or read-derivation only, verified by reasoning through every production call site and covered by new or updated automated tests.

## 2. Changes Implemented

By workstream, each corresponding to one or more commits (full SHAs and diffs in §14):

1. **Frontend entitlement awareness** — `GET /auth/me` now returns `entitlements: string[]` alongside `user`; `apps/web/src/lib/session.ts` exposes it via a new `useEntitlements()` hook without changing `useSession()`'s existing contract.
2. **Grow-first navigation** — new `apps/web/src/lib/productNav.ts` centralises nav-link construction (Grow always first) and post-login landing routing (entitlement-aware), wired into `App.tsx`.
3. **Grow/Run entitlement boundary** — new coarse `run.access` entitlement key, mapped only to the Starter/RUN product and the Pro+Grow bundle; backfilled non-destructively to every existing brokerage; enforced on every Pit Crew and Financial route.
4. **AI entitlement source-of-truth consolidation** — `resolveBrokerageTier()` now derives its answer from real entitlement grants via the tested resolver, replacing a disconnected hardcoded stub, with a proven no-divergence guarantee for zero-grant brokerages.
5. **Grow "Today" preparation** — documentation-only comments added to `homeSummary.ts` and `Home.tsx` recording the architectural boundary between RUN's existing Home surface and Grow's future "Today" view; no behaviour changed.
6. **Pre-property relationship migration** — `growRelationships.propertyId` is now nullable, with a hand-authored migration, updated routes, and new regression tests; evaluated as safe and completed (not stopped/documented-only).
7. **Voice interaction readiness** — documentation only (§10); no code.
8. **Conversation intelligence readiness** — documentation only (§11); no code.
9. **Contact Intelligence path preserved** — no schema or route changes that would foreclose it; confirmed in §16.
10. **Tests** — new/updated automated test coverage across all code-bearing workstreams (§13).

## 3. Product Hierarchy

The commercial hierarchy this phase builds toward is now reflected in the entitlement model, not yet in customer-facing pricing UI (out of scope for 0.5):

| Product | Price | Promise | Entitlement foundation |
|---|---|---|---|
| **GROW** | $99/mo | "Find the business" | `grow.access` + existing `grow.*` keys (pre-existing, Stage A) |
| **RUN** | $289/mo + Pit Crew success fee (10.9%, capped $20k/yr) | "Deliver the business" | New `run.access` (this phase) + existing role/route gates |
| **SCALE** | Future | "Manage the business" | Not started — explicitly out of scope |

`run.access` is the only new entitlement key. It is additive to, not a replacement for, existing role-based checks (`requireAuth`, role arrays) already on every Run route — every gate now requires **both** the correct role/auth **and** the entitlement.

## 4. Grow-First Navigation

`apps/web/src/lib/productNav.ts` is the single source of truth for two previously inline, scattered concerns in `App.tsx`:

- **`buildProductNavLinks(ctx)`** — Grow is always the first link in the sidebar for every authenticated role. Every existing RUN link (Properties, Pit Crew, Financial, etc.) keeps its exact prior ordering and role-gating; Settings stays last. No Scale entry exists anywhere.
- **`resolveLandingRoute(ctx)`** — decides where `/login` redirects post-authentication. A user with `grow.access` who is **not** Pit Crew lands on `/grow`. Pit Crew always lands on `/` regardless of entitlement — this was a deliberate, explicit rule to satisfy Stop Condition 7 (never break Pit Crew's operational access) and is covered by its own test. Everyone else (no `grow.access`, or role not otherwise specified) lands on `/`, identical to pre-existing behaviour.

Grow itself is **not** hidden from the nav for brokerages lacking `grow.access` — it always appears, leading to Grow's existing locked-shell/upgrade experience (`GET /grow/access` reports `entitled: false`, and the page renders its own upsell). This was a deliberate choice, not an oversight: hiding a nav link based on entitlement while the backing route is unprotected would be **frontend-only gating** (explicitly listed as Stop Condition 3). The actual protection is the existing `requireEntitlement("grow.access")` on Grow's data routes (routes/grow.ts, pre-existing from Grow Stage A) — the nav link is honest advertising of a feature that then correctly gates itself server-side.

`App.tsx`'s prior inline `canSeePitCrew` / `canSeeFinancial` / `links` construction was extracted into `buildProductNavLinks` with **zero change** to who can see Pit Crew or Financial — this was a refactor of where the logic lives, not a change to the logic itself.

## 5. Entitlement Architecture

No changes were made to the entitlement resolver itself (`apps/api/src/lib/entitlements/resolver.ts`) — it was already the real, tested, tenant-scoped, fail-closed source of truth from Grow Stage A, and stayed exactly as it was. What Priority 0.5 added:

- **`run.access`** — new key in `ENTITLEMENT_KEYS` (now 14 keys total), mapped in `lib/billing/catalogue.ts` to the Starter/RUN product and the Pro+Grow bundle, and explicitly **not** to standalone Grow — buying Grow alone must never grant Run access.
- **Non-destructive backfill** — `ensureRunAccessBackfilled()` (`lib/billing/runAccessBackfill.ts`) idempotently grants `run.access` (sourceType `"migration"`) to every brokerage that existed before this key did. Called fire-and-forget at boot in `index.ts`, alongside the pre-existing catalogue seed. New brokerages get the grant inline at creation time in dev-login (`routes/auth.ts`).
- **Enforcement** — `requireEntitlement("run.access")` added to every route in `routes/pitCrew.ts` and to the shared `requireFinancialAdmin` middleware array in `routes/financial.ts`, alongside their pre-existing role checks (never instead of them).
- **Frontend exposure** — `GET /auth/me` now returns `entitlements: string[]` as a sibling field to `user`, resolved via the same real resolver server-side. No new client-side entitlement logic exists that isn't backed by a server-side gate; the frontend's use of entitlements is limited to navigation/landing UX, never to hiding the actual access control.
- **Synthetic system actor pattern** — used in two places (backfill checks and AI tier reconciliation, §7) to resolve brokerage-level entitlements without a specific acting user: `{id: -1, role: "system", brokerageId}`. This works safely with zero resolver changes because `grantAppliesToActor` in the existing resolver already ignores `actor.id` for `"brokerage"`/`"platform"` grant types — the pattern was verified against the resolver's actual logic, not assumed.

## 6. Grow/Run Boundary

The explicit key-by-key mapping requested by the task:

| Entitlement key | Grants access to | Granted by |
|---|---|---|
| `grow.access` | Grow's core surfaces (relationships/activities/opportunities read) | Grow product purchase (pre-existing) |
| `grow.relationships.manage` | Creating/updating Grow relationships | Grow product purchase (pre-existing) |
| `grow.activities.manage` | Creating Grow activities | Grow product purchase (pre-existing) |
| `grow.opportunities.manage` | Creating Grow opportunities | Grow product purchase (pre-existing) |
| *(10 further pre-existing `grow.*` keys, unchanged)* | Grow Stage A feature surfaces | Grow product purchase (pre-existing) |
| **`run.access`** *(new)* | Pit Crew routes, Financial/financial-admin routes | RUN product purchase, or the Pro+Grow bundle, or the non-destructive backfill for pre-existing brokerages |

The boundary is coarse by design, matching the task's instruction for "a minimum coarse `run.*` entitlement" — it is a single on/off gate for the whole Run surface, not a per-feature breakdown within Run. A finer-grained `run.*` taxonomy (mirroring Grow's per-capability keys) was considered and deliberately deferred: the task authorized only the *minimum* foundation, and Run's existing role-based checks already provide meaningful internal differentiation that a coarse product-level gate doesn't need to duplicate.

## 7. AI Entitlement Reconciliation

**Before:** `resolveBrokerageTier()` (`apps/api/src/lib/ai/entitlements.ts`) was a synchronous stub, hardcoded to always return `"STARTER"` regardless of what the brokerage had actually purchased — a second, disconnected notion of tier that had no relationship to the real entitlement system.

**After:** `resolveBrokerageTier()` is now `async` and derives its answer from real entitlement grants via `resolveEntitlements({id: -1, role: "system", brokerageId})` (the synthetic system actor, §5):

- `grow.access` **and** `run.access` both present → `"PRO"`
- `grow.access` only → `"GROW"`
- neither → `"STARTER"`

This maps exactly onto the three real product tiers in `lib/billing/catalogue.ts`. `TIER_CAPABILITIES` and `isRoleEntitled` (which consume the resolved tier) were **not** changed — only how the tier itself is produced.

**Call-site verification:** `apps/api/src/lib/ai/context/contextEngine.ts`'s `buildBrokerageContext()` is the **only** production call site of `resolveBrokerageTier`, confirmed by reading `orchestrator.ts` and `gateway.ts` in full — both only ever call `isRoleEntitled(context.tier, role)` against an already-resolved context, never `resolveBrokerageTier` directly. The single call site was updated from `tier: resolveBrokerageTier(brokerageId)` to `tier: await resolveBrokerageTier(brokerageId)`; `buildBrokerageContext` was already `async`, so this required no signature change up its own call chain.

**No-divergence guarantee:** a brokerage with zero entitlement grants resolves to `"STARTER"` under the new logic — identical to the old hardcoded default. No existing brokerage's AI capability can silently change as a side effect of this reconciliation; a brokerage only sees a different tier if it genuinely holds different entitlement grants than before, which was already true of every other part of the app. This is proven by test, not just asserted (§13).

## 8. Grow Today Preparation

Per the task's explicit instruction to prepare architecturally "using `Home.tsx`/`homeSummary.ts` without building real UX," this workstream added **documentation only** — no exports, function signatures, queries, gating, or rendered output changed in either file:

- `apps/api/src/lib/homeSummary.ts` gained a comment block establishing that `getHomeSummary()`/`getDashboardOverview()` remain RUN's existing property-workflow aggregation, and that Grow's future "Today" view is a separate function reading Grow's own domain tables (`growRelationships`/`growActivities`/`growOpportunities`), gated by `grow.access` rather than reused wholesale from this module.
- `apps/web/src/pages/Home.tsx` gained a matching comment establishing that this remains RUN's page, that Grow-entitled non-Pit-Crew users are now routed to the distinct `/grow` route instead (§4), and that this page continues to serve every existing RUN user unchanged.

This intentionally does not decide Grow "Today"'s eventual UI shape or exact data contract — only the boundary that it will be its own surface, not a repurposing of RUN's. That decision is left to Priority 1.

## 9. Pre-Property Relationship Decision

**Decision: migrate, not stop.** `growRelationships.propertyId` was evaluated and found safe to make nullable, so the migration was completed rather than merely documented as a risk.

**Why it's needed:** the revised Grow model requires recording a relationship with a contact *before* AE knows which property is relevant — prospecting and nurture naturally start with a person, not a property. The prior `NOT NULL` constraint made this structurally impossible.

**Why it's safe:**

- **Import pipeline:** `apps/api/src/lib/import/relationships.ts`'s `resolveRelationshipLinks()` already, independently, only ever creates a link for a row carrying a real formatted property address (`if (!record.property?.address?.formatted) return;`) — this guard predates and is unrelated to the schema's nullability. Making the column nullable therefore changes **zero** import-pipeline behaviour; it never relied on the database constraint to stay correct. Proven by three new tests in `apps/api/src/lib/import/__tests__/relationships.test.ts`.
- **API routes:** two consequential, deliberate changes were made in `apps/api/src/routes/grow.ts` to actually make the new capability usable and to avoid silently breaking existing data:
  - `POST /relationships` now requires only `partyId` + `relationshipType`; `propertyId` is optional, and when supplied is still tenant-checked exactly as before.
  - `GET /relationships` changed from `.innerJoin(properties, ...)` to `.leftJoin(...)` — without this, a property-less relationship would have silently vanished from every list response, which would have been a real regression even though the row existed in the database. Existing property-linked relationships are unaffected by this join change (proven by a test that specifically re-checks an existing linked row after the join change, §13).
- **Migration mechanics:** a minimal, hand-authored SQL migration (`packages/db/migrations/0013_grow_relationship_property_optional.sql`: `ALTER TABLE "grow_relationships" ALTER COLUMN "property_id" DROP NOT NULL;`) plus the matching `_journal.json` entry. This is a single, additive, non-destructive `ALTER COLUMN ... DROP NOT NULL` — it cannot fail against existing data (dropping a constraint never violates it) and requires no backfill.

**Transparently deferred:** drizzle-kit's internal snapshot JSON (a large, machine-generated file used only by `drizzle-kit generate` to diff future schema changes) was **not** hand-regenerated. The runtime `migrate()` function used in production and tests reads only `_journal.json` and each migration tag's `.sql` file — never the snapshot — so this has no runtime or test-time effect. Its only consequence is that a future `drizzle-kit generate` run may propose a redundant, harmless no-op migration until the snapshot is regenerated by running that tool in a real developer environment (not available in this sandbox). This is a known, bounded, cosmetic gap, not a functional one.

## 10. Voice Interaction Readiness

**Documentation only, as instructed — no code, no schema, no routes.**

No voice/speech infrastructure exists in AE today, and none was added in this phase. For Priority 1's future voice assistant to land cleanly, this phase records the following readiness notes rather than building anything:

- **Entitlement hook point:** voice access should be gated by its own new entitlement key (e.g. `grow.voice.access` or a Run-tier equivalent, to be decided in Priority 1 based on which product tier(s) it ships in), resolved the same way every other entitlement is — via `resolveEntitlements`, never a separate ad-hoc check. This phase's `run.access` pattern (§5) is the template to follow: additive to existing gates, never a replacement.
- **Actor/context shape:** any future voice command handler will need the same `EntitlementActor { id, role, brokerageId }` shape already used everywhere else in the app (`apps/api/src/lib/entitlements/types.ts`) — no new actor concept is needed.
- **Domain surface:** voice commands acting on Grow data (e.g. "log a call with [contact]") would write through the existing `growActivities` table and its existing validation/tenant-isolation rules in `routes/grow.ts` — not a parallel data path. Voice is a new *input modality* onto existing domain writes, not a new domain.
- **Explicit non-scope:** no speech-to-text integration, wake-word handling, audio capture, telephony, or call recording exists or was evaluated for vendor selection in this phase — all correctly out of scope per the task's DO NOT DO list.

## 11. Conversation Intelligence Readiness

**Documentation only, as instructed — no code, no schema, no routes.** This section deliberately distinguishes two concepts the task called out as easy to conflate:

- **"Voice commands"** (§10) are AE being *told to do something* by the user — a control-plane interaction, structurally similar to clicking a button, just spoken. It has no independent data model beyond what the resulting action already writes (e.g. a `growActivities` row).
- **"Contact conversations"** (this section) are AE *observing or being told about* a conversation the agent had *with a contact* — a data-plane concern, and a much larger future surface: call transcripts, meeting notes, email/SMS threads, sentiment, extracted commitments. None of this exists today and none was built in this phase.

Readiness notes for Priority 1:

- **Natural home:** `growActivities` (Grow Stage A, unchanged in this phase) already has an `activityType` enum including `"call"`, `"email"`, `"sms"`, `"meeting"`, and a free-text `summary` plus a `jsonb details` column — this is very likely the right foundation for a future conversation record to extend (e.g. richer `details` payload for a transcript reference or extracted entities) rather than a new parallel table, but that decision is explicitly left to Priority 1, not made here.
- **Explicit non-scope confirmed:** no call recording, no transcription, no telephony integration, and no conversation-intelligence UI (sentiment displays, extracted-commitment surfaces, etc.) exists or was designed in this phase, per the task's DO NOT DO list.

## 12. Privacy/Consent Gate

No new personal data collection, storage, or processing was introduced in this phase — every change was either an entitlement/access-control mechanism (§3–§7) or a nullability relaxation on an existing column with existing validation (§9). Nothing in this phase touches or requires changes to the pilot's existing legal/privacy framework (`PILOT_PRIVACY_POLICY.md`, `PILOT_TERMS_OF_USE.md`, and the rest of the 13-document pack landed in the prior `feat/operational-readiness-pilot-gate` PR, merged at this branch's base commit `390cbd0f`) — those documents' consent and disclosure commitments are unaffected because no new category of data is collected. The pre-property relationship capability (§9) lets an agent record a relationship with a *contact* earlier in the pipeline than before, but the contact data itself is still the pre-existing `parties` record with its pre-existing fields and pre-existing tenant isolation — no new PII field, retention behaviour, or third-party disclosure was added. Voice and conversation-intelligence readiness (§10, §11) are documentation only and introduce no actual data collection to evaluate against consent commitments; a real privacy/consent review of those capabilities is squarely a Priority 1 concern once they have an actual design to review.

## 13. Test Evidence

**New or materially updated automated tests this phase**, all committed to the branch:

- `apps/api/src/lib/ai/__tests__/entitlements.test.ts` — full rewrite. Covers: zero grants → `STARTER`; `run.access` only → `STARTER`; `grow.access` only → `GROW`; both → `PRO`; a revoked grant reverting to `STARTER`; plus the pre-existing, unchanged `isRoleEntitled` tests.
- `apps/web/src/lib/__tests__/productNav.test.ts` — new file, 12 tests. Covers nav-link ordering (Grow always first), role-gating parity with the pre-refactor inline logic, and `resolveLandingRoute` for every role × entitlement combination that matters (Grow-entitled non-Pit-Crew → `/grow`; Pit Crew regardless of entitlement → `/`; no entitlement → `/`).
- `apps/api/src/routes/__tests__/grow.test.ts` — 10 pre-existing HTTP-level regression tests preserved unchanged, plus 2 new tests: a missing `propertyId` is accepted on `POST /relationships` and correctly returned (with a null property) by `GET /relationships` via the new `leftJoin`, while an existing property-linked relationship created earlier in the same test file is independently re-verified as still correctly linked (proving the join change is additive, not lossy); and tenant isolation on `partyId` still holds when no `propertyId` is supplied at all.
- `apps/api/src/lib/import/__tests__/relationships.test.ts` — new file, 3 tests proving `resolveRelationshipLinks()` and `groupProperties()` never produce a property link for a row lacking a real formatted property address, regardless of the schema's nullability — the direct proof that Workstream 6 changes no import behaviour.
- `apps/api/src/routes/__tests__/auth.test.ts` and `authSecurity.test.ts` — updated (as a consequence of Workstream 3's dev-login auto-grant) to also delete `entitlementGrants` rows in their ad-hoc brokerage cleanup, since `entitlementGrants.brokerageId` is a non-cascading foreign key.

**What was not run, and why:** this sandbox's local mirror of the repository has no configured git remote and carries pre-existing, unrelated local modifications — it is stale and disconnected from the actual state of `staging`/this branch on GitHub, and running the suite against it would not validate the changes actually pushed in this phase. All writes this entire session went through the GitHub MCP server directly against the real repository, per this session's established discipline against raw `git`/`curl` access to github.com (including read-only), which also means there is no local clone of the *current* branch tip available to execute against. Consequently:

- The full automated suite (`pnpm run test` across all packages, most recently reported at 707 tests / 706 pass / 1 pre-existing skip against a disposable Postgres instance, per the merged PR #27 gate report at this branch's base commit) was **not** re-executed in this sandbox against the new commits.
- `pnpm -r run typecheck` and the production build were **not** re-executed in this sandbox.
- In place of execution, verification was performed by: reading every modified file's full content fresh from the branch after each push to confirm exact intended content (not paraphrased or assumed); tracing every production call site of every changed function (`resolveBrokerageTier`, the entitlement resolver's `grantAppliesToActor`) by reading the actual consuming code, not inferring from names; and writing tests that encode the specific guarantees this report claims, ready to run in CI or a developer environment.

**Recommendation:** before Priority 1 begins, run the real CI pipeline (or a developer environment with a disposable Postgres instance) against this branch to execute the full suite, typecheck, and build, and to regenerate the drizzle-kit snapshot (§9, §15). This is expected to be a clean pass based on the manual verification performed, but has not been machine-confirmed in this session.

## 14. Files Changed

Commits on this branch, oldest to newest (full messages on GitHub; `deb4a42a` is superseded by the two fix commits immediately following it, per this task's "never rewrite history" rule — it was corrected forward, not removed):

| SHA | Description |
|---|---|
| `deb4a42a` | Workstream 3 (run.access foundation) — **pushed with corrupted placeholder content, superseded below** |
| `e7ce5a88` | Fix (part 1): restores real content for `billing.ts`, `catalogue.ts`, `runAccessBackfill.ts`, `index.ts`, `routes/auth.ts` |
| `14cccd96` | Fix (part 2): restores real content for `routes/pitCrew.ts`, `routes/financial.ts`, `auth.test.ts`, `authSecurity.test.ts` |
| `aacf171d` | Workstream 4 — AI entitlement reconciliation: `lib/ai/entitlements.ts`, `lib/ai/context/contextEngine.ts`, `lib/ai/__tests__/entitlements.test.ts` |
| `cadd1abb` | Workstreams 1 & 2 — frontend entitlement awareness + Grow-first navigation: `apps/web/src/lib/session.ts`, `apps/web/src/lib/productNav.ts` (new), `apps/web/src/lib/__tests__/productNav.test.ts` (new), `apps/web/src/App.tsx`, `apps/web/package.json` |
| `5463d58c` | Workstream 6 — nullable `propertyId`: `packages/db/src/schema/grow.ts`, `packages/db/migrations/0013_grow_relationship_property_optional.sql` (new), `packages/db/migrations/meta/_journal.json`, `apps/api/src/routes/grow.ts`, `apps/api/src/routes/__tests__/grow.test.ts`, `apps/api/src/lib/import/__tests__/relationships.test.ts` (new) |
| `cf6e25e5` | Workstream 5 — Grow "Today" documentation: `apps/api/src/lib/homeSummary.ts`, `apps/web/src/pages/Home.tsx` |

**Net files touched, deduplicated:** `packages/db/src/schema/billing.ts`, `packages/db/src/schema/grow.ts`, `packages/db/migrations/0013_grow_relationship_property_optional.sql` (new), `packages/db/migrations/meta/_journal.json`, `apps/api/src/lib/billing/catalogue.ts`, `apps/api/src/lib/billing/runAccessBackfill.ts` (new), `apps/api/src/index.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/routes/pitCrew.ts`, `apps/api/src/routes/financial.ts`, `apps/api/src/routes/grow.ts`, `apps/api/src/routes/__tests__/auth.test.ts`, `apps/api/src/routes/__tests__/authSecurity.test.ts`, `apps/api/src/routes/__tests__/grow.test.ts`, `apps/api/src/lib/ai/entitlements.ts`, `apps/api/src/lib/ai/context/contextEngine.ts`, `apps/api/src/lib/ai/__tests__/entitlements.test.ts`, `apps/api/src/lib/import/__tests__/relationships.test.ts` (new), `apps/api/src/lib/homeSummary.ts`, `apps/web/src/lib/session.ts`, `apps/web/src/lib/productNav.ts` (new), `apps/web/src/lib/__tests__/productNav.test.ts` (new), `apps/web/src/App.tsx`, `apps/web/src/pages/Home.tsx`, `apps/web/package.json`, this report.

No production configuration was modified. No force-push, history rewrite, squash, amend of unrelated work, or unrelated PR merge occurred — every fix was a new forward commit, per the task's source-control rules.

## 15. Deferred Work

Two items, both transparent and bounded, neither blocking Priority 1:

1. **drizzle-kit snapshot regeneration** (§9) — the internal, machine-generated schema snapshot JSON was not hand-regenerated to reflect the nullable `propertyId` column. Zero runtime or test-time effect (the migration runner never reads it); the only consequence is a future `drizzle-kit generate` invocation may propose a redundant migration until it's regenerated by running that tool in a real environment. Recommended: run `drizzle-kit generate` (or equivalent) once in a developer environment before or during Priority 1.
2. **Real suite/typecheck/build execution** (§13) — not run in this sandbox due to the local mirror being disconnected from the real repository state. Recommended: run the existing CI pipeline against this branch before merging, as the authoritative confirmation this report's manual verification is correct.

Nothing else was deferred. All ten workstreams have real, committed changes (or, for Workstreams 7–9, real committed documentation) on the branch.

## 16. Priority 1 Readiness

The foundation Priority 1 needs is in place:

- **Product boundary is real, not aspirational** — `run.access` exists, is enforced, and cleanly separates Run from Grow at the entitlement layer, so Priority 1 features can be gated by the correct product tier from day one rather than retrofitted later.
- **AI tier is trustworthy** — any Priority 1 AI feature (AI Performance Coach, Nurture Engine's AI-assisted messaging, etc.) that checks `isRoleEntitled(tier, role)` now gets a tier that reflects what the brokerage actually purchased, not a hardcoded stub.
- **Navigation has a Grow-first home** — Priority 1's Daily Command Centre and Opportunity Engine have an obvious landing point (`/grow`, already routed to for entitled non-Pit-Crew users) and an obvious nav position (first) to build into, without another navigation refactor.
- **The relationship model no longer blocks prospecting-first workflows** — Contact Intelligence and the Nurture Engine can create relationships before a property exists, which is very likely a precondition for both.
- **Contact Intelligence's path is unobstructed** — no schema, route, or data-model decision made in this phase forecloses it; `growActivities`' existing shape (§11) is a plausible foundation Priority 1 can build on or deliberately supersede, its choice.
- **Voice and conversation-intelligence have a documented landing spot** (§10, §11) — enough for Priority 1 planning to start from a real design conversation rather than a blank page, without any premature commitment to vendor, schema, or UI.

Per this task's explicit final instruction: Priority 0.5 implementation is complete, this report is filed, and no Priority 1 work has been started. **Awaiting Project Owner approval before Priority 1 begins.**

## 17. Full-Suite CI Failure Investigation

**Trigger:** Project Owner's "AE GROW — PR #28 CI FAILURE INVESTIGATION GATE" decision, followed by "AE GROW — PR #28 FINAL CONFIRMATION AND MERGE GATE" decision. The stacked merge sequence (PR #28 → PR #29 → PR #30 → `staging`) was held at PR #28 pending root-cause and CI resolution of failures observed in the full-suite CI run. This section is the required record of that investigation, per the Project Owner's step 11 (17-point) documentation requirement.

### 17.1 Starting SHA

`3494d85aeb8f9e4f5dd0705b6c7aef9fcfd10dc6` — "fix(test): stop privacy.test.ts teardown from hanging CI (backport from Priority 2)", the branch tip at the point the full-suite CI investigation began. This commit (together with `995bac3a04d48ce840d7bf66fe6aa4297508ee2d` and `69b13176cb3b9d6d906d420be0b91838c94c111f`, its two predecessor commits) had already fixed a prior, separate CI-hang defect (`privacy.test.ts`'s hand-rolled teardown throwing a Postgres FK violation on `entitlement_grants` and never reaching `server.close()`) — confirmed still effective in this investigation (no hang; see 17.9).

### 17.2 Final SHA

`4cf81d086605f836ba21c9cade877a6874ec1aa2` — current tip of `feat/ae-grow-priority-0-5-foundation` and current PR #28 HEAD at the time this section was written. (Note: this supersedes the "Final SHA: `cf6e25e5...`" recorded at the top of this report — that value was accurate as of §1–§16's Priority 0.5 implementation work; the branch has since advanced through this CI investigation, documented here.)

### 17.3 CI run IDs

| Run | Commit | Result | Total duration |
|---|---|---|---|
| #205 (run `34453097673`) | `3494d85aeb8f9e4f5dd0705b6c7aef9fcfd10dc6` | **Failure** — 4 test failures | 16m 2s |
| #207 (run `34459749102`) | `71bd961e9f844880d09e419578309ddbf94b30a2` | **Failure** — typecheck error (tooling mistake, see 17.5) | 1m 14s |
| #208 attempt 1 (run `34459859218`, attempt 1) | `4cf81d086605f836ba21c9cade877a6874ec1aa2` | **Success** — 774 tests, 0 fail | 16m 2s |
| #208 attempt 2 / "Latest #2" (run `34459859218`, attempt 2) | `4cf81d086605f836ba21c9cade877a6874ec1aa2` | **Success** — 774 tests, 0 fail | 16m 21s |

### 17.4 Original four failures (run #205, commit `3494d85`)

Full-suite result: `tests 774`, `suites 82`, `pass 769`, `fail 4`, `cancelled 0`, `skipped 1`, `todo 0`, `duration_ms 885780.88` (test step); job total 16m 2s. Exact failing tests and assertion text, read directly from the CI job log's "failing tests:" section:

1. **`GET /access reports entitlement state honestly and is never itself gated by grow.access`** (`apps/api/src/routes/__tests__/grow.test.ts:124`, assertion at line 129)
   `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + actual - expected + [ + 'run.access' + ] - []` — `code: 'ERR_ASSERTION'`, `actual: [ 'run.access' ]`, `expected: []`, `operator: 'deepStrictEqual'`.

2. **`grow.access unlocks the four read routes but grants no write access of its own`** (`grow.test.ts:140`, assertion at line 145)
   `AssertionError [ERR_ASSERTION]: GET /overview should be readable with only grow.access — 403 !== 200` — `actual: 403`, `expected: 200`, `operator: 'strictEqual'`.

3. **`POST /activities requires grow.activities.manage even though GET /activities only needs grow.access, and validates required fields`** (`grow.test.ts:255`, assertion at line 284)
   `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 403 !== 200` — `actual: 403`, `expected: 200`, `operator: 'strictEqual'`.

4. **`POST /relationships accepts a missing propertyId (pre-property relationships), and GET /relationships returns it with a null property via leftJoin`** (`grow.test.ts:444`, assertion at line 460)
   `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 403 !== 200` — `actual: 403`, `expected: 200`, `operator: 'strictEqual'`.

### 17.5 Root cause

**A single defect: a stale assertion in failure 1, which throws before a required `grant()` call in the same test executes.**

Test 1 (`GET /access reports entitlement state honestly...`, `grow.test.ts:124`) asserted `beforeBody.entitlements` deep-equals `[]` immediately after Brokerage A's dev-login. This was correct until Priority 0.5 Workstream 3 shipped: every brand-new brokerage now auto-receives `run.access` at dev-login time (`routes/auth.ts`). The assertion was never updated to match, so it threw `AssertionError [ERR_ASSERTION]` with `actual: ['run.access']` vs `expected: []` (17.4.1) — a genuinely stale test expectation, not an application defect. `run.access` is a RUN-surface key, never one of the `grow.*` keys, so `entitled` (which specifically means `grow.access`) was and remains correctly `false`; only the `entitlements` array's contents were stale.

Node's `node:test` runner does not implicitly wrap a test body in try/finally: when a `test()` callback throws, every statement *after* the throw point in that same callback is skipped, but subsequent `test()` blocks in the file still run normally. The line immediately following the failing assertion in test 1 was `await grant(A.brokerageId, "grow.access")` — the call that grants Brokerage A its `grow.access` entitlement for the rest of the file. Because the assertion above it threw, **this grant call never executed**, meaning Brokerage A genuinely, correctly never held `grow.access` for the remainder of the test run — not because of any resolver, cache, database, or CI-concurrency defect, but because the test file's own control flow never reached the line that was supposed to grant it.

Failures 2, 3, and 4 are the direct, deterministic, and entirely expected consequence of that one missing grant: each is a later `grow.access`-gated `GET` request (the read-routes check in test 2, and the final `GET /activities` / `GET /relationships` re-checks at the end of two later `POST` tests) correctly 403ing because Brokerage A genuinely had no `grow.access` grant — `requireEntitlement("grow.access")` (`apps/api/src/middlewares/entitlement.ts`) did exactly what it is supposed to do. No apparent inconsistency exists between "the resolver worked correctly" and "the routes 403'd" — both are true, and both are explained by the single missing `grant()` call.

**Why this was initially suspected to be four separate, full-suite-only, order/timing-dependent defects:** before this control-flow read was performed, the working hypothesis was that failures 2–4 were caused by full-suite state leakage, entitlement-cache staleness, or CI-only concurrency effects, since they did not reproduce in an isolated local resolver/DB repro (`repro2.mjs`, §17.6). That hypothesis is now known to be incorrect — see 17.6 for the negative evidence that ruled it out and led to the correct root cause.

### 17.6 Diagnostic steps taken (full-suite state leakage, entitlement regression, and isolation checks)

Per the Project Owner's steps 3–6, the following were investigated as candidate causes for failures 2–4 before the true root cause (17.5) was found, using GitHub Actions CI as the reproduction environment (no local git/gh credentials are available in this environment — confirmed: `GH_TOKEN`/`GITHUB_TOKEN` fail GitHub's HTTP auth for `git clone`, and no `gh` CLI is installed):

- **Entitlement cache staleness** — ruled out by reading `apps/api/src/lib/entitlements/resolver.ts` in full: the GET routes' gate (`requireEntitlement` → `explainEntitlementDecision`) issues a fresh `db.select()` on every call with no cache involved at all. Only `resolveEntitlements`/`GET /access` uses the separate 30s-TTL cache, and that path is unrelated to the 403s observed.
- **Route-level hidden logic** — ruled out by re-reading `apps/api/src/routes/grow.ts` in full: all four GET routes share identical `requireAuth, requireEntitlement("grow.access")` middleware with no additional checks.
- **Database schema / unique-constraint overwrite** — ruled out by re-reading `packages/db/src/schema/billing.ts`: `entitlementGrants` has no unique constraint beyond its serial primary key, so no silent overwrite-via-conflict is possible.
- **Test cleanup / cross-suite leakage** — ruled out by re-reading `apps/api/src/routes/__tests__/testSupport.ts`'s `cleanupBrokerages()` (the shared teardown helper) in full: every delete in its ~150-line body is scoped by `inArray(...ids)`; no unscoped delete exists.
- **Billing-sync interference** — ruled out by reading `apps/api/src/lib/billing/sync.ts` and its test file in full: `applySubscriptionSnapshot`'s grant/revoke logic matches existing grants by `brokerageId` + `entitlementKey` + `sourceType: "subscription"` + `sourceId`, and the sync test's own cleanup is scoped to its own brokerage — neither can touch `grow.test.ts`'s Brokerage A/B rows (`sourceType` `"manual"`/`"migration"`, not `"subscription"`).
- **Faithful full-sequence local reproduction** (`repro2.mjs`, run against a real local Postgres 16 instance with byte-for-byte-faithful copies of the resolver and schema): every grant and realistic inter-request timing gap in `grow.test.ts` was replayed in order, checking `explainEntitlementDecision(actorA, "grow.access")` at 11 checkpoints from immediately after granting `grow.access` through to the end of the file. **Result: `allowed=true reason=OK` at every single checkpoint.** This is the key negative result: it proves the entitlement resolver and database logic were never the defect, under a grant sequence that *does* include the `grow.access` grant. Combined with 17.5's control-flow finding — that the real (broken) test file's control flow meant the grant call was *never reached at all* — the full picture resolves cleanly: the resolver works correctly whenever it is actually given a grant to find; failures 2–4 occurred because the broken test never gave it one, not because the resolver misbehaved when it was given one.

**Entitlement regression check (Project Owner step 5):** none of the four failures are an application-level entitlement regression. Failure 1 is a stale test expectation that Priority 0.5 Workstream 3's `run.access` auto-grant (documented and intended, §5 of this report) correctly invalidated. Failures 2–4 are the test's own control-flow consequence of failure 1, not a `grow.access`/`run.access`/tier-derivation defect in the application. No expected outcome was changed without a corresponding, cited Priority 0.5 contract change (§5–§6 of this report) — the *only* application-facing behaviour these failures relate to is the one Priority 0.5 change already documented and intended: the `run.access` auto-grant itself.

**Isolation/cleanup check (Project Owner step 6):** `grow.test.ts`'s own setup/teardown was re-read in full; failures 2–4 do not stem from cross-test or cross-suite isolation defects — they stem from control flow *within a single test's body*, upstream of any cleanup boundary. No fixture or cleanup change was needed or made.

### 17.7 Classification

| # | Failure | Classification |
|---|---|---|
| 1 | `GET /access ... entitlements` assertion | **Stale test expectation** — assertion not updated when Priority 0.5 Workstream 3's `run.access` auto-grant shipped. |
| 2 | `grow.access unlocks the four read routes...` (`GET /overview`, 403) | **Downstream consequence of #1** (test-order/control-flow dependency within the same file: the `grant("grow.access")` call after #1's throwing assertion never executed) — not an independent defect. |
| 3 | `POST /activities requires grow.activities.manage...` (final `GET /activities`, 403) | **Downstream consequence of #1**, same mechanism. |
| 4 | `POST /relationships accepts a missing propertyId...` (final `GET /relationships`, 403) | **Downstream consequence of #1**, same mechanism. |

All four are one root cause, not four independent defects. None is an unrelated pre-existing defect (each is directly attributable, with evidence, to the interaction between Priority 0.5's own `run.access` auto-grant and this specific test file's assertion/control-flow — nothing was labelled "pre-existing" without that evidence, per the Project Owner's explicit instruction not to do so).

Separately, commit `71bd961e` (run #207) was **not** a test or application defect at all: it was an authoring/tooling mistake in this session (a `create_or_update_file` MCP call was made with the literal placeholder string `"FILE_CONTENT_PLACEHOLDER"` as file content instead of the real ~500-line file), causing a real TypeScript compile error (`Cannot find name 'FILE_CONTENT_PLACEHOLDER'`) at the Typecheck step. It was self-caught immediately (the tool result reported a 24-byte file size), never merged anywhere, and corrected forward in the very next commit (`4cf81d08`) with no history rewrite, per this task's source-control rules. It is recorded here only for a complete, non-vague account of every CI run in this investigation's window, not because it bears on the four Grow-entitlement failures.

### 17.8 Exact test corrected

`apps/api/src/routes/__tests__/grow.test.ts`, line 129 (inside `"GET /access reports entitlement state honestly and is never itself gated by grow.access"`):

```diff
- assert.deepEqual(beforeBody.entitlements, []);
+ // AE GROW Priority 0.5 -- Workstream 3: every brand-new brokerage now auto-receives
+ // "run.access" at dev-login time (see routes/auth.ts's "every brand-new brokerage
+ // automatically receives run.access at creation time" grant), matching pre-Grow behaviour
+ // where every brokerage could use the RUN surface (Pit Crew, Financial) with no separate
+ // purchase step. run.access is a RUN-surface key, never one of the grow.* keys, so a
+ // brand-new brokerage with zero Grow entitlements now reports entitlements === ["run.access"]
+ // rather than [] -- `entitled` above (which specifically means grow.access) is correctly
+ // still false. This was previously asserted as [] and went stale the moment Workstream 3's
+ // auto-grant shipped; CI's "AE GROW Priority 0.5/1/2 -- CI Stabilisation Gate" investigation
+ // traced the resulting failure back to this exact line.
+ assert.deepEqual(beforeBody.entitlements, ["run.access"]);
```

No other line in the file was changed.

### 17.9 Corrected expectation and justification

`entitlements` now expected to equal `["run.access"]`, not `[]`, for a brand-new brokerage immediately after dev-login. This is justified directly by this report's own §5 ("Non-destructive backfill... New brokerages get the grant inline at creation time in dev-login (`routes/auth.ts`)") and §3 ("`run.access` is the only new entitlement key... additive to, not a replacement for, existing role-based checks"): a zero-Grow-entitlement brokerage correctly still has `entitled: false` (unchanged, still asserted), but its `entitlements` array honestly reflects the one RUN-surface grant it now holds by default. This is not a weakened assertion — it is the same strict `deepEqual` check, updated to the value the application now correctly and intentionally produces.

### 17.10 Priority 0.5 fix SHA

`4cf81d086605f836ba21c9cade877a6874ec1aa2` (branch `feat/ae-grow-priority-0-5-foundation`) — full, verified file content (25,821 bytes), confirmed byte-for-byte via a `get_file_contents` read-back after push. (Superseded an earlier same-session commit, `71bd961e9f844880d09e419578309ddbf94b30a2`, which was pushed with accidental placeholder content — see 17.7 — and is corrected forward by this commit, not amended or rewritten.)

### 17.11 Priority 1 corresponding fix SHA

`1745b82d8c2e6b606482d1c890ef99cc86fccb40` (branch `feat/ae-grow-priority-1-daily-command-centre`) — identical corrected `grow.test.ts` content (same fix, pushed directly with full correct content, no placeholder mistake on this branch), keeping the two branches' shared test file in sync per this task's established convention. This branch's own PR (#29) will run its own full CI at merge time (§8 of the Project Owner's "FINAL CONFIRMATION AND MERGE GATE" decision); this commit is recorded here as evidence the fix is already present on that branch ahead of that run.

### 17.12 GitHub Actions run #208 attempt 1 result

Run `34459859218`, attempt 1. Commit `4cf81d086605f836ba21c9cade877a6874ec1aa2`. **Success**, total duration 16m 2s. Full-suite summary (`API automated test suite` step): `tests 774`, `suites 82`, `pass 773`, `fail 0`, `cancelled 0`, `skipped 1`, `todo 0`. The 1 skip is pre-existing and unrelated to this investigation (present identically in run #205's 774/769/4/1 breakdown, i.e. it is not one of the 4 original failures and is not newly introduced).

### 17.13 GitHub Actions run #208 attempt 2 ("Latest #2") result

Run `34459859218`, attempt 2, triggered via "Re-run all jobs" specifically to obtain the Project Owner's required second, independent confirmation (a single green run is not conclusive if a defect might be order/timing related). Commit unchanged: `4cf81d086605f836ba21c9cade877a6874ec1aa2`. **Success**, total duration 16m 21s. Full-suite summary, extracted directly from the job log: `tests 774`, `suites 82`, `pass 773`, `fail 0`, `cancelled 0`, `skipped 1`, `todo 0`, `duration_ms 893566.46`. Identical outcome to attempt 1 in every count. Two consecutive, independent, fully green full-suite CI runs against the same final commit are now on record.

### 17.14 Total tests / total failures

774 tests total in both confirmation runs (attempt 1 and attempt 2); 0 failures in both. (For contrast: run #205, against the pre-fix commit, was also 774 tests total, with 4 failures — confirming the fix changed only the failure count, not the total test count, i.e. no test was added, removed, or skipped as part of the remediation.)

### 17.15 Confirmation: suite exited normally; no application logic changed; no tests skipped or weakened

- **Suite exited normally** in both confirmation runs: the "API automated test suite" step, and the overall job, both completed with a green check (not cancelled, not timed out) in both attempts, with the CI-hang fix (`--test-timeout=120000`, commits `995bac3a`/`69b13176`/`3494d85`) confirmed still in effect and not triggered (no test needed its safety-rail timeout).
- **No application logic was changed** by this remediation. The only change across the entire investigation (excluding the self-corrected tooling mistake in 17.7, which also touched no application code — it corrupted a test file, not `apps/api/src/**` production source) is the one-line test assertion at `grow.test.ts:129` plus its explanatory comment. `git diff`-equivalent verification: the full corrected file content was read back via `get_file_contents` after each push and confirmed to match the intended content exactly, with the sole functional change being that one assertion line.
- **No tests were skipped or weakened.** The corrected assertion is the same strict `assert.deepEqual` check as before, against an updated (not loosened) expected value; the pre-existing 1 skip is unrelated and unchanged across every run in this investigation (17.4, 17.12, 17.13). No `.skip`, `.only`, `test.todo`, broadened matcher, or removed assertion was introduced anywhere in this investigation.

### 17.16 Final risk assessment

Low. The root cause is fully explained, attributable to one line, and directly tied to an already-documented, intentional Priority 0.5 behaviour change (§3, §5 of this report) rather than to any unexplained infrastructure, concurrency, or resolver defect. The full-suite-only reproduction that initially looked like it might indicate order/timing risk is now explained without residual mystery: it reproduced in the full suite (and not in isolation) simply because the full suite is what runs `grow.test.ts`'s tests in their real order, which is exactly where the control-flow dependency between test 1's throw and test 1's own subsequent `grant()` call lives — there was never a cross-file or cross-suite interaction involved, which the diagnostic work in 17.6 independently corroborates. Two independent, consecutive, full-suite CI runs against the final commit are both fully green with an identical 774/773/0/1 breakdown, satisfying the Project Owner's explicit "do not treat one accidental green run as conclusive" bar. No remaining known risk is being carried forward into the merge.

### 17.17 Merge recommendation

**Proceed with merge.** The remaining three failures reported at the start of this investigation, plus the one stale-assertion failure that caused them, are a single, fully root-caused, minimally remediated defect (one corrected assertion line, permitted under the Project Owner's "minimal remediation only" rule — no skipped tests, no weakened assertions, no broad refactor, no unrelated changes). Required CI is green on two independent, consecutive full-suite runs against PR #28's current HEAD (`4cf81d086605f836ba21c9cade877a6874ec1aa2`). This satisfies the Project Owner's Merge Authorisation Rule §10 "Preferred" path ("the remaining three failures are fixed and required CI passes") without requiring an override.

**Verdict: COMPLETE — PR #28 READY FOR MERGE.**
