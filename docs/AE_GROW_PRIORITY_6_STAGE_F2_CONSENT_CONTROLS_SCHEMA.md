# AE GROW Priority 6 Stage F2 — Consent controls schema (step 1)

This note describes the provider-neutral data model delivered in step 1. It
does not claim that a policy value is legal advice, does not contact a DNCR,
and does not enable sending, calling, recording, or a live vendor.

## Tables and columns

All five new tables carry `brokerageId` and are read through a
`brokerageId`-scoped query. Foreign-key IDs supplied to the supporting
library are re-resolved under the same brokerage before they are used. This
is the existing application-level tenant convention in this repository;
PostgreSQL foreign keys alone do not prove that two independently supplied
IDs belong to the same tenant.

### `grow_contact_channel_consents`

Append-only consent capture events for one `brokerageId` + `partyId` +
`channel` + `purpose` + `scope`. `state` defaults to `UNKNOWN` and is one of `EXPRESS`,
`INFERRED`, `NONE`, `WITHDRAWN`, `UNKNOWN`, or `NOT_REQUIRED`.

* `source`, `capturedAt`, `captureMethod`, `purpose`, and `scope` describe how
  the event was captured.
* `evidenceReference` and `evidence` point to capture evidence without storing
  audio or a vendor payload.
* `jurisdiction` is the captured jurisdiction and may be unknown.
* `recordedByUserId` is the recording actor.
* `withdrawnAt`, `withdrawnByUserId`, and `withdrawalReason` explain a
  withdrawal; `expiresAt` and `reviewAt` support expiry/review controls.
* `inferredReasoning`, `relationshipEvidence`, a durable `evidenceReference`,
  `inferredEvidenceReviewedAt`, and `inferredEvidenceReviewedByUserId` are
  required for `INFERRED`. A presumed relationship or unreviewed relationship
  evidence is rejected by the library and the database check.
* `notRequiredJustification` is required for `NOT_REQUIRED`.
* `supersedesConsentId` links a later event to the append-latest matching
  purpose/scope event without mutating either row. Every append after the
  first must carry that link. Withdrawals must supersede that canonical event;
  a withdrawn stream rejects all later appends (step 1 has no re-consent flow).
* `capturedAt` is evidence metadata only. Canonical selection uses serial
  append order (`id` descending), never a caller-provided capture time.

### `grow_consent_policy_versions`

Versioned, tenant-scoped policy configuration. AU and NZ are separate rows,
identified by `jurisdiction` + `version`; no route contains jurisdiction
conditionals. The row includes `allowInferredConsent`, explicit
`allowNotRequiredConsent`, `dncrRequired`, `suppressionEnabled`, `timeZone`,
allowed-hours start/end, quiet-hours start/end, and a free-form `policyData`
snapshot for reviewed extensions. `effectiveAt` and `retiredAt` select the
canonical current version; callers cannot select an arbitrary policy version.
Missing or invalid `effectiveAt`, missing explicit `dncrRequired`, and caller
policy overrides are rejected/review-required. Missing timezone or allowed-hours
configuration is review-required (there is no default Brisbane timezone).

`apps/api/src/lib/consentPolicyTemplates.ts` exposes separate, non-seeded
`GROW_AU_CONSENT_POLICY_TEMPLATE` and `GROW_NZ_CONSENT_POLICY_TEMPLATE`
objects. Both use conservative `dncrRequired: true`,
`allowInferredConsent: false`, `allowNotRequiredConsent: false`, and
`suppressionEnabled: true`. Their identifiers and jurisdictions are distinct.
Both deliberately leave timezone and allowed-hours fields `null` until
jurisdiction-specific review approves them; callers may spread either object
into `recordConsentPolicy` with their brokerage, effective time, and actor.
The evaluator therefore returns `POLICY_INVALID_WINDOW` rather than treating a
template as eligible. The templates describe AU's multiple timezone/DST
considerations separately from NZ's timezone/DST considerations and make no
legal or operational default claim.

### `grow_contact_dncr_statuses`

Append-only, provider-neutral DNCR observations for a contact/channel:
`status` (`CLEARED`, `LISTED`, `UNKNOWN`, or `NOT_CHECKED`), check time,
validity/review times, jurisdiction, source, reference, and optional
response metadata. A `CLEARED` row requires a reference, validity timestamp,
and review timestamp. The gate also requires matching jurisdiction, non-future
check time, active validity, and a non-due review time. The row is suitable for
deterministic mocks; it is not a DNCR integration.

