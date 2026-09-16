# Durable Document Storage — Architecture and Operator Guide

## Purpose and boundary

PostgreSQL is the authoritative record of document identity, tenancy, workflow state, audit
references, and object-version metadata. Document bytes are held by the `ObjectStorageProvider`
behind a provider-neutral interface (`put`, `get`, `head`, delete, signed download, integrity,
and readiness). Production selects its S3-compatible implementation with
`OBJECT_STORAGE_PROVIDER=s3`; local storage is development/test only and production startup
rejects it.

The adapter uses the S3 API over HTTPS and AWS Signature Version 4. It deliberately does not
depend on a particular cloud vendor: the storage owner may use AWS S3 or a private,
S3-compatible service that supports the required operations and headers. It uses
path-style requests: `<OBJECT_STORAGE_ENDPOINT>/<bucket>/<prefix>/<key>`.

### Object and tenancy model

The server, not a caller, generates every durable key:

```text
<optional prefix>/tenants/<brokerageId>/documents/<documentId>/<UUID>-v<version>.<extension>
```

Client-supplied paths are never accepted. The brokerage ID is checked when a document is found,
ingested, read, signed for download, or quarantined. The database has a unique object key and
one immutable logical version sequence per document. `documents.object_storage_key` is only the
active-key compatibility pointer; `document_object_versions` is the integrity, provenance, and
retention history.

The implementation's **document version** is not a provider version ID. Each replacement is a
new, uniquely named object and requires a non-empty replacement reason; repeated active content
with the same SHA-256 and byte length is deduplicated. Enable the bucket's native versioning as
an independent recovery control, but do not substitute provider version IDs for the application's
version/inventory records.

## Integrity, access, retention, and quarantine semantics

On ingest the service validates size, filename, declared MIME type, and detected bytes; calculates
SHA-256; and first commits an immutable metadata row with `PendingUpload` status. It then writes
the object and requires `HEAD` size and checksum metadata to match before a second transaction
marks the version `Active` and updates the compatibility pointer. S3 writes include
`x-amz-checksum-sha256` and `x-amz-meta-sha256`. If finalization has an ambiguous outcome, bytes
are never blindly deleted: an idempotent retry resumes the same pending key, while a different
payload is blocked for reconciliation. A checksum acknowledgement mismatch quarantines the
pending version. Reads perform `HEAD` then `GET` and verify byte count and SHA-256 again. An
acknowledgement or read mismatch is an integrity failure, not a successful document.

Every ingestion state change has an immutable audit row: pending creation, activation, resumed
pending reconciliation, storage-write failure, finalization failure, and integrity quarantine.
Callers also distinguish `created`, `resumed`, and `deduplicated` outcomes so a recovered pending
upload is never mislabeled as a duplicate.

A boot-registered reconciler scans aged `PendingUpload` rows in bounded, cursor-based batches. It
performs `HEAD` plus a full-byte SHA-256 verification sequentially, so memory is bounded to one
configured document. Matching objects are finalized through the same advisory-locked transaction
as live ingestion. Missing objects remain retryable until the terminal age, then become
`Quarantined`; size/checksum mismatches quarantine immediately. Provider/DB errors stay pending and
raise an operational alert. The reconciler never auto-deletes a pending or quarantined legal
object: a matching object is authoritative and finalized, while a mismatch is incident evidence.

`retention_class`, `retain_until`, and `retention_status` are recorded with every logical version.
Allowed classes are configured by `DOCUMENT_STORAGE_RETENTION_CLASSES` (default:
`legal-pending,transaction,signed-agreement,general`). These fields are application metadata:
they do **not** configure or enforce provider retention, legal hold, lifecycle expiry, immutable
storage, or deletion. The storage/compliance owner must map each class and legal-hold requirement
to bucket lifecycle/Object Lock/retention policy and preserve a record of that mapping.

Quarantine is an administrator-only operation. It marks the latest version `Quarantined`, records
the time, creates an audit entry, and blocks normal application content reads and signed-download
creation. It does **not** move, delete, revoke, or cryptographically alter the provider object,
nor does it automatically quarantine earlier versions. Immediately restrict direct provider access
and preserve the object and its metadata for investigation; a replacement must be a new version.

