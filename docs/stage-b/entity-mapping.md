# Stage B.1 — Source Data -> Canonical Agent Engine Entity Mapping

Confirmed by direct inspection of the live Stage A schema before writing any
Stage B persistence code. No parallel entities are created.

## Canonical destination tables (existing, reused as-is)

| Concept                    | Table                | Key columns actually available |
|-----------------------------|-----------------------|--------------------------------|
| Contact / Person / Org      | `parties`             | firstName, middleName, lastName, organisationName, partyType, mobile, email, residentialAddress (single formatted string), entityDetails (jsonb — used for anything with no dedicated column: title, preferredName, alternateEmail, alternatePhone, notes) |
| Property                    | `properties`          | formattedAddress (NOT NULL), placeId (Google Places, nullable), suburb, state, postcode, isManualAddress (bool — manual addresses are first-class), agentId (NOT NULL — every property has an owning agent), brokerageId |
| Contact <-> Property relationship | `growRelationships` | partyId, propertyId, relationshipType (constrained to `GROW_RELATIONSHIP_TYPES`), role (free-text refinement), status (Active / Historical / PendingReview), isPrimary, confidenceScore, validFrom/validTo, sourceType (already includes "import" and "migration" as defined values), sourceId, sourceEvidence, createdBy |
| Organisation / Brokerage    | `brokerages`           | existing, unchanged |
| User / Agent                | `users`                | existing, unchanged — `role` in {"Agent","Brokerage Administrator"} |
| Activity                    | `growActivities`       | partyId/propertyId/opportunityId nullable, activityType, occurredAt, recordedAt, summary (required), details (jsonb), source (already supports "import"), sourceId |
| Import metadata              | NEW — see B.2          | `importJobs` / `importRecords` (do not exist yet, must be created) |

## Explicit non-duplication decisions

- Stage B never writes to `propertyParties`. That table is RUN's transaction-role
  model (Seller/Buyer/Solicitor/PowerOfAttorney for AML/agency-agreement
  purposes) and is a deliberately separate concern from Grow's relationship
  model per Stage A's own schema comments. Only `growRelationships` is Grow's
  CRM-relationship table and the only one Stage B populates.
- `GROW_RELATIONSHIP_TYPES` (owner, co_owner, former_owner, occupier, tenant,
  landlord, buyer, prospective_buyer, seller, prospective_seller,
  appraisal_contact, vendor, investor, developer, referrer, related_party,
  unknown_pending_review) is the only relationship vocabulary Stage B uses.
  No second taxonomy is introduced. Anything the importer cannot confidently
  classify maps to `unknown_pending_review` with `status: "PendingReview"`
  rather than being guessed — this exact behaviour is already anticipated in
  the Stage A schema comment on `growRelationships`.
- `sourceType: "import"` and `sourceId: "<importJobId>:<sourceRowNumber>"` on
  every `growRelationships` row created by an import gives full traceability
  back to the originating job without a separate join table for that purpose.
  `sourceEvidence` carries the original source column value.
- `properties.agentId` is NOT NULL, so every imported property is assigned to
  the importing user (the Brokerage Administrator or Agent who ran the
  import), matching the existing "+Start Property" ownership pattern.
- `parties.residentialAddress` and `properties.formattedAddress` are both
  single formatted strings, not structured components — normalisation
  produces a clean formatted string for storage; structured components are
  used only in-memory during matching, never as new schema.
- Entitlement keys already exist from Stage A's seed catalogue and are reused
  verbatim: `grow.import.execute` ("Run a Grow contact/property import job")
  gates job creation, mapping, confirm and rollback; `grow.import.review`
  ("Review and resolve import matches/merges without executing the import")
  additionally allows viewing preview/duplicates without commit rights.
  `grow.contacts.manage`, `grow.properties.link` and `grow.relationships.manage`
  describe the underlying writes an import performs but are not re-checked
  per-row — `grow.import.execute` is the single gate for the import
  operation as a whole, consistent with how the rest of Grow's API composes
  entitlement checks per endpoint rather than per side effect.
