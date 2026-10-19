# Backup and Restore Runbook — REMEDIATION REQUIRED

## Status, scope, and proven drill

This is a provider-neutral operational runbook for the backup scripts in
`apps/api/src/ops/backup`. It applies only to the controlled pilot: invited participants,
synthetic/test transaction data, no public signup, and no live customer-money traffic. It
does not authorise a pilot or any live-traffic use.

On **2026-09-07 AEST**, a controlled local recovery drill completed using real
`pg_dump`, `pg_restore`, `tar`, and authenticated AES-GCM encryption/decryption commands.
The disposable restore validated **93 tables**, **1 tenant**, and **one representative
document byte match**. This is evidence that the local mechanical path can work. It is
explicitly **not** evidence of offsite storage, a scheduled backup, production recovery,
or external-alert delivery/acknowledgement.

**REMEDIATION REQUIRED:** do not represent this drill as a production backup or disaster
recovery capability until the external scheduler, owner-controlled durable destination,
key management, retention operation, restore preflight, and external alert evidence below
are established and recorded.

## Production architecture and what the backup covers

The platform stores state in two places, and **a database dump alone does not protect both**:

| State | Where it lives in production | Covered by `backup:run`? |
| --- | --- | --- |
| PostgreSQL (all tenants) | Pilot database (`DATABASE_URL`) | Yes: custom-format `pg_dump` plus a row/tenant/document-key inventory. |
| Document bytes (generated and signed PDFs, other stored objects) | **Private S3-compatible object storage** (`OBJECT_STORAGE_PROVIDER=s3`; ADR 0001 prohibits local document disk in production). The database holds only key, SHA-256 and version metadata. | **Only with `BACKUP_DOCUMENT_SOURCE=object-storage`** (PR #226, see below). The original script archived only the local `BACKUP_DOCUMENT_DIRECTORY`, so against a real S3 deployment it could not back documents up, and would stop with `Document integrity failed before backup` because every database document key was "missing" locally. |
| Secrets and configuration (`SESSION_SECRET`, `DOCUMENT_STORAGE_SIGNING_SECRET`, `METRICS_TOKEN`, alert token, storage and KMS credentials, Replit deployment settings) | Replit deployment Secrets / owner systems | **No, by design.** The owner must hold a separate, access-controlled recovery inventory (names, owner, where stored). Never place values in this repository. |
| Storage-provider configuration (bucket policy, versioning, Object Lock, lifecycle, KMS key and key policy) | Provider account | **No.** Record it as infrastructure documentation; losing a KMS key loses everything encrypted with it. |
| Any other state held by the hosting platform | Unverified | Unknown. Do not assume it exists or is protected. |

Consistency: the database dump and the document read happen in the same run, but not in one
transaction. Documents written between the two steps can cause a reported mismatch; re-run rather
than ignore it.

### PH-7 changes (unmerged; verify merge status before relying on them)

These describe behaviour that exists **only after the named change is merged**. Until then the
previous behaviour in the rest of this document applies. **Draft status (2026-10-17):** #224–#228
are draft/on hold. #228 is Package A (tiered retention and the listing safeguards, stacked on #224);
the "Package B" items (separate verifier/restore download commands and command-level environment
isolation) exist only in a local, unpublished integration branch and have no PR yet. This section
describes the intended integrated behaviour (Packages A + B + C + D) and is not evidence that any of
it has run against a real provider.

- **#224 prune safeguard.** Pruning keeps the newest `BACKUP_MIN_RETAINED_COUNT` (default 7,
  optional) *recoverable* backups (artifact **and** manifest present) and the artifact created by
  the current run, regardless of age or `BACKUP_RETENTION_DAYS`; it deletes nothing when no
  recoverable backup exists. An artifact and its manifest are **one recoverability unit** (D-3, local
  R12 change): units are deleted one at a time, artifact first, and the manifest is deleted **only
  after its artifact delete was confirmed successful in the same run**. Any artifact delete that is
  refused (Object Lock/retention), times out or has an unknown outcome leaves the manifest in place,
  is logged as `prune_delete_failed` (level `error`), **stops pruning for the run** (`prune_stopped`),
  and raises one `prune_delete_refused` alert; the backup that was just stored and verified is still
  reported as successful. Before the first delete the run uploads a durable intent record
  `deletion-records/<runId>.intent.json` (every planned unit); if that upload fails nothing is deleted
  and the run fails with `prune_failed`. After the last delete it uploads
  `deletion-records/<runId>.outcome.json` with a per-unit status (`deleted`,
  `artifact_delete_failed_manifest_preserved`, `manifest_delete_failed_artifact_deleted`,
  `not_attempted_pruning_stopped`). The records contain object keys only and live outside the tier
  folders; they are never pruned by this code. Retrying is idempotent: refused units remain whole and
  are planned again next run. Operators must alert on `prune_delete_failed` and `prune_stopped`.
  Not yet evidenced against a real provider or Object Lock.
