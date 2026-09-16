# AE GROW Priority 6 — Step 3 Recording Storage Architecture

## Scope

Step 3 adds an internal recording-storage seam only. It does not place calls,
capture provider media, produce audio, add a route, alter the UI, evaluate
recording consent/gates, or change commit/push/branch logic.

The implementation is
`apps/api/src/lib/telephony/recordingStorage.ts`. It is intentionally not
mounted by an HTTP route. A future server-side capture adapter may call it
after the existing call-session/gate flow has persisted its authoritative
permission state.

## Storage model

There is no recording bucket, provider abstraction, or recording table. The
service creates (or resolves) one tenant-owned, propertyless logical document
per `(brokerageId, callSessionId)`. A compatibility `documentId` selector is
accepted only when it resolves to that exact service-owned logical document;
caller-selected property documents are rejected. `documents.brokerageId`,
`logicalOwnerType`, and `logicalOwnerId` extend the existing document model,
while `propertyId` remains nullable for this internal record. Each stored version is written through
`ingestDocumentVersion`, and its immutable `documentObjectVersions.metadata`
contains:

- `logicalOwner: { kind: "telephony-call", brokerageId, ownerId }`;
- `kind: "telephony-call-recording"` and `schemaVersion: 1`;
- brokerage, call-session, and party identifiers;
- capture/provider identifiers and server capture evidence references;
- captured timestamp and the permission snapshot that was already persisted
  on the call session;
- the named retention class and text metadata payload details.

The call link is checked in application code while reading version rows. A
tenant plus `callSessionId` is required for metadata/content/reference reads;
cross-tenant sessions and document links are rejected. The logical-owner
invariant is also checked inside the same document advisory lock used by
`ingestDocumentVersion`, so concurrent retries cannot claim one document for
different calls.

Generic document storage loaders and routes remain property-backed only.
Telephony uses separate internal logical-owner loaders after its
tenant/session-owner-or-administrator and `grow.calling.recording` checks; there is no
public route option that can select a logical owner or upload to one.

The metadata-only path serializes a bounded `text/plain` artifact. The
optional `bytes` field is an explicitly internal synthetic-payload seam for
storage/integrity tests and future trusted adapter work. No current route or
provider supplies real audio, and this step does not add audio MIME support.

## Permission and evidence boundary

`storeCallRecording` first loads the session through
`getCallSessionForBrokerage(brokerageId, callSessionId)`. It accepts storage
only when the server-loaded row has both:

- `recordingPermitted === true`; and
- `recordingStatus === "PERMITTED_NOT_CAPTURED"`.

The input has no client `recordingPermitted` field and no gate-result field.
`TrustedServerCaptureEvidence` requires the internal
`trustedByServer: true` / `server-telephony-provider` marker plus capture and
provider references. This service does not call or duplicate consent, DNCR,
hours, jurisdiction, kill-switch, or gate evaluation.

## Reused durability controls

The existing document storage service remains responsible for:

- tenant-safe object keys and the configured object-storage provider;
- pending-upload rows, retry/reconciliation, advisory locking, and
  deduplication;
- byte size and SHA-256 verification, quarantine, and active-version pointer
  transitions;
- provider private ACL/server-side encryption and signed-download behavior;
- document/version audit transitions.

The recording service adds call-scoped storage/read/quarantine audit entries
and never constructs provider object keys. Its quarantine operation delegates
to `quarantineDocument`; it does not delete provider objects or invent a
separate lifecycle.

The propertyless document/version extension is delivered by the
Drizzle-generated plain SQL migration
`packages/db/migrations/0021_hard_maria_hill.sql` and its generated snapshot;
the exact-one-owner constraint is in the separately generated
`packages/db/migrations/0022_complete_mariko_yashida.sql` and snapshot. These
do not create a recording table. Legacy property-backed documents remain
tenant-scoped through their existing property relationship.

## Retention configuration

`TELEPHONY_RECORDING_RETENTION_CLASS` selects one name from
`DOCUMENT_STORAGE_RETENTION_CLASSES`. It defaults to `legal-pending`.
`legal-pending` is deliberately a legal-review/application label only. The
repository does **not** claim a statutory retention period, infer one, or
configure provider lifecycle expiry from this value. Legal review, the final
named class, and provider lifecycle/legal-hold policy remain operator/legal
configuration work.

## Exported internal contract

- `storeCallRecording(input)` — authoritative session check, metadata build,
  and existing document/version ingestion.
- `storeCallRecordingMetadata(input)` — metadata-only convenience wrapper.
- `createServerCaptureMetadataAdapter(producer)` — internal callback seam for
  a future server-side provider adapter; no live capture implementation is
  installed.
- `getCallRecordingMetadata({ brokerageId, callSessionId, actor? })` —
  tenant/call scoped metadata lookup; a supplied actor must be the session
  owner or brokerage administrator and hold `grow.calling.recording`.
- `getCallRecordingContent({ brokerageId, callSessionId, actor? })` — same
  scoped authorization followed by existing byte integrity verification.
- `createCallRecordingReference({ brokerageId, callSessionId, actor? })` —
  performs the scoped authorization before issuing an existing signed document
  reference.
- `quarantineCallRecording({ brokerageId, callSessionId, actor? })` —
  scoped authorization and quarantine through document storage.

The focused tests cover configured named retention, retention-safe
deduplication, generic propertyless-document rejection, missing/mixed owner
database checks, actor access denial, propertyless logical ownership,
deterministic synthetic text payloads, and rejection of untrusted capture
evidence. Consent and outbound-control scenarios remain outside this
storage-focused test scope.