Signed downloads are short-lived, HMAC-signed application URLs. Redemption re-checks the active
version and quarantine state, fetches and verifies byte count/SHA-256, and emits safe attachment,
`nosniff`, and no-store headers. Quarantine therefore revokes a previously issued link immediately.
`DOCUMENT_STORAGE_SIGNED_DOWNLOAD_SECONDS` defaults to 300 seconds and is capped at 900 seconds.
Treat URLs as bearer credentials: do not log, ticket, cache, or expose them in referrers.

## Required production configuration

Store credentials only in the deployment secret manager, never in source, tickets, or this file.
Startup validates the values below and fails before serving if the production provider/configuration
is invalid.

| Variable | Requirement |
|---|---|
| `OBJECT_STORAGE_PROVIDER` | Exactly `s3` in production. |
| `OBJECT_STORAGE_ENDPOINT` | Private S3-compatible **HTTPS** endpoint, with no embedded credentials, query, or fragment. |
| `OBJECT_STORAGE_REGION` | Region used for SigV4 signing; must match the provider's configured signing region. |
| `OBJECT_STORAGE_BUCKET` | Existing private bucket/container name. |
| `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` | Dedicated runtime identity with only the permissions listed below. |
| `OBJECT_STORAGE_SESSION_TOKEN` | Required as well when using temporary credentials. |
| `OBJECT_STORAGE_PREFIX` | Optional stable deployment/environment prefix; do not change it without migration planning. |
| `OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION` | `AES256` or `aws:kms`. Prefer `aws:kms` for regulated production data. |
| `OBJECT_STORAGE_KMS_KEY_ID` | Mandatory when encryption is `aws:kms`; grant runtime use of this key only. |
| `DOCUMENT_STORAGE_MAX_BYTES` | Optional integer, 1–104857600; defaults to 10 MiB. |
| `DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENT_BYTES` | Maximum decoded bytes per completed e-sign document, 1–10485760; defaults to 2 MiB. |
| `DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENTS` | Maximum documents in one completed e-sign envelope, 1–10; defaults to 5. The raw JSON parser limit is derived from these two values including Base64 and bounded metadata overhead. |
| `DOCUMENT_STORAGE_PENDING_RECONCILE_AFTER_SECONDS` | Minimum pending age before verification, 30–604800; defaults to 300. |
| `DOCUMENT_STORAGE_PENDING_QUARANTINE_AFTER_SECONDS` | Terminal age for a still-missing object, 60–2592000 and greater than reconcile age; defaults to 86400. |
| `DOCUMENT_STORAGE_PENDING_RECONCILE_BATCH_SIZE` | Rows per scheduled/manual sweep, 1–500; defaults to 50. |
| `DOCUMENT_STORAGE_PENDING_RECONCILE_INTERVAL_SECONDS` | Scheduler interval, 30–86400; defaults to 300. |
| `DOCUMENT_STORAGE_SIGNED_DOWNLOAD_SECONDS` | Optional integer, 1–900; defaults to 300. |
| `DOCUMENT_STORAGE_SIGNING_SECRET` | Dedicated random secret of at least 32 bytes for revocable application download links. |
| `DOCUMENT_STORAGE_RETENTION_CLASSES` | Optional comma-separated safe class names; coordinate it with provider retention policy. |
| `TELEPHONY_RECORDING_RETENTION_CLASS` | Optional named class for the Step 3 internal call-recording metadata seam; defaults to `legal-pending`, which is a legal-review label and not a statutory retention period. The value must appear in `DOCUMENT_STORAGE_RETENTION_CLASSES`. |

The S3 adapter sets `x-amz-acl: private` and server-side encryption on every write. The endpoint
must accept `PUT`, `GET`, `HEAD`, and `DELETE`, checksum and metadata headers, SSE-S3 (`AES256`)
or SSE-KMS (`aws:kms`) headers as selected. The application does not expose provider presigned
URLs for document delivery. A gateway/proxy must forward signed request headers unchanged and
must not rewrite the canonical path.

## Provider-account, bucket, and network responsibilities

The provider account owner is responsible for creating and owning a production account/project,
region, private bucket, DNS/TLS endpoint, credential rotation, KMS key and recovery access,
billing/availability support, replication/backup policy, native bucket versioning, retention/legal
hold/lifecycle policy, and evidence that those controls are operating. Application operators own
the deployment configuration, runtime credential injection, readiness monitoring, and documented
recovery procedure. The two roles must agree on a break-glass process and record accountable
people outside the repository.

