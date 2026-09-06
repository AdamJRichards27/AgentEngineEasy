# Technical Closure and Gate Reconciliation

`docs/gate-evidence/TECHNICAL_CLOSURE_AND_GATE_RECONCILIATION.md`

**Owner instruction this document implements:** "AE Operational Readiness — Technical Closure
and Gate Reconciliation." That instruction rejected the prior renewed decision's framing —
`docs/gate-evidence/PHASE12_COMPLETION_REPORT_AND_RENEWED_GATE_DECISION.md`'s own words, *"what
remains open is not an engineering defect... a single external decision"* — as incomplete, and
named six specific technical matters to reconcile before any framing of "legal is the only
outstanding gate" is allowed to stand: (1) an updated `pnpm-lock.yaml` not on GitHub; (2) two
`drizzle-kit` snapshot files not on GitHub; (3) automated backup/offsite document recovery; (4)
external monitoring/alert delivery; (5) webhook signature verification; (6) admin
succession/role-change. Per the governing instruction: continue on
`feat/operational-readiness-pilot-gate`, PR #27, no replacement branch/PR, no merge, no deploy, no
participant invitation, stop after the corrected decision. Nothing in this document supersedes
Phase 12 or the original report as history; both remain intact below this one as the record of
what they actually said and why this document reconciles rather than repeats them.

---

## CORRECTED FINAL DECISION

# REMEDIATION REQUIRED

**This does not replace B2's separate, independent blocker.** Two things are true at once, and
neither substitutes for the other:

1. **Formal legal review and approval of the 13-document pilot legal/privacy pack (B2) remains
   completely outstanding**, exactly as Phase 12 found. Nothing in this pass touches that; it
   still requires the AE Project Owner and/or external legal counsel, and this engineering
   process still has no authority to grant it. If B2 were the only open item, "BLOCKED — HUMAN OR
   EXTERNAL DECISION REQUIRED" would be the correct and complete category, as Phase 12 issued it.