### `grow_contact_channel_suppressions`

Append-only suppression events with `SUPPRESSED` or `RELEASED` state, reason,
effective/expiry time, reference, and actor. The latest append event effective
at evaluation time for the tenant/contact/channel is used; a suppression is a hard block unless a
reviewed policy version explicitly disables suppression handling.

### `grow_consent_decisions`

Immutable, insert-only decision evidence. It records `decision`
(`ELIGIBLE`, `BLOCKED`, or `REVIEW_REQUIRED`), one `reasonCode`, all
`reasonCodes`, the selected consent/DNCR/suppression/policy row IDs, policy
and jurisdiction snapshots, decision actor/time, and complete consent, DNCR,
suppression, policy, request, and evaluation JSON snapshots. The supported
library never updates or deletes this table and also writes the existing audit
logger with tenant context in the same transaction.

## Exact SQL column inventory

The current generated schema contains these columns (SQL names, including
nullable control fields):

* `grow_contact_channel_consents`: `id`, `brokerage_id`, `party_id`, `channel`,
  `state`, `source`, `captured_at`, `capture_method`, `purpose`, `scope`,
  `evidence_reference`, `evidence`, `jurisdiction`, `recorded_by_user_id`,
  `expires_at`, `review_at`, `withdrawn_at`, `withdrawn_by_user_id`,
  `withdrawal_reason`, `inferred_reasoning`, `relationship_evidence`,
  `inferred_evidence_reviewed_at`, `inferred_evidence_reviewed_by_user_id`,
  `not_required_justification`, `supersedes_consent_id`, `created_at`.
* `grow_consent_policy_versions`: `id`, `brokerage_id`, `jurisdiction`,
  `version`, `effective_at`, `retired_at`, `allow_inferred_consent`,
  `allow_not_required_consent`, `dncr_required`, `suppression_enabled`,
  `time_zone`, `allowed_hours_start`, `allowed_hours_end`, `quiet_hours_start`,
  `quiet_hours_end`, `policy_data`, `recorded_by_user_id`, `created_at`.
* `grow_contact_dncr_statuses`: `id`, `brokerage_id`, `party_id`, `channel`,
  `jurisdiction`, `status`, `checked_at`, `valid_until`, `review_at`, `source`,
  `reference`, `response_metadata`, `recorded_by_user_id`, `created_at`.
* `grow_contact_channel_suppressions`: `id`, `brokerage_id`, `party_id`,
  `channel`, `state`, `reason`, `effective_at`, `expires_at`, `reference`,
  `recorded_by_user_id`, `created_at`.
* `grow_consent_decisions`: `id`, `brokerage_id`, `party_id`, `channel`,
  `decision`, `reason_code`, `reason_codes`, `consent_id`, `dncr_status_id`,
  `suppression_id`, `policy_version_id`, `jurisdiction`, `policy_version`,
  `evaluated_at`, `decided_by_user_id`, `evidence`, `created_at`.
* Existing `audit_logs` used by these controls: `id`, `brokerage_id`, `user_id`,
  `user_email`, `action`, `record_type`, `record_id`, `property_id`,
  `previous_value`, `updated_value`, `provider_reference`, `created_at`.

## Decision assumptions

The pure decision gate fails closed:

* missing/unknown consent or jurisdiction is review-required; caller
  jurisdiction cannot supply a missing consent jurisdiction;
* withdrawal, missing valid cleared DNCR where the selected policy requires
  it, suppression, and outside-hours sends are blocked;
* express consent can be eligible after the configured checks;
* inferred consent can be eligible only when a policy version enables it and
  durable, reviewed relationship evidence is supplied;
* `NOT_REQUIRED` is eligible only with a recorded justification and explicit
  policy enablement;
* expired/review-due consent and unknown/due/invalid DNCR status require
  review.

Hours are evaluated in the policy's configured timezone and support
midnight-wrapping windows. All supported source writes and decision reads plus
their audit insert use one transaction; a tenant-scoped PostgreSQL advisory
transaction lock serializes source writers and evaluator reads, and strict
audit failures roll back the source/decision write. The library is the
append-only boundary, but because this step does not hand-edit migrations or
install DB triggers, direct database-admin `UPDATE`/`DELETE` writes are not
prevented by the database itself. The implementation uses no live capability,
credential, SDK, real vendor, route, or UI.