Apply all of the following before production use:

- Block all public access at account and bucket level. No public bucket policy, ACL, anonymous
  list/read/write, static website endpoint, or broad cross-account grant is permitted.
- Give the runtime principal only bucket/prefix-scoped `GetObject`, `PutObject`, `HeadObject`
  (normally covered by `GetObject`), and `DeleteObject` as required by the adapter. It does not
  need `ListBucket`; restrict bucket-level permissions to the prefix if the provider requires
  them. Separate backup, migration, and break-glass identities; do not use owner/admin keys at
  runtime.
- Permit the runtime principal to use the selected KMS key for encrypt/decrypt/data-key operations;
  prevent key deletion/disablement without the document owner’s approval. Rotate credentials and
  keys under the provider's process and test a new identity before revoking the old one.
- Restrict endpoint network access to the application/worker egress and approved recovery
  operators. Enable provider audit/data-event logs without putting document bytes or presigned URLs
  in application logs.
- The application proxies ordinary content downloads; it does not require browser-to-bucket CORS.
  If product use of a presigned URL requires programmatic browser cross-origin access, configure
  only approved application origins, `GET`/`HEAD`, required response headers, and the shortest
  practical max-age. Do not allow `*`, credentials, `PUT`, `DELETE`, or arbitrary headers.

## Startup and readiness

At process startup, configuration construction validates provider choice, HTTPS endpoint, region,
bucket, credentials, encryption mode/KMS requirement, and document limits. A successful startup
is not evidence that the bucket is reachable.

`GET /api/health/live` tests only whether the process can answer. `GET /api/health/ready` also
checks PostgreSQL and storage. For S3, readiness sends an authenticated, non-mutating `HEAD` for a
random nonexistent key; a reachable authenticated `404` is expected and ready. Any other response
or transport failure makes readiness return HTTP 503 (`document storage unreachable`) and removes
the instance from traffic. Configure the platform to restart on liveness failure and remove from
rotation/alert on readiness failure; do not restart-loop solely for a dependency outage.

## Backup, restore, and migration

The existing backup scripts and their documented local document-directory archive are not, by
themselves, a backup of private S3 document bytes. The provider/storage owner must provide and
test object replication, version recovery, immutable backup where required, and a restore path
that preserves keys, metadata, checksums, encryption access, and retention evidence. Database
restore alone can restore object metadata pointing to absent bytes.

Before a restore or storage migration, run an inventory **without writes** and retain its output.
The repository command is resumable and bounded:

```sh
pnpm --filter @aee/api run documents:inventory -- \
  --batch-size=100 --cursor=0 --legacy-local-dir=./storage \
  --report=/secure/path/document-storage-inventory.json
```

Continue with `--resume-report=<previous-report.json>`. Add `--brokerage-id=<id>` to constrain
the run to one tenant. `--legacy-local-dir` adds containment-checked actual-byte hashes plus
duplicate/orphan classification for the old filesystem source while the configured provider is
checked as the destination. The command has no apply mode, opens reports with exclusive-create
permissions, performs no database/object writes, never follows symlinks, and never deletes source
files.

Review the report using this reconciliation sequence:

1. Export `document_object_versions` including brokerage/document IDs, logical version,
   `storage_object_key`, byte size, SHA-256, status, retention fields, and provenance; include
   legacy `documents.object_storage_key` rows that lack a version row.
2. For each active source object, perform authenticated `HEAD` and compare key, size, and
   `x-amz-meta-sha256`; sample/full-read hashes according to the approved migration plan.
   Record missing objects, orphan objects, duplicate keys, malformed metadata, quarantined
   objects, and objects whose database tenancy/prefix disagrees.
3. Reconcile counts by tenant, document, version, status, and retention class. Obtain a named
   approval of the discrepancies and a rollback plan before any copy.

A legacy record without `--legacy-local-dir` is classified
`source-unknown/manual-review blocker`; it is never emitted as a copy plan without actual source
bytes that the inventory has hashed.