- **#225 post-upload verification.** After upload the run downloads the artifact and manifest,
  requires the stored manifest to equal the one written for the run, and re-checks SHA-256 and byte
  length. **Every tier copy written by the run** (daily, weekly, monthly) is verified, and all
  verification happens **before the first list or delete command** can run. A mismatch or unreadable
  object fails the run (error log plus `BACKUP_ALERT_COMMAND`) and skips pruning. Completion logs
  then include `verified: true`.
- **#226 object-storage documents.** Set `BACKUP_DOCUMENT_SOURCE=object-storage` (requires
  `OBJECT_STORAGE_PROVIDER=s3`; `BACKUP_DOCUMENT_DIRECTORY` is then not used). The run reads every
  `documents.object_storage_key` through the application's existing object-storage provider
  (`OBJECT_STORAGE_*`, size and SHA-256 verified on read) into the same `documents.tar` layout, so
  restore is unchanged. Give the backup job a **read-only** storage identity (GetObject/HeadObject).
  Missing, unreadable, corrupt or unsafe (path-escaping) keys fail the run with counts before
  anything is uploaded or pruned. Object-storage documents work with tiered layout and `--tier`
  restore unchanged. Orphan objects (present in storage but not in the database) cannot be
  detected because the provider has no list operation. The storage-read credentials
  (`OBJECT_STORAGE_*`) are read **in the backup process itself** through the application's
  provider, not by a child command, so command-level environment isolation (below) does not scope
  them: run the backup job under a dedicated read-only storage identity.
- **Package B identity separation (local, not yet a PR).** Three optional/opt-in controls; see
  "Identity separation" below.

### Known gaps that remain (unchanged by Phase A)

- No scheduler, offsite/immutable destination, key management, restore-verification schedule or
  named owners exist yet (see below). The database recovery point is the last successful daily run
  (up to 24 hours of data loss), and document recovery depends on the storage provider's own
  versioning/replication, which this repository does not configure or verify.
- Environment isolation is **off by default**; until an operator enables it, every command adapter
  inherits the full process environment (the original behaviour).
- Restoring documents writes them to the **disposable restore directory only**. Returning bytes to
  a bucket is a separate, owner-approved manual step: upload with the original keys, then confirm
  each object's SHA-256 against `document_object_versions` before pointing any service at it.
- The 2026-09-07 drill used a local document directory; it did not exercise object storage.

## Script contract and required configuration

Run the existing scripts, not ad-hoc replacement commands:

```sh
pnpm --filter @aee/api backup:run
pnpm --filter @aee/api backup:restore -- --artifact=<artifact-name> --confirm-disposable
pnpm --filter @aee/api backup:restore -- --artifact=<artifact-name> --tier=daily|weekly|monthly --confirm-disposable
```

Backups written after tiering are restored with `--tier=` naming the folder they were written to
(the manifest is stored inside the same folder). Omit `--tier` only for legacy flat backups written
before tiering; behaviour without `--tier` is unchanged. If a tier restore cannot download the
artifact, the error names the tier and reminds you to check `--tier`.

Both scripts require `BACKUP_ENVIRONMENT=production`; this is a deliberate explicit
production-operation guard, not permission to restore into production. Configure the
following through the deployment's owner-controlled secret/configuration system:

- `DATABASE_URL` and a private `BACKUP_STAGING_DIRECTORY`. Document source: either
  `BACKUP_DOCUMENT_DIRECTORY` (local directory; development/test only, prohibited for production
  documents) with a staging directory that does not contain it, or, once #226 is merged,
  `BACKUP_DOCUMENT_SOURCE=object-storage` with the `OBJECT_STORAGE_*` variables the API itself uses.
- `BACKUP_DESTINATION` as a durable `s3://`, `gs://`, or `azblob://` object-store URI;
  credentials and bucket/container policy belong to the object-store owner and are never
  placed in this runbook.
- Positive-integer `BACKUP_RETENTION_DAYS` (and, once #224 is merged, optional `BACKUP_MIN_RETAINED_COUNT`, default 7, which always wins over the age cutoff).
- `BACKUP_ENCRYPTION_AUTHENTICATED=true` and a non-secret
  `BACKUP_ENCRYPTION_KMS_PROFILE=kms:<profile>`. The owner controls the KMS key/profile,
  encryption command implementation, access policy, rotation, and recovery access.
- Optional identity-separation settings (see "Identity separation"):
  `BACKUP_VERIFY_DOWNLOAD_COMMAND`, `BACKUP_RESTORE_DOWNLOAD_COMMAND`, `BACKUP_ENV_ISOLATION` and
  the `BACKUP_ENV_*` allowlists.
- JSON-array command adapters: `BACKUP_ENCRYPT_COMMAND` and
  `BACKUP_DECRYPT_COMMAND` (must accept `{input}`, `{output}`, `{kmsProfile}`),
  `BACKUP_UPLOAD_COMMAND`/`BACKUP_DOWNLOAD_COMMAND` (must accept `{source}` and
  `{destination}`), `BACKUP_LIST_COMMAND` (`{destination}`), and
  `BACKUP_DELETE_COMMAND` (`{object}`). These adapters make object storage and KMS
  provider-neutral; they must use authenticated AES-GCM encryption in the configured
  deployment.
- Restore isolation: `BACKUP_RESTORE_DISPOSABLE=true`,
  `BACKUP_RESTORE_ENVIRONMENT_ID=restore-...`,
  `BACKUP_RESTORE_DATABASE_URL`, `BACKUP_RESTORE_ROOT`, and
  `BACKUP_RESTORE_DOCUMENT_DIRECTORY` beneath that restore root.
- `BACKUP_ALERT_COMMAND`, which must accept `{operation}` and `{error}`. The scheduler
  owner supplies this adapter and records whether it reaches an external receiver.

The scripts create a custom-format PostgreSQL dump, inventory database rows/tenant/document
keys, archive documents with `tar`, package the payload, encrypt it, generate a SHA-256
manifest, upload artifact plus manifest to each applicable tier folder, (once #225 is merged)
re-download and verify every tier copy, and only then prune retained artifacts per tier. They do not embed
cloud credentials, select a KMS, or create a scheduler.

## Daily external scheduler contract

An **external scheduler**, operated by an assigned operations owner, must invoke
`backup:run` once per day with the complete configuration above. The API does not own or
invent this scheduler. The scheduler contract is:

1. Run once daily; retain the command exit status and structured stdout/stderr without
   exposing connection strings, tokens, or key material.
2. Treat a non-zero exit, absent completion record, failed upload, failed manifest upload,
   failed retention/list/delete operation, or document-integrity failure as a backup
   failure. Invoke `BACKUP_ALERT_COMMAND` on failure and create an operational record.
3. Verify that the artifact and its `.sha256.json` manifest are present in the configured
   durable destination. Retention is enforced by the script from
   `BACKUP_RETENTION_DAYS` **only when `BACKUP_PRUNE=on` (default off; with pruning off nothing is ever deleted and storage grows until pruning is deliberately enabled)**; the owner must periodically verify object-store lifecycle
   policy does not contradict that setting.
4. Assign and record accountable owners for scheduler operation, object-store access/KMS
   administration, and alert receiver response. **Those external accountable owners are
   currently unassigned.**

## Tiered retention, pruning and the list-command contract

**Pruning is default OFF (D-2, local R12 change).** With `BACKUP_PRUNE` unset or `off` a run uploads and verifies
but never lists or deletes anything, so the list-command contract below is not exercised until pruning is enabled
(validate it in a non-production destination before enabling). Enabling pruning in production is a separate owner decision.

**Layout.** Each run writes the same encrypted artifact and manifest once per applicable tier
under `<BACKUP_DESTINATION>/<tier>/`: `daily/` always, `weekly/` on Sundays (UTC) and `monthly/`
on the 1st (UTC). Backups written before tiering sit flat at the destination root ("legacy").

**Settings** (all optional; defaults shown):

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_TIER_DAILY_KEEP` / `_DAYS` | 7 / 14 | newest recoverable backups never pruned / minimum age in days |
| `BACKUP_TIER_WEEKLY_KEEP` / `_DAYS` | 4 / 35 | as above |
| `BACKUP_TIER_MONTHLY_KEEP` / `_DAYS` | 12 / 395 | as above |
| `BACKUP_MIN_RETAINED_COUNT` | 7 | floor for legacy flat backups only (aged out with `BACKUP_RETENTION_DAYS`) |
| `BACKUP_PRUNE` | **off** (unset/blank = off) | exactly `on` to enable pruning; `off` = explicit off; any other value fails startup. Each run logs `prune_disabled` or `prune_enabled` and `pruneStatus` (`disabled_default`, `disabled_explicit`, `enabled`) in the `completed` event |
| `BACKUP_DELETE_VERIFY_COMMAND` | unset | **Required when `BACKUP_PRUNE=on`** (fail closed: config loading and the engine both refuse `BACKUP_PRUNE=on` without it, before any list or delete; it must differ from the delete, list, upload, download and alert commands, resolve to a real executable, take `{object}` or `{remote}`, and not be an obvious no-op). Run after every delete under the read-only `list` identity. A delete command's exit status is never proof of permanent deletion (a versioned or Object Lock bucket answers a plain delete with a delete marker). The verifier must exit 0 **and** print `{"class":"absent","verified":true}` only when no version and no delete marker remains; empty, malformed, contradictory or non-`absent` output, a non-zero exit or a missing verifier is "not verified": the manifest is kept, pruning stops (no later unit is touched), the unit is recorded `*_delete_not_verified_*` with its `verifierClass`, and an alert is sent. The `completed` event reports `prunedVerified` (verified permanent deletions), `pruned` (**deprecated alias of `prunedVerified`**, never larger) and `deleteCommandsAccepted` (delete commands that exited 0, not proof of deletion). Outcome records are version 2; legacy `deleted` (v1) and `deleted_unverified` (R18) statuses are no longer written. Reference adapter `apps/api/src/ops/backup/verifiers/verifyDeleteMc.mjs` (mc based, classes absent / delete_marker_retained / versions_retained / governance_locked / compliance_locked / access_denied_or_incomplete / inconclusive; exit 0 only for absent; validated on local MinIO only, not AWS). Pruning stays off unless `BACKUP_PRUNE=on` |
| `BACKUP_VAULT_MODE` | false | exactly `true` or `false`; with `true`, `BACKUP_PRUNE=on` is refused (config error); unset/off is fine |

Retention is a *floor*: a backup is deleted only when it is both outside the newest `KEEP` of its
tier **and** older than its `DAYS` window, so more than `KEEP` copies normally survive (with the
defaults, about 15 daily, 5 weekly, 13 monthly at steady state). A backup counts as recoverable only
when both its artifact and manifest exist. The newest recoverable backups, the artifact uploaded by the
current run, and everything in an unknown folder or with an unparseable name are never deleted.

**`BACKUP_LIST_COMMAND` output contract.** The adapter receives `{destination}` and must print, on
stdout, one JSON array whose elements are `{"key": <string>, "lastModified": <ISO-8601 string>}`.
`key` must be **relative to `BACKUP_DESTINATION`** — no scheme, bucket or base prefix — and use `/`
as separator, e.g. `daily/aee-protected-20260301T000000Z-0123456789ab.tar.enc` and its
`.sha256.json` manifest. Example adapter response for destination `s3://example-bucket/backups`:

```json
[
  {"key": "daily/aee-protected-20260301T000000Z-0123456789ab.tar.enc",             "lastModified": "2026-03-01T00:05:12Z"},
  {"key": "daily/aee-protected-20260301T000000Z-0123456789ab.tar.enc.sha256.json", "lastModified": "2026-03-01T00:05:13Z"},
  {"key": "weekly/aee-protected-20260301T000000Z-0123456789ab.tar.enc",            "lastModified": "2026-03-01T00:05:14Z"}
]
```

This example documents the shape the code expects. It does **not** establish that any real cloud
provider CLI or adapter produces this shape; an adapter that strips the bucket/prefix and converts
timestamps must be written and verified by the operator. If a non-empty listing contains **no**
recognisable backup key (for example bucket-absolute keys or `s3://...` URIs), the run fails with
`prune_list_unexpected`, deletes nothing, and sends a count-only alert
(`prune_list_unexpected: listing had N entries, 0 recognised`) instead of silently pruning nothing.
A listing that mixes recognised keys with **backup-named keys in an unrecognised shape** (for
example one bucket-absolute or `s3://` key whose name looks like a backup artifact or manifest) is
**also refused**: the run fails with `prune_list_unexpected`, deletes nothing and alerts with counts
(`prune_list_unexpected: listing had N entries, M recognised, K backup-named unrecognised`). Foreign
objects whose names are not backup artifact/manifest names are ignored and never deleted. An empty
listing is accepted (fresh destination). Legacy flat backups (written before tiering) are only aged
out down to `BACKUP_MIN_RETAINED_COUNT` (default 7) and then remain; they are not migrated into tiers. Treat this alert as a configuration fault in the
list adapter, not as a backup failure: the new backup was already uploaded.

### Identity separation (Package B; local, not yet a PR)

The design uses three separate identities. Configure each as a **separate credential reachable only by
its own command adapter**:

| Identity | Commands it should run | Must be able to | Must not be able to |
|---|---|---|---|
| Writer | encrypt, upload (and list/delete if pruning is on) | write the destination; encrypt with KMS | read back for restore, decrypt |
| Verifier | `BACKUP_VERIFY_DOWNLOAD_COMMAND` | read artifact + manifest | write, delete, decrypt |
| Restore | `BACKUP_RESTORE_DOWNLOAD_COMMAND`, decrypt | read, decrypt (disposable environment only) | write or delete backups |

- `BACKUP_VERIFY_DOWNLOAD_COMMAND` (post-upload verification) and `BACKUP_RESTORE_DOWNLOAD_COMMAND`
  (restore) are optional and take `{source}`/`{destination}`. If either is unset the run falls back to
  `BACKUP_DOWNLOAD_COMMAND`, i.e. the original behaviour.
- **Command-level environment isolation** (`BACKUP_ENV_ISOLATION=true`; default off). Without it,
  every child command inherits the entire process environment, so a command flag alone does not
  separate credentials. With it, each child receives only: a fixed non-secret base (`PATH`,
  `TMPDIR`/`TMP`/`TEMP`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, and the Windows basics
  `SystemRoot`, `WINDIR`, `COMSPEC`, `PATHEXT`), the variables in `BACKUP_ENV_COMMON_ALLOW`
  (non-secret shared settings such as a region), and its own operation's list. Each list is
  comma-separated names; a trailing `*` makes a prefix. Operations and variables:
  `BACKUP_ENV_DATABASE_ALLOW` (`pg_dump`/`psql`/`pg_restore`), `_ENCRYPT_`, `_UPLOAD_`,
  `_VERIFY_DOWNLOAD_`, `_LIST_`, `_DELETE_`, `_ALERT_`, `_DECRYPT_`, `_RESTORE_DOWNLOAD_` (all
  `BACKUP_ENV_<OPERATION>_ALLOW`). `tar` receives the base only. Startup fails if any two operations'
  allowlists overlap, if a list is `*`, or if an entry also appears in `BACKUP_ENV_COMMON_ALLOW`, so a
  credential variable cannot be admitted to both a writer and a restore/verifier operation.
  Database URLs are passed as arguments, not environment variables, and are no longer inherited by
  adapters when isolation is on. Only variable **names** are inspected; values are never logged.
- **Home directory and credential discovery (local R12 hardening).** The parent's `HOME`/`USERPROFILE` is
  never inherited. Children get a home only when `BACKUP_ENV_HOME` (absolute path, ideally an empty
  directory) is set; they then see exactly that value. Credential-discovery variables (`XDG_*`,
  `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_PROFILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`,
  `AWS_CONTAINER_*`, `AWS_EC2_METADATA_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`, `PGPASSFILE`,
  `SSH_AUTH_SOCK`, ...) can never go on the shared list or be swept in by a prefix such as `AWS_*`;
  home locators (`HOME`, `XDG_*`, ...) can be on no list. `BACKUP_ENV_COMMON_ALLOW` accepts exact,
  upper-case, non-secret-looking names only (no prefixes; names containing SECRET, TOKEN, PASSWORD, KEY,
  CREDENTIAL, SESSION, PRIVATE, URL or DSN are refused).
- **Windows limitation (observed on NITRO, Node 24).** The OS adds its own `HOMEDRIVE`, `HOMEPATH`, `USERPROFILE`, `USERNAME`,
  `LOGONSERVER`, `TEMP` and `SYSTEMDRIVE` to every child process whatever the parent passes, so environment scrubbing cannot hide the
  real user profile from a child on Windows. A Windows-style `BACKUP_ENV_HOME` (for example `C:\aee\home`) overrides
  `USERPROFILE`, `HOMEDRIVE` and `HOMEPATH`; the rest cannot be removed. Treat Windows hosts as weaker evidence for home isolation.
- **Restore database scope.** `BACKUP_ENV_RESTORE_DATABASE_ALLOW` is a separate allowlist for the restore
  target's `psql`/`pg_restore`; it may not overlap `BACKUP_ENV_DATABASE_ALLOW`, so restore-only database
  settings are not available to backup operations (and vice versa).
- **Fail-closed production mode: `BACKUP_ENV_ISOLATION_REQUIRED=true`.** Loading the configuration fails
  (and the engine refuses to run any command if a policy is somehow absent) unless: `BACKUP_ENV_ISOLATION=true`;
  `BACKUP_ENV_HOME` is set; non-empty allowlists exist for database, restore_database, encrypt, upload,
  verify_download, alert, decrypt and restore_download (plus list and delete only when `BACKUP_PRUNE=on`);
  `BACKUP_VERIFY_DOWNLOAD_COMMAND` and `BACKUP_RESTORE_DOWNLOAD_COMMAND` are set and differ from the writer,
  delete, list and each other. With pruning off, the list and delete allowlists must be **empty**, so no
  delete-capable credential is provisioned to a backup that does not prune. Note the engine can only
  prove the *environment* the verifier receives; whether its credentials lack delete rights is an IAM policy
  property that must be tested against the real provider.
- With isolation on and an operation that has no allowlist (for example a verifier that falls back to
  the writer download command), that command receives only the base environment and will fail to
  authenticate rather than borrow another identity's credentials.
- Isolation separates **environment variables only**. It does not isolate files (for example shared
  credential files under `HOME`), instance metadata, or IAM roles; enforce least privilege in the
  object-store/KMS policies themselves. Not yet evidenced against any real provider.

**Alerts** carry only a fixed reason code and counts (for example `prune_delete_refused: 2 delete(s)
refused`, `restore_failed: restore failed during download`). Object names, bucket names and raw
provider output stay in the local operation log only.

## Restore preflight and disposable-only procedure

Restore is a verification/recovery operation for a **fresh disposable environment only**.
It must never overwrite a live, active, pilot, or production database or document directory.
The script rejects an equivalent source/target database, requires
`--confirm-disposable`, requires the configured `restore-*` environment, checks the target
database is empty, and rejects unsafe document paths.

Before every restore:

1. Select the protected artifact name and matching manifest from the durable destination.
2. Confirm the restore database and document root are the isolated disposable values and
   are empty; confirm no live service points at either target.
3. Confirm the KMS owner has authorised decryption and the restore operator has no need
   to copy secrets into logs or tickets.
4. Run the restore command above (add `--tier=` for tiered backups). It downloads artifact and manifest
   (through `BACKUP_RESTORE_DOWNLOAD_COMMAND` when set), verifies SHA-256
   integrity before decryption, extracts with `tar`, restores with `pg_restore
   --exit-on-error`, validates table/row/tenant/document inventory and the drizzle migration journal (row count + digest; artifacts created before this check are not journal-validated), and verifies restored
   document keys.
5. Record artifact name, restore environment id, table/tenant/document validation result,
   duration, and any discrepancy. Destroy or reset the disposable restore environment
   according to its owner’s handling policy after verification.

A failed restore, integrity mismatch, or document mismatch is Critical and follows
`docs/INCIDENT_RESPONSE_RUNBOOK.md` scenario 7. Do not “fix” it by restoring over live data.

## Operational-alert boundary

Backup scripts use their configured `BACKUP_ALERT_COMMAND`; the application also exposes
the `operationalAlerts` `BACKUP_FAILURE` boundary for a scheduler/integration to call.
For production application startup, operational alerts require
`OPERATIONAL_ALERTS_ENABLED=true`, `OPERATIONAL_ALERTS_PROVIDER=webhook`, a valid HTTPS
`OPERATIONAL_ALERTS_WEBHOOK_URL`, and an `OPERATIONAL_ALERTS_TOKEN` of at least 16
characters. The receiver/token owner is **unassigned**.

Delivery makes at most three bounded in-process attempts. Cooldown/deduplication is
process-local, and there is no durable alert outbox. A successful HTTP response is not
proof that a human received or acknowledged the alert. External delivery and acknowledgement
have **not yet been evidenced**.

## Stale staging sweep (D-5, local R13 - production policy NOT approved)

Every backup/restore run directory in `BACKUP_STAGING_DIRECTORY` carries a `.run.json` marker (runId, kind, pid, host,
uid, heartbeat, state). A run killed by OOM/power loss leaves its directory, including plaintext dumps. The sweep is
**off by default**: `BACKUP_STAGING_SWEEP=off|dry-run|on` (invalid value = startup error), `BACKUP_STAGING_SWEEP_MIN_AGE_HOURS`
(1-720, default 24). `pnpm --filter api backup:sweep` runs it on demand; with `on`/`dry-run` set, every backup also sweeps first (never fatal).

A directory is removed only if: name and marker agree, owned by the current user on this host, heartbeat older than the
minimum age, the pid is not alive, and it contains no symlinks, hardlinks or unrecognised files. Anything else is
reported `ambiguous` and left alone (including directories from versions without markers). A backup directory whose
encrypted artifact was not verified as uploaded keeps the artifact and manifest (it may be the only recoverable copy)
while the plaintext beside it is overwritten and removed. Decisions are appended to `sweep-audit.jsonl` in the staging
root (no file contents); if the audit cannot be written nothing is deleted.

Limits: overwrite-before-unlink is best effort and not a guarantee on SSD, copy-on-write or journalled filesystems or
snapshots; use an encrypted staging volume. Ownership checks use uid and are skipped on Windows, where the marker's host and pid
checks apply. Retained unverified artifacts are never deleted automatically (Owner decision needed).

### Operating `backup:sweep` (R15 operator command)

`BACKUP_STAGING_SWEEP` stays **off by default**; an invalid value is a startup error. Nothing here enables the sweep.

- **Console output needs `LOG_LEVEL=info`.** The command logs through the shared structured logger, one JSON line per run on
  stdout: `staging_sweep_disabled` (mode off, nothing read or changed), `staging_sweep` with `mode=dry-run` (decisions only)
  or `mode=on` (decisions applied), each with `counts`. At `LOG_LEVEL=warn` or `error` these info lines are dropped, so a
  disabled, dry-run or completed sweep prints nothing and exits 0.
- **Failures exit with code 1** and write one `staging_sweep_failed` line to stderr (shown at every log level). This covers a
  complete failure (bad staging path or config, filesystem error; only the error code is logged for filesystem errors) and a
  sweep that completed but had per-directory errors (`reason=completed_with_errors`, `errorCount`).
- **`sweep-audit.jsonl` in the staging root is the complete record** of sweep decisions. Console output truncates arrays
  such as `entries` at 20 items and masks quoted paths in per-directory error reasons; the audit file keeps the full list and raw text.
