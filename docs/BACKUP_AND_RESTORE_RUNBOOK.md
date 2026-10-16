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

### Phase A changes (open pull requests; verify merge status before relying on them)

These describe behaviour that exists **only after the named PR is merged**. Until then the
previous behaviour in the rest of this document applies.

- **#224 prune safeguard.** Pruning keeps the newest `BACKUP_MIN_RETAINED_COUNT` (default 7,
  optional) *recoverable* backups (artifact **and** manifest present) and the artifact created by
  the current run, regardless of age or `BACKUP_RETENTION_DAYS`; it deletes nothing when no
  recoverable backup exists; it removes an artifact together with its manifest (artifact first). A
  delete refused by Object Lock/retention is logged as `prune_delete_failed` (level `error`) and
  does not fail a backup that was stored. Operators must still alert on `prune_delete_failed`.
- **#225 post-upload verification.** After upload the run downloads the artifact and manifest,
  requires the stored manifest to equal the one written for the run, and re-checks SHA-256 and byte
  length. A mismatch or unreadable object fails the run (error log plus `BACKUP_ALERT_COMMAND`) and
  skips pruning. Completion logs then include `verified: true`.
- **#226 object-storage documents.** Set `BACKUP_DOCUMENT_SOURCE=object-storage` (requires
  `OBJECT_STORAGE_PROVIDER=s3`; `BACKUP_DOCUMENT_DIRECTORY` is then not used). The run reads every
  `documents.object_storage_key` through the application's existing object-storage provider
  (`OBJECT_STORAGE_*`, size and SHA-256 verified on read) into the same `documents.tar` layout, so
  restore is unchanged. Give the backup job a **read-only** storage identity (GetObject/HeadObject).
  Missing, unreadable or corrupt objects fail the run with counts. Orphan objects (present in
  storage but not in the database) cannot be detected because the provider has no list operation.

### Known gaps that remain (unchanged by Phase A)

- No scheduler, offsite/immutable destination, key management, restore-verification schedule or
  named owners exist yet (see below). The database recovery point is the last successful daily run
  (up to 24 hours of data loss), and document recovery depends on the storage provider's own
  versioning/replication, which this repository does not configure or verify.
- Restoring documents writes them to the **disposable restore directory only**. Returning bytes to
  a bucket is a separate, owner-approved manual step: upload with the original keys, then confirm
  each object's SHA-256 against `document_object_versions` before pointing any service at it.
- The 2026-09-07 drill used a local document directory; it did not exercise object storage.

## Script contract and required configuration

Run the existing scripts, not ad-hoc replacement commands:

```sh
pnpm --filter @aee/api backup:run
pnpm --filter @aee/api backup:restore -- --artifact=<artifact-name> --confirm-disposable
```

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
manifest, upload artifact plus manifest, (once #225 is merged) re-download and verify both, and
prune retained artifacts. They do not embed
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
   `BACKUP_RETENTION_DAYS`; the owner must periodically verify object-store lifecycle
   policy does not contradict that setting.
4. Assign and record accountable owners for scheduler operation, object-store access/KMS
   administration, and alert receiver response. **Those external accountable owners are
   currently unassigned.**

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
4. Run the restore command above. It downloads artifact and manifest, verifies SHA-256
   integrity before decryption, extracts with `tar`, restores with `pg_restore
   --exit-on-error`, validates table/row/tenant/document inventory, and verifies restored
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