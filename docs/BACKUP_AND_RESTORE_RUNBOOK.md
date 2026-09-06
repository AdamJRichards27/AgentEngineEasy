# Backup and Restore Runbook — Controlled Pilot

**Scope.** This runbook records the mechanical backup/restore procedure proven during the
Operational Readiness & Controlled Pilot Gate, states plainly what it does and does not
establish, and gives AE Backend Engineering the steps to run this again against a real pilot
database. It complements, and does not duplicate, `docs/SECURITY_INCIDENT_RUNBOOKS.md`'s own
"Backup and recovery" section (a second, independently-run drill with its own numbers) and
`docs/INCIDENT_RESPONSE_RUNBOOK.md` scenarios 4 and 7 (data loss / restore failure), which this
document is cited from.

## What was actually run, and its results

A non-destructive `pg_dump` / `pg_restore` drill was run this pass against a local, disposable
`aee_test` database (never a real pilot or production dataset) as part of Phase 4 of the
readiness gate. Evidence lives in the gate branch's supporting material and is summarized here:

- **Schema scope:** 89 tables enumerated before the drill.
- **Row-count fidelity:** a full 89-table row-count comparison between the source database and
  the restored database matched exactly on 88 of 89 tables. The one discrepancy —
  `audit_logs`, source 17,523 rows vs. restored 17,519 rows (a 4-row / 0.02% difference) — is
  attributable to `audit_logs` being the one table under continuous background write traffic
  during the drill (every authenticated action logs a row); the most likely explanation is a
  few rows written between the `pg_dump` snapshot and whenever the source-side count was taken,
  not a restore defect. This is the expected signature of comparing a live, continuously-written
  table against a point-in-time snapshot — not the pattern (missing whole tables, halved counts,
  corrupted rows) that would indicate the restore mechanism itself lost data.
- **Referential integrity:** a generic loop over every single-column foreign key in the schema
  found zero orphaned references after restore.
- **Content fidelity:** a single-row, byte-for-byte content comparison between source and
  restored data matched exactly.
- **Restore log:** the `pg_restore` output log was empty, consistent with a clean restore (no
  errors or warnings are written to stdout by pg_restore by default on success).
- **A second, independent drill** is separately recorded in this repository's own
  `docs/SECURITY_INCIDENT_RUNBOOKS.md` ("Backup and recovery" section), with its own numbers:
  89/89 tables, 191/191 indexes, 357/357 constraints, zero FK orphans, matching whole-table
  checksums — a second, corroborating data point that the mechanical dump/restore path works
  against this schema.
- **RTO evidence:** `pg_restore` completed in 0.779 seconds against the test-sized dataset used
  in this drill. **This is not a meaningful RTO estimate for a real pilot-sized dataset** — it
  only proves the mechanism works, not how long a real restore would take under real data
  volume and real infrastructure conditions.
- **RPO:** not established. There is no recurring backup schedule in this repository from which
  an RPO could be derived (see "What this does not establish" below).

Both this drill and the one recorded in `SECURITY_INCIDENT_RUNBOOKS.md` ran against
`aee_test` / local scratch databases — **neither has ever run against a real pilot or
production dataset.**

## What this does not establish (read before relying on this for the pilot)

1. **No automated, recurring backup schedule exists anywhere in this repository or its
   infrastructure configuration.** `.github/workflows/` contains only `ci.yml` (a push/PR test
   and build gate, not a scheduled job). There is no cron, scheduled Action, or equivalent that
   invokes `pg_dump` on any cadence. Until one is configured, "backup" means a human manually
   running the procedure below, on whatever cadence they remember to.
2. **No offsite/durable storage target for dump files.** The drill produced a dump file on the
   same local disk as the database it dumped — a real disaster (disk failure, instance loss)
   would take the dump with it. A pilot-real backup needs the dump copied somewhere durable and
   separate from the source instance before it counts as a real backup.
3. **No encryption at rest for the dump file itself**, which contains the same sensitive data
   the live database does (PII, financial figures, session data).
4. **Generated transaction documents are not covered by any backup drill.** Documents (agency
   agreements, signature packages) are stored on local filesystem disk via
   `LocalObjectStorageProvider` (`packages/integrations/object-storage`), entirely separate from
   Postgres. In this mirror, that directory held 10,866 files totalling 71MB. Neither backup
   drill touches this directory. For a real-estate platform whose core value includes signed
   agency agreements, this is a real gap: today, "backing up the data" means backing up the
   database only — the actual document files exist solely as ordinary files on whatever disk the
   application instance runs on, with no automated backup, versioning, or off-instance copy of
   any kind.
5. **No restore has been rehearsed under time pressure against a realistically pilot-sized
   dataset.** The drill proves the mechanism is sound at test scale; it does not prove how long a
   real restore takes, or how a restore behaves against a schema that has accumulated 60 days of
   real pilot activity plus whatever migrations shipped in between.

**Bottom line:** the mechanical dump/restore procedure is proven correct, twice, independently.
The operational practice around it — a schedule, an offsite copy, encryption, and document-store
coverage — does not exist yet and must be stood up before this is a real backup story for a live
pilot, not just a successful lab exercise.

## The procedure (for AE Backend Engineering to re-run against a real pilot database)

1. **Dump.** `pg_dump -Fc --file=<timestamped-file>.dump "$DATABASE_URL"` — the custom format
   (`-Fc`) is what was used and verified in this drill; it supports selective/parallel restore if
   ever needed.
2. **Store the dump somewhere other than the source instance immediately.** This is not
   optional — a dump left next to the database it came from protects against nothing.
3. **Restore drill (never against a live/active database):** create a fresh, disposable target
   database, then `pg_restore --no-owner --no-privileges --dbname=<disposable-target>
   <dump-file>.dump`.
4. **Verify, every time, not just on the first drill:**
   - Row counts per table, source vs. restored (a full loop over `information_schema.tables`,
     not a spot check).
   - A generic foreign-key-orphan check across every FK in `public` (the same approach used in
     this drill's own `fk_orphan_check.sql`).
   - At least one full-row content comparison for a known record.
   - Record the wall-clock time the restore took, as that pilot's own RTO evidence point.
5. **Never restore over an active environment.** Every restore in this procedure targets a fresh,
   disposable database — this is the same discipline `docs/INCIDENT_RESPONSE_RUNBOOK.md`
   scenario 4 and scenario 7 both require explicitly.
6. **Document object storage separately.** Until a real backup mechanism exists for
   `OBJECT_STORAGE_LOCAL_DIR`, treat this as an open item, not as covered by the database drill
   above.

## Recommendation before this stops being a pilot blocker

Stand up, before pilot participants are admitted: (a) a recurring, scheduled backup job (not a
manual, remembered task); (b) an offsite/durable storage destination for dump files, separate
from the database instance; (c) a decision and, if needed, a mechanism for backing up the
document-storage directory; and (d) one full restore drill run against a copy of the actual
pilot database once real pilot data exists, to get a real RTO figure rather than the test-scale
number recorded here. Until these exist, this readiness gate's blocker register lists the
database side as "backup restoration proven mechanically, but a real backup story does not yet
exist" and the document-storage side as "no backup coverage of any kind."
