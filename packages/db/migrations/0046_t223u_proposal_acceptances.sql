-- Owner t223u (31 Oct 2026): proposal acceptance evidence. PREPARED ONLY — not applied to any
-- shared/staging/production database. Numbered 0046 to sit after #245's 0037-0045; the journal
-- entry must be re-sequenced when this lands after #245 (see PR #282 notes). Additive, no backfill.
CREATE TABLE "proposal_acceptances" (
  "id" serial PRIMARY KEY,
  "brokerage_id" integer NOT NULL REFERENCES "brokerages"("id"),
  "appraisal_id" integer NOT NULL REFERENCES "appraisals"("id"),
  "property_id" integer NOT NULL REFERENCES "properties"("id"),
  "acceptor_capacity" text NOT NULL,
  "acceptor_party_id" integer REFERENCES "parties"("id"),
  "acceptor_name" text NOT NULL,
  "authority_basis" text,
  "evidence_type" text NOT NULL,
  "evidence_reference" text NOT NULL,
  "evidence_document_id" integer,
  "accepted_at" timestamp with time zone NOT NULL,
  "recorded_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "withdrawn_at" timestamp with time zone,
  "withdrawn_by_user_id" integer REFERENCES "users"("id"),
  "withdrawn_reason" text,
  CONSTRAINT "proposal_acceptances_capacity_chk" CHECK ("acceptor_capacity" IN ('OWNER','AUTHORISED_REPRESENTATIVE')),
  CONSTRAINT "proposal_acceptances_evidence_type_chk" CHECK ("evidence_type" IN ('SIGNED_ACCEPTANCE','EMAIL','RECORDED_CALL','IN_PERSON_WITNESSED','OTHER')),
  CONSTRAINT "proposal_acceptances_status_chk" CHECK ("status" IN ('ACTIVE','WITHDRAWN')),
  CONSTRAINT "proposal_acceptances_rep_authority_chk" CHECK ("acceptor_capacity" <> 'AUTHORISED_REPRESENTATIVE' OR length(btrim(coalesce("authority_basis",''))) > 0),
  CONSTRAINT "proposal_acceptances_evidence_ref_chk" CHECK (length(btrim("evidence_reference")) > 0),
  CONSTRAINT "proposal_acceptances_not_future_chk" CHECK ("accepted_at" <= "recorded_at" + interval '5 minutes'),
  CONSTRAINT "proposal_acceptances_withdrawn_chk" CHECK (("status" = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "proposal_acceptances_property_idx" ON "proposal_acceptances" ("brokerage_id","property_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_acceptances_one_active_idx" ON "proposal_acceptances" ("appraisal_id") WHERE "status" = 'ACTIVE';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION proposal_acceptances_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'proposal_acceptances is append-only (withdraw instead of delete)'; END IF;
  IF OLD.status = 'WITHDRAWN' OR NEW.status <> 'WITHDRAWN'
     OR (NEW.brokerage_id, NEW.appraisal_id, NEW.property_id, NEW.acceptor_capacity, NEW.acceptor_party_id, NEW.acceptor_name,
         NEW.authority_basis, NEW.evidence_type, NEW.evidence_reference, NEW.evidence_document_id, NEW.accepted_at,
         NEW.recorded_by_user_id, NEW.recorded_at)
        IS DISTINCT FROM
        (OLD.brokerage_id, OLD.appraisal_id, OLD.property_id, OLD.acceptor_capacity, OLD.acceptor_party_id, OLD.acceptor_name,
         OLD.authority_basis, OLD.evidence_type, OLD.evidence_reference, OLD.evidence_document_id, OLD.accepted_at,
         OLD.recorded_by_user_id, OLD.recorded_at)
  THEN RAISE EXCEPTION 'proposal_acceptances: only ACTIVE -> WITHDRAWN is allowed'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER proposal_acceptances_append_only_trg BEFORE UPDATE OR DELETE ON "proposal_acceptances"
  FOR EACH ROW EXECUTE FUNCTION proposal_acceptances_append_only();
