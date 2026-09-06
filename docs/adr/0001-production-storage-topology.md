# ADR 0001: Production Storage Topology

**Status:** Accepted target architecture; implementation remediation remains required.  
**Decision:** PostgreSQL is the authoritative operational record store. Generated and signed
document bytes must be held separately in durable S3/GCS-compatible object storage. Local disk is
development/test only and must not be used as the production system of record.

## Context

The current object-storage implementation defaults to `OBJECT_STORAGE_PROVIDER=local` and writes
to `OBJECT_STORAGE_LOCAL_DIR`. That location is suitable for local development and automated
testing, but it is not a durable production service, does not establish off-host durability, and
has no implemented durable adapter. Document metadata and operational workflow records require
transactional, queryable storage, while generated/signed bytes require durable object storage with
integrity and lifecycle controls.

Signature validation on AML, payment, or communications webhooks authenticates a callback; it does
not by itself prove that related bytes were durably ingested, checksum-verified, or tied to a
specific document/version.

## Decision

1. Use PostgreSQL for authoritative operational records, including document metadata, workflow
   state, consent/acceptance records, audit references, and object identifiers/checksums.
2. Use a separate durable S3/GCS-compatible object store for generated and signed document bytes.
   The object-store adapter must persist and retrieve bytes and record object identity, version
   (where supported), and SHA-256 checksum/provenance in PostgreSQL.
3. Treat local disk only as a development/test provider. It is prohibited for production document
   persistence.
4. Production configuration must fail closed if the durable database/object-store configuration,
   credentials, encryption/KMS profile, backup/restore contract, or scheduled backup evidence is
   absent or invalid.
5. Webhook processing that creates or updates regulated/document evidence must not represent a
   callback as complete until durable ingestion and recorded checksum/version provenance have
   succeeded.

## Consequences and unresolved implementation gaps

This decision does not claim the target is implemented. The following remain pilot blockers:

- no durable S3/GCS-compatible object-storage adapter;
- local disk is still the default;
- signed webhook handling lacks byte-ingestion, checksum, and version-proof evidence; and
- no production fail-closed durable-storage configuration proves this topology at startup.

Until those gaps are remediated and evidenced, **overall status is REMEDIATION REQUIRED** and
**B2 is BLOCKED — HUMAN OR EXTERNAL DECISION REQUIRED**.