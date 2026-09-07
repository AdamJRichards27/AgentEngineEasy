# ADR 0001: Production Storage Topology

**Status:** Accepted and implemented for the production S3-compatible provider; external provider
controls and operational evidence remain required.
**Decision:** PostgreSQL is the authoritative operational record store. Generated and signed
document bytes must be held separately in durable S3/GCS-compatible object storage. Local disk is
development/test only and must not be used as the production system of record.

## Context

The current object-storage implementation defaults to `OBJECT_STORAGE_PROVIDER=local` and writes
to `OBJECT_STORAGE_LOCAL_DIR`. That location is suitable for local development and automated
testing, but it is not a durable production service, does not establish off-host durability, and
must not be selected in production. Document metadata and operational workflow records require
transactional, queryable storage, while generated/signed bytes require the implemented
S3-compatible adapter plus externally configured durability and lifecycle controls.

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
4. Production configuration and startup must fail closed if durable object-store configuration,
   credentials, encryption profile, or a bounded storage readiness probe is absent or invalid.
   Backup/restore controls and scheduled evidence remain an external operational gate.
5. Webhook processing that creates or updates regulated/document evidence must not represent a
   callback as complete until durable ingestion and recorded checksum/version provenance have
   succeeded.

## Consequences and operational requirements

The durable adapter now provides S3-compatible HTTPS/SigV4 access, per-object SSE headers,
server-generated tenant keys, SHA-256 verification, immutable application-level versions,
quarantine state, and storage readiness. `docs/DURABLE_DOCUMENT_STORAGE_OPERATOR_GUIDE.md`
defines the operator contract.

This does not make a provider account durable by itself. Before production use, the provider and
operations owners must configure a private bucket and HTTPS endpoint, scoped credentials, SSE/KMS,
native bucket versioning, retention/legal-hold policy, audit/network/CORS controls, offsite
recovery, readiness alerting, and a tested restore/migration plan. Application retention and
quarantine metadata do not replace provider-level retention or access controls.

Until those external controls are configured and evidenced, production use remains **REMEDIATION
REQUIRED** and **B2 is BLOCKED — HUMAN OR EXTERNAL DECISION REQUIRED**.