2. **It is not the only open item.** Automated backup/offsite recovery (B5) and external
   monitoring/alerting (B9) are confirmed, this pass, still completely absent — not partially
   built, not configured-but-undeployed, not a policy decision waiting on a signature: there is no
   code, script, workflow, or config for either, anywhere in this repository. Both are
   engineering/ops work items squarely within this process's own remediation authority, explicitly
   *not* the kind of thing "only a human or external party can do" that B2 is. Phase 12's own
   blocker register (§5) already rated both correctly as unclosed ("Unchanged... out of this
   pass's named scope") — but its top-line renewed-decision narrative did not carry that forward,
   and led with language that reads as though nothing but B2 stood between this build and a pilot.
   That is the specific framing the governing instruction for this pass rejected, and the reason
   this report does not reissue "BLOCKED — HUMAN OR EXTERNAL DECISION REQUIRED" unchanged.

**Net effect on sequencing: both tracks must clear, and neither depends on the other.** Legal
approval of B2 does not stand up a backup schedule or an alerting pipeline. Building B5/B9 does
not substitute for legal review. A pilot should not start until both are done. This report's
category — **REMEDIATION REQUIRED** — names the fact that real, scoped, engineering-owned work
remains and is not yet even started, which "BLOCKED — HUMAN OR EXTERNAL DECISION REQUIRED" does
not communicate on its own.

---

## 1. What changed this pass, precisely

| Item | Phase 12 state | This pass | Evidence |
|---|---|---|---|
| `pnpm-lock.yaml` | On local mirror only; "accepted... a future session with direct git push access should push [it] verbatim" | **Pushed and verified.** | Commit `f680dc9d897855c9c1b75cb9fa3bd112aa6e44f8`, blob `9059283294532c3f31d0b44e9ccb387248b5290c`. Re-verified this pass by re-fetching the file from the branch via `get_file_contents` (fresh read, not trusted from memory) and confirming its reported SHA matches `git hash-object` on the local file exactly. |
| `packages/db/migrations/meta/0010_snapshot.json`, `0011_snapshot.json` | Same "accepted" status | **Still not pushed. Root cause now precisely identified (§2), not merely suspected.** | `get_file_contents` against the branch for both paths returns "does not exist in the repository" (re-confirmed this pass, not assumed from Phase 12). |
| CI status of PR #27's head commit | Not checked in either prior report — both relied exclusively on locally-run test suites (§13 of the original report, §3 of Phase 12) | **Checked directly this pass; confirmed inaccessible, not confirmed green.** | See §3. |
| B5 / B6 / B8 / B9 | Carried in the blocker register, unchanged | **Independently re-verified from the current source tree this pass (not re-stated from the prior report), confirmed unchanged.** | See §4. |
| Migration-chain integrity | Not examined at this level of detail in either prior report | **New finding: three orphaned, unreferenced `.sql` files exist in `packages/db/migrations/`; confirmed non-blocking, but a real repository-hygiene issue worth closing.** | See §5. |

---

## 2. Why the two snapshot files still cannot be pushed, and why that's a genuine environment
   constraint rather than an unmade effort

Both files were fully reconstructed on the local mirror this pass and verified byte-for-byte
against the canonical source before any push was attempted: `sha256`, `git hash-object` (matching
the real files' own blob SHAs, `3308a159f23354def698ad2062f158e7cff8a9b3` and
`f7887bf7dd3eecaa0cb6f1f782dc208caae7e155` respectively), and `python3 -m json.tool` validation
all passed. The content is correct and ready.

**The blocker is transport, not correctness.** This session's only sanctioned write path to
GitHub — `mcp__GitHub_MCP__create_or_update_file` / `push_files` — requires each file's complete
literal content typed inline in a single tool call; there is no local-file-reference, URL, or
base64-from-elsewhere parameter (confirmed by re-reading both tools' current schemas this pass).
GitHub's underlying Contents API has no partial-write mode either way — every write replaces a
file's full content atomically, so no amount of splitting into multiple commits reduces the
content size the *final* call must contain. This pass has direct, first-party evidence — not
inference — that generating content at this scale (0010: 427,126 bytes; 0011: 431,119 bytes) in a
single turn exceeds this environment's per-turn output ceiling: reconstructing 0010 locally via
the `Write` tool at full size hit an explicit "Output token limit hit" condition and had to be
split into four ~130,000-byte parts across separate turns before it would complete. By contrast, a
lower-risk file, `pnpm-lock.yaml` (95,569 bytes), pushed correctly in one call, giving a real
proof point of what does fit. Because the same generation limit — not a `Write`-tool-specific
quirk — governs any single turn's output regardless of which tool consumes it, a single
`create_or_update_file` call for either snapshot file (4-4.5x larger than the proven-safe size)
carries the same failure mode. Direct git or REST push using this session's own injected
credential was not used as a workaround: an earlier read-only probe this pass confirmed the
platform itself gates this repository's write/content endpoints per-session (`403 GitHub access
to this repository is not enabled for this session`), independent of the token's validity — using
that credential directly would route around a boundary the platform put there deliberately, not
around a mere inconvenience.

**Why this remains non-blocking for runtime safety, independently re-verified this pass (not
re-stated from Phase 12):** `packages/db/src/migrate.ts:51` calls Drizzle's `migrate(db, {
migrationsFolder })`, which — confirmed by direct reading of the migration runner and the
journal — applies migrations strictly from `meta/_journal.json`'s ordered `tag` list, executing
each tag's own `.sql` file. It never opens `meta/*_snapshot.json` at runtime; those files are
`drizzle-kit`'s own internal state for diffing when a developer next runs `drizzle-kit generate` to
author a *new* migration. Both `.sql` files these two snapshots pair with (`0010_invitation_auth.sql`,
`0011_privacy_controls.sql`) are already pushed and journal-tracked. **Recommendation, unchanged
from Phase 12 and still not self-authorized here:** the next session with direct git push access
should push both files verbatim from the local mirror in one trivial `git push`, at which point
this item closes completely with no further action.

---

## 3. CI status — confirmed inaccessible, not confirmed green

Checked directly this pass against PR #27's actual current head commit
(`f680dc9d897855c9c1b75cb9fa3bd112aa6e44f8`, confirmed via a fresh `pull_request_read` immediately
before this check, not assumed from an earlier record):

- `pull_request_read` (`get_status`): `403 Resource not accessible by integration`
- `pull_request_read` (`get_check_runs`): `403 Resource not accessible by integration`

This is a distinct failure mode from the repo-content 403 in §2 — that one is a session-level
access gate ("not enabled for this session"); this one is a GitHub App/token permission-scope gap
specific to the Checks/Statuses API. Net effect is the same for evidentiary purposes: **this
session cannot read GitHub-hosted CI results for this PR at all, in either direction.** This
matters because it means every "CI evidence" claim in this repository's own gate history — §13 of
the original report, §3 of Phase 12 (typecheck, full test suite, migrations) — is evidence of
tests run **locally, by the agent, against a disposable Postgres instance**, not of a GitHub
Actions workflow run having executed and passed on the pushed commits. A `.github/workflows/ci.yml`
exists in this repository, but whether it has ever run, and with what result, on this branch or
PR is not verifiable through any tool available this pass. Per the governing instruction's own
rule — do not present downstream closure claims while required CI status is unresolved — this
report treats CI-hosted verification as an **open, unresolved item**, not as "presumed passing
because local tests passed." This is a new, previously-unstated distinction; neither prior report
claimed GitHub CI had run, but neither made explicit that it hadn't been checked, either.

---

## 4. B5 / B6 / B8 / B9 — independently re-verified against the current source tree

Re-investigated this pass directly from source (not re-stated from either prior report), to
confirm none of these have silently drifted, regressed, or been quietly closed without the gate
record being updated:

- **B5 — backup/offsite recovery: still completely absent.** No `pg_dump`, cron, CI workflow, or
  infra config performs any backup anywhere in the repository. Document storage
  (`packages/integrations/object-storage/src/index.ts`) is local-disk-only; no S3/GCS/offsite
  adapter exists. `docs/BACKUP_AND_RESTORE_RUNBOOK.md` documents a manually-run drill proving the
  mechanism works, which is not the same as a schedule or an offsite target. Unchanged from B5's
  original rating.
- **B9 — external monitoring/alerting: still completely absent.** No Sentry/Datadog/PagerDuty/
  uptime-check SDK, import, or credential exists anywhere (`.env.example` reviewed in full).
  Internal Prometheus-style gauges exist (`apps/api/src/lib/observability/queueGauges.ts`) but are
  pull-based and unscraped by anything external; unhandled errors reach only the structured logger
  (`apps/api/src/middlewares/errorHandler.ts`). Nothing pages a human. Unchanged from B9's original
  rating.
- **B6 — webhook signature verification: unchanged, correctly characterized as "risk materially
  reduced, not eliminated."** The verification code itself is real and correct where it exists
  (HMAC + `timingSafeEqual`, e.g. `apps/api/src/lib/integrations/webhooks.ts:22-44`), and route
  handlers do call it and do reject bad signatures. But every provider that actually ships as the
  live implementation is a `Mock`/`Sandbox` adapter whose `verifyWebhookSignature()`
  unconditionally returns `true`, and the `LIVE_EXTERNAL_TRANSACTIONS_APPROVED` fail-closed flag
  (Phase 10) means no real provider — and so no real webhook traffic with financial consequence —
  is reachable without a second, explicit, separately-approved flag. This bounds the residual risk
  to a deliberate two-flag decision rather than a silent gap, exactly as Phase 12 stated; it does
  not close the underlying gap.
- **B8 — role change / admin succession: unchanged, "partially closed."** `apps/api/src/routes/
  auth.ts` has no endpoint to change an existing user's role; only invite-time role assignment and
  disable/enable exist. Self-disable is blocked, but nothing prevents a brokerage from ending up
  with zero active admins, and `bootstrapAdmin.ts` explicitly refuses to run once any user exists
  for a brokerage, so it cannot serve as a recovery path. This is explicitly documented as an open
  gap in `docs/OPERATIONAL_READINESS_GATE_REPORT.md:217-222` and
  `PHASE12_COMPLETION_REPORT_AND_RENEWED_GATE_DECISION.md:181` — this pass found nothing that
  contradicts either.

None of these four are newly discovered; all four were already named, correctly, in the existing
blocker register. What this pass adds is independent re-confirmation from source (rather than
trusting the prior report's own account) and, per §0 above, surfacing B5/B9 specifically as
engineering-owned remediation items in the headline decision rather than allowing them to be read
as resolved-by-implication once B2 clears.

---

## 5. New finding: three orphaned migration files, confirmed non-blocking

While tracing whether the missing snapshot files could indicate a deeper migration-chain problem
(the concern that motivated re-checking this area at all), this pass found that
`packages/db/migrations/` contains three `.sql` files **not referenced anywhere in
`meta/_journal.json`**: `0009_tired_warbird.sql`, `0010_integration_and_data_exchange_foundation.sql`,
and `0011_session_epoch_revocation.sql`. Their existence alongside journal-tracked files sharing
the same numeric prefix (`0009_flimsy_norrin_radd.sql`, `0010_invitation_auth.sql`,
`0011_privacy_controls.sql`) could plausibly indicate either dead draft artifacts or a real gap
where the running schema is missing tables/columns the application code expects.

**Checked directly, not assumed:** every table and column the three orphaned files would create —
including `integration_outbox` and `session_epoch`, both depended on by live application code
(`apps/api/src/lib/integrations/outbox.ts`, session-revocation logic) — is already created by the
journal-tracked `0009_flimsy_norrin_radd.sql`. The orphaned files are superseded drafts, not a
missing dependency: running `migrate()` against a fresh database via the actual journal (as Phase
12 did, and as this pass confirmed by reading the runner directly) produces a schema the
application code is already satisfied by. **This is not a runtime or security gap.** It is a
repository-hygiene item — leftover files from an earlier draft/consolidation of migration
authoring — worth deleting in a future bounded pass so a later `drizzle-kit generate` run, or a
future developer reading this folder, is not misled by the numbering collision the way this
pass's own initial investigation was. Not remediated in this pass, since deleting migration
history files is exactly the kind of change this process should not make unilaterally without the
Owner's sign-off, given migration folders are treated as append-only historical record in most
Drizzle workflows.

---

## 6. What this report does not do

Consistent with every prior report in this gate's history and the governing instruction's own
closing constraints: this report does not merge PR #27, does not deploy anything, does not invite
any pilot participant, and does not grant legal approval on anyone's behalf. It also does not
attempt to build B5/B9 (standing up a real backup schedule or a real alerting pipeline is
"REMEDIATION REQUIRED" work for a dedicated pass with its own scope and testing, not a
same-pass addition to a reconciliation report), and does not delete the orphaned migration files
identified in §5 without separate authorization.

---

## 7. Stop

Per the governing instruction: continue on this branch, no replacement branch or PR, no merge, no
deploy, no participant invitation, stop after the corrected decision. This is that stop.
