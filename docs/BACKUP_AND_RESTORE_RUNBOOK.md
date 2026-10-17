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

- `DATABASE_URL`, `BACKUP_DOCUMENT_DIRECTORY`, and a private
  `BACKUP_STAGING_DIRECTORY` that does not contain the live document directory.
- `BACKUP_DESTINATION` as a durable `s3://`, `gs://`, or `azblob://` object-store URI;
  credentials and bucket/container policy belong to the object-store owner and are never
  placed in this runbook.
- Positive-integer `BACKUP_RETENTION_DAYS`.
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
manifest, upload artifact plus manifest, and prune retained artifacts. They do not embed
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

## Tiered retention, pruning and the list-command contract

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
| `BACKUP_PRUNE` | on (blank = on in this build) | exactly `on` or `off`; any other value fails startup |
| `BACKUP_VAULT_MODE` | false | exactly `true` or `false`; with `true`, `BACKUP_PRUNE=off` is mandatory or the run is refused before any work |

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
A listing mixing recognised and unrecognised keys is not flagged; unrecognised keys are never deleted.
An empty listing is accepted (fresh destination). Treat this alert as a configuration fault in the
list adapter, not as a backup failure: the new backup was already uploaded.

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