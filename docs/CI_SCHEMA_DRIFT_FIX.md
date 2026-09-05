# CI schema-drift fix — Agent Engine 2.0, Step 2 closure (Part D)

## Update (CI Unblocking and Final Merge-Readiness pass)

This pass re-diagnosed the failure directly from a live run rather than
relying on the record above, and the fix below **supersedes** the
"meta/0011_snapshot.json" approach described earlier in this document —
same root cause, same underlying schema content, a cleaner and more fully
tool-verified fix.

### Fresh CI evidence (this pass)

Workflow `CI`, run **#127** (run ID `33976931377`, job ID `101335170875`),
triggered by this PR's own most recent commit,
`ba9d86980bea8379e055a54c3dbe008561bcc51d` (the completion-report-only
commit from the prior pass — no code changed, so this reconfirms the
pre-existing failure, not a new one). Job "Typecheck, test, build,
migration validation" failed in 1m12s at the **Schema drift check** step,
identical symptom to every prior run:

```
[✓] Your SQL migration file ➜ migrations/0009_awesome_shen.sql 🚀
... (diff of meta/_journal.json adding one new idx-9 entry) ...
Error: packages/db/migrations is out of date with packages/db/src/schema.
Run 'pnpm --filter @aee/db run db:generate' locally and commit the result.
Error: Process completed with exit code 1.
```

### Correction to the fix approach described above

The fix section above proposed hand-registering the three already-committed
legacy files (`0009_tired_warbird.sql`, `0010_integration_and_data_exchange_foundation.sql`,
`0011_session_epoch_revocation.sql`) as journal entries 9/10/11, with a
single final snapshot (`meta/0011_snapshot.json`) whose `prevId` was set to
point directly at 0008's snapshot id — skipping past what would normally be
9's and 10's own snapshots. That snapshot was **not** produced by asking
`drizzle-kit generate` to fill journal position 11; it was produced by
running `generate` against a journal still sitting at idx 8 (which
necessarily yields one cumulative migration, exactly like this pass's
finding below) and then hand-relabelling the result as idx 11. That is a
form of manually-assembled migration metadata, not tool-generated output
for the position it claims to represent — this pass's own governing
instruction for this closure step is explicit that generated migration
metadata should not be hand-fabricated, so this document now records the
correction plainly rather than carrying the earlier approach forward
silently. (To be precise about what is proven versus reasoned: this pass
did not find or reproduce an actual downstream failure caused by the
earlier approach — `db:migrate` only reads journal entries plus their
matching `.sql` files, which are correct and already committed, and
`drizzle-kit generate` only reads the *last* journal entry's snapshot to
diff against, which the earlier approach did supply. It likely would have
made both CI checks pass. The correction here is about not relying on
hand-assembled tool metadata when the tool itself can produce the
equivalent output cleanly — not a claim that the earlier version was
broken.)

### This pass's fix — re-derived from a clean, tool-only run

With the local working copy first confirmed to match the branch's actual
committed state (a stray, previously-generated local-only
`meta/0011_snapshot.json` from an earlier session was found and removed —
its presence had been silently masking the real drift, since drizzle-kit
picks up any snapshot file in `meta/` as the diff baseline regardless of
whether the journal references it, and that file made a fresh `generate`
report "No schema changes" incorrectly), `pnpm --filter @aee/db exec
drizzle-kit generate` was re-run. It reproduces exactly what CI's own
generate step does: **one** new, tool-generated, consolidated migration —
`migrations/0009_flimsy_norrin_radd.sql` locally (drizzle-kit names each
generated file randomly; CI's own attempt on this same schema state named
it `0009_awesome_shen.sql` — the SQL content is what matters, and it is
identical either way) — plus a properly tool-produced `meta/0009_snapshot.json`
and an updated `meta/_journal.json` with one new entry.

**Verified this is a pure consolidation, introducing no unintended schema
change:** every one of the new migration's 57 SQL statements was diffed,
as a normalized set, against the concatenation of the three legacy files'
statements. Zero statements differ in either direction — the new single
migration and the three legacy files describe exactly the same schema
delta.

**Verified end-to-end against a real, disposable Postgres 16 database:**
- `pnpm --filter @aee/db run db:migrate` against a brand-new, empty
  database succeeds; `drizzle.__drizzle_migrations` shows all 10 entries
  applied (0000 through the new consolidated 0009).
- Resulting database: 89 tables (matches CI's own schema listing exactly),
  `users.session_epoch` present, all 10 `integration_*` tables present,
  `financial_reconciliations_legacy_commission_unique_idx` present.
- Re-running `db:migrate` a second time is a safe no-op (idempotent, per
  `migrate.ts`'s own documented design).
- Re-running `drizzle-kit generate` afterward reports **"No schema
  changes, nothing to migrate"** — confirming the Schema drift check would
  now pass.

**Recommendation for the three now-superseded legacy files:** since the
new single migration's content is proven identical to their combined
content, and none of the three was ever actually applied to any tracked
database (none appears in any environment's `__drizzle_migrations` table,
because they were never in the journal), this pass recommends removing
them as part of applying this fix, to avoid two competing on-disk
descriptions of the same schema change. This is a recommendation, not a
requirement — leaving them in place as inert, unregistered files is also
safe and does not affect either CI check.

### Why this still cannot be pushed from this session

Both blockers described in the original section above were re-confirmed
live, this pass, rather than assumed to still hold:

1. **Workflow-scope permission** — a fresh, isolated push attempt of the
   drafted `permissions:` hardening to `.github/workflows/ci.yml` (see the
   "CI workflow permission hardening" work in the completion report) was
   made this pass and returned the same class of error, verbatim:
   `403 refusing to allow a GitHub App to create or update workflow
   '.github/workflows/ci.yml' without 'workflows' permission`. Unchanged
   from the prior pass; this session's GitHub App installation still lacks
   the `workflow` scope.
2. **Large-file transmission** — the new `meta/0009_snapshot.json` is
   421,545 bytes, the same order of magnitude as the file that failed to
   transmit intact in the prior pass. This pass did not re-attempt pushing
   it through the GitHub API tooling at all — the governing instruction for
   this pass explicitly directs against attempting to transmit generated
   migration snapshots through that mechanism, given the already-demonstrated
   corruption risk. Instead, the fix is delivered as an exact file bundle
   (see the completion report's maintainer-patch section) for a human with
   real `git push` access to apply directly — no API transmission involved,
   no size risk.

### Exact files delivered this pass (maintainer patch bundle)

- `migrations/0009_flimsy_norrin_radd.sql` — 15,974 bytes,
  git-blob-sha1 `86e3784c78d8aab3e2ffbc24671a249c92993895`
- `migrations/meta/0009_snapshot.json` — 421,545 bytes,
  git-blob-sha1 `f33bf6b3db2bf222d977ec87973297ae5a33bb33`
- `migrations/meta/_journal.json` (replacement) — 1,517 bytes,
  git-blob-sha1 `098f146fb8f2f85ce5ea02ef0446730308ddefcc`

See the completion report and the delivered `pr25_maintainer_patch.zip` for
exact apply instructions and validation commands.

---

## Why this document exists

Part D of this closure pass ("stand up CI") required observing an actual
CI run for this PR before claiming anything about it — never inferring
success. The first attempt to do that (via the GitHub API, then via a
direct browser check of the Actions tab) found something that needed a
real fix, not just a permissions workaround. This document records what
was found, why it happened, and exactly what was changed and how it was
verified, so the fix is auditable independently of the PR description.

## What was observed

`.github/workflows/ci.yml` predates this closure pass — it was not created
by it. Every one of its 115 recorded runs against this PR failed, every
time, in roughly 1–2 minutes, at the same step: **"Schema drift check"**,
with the error:

```
packages/db/migrations is out of date with packages/db/src/schema. Run
'pnpm --filter @aee/db run db:generate' locally and commit the result.
```

This was confirmed visually (browser, GitHub's own Actions UI showing a
red ✗ on every run of the `CI` workflow, run #1 through #115) after the
GitHub API route this pass first tried
(`pull_request_read` with `get_check_runs` / `get_status`) returned `403
Resource not accessible by integration` — the calling GitHub App has
`actions: read` but not `checks: read` / `statuses: read`. The browser
check was the only way to actually see the result, and it showed a
**real, consistent failure**, not a permissions dead-end — so this is
recorded as a genuine CI defect found and fixed, not a permissions
blocker.

## Root cause

`packages/db/migrations/` contains three SQL files —
`0009_tired_warbird.sql`, `0010_integration_and_data_exchange_foundation.sql`,
and `0011_session_epoch_revocation.sql` — that were already present,
already correct, and already reflected in every developer/test database
this whole engagement has used. But `packages/db/migrations/meta/_journal.json`
(drizzle-kit's own change-tracking ledger) only ever listed entries up to
idx 8 (`0008_striped_reaper`), and no `meta/0009_snapshot.json` /
`0010_snapshot.json` / `0011_snapshot.json` files existed. In other words:
these three migrations were added to the repository without ever being
registered through `drizzle-kit generate` — most likely hand-authored or
copied in directly.

This had two consequences, one merely noisy and one much more serious:

1. **`drizzle-kit generate` (the "Schema drift check" step)** diffs the
   current `packages/db/src/schema` against the *last* snapshot it knows
   about. With its last known snapshot stuck at idx 8, it recomputed the
   entire 0009–0011 delta as though it were still pending, and tried to
   write it out again as a brand-new migration on every run — which is
   what failed the `git diff --exit-code` check.
2. **`pnpm --filter @aee/db run db:migrate`** (the "Deterministic
   clean-database migration check" step, which runs *before* the drift
   check) applies migrations strictly in the order `meta/_journal.json`
   lists, tracked via drizzle's own `__drizzle_migrations` table. Because
   the journal never listed `0009_tired_warbird` / `0010_...` /
   `0011_...`, this step was **silently never applying them** to CI's
   ephemeral database — it "succeeded" while leaving that database missing
   every Step 5 integration table and the `users.session_epoch` column.
   Because the drift-check step immediately after it always failed, no CI
   run ever reached the "API automated test suite" step to find this out
   the hard way.

This defect predates this closure pass. It was not introduced by any Part
A/B/C change in this pass, and none of this pass's own extensive local
test runs (662 tests, run against a long-lived local `aee_test` database
that was originally provisioned via `drizzle-kit push`, not
`db:migrate`) were capable of surfacing it — `db:push` applies
`schema.ts` directly and never consults the migrations journal at all.
Only a genuinely fresh, from-scratch database — exactly what CI's ephemeral
Postgres service is — exposes it.

## The fix (original diagnosis pass — see the correction and re-derivation in the update section above)

No migration SQL content was changed. `packages/db/migrations/meta/_journal.json`
had three entries appended (idx 9/10/11, tags `0009_tired_warbird`,
`0010_integration_and_data_exchange_foundation`,
`0011_session_epoch_revocation`), and a new `meta/0011_snapshot.json` was
added, generated by `drizzle-kit generate` itself against the current
`packages/db/src/schema` (which already includes everything those three
files add) — so it is an accurate, tool-produced snapshot, not a
hand-written one. No `0009_snapshot.json` / `0010_snapshot.json` files were
created: drizzle-kit only reads the *last* journal entry's snapshot to
diff against, confirmed empirically (see verification below), so
intermediate snapshots are not required for `generate` to work correctly
going forward.

## Verification performed (locally — see "Why this fix is not yet on the branch" below for why it isn't pushed)

1. `pnpm --filter @aee/db exec drizzle-kit generate` against the
   existing long-lived local test database, after the journal/snapshot
   fix: **"No schema changes, nothing to migrate"** (previously produced a
   full duplicate-table migration).
2. A brand-new, genuinely empty database (`aee_ci_verify`) was created
   from scratch. `pnpm --filter @aee/db run db:migrate` was run against it
   with no other setup — the same command and the same kind of ephemeral
   database CI's Postgres service provides:
   - 89 tables created (matches the table count already reported
     elsewhere in this PR's backup/restore drill).
   - `users.session_epoch` present.
   - All 10 `integration_*` tables present.
   - `drizzle-kit generate` against that freshly-migrated database also
     reported **"No schema changes, nothing to migrate"**.
3. The full integrations test suite plus the middleware test suite (56
   tests: `lib/integrations/__tests__/*`,
   `routes/__tests__/integrationsWebhooks.test.ts`,
   `middlewares/__tests__/*`) was run directly against that same
   freshly-migrated database as a spot check that nothing about a
   from-scratch database (as opposed to the long-lived local one) changes
   application behavior. 56/56 passed.

## Why this fix was not pushed in the prior pass (still unresolved — see the update section above for this pass's fresh re-confirmation)

This closure pass tried to push the fix and hit two independent, confirmed
blockers — so it is documented here, fully verified, rather than landed
and claimed:

1. **`.github/workflows/ci.yml` cannot be modified by this integration.**
   A direct attempt via `push_files` to update it (to add the
   `permissions:` block and the two reconciled steps described in that
   file's own header comment, which this pass drafted) returned
   `403 Resource not accessible by integration`. An isolated test — the
   same push mechanism, same branch, a different, non-workflow path —
   succeeded immediately, isolating the cause to GitHub's own
   `workflow` OAuth/App permission scope specifically, which this
   integration does not hold. This is a distinct permission from the
   `checks`/`statuses` read-scope gap this pass found earlier (see the
   "What was observed" section above) — that one blocked *reading* CI
   results via the API (worked around via a direct browser check); this
   one blocks *writing* to `.github/workflows/**` by any means available
   in this session, with no workaround available. Note that this gap does
   **not** block the actual root-cause fix below, since that fix touches
   only `packages/db/migrations/meta/`, not the workflow file.
2. **The accompanying `meta/0011_snapshot.json` (421,545 bytes) could not
   be transmitted intact.** A first attempt (a dedicated subagent, four
   tries) produced corrupted or fabricated JSON rather than the real
   content and was caught before being left on the branch (see below).
   This was then independently reproduced and confirmed directly: asked to
   reproduce a *much smaller* 53KB / 2,000-line slice of the same file
   verbatim into a new file, only 468 of the 2,000 lines (23%) were
   actually reproduced before the output truncated itself early —
   confirmed by a direct `diff` against the source. This is a genuine
   limitation of reproducing large exact-byte content through this
   session's tool-call interface, not a one-off mistake by a careless
   attempt or a fixable process error — no chunking strategy avoids it,
   because every method available here (`push_files`,
   `create_or_update_file`) requires the complete final file content to be
   supplied in a single call, and a valid drizzle-kit snapshot for an
   89-table schema cannot be made meaningfully smaller than this one already
   is (snapshots are full-state, not diffs).

**What was actually pushed, and what was safely reverted:** the first
attempt above landed a corrupted placeholder `0011_snapshot.json` and a
`meta/_journal.json` that referenced it. Both were caught immediately
after being pushed (before any CI run reflected them) and reverted in two
follow-up commits: the placeholder file was deleted, and `_journal.json`
was restored to its exact prior 9-entry (idx 0–8) content — the same
state this fix started from. The branch is left exactly as it would be
if this fix had never been attempted; `docs/CI_SCHEMA_DRIFT_FIX.md` (this
file) is the only trace, by design, so the next person (human or agent)
with real `git push` access has the diagnosis, the verified fix, and the
exact reason it couldn't be applied through this session's tools —
without also having to untangle a half-applied state first.

**To actually apply this fix:** see the update section at the top of this
document for the current, re-derived, fully tool-verified fix and its
exact delivered files — supersedes the plan described in this
paragraph in the original pass. A repo maintainer with
`.github/workflows/**` write access should also still apply the
`permissions:` block this pass (re-)drafted and delivered (see the
completion report's maintainer-patch section); the previously-proposed
"two reconciled steps" (a non-blocking dependency audit step and a
secret-pattern-scan step) were an idea from the original pass, not part of
either pass's actual permissions-hardening deliverable, and remain an
optional future enhancement, not something either pass implemented.

## What this fix did not do

- It did not touch any of the three existing migration SQL files' content
  (though this pass recommends removing them once superseded — see the
  update section above), and it did not change the actual database schema
  in any environment.
- It did not attempt to reconstruct historical snapshot files for idx 9
  or idx 10 in the original pass's approach; this pass's re-derived fix
  instead lets `drizzle-kit generate` produce the correct single
  consolidated migration and its own snapshot directly, with no manual
  snapshot construction at all.
- It did not investigate whether staging's actual database (built via
  `drizzle-kit push`, per `packages/db/src/migrate.ts`'s own module
  comment) is missing anything — that script is explicitly documented as
  not run against staging by this remediation effort, and this fix does
  not change that.
