-- PROPOSED, NOT APPLIED, OPTIONAL (t228u Priority 3). Not in the journal.
-- property_parties.role is free text; the API validates it. Owner, Landlord and
-- Tenant need NO migration (no Postgres enum). This optional CHECK makes the
-- database refuse values the API would refuse. Apply only after audit query R1
-- shows no value outside this list (or those rows are approved for remapping).
-- NOT VALID + VALIDATE: the ADD takes a brief lock and skips the scan; VALIDATE
-- scans without blocking writes, and fails (changing nothing further) on a bad row.
ALTER TABLE "property_parties"
  ADD CONSTRAINT "property_parties_role_check"
  CHECK ("role" IN ('Seller','Buyer','Solicitor','PowerOfAttorney','Owner','Landlord','Tenant','Other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "property_parties" VALIDATE CONSTRAINT "property_parties_role_check";