There is no repository command that copies existing objects between providers, mutates legacy
metadata, or automatically turns metadata retention into bucket policy. Any future apply tool must
remain separate from this inventory command and require explicit approval after dry-run review.
Copy to the server-generated destination key, verify destination `HEAD`/full SHA-256, preserve
source until the retention/legal and rollback window closes, then transactionally update the
active pointer and version history through an approved procedure. Re-run the inventory after
cutover and test a disposable restore before declaring recovery complete.

### Pending-upload reconciliation

The production API runs the bounded reconciler automatically. Operators can run one batch without
waiting for the scheduler:

```bash
pnpm --filter @aee/api run documents:reconcile-pending -- --after-id=0
```

The JSON result reports counts and `nextCursor`. If `nextCursor` is non-null, rerun with that value;
when it is null, the sweep has reached the current end. Repeated runs are safe: every transition
re-reads state under the document advisory lock and conditionally updates only `PendingUpload`.
Investigate `quarantinedMissing`, `quarantinedIntegrity`, `deferredProviderError`, and
`deferredTransitionError` with the corresponding audit rows and operational alert. Do not edit
status/pointers or delete provider objects by hand.

## Corruption, missing-object, and quarantine response

Treat a checksum mismatch, unexpected `HEAD` metadata, missing active object, unreadable encrypted
object, unauthorized access, accidental public exposure, or storage readiness failure as a
document-storage incident. Do not overwrite the evidence object or silently regenerate a signed
document.

For completed e-sign callbacks, invalid/missing package bytes are acknowledged as semantic failures,
but a storage or finalization failure returns HTTP 503 with `Retry-After: 30`. The exact provider
redelivery is bounded by the configured document-byte checks and resumes the same tenant key. It
also records `esign_completed_document_storage_retry_required` and dispatches the deduplicated
`DOCUMENT_STORAGE_INGESTION_RETRY_REQUIRED` operational alert. If the provider exhausts redelivery,
escalate that alert to integration/storage owners, preserve the `PendingUpload` row and provider
envelope reference, obtain the exact completed bytes through an approved provider recovery path,
and redeliver them through the same verified webhook flow. Never mark the signature request
complete, replace it with generated content, or edit the pending row by hand.

1. Stop affected writes/downloads where safe; quarantine the affected latest version through the
   administrator control and restrict direct provider access. If exposure is suspected, disable
   the runtime credential/presigned distribution path as appropriate.
2. Preserve the database version row, audit records, provider request/data-event logs, object
   headers/version IDs, KMS/access evidence, calculated and recorded SHA-256 values, and a list of
   affected tenants/documents. Never place document bytes, credentials, or presigned URLs in the
   incident ticket.
3. Determine scope with the read-only inventory above. Verify an alternate provider-native version,
   replica, or backup in an isolated environment before recovery. Restore bytes under an approved
   new immutable application version; do not alter checksum/history to make a mismatch disappear.
4. Reconcile the recovered object byte-for-byte and record the replacement reason, recovery source,
   retention consequences, and participant/compliance notification decision. Re-enable access only
   after owner approval and readiness/integrity checks pass.

Follow `docs/INCIDENT_RESPONSE_RUNBOOK.md` for severity, communications, escalation, and
disposable restore discipline. A failed integrity check or inability to prove durable recovery is
a stop-pilot/production-escalation condition.

## External configuration still required

Code cannot create or prove the following. They are required operator work, not optional defaults:

1. A production S3-compatible account, private HTTPS endpoint, bucket, region, runtime identity,
   secret delivery, and working SigV4 compatibility.
2. An SSE choice and, for KMS, a live key, restrictive key policy, rotation/recovery process, and
   separate authorised recovery identity.
3. Public-access blocks, least-privilege IAM, network restrictions, provider audit logs, narrowly
   scoped CORS only if browser cross-origin access is genuinely needed, and tested credential
   rotation/revocation.
4. Native bucket versioning; documented retention/lifecycle/legal-hold mapping for every
   application retention class; and explicit deletion/destruction approval controls.
5. Offsite replication/backup and a tested isolated restore procedure covering both PostgreSQL
   metadata and object bytes, plus monitoring/alert routing for readiness and provider/KMS events.
6. An approved migration inventory, dry-run manifest, cutover/rollback plan, and accountable
   provider, security/compliance, and operations owners.
