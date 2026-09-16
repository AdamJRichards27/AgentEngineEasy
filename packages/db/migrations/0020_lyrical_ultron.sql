ALTER TABLE "grow_contact_channel_consents" DROP CONSTRAINT "grow_contact_channel_consents_inferred_evidence_check";--> statement-breakpoint
ALTER TABLE "grow_consent_policy_versions" ADD COLUMN "allow_not_required_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD COLUMN "inferred_evidence_reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD COLUMN "inferred_evidence_reviewed_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD CONSTRAINT "grow_contact_channel_consents_inferred_evidence_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("inferred_evidence_reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD CONSTRAINT "grow_contact_channel_consents_inferred_evidence_check" CHECK (state <> 'INFERRED' OR (
        length(trim(coalesce(inferred_reasoning, ''))) > 0
        AND length(trim(coalesce(evidence_reference, ''))) > 0
        AND relationship_evidence IS NOT NULL
        AND inferred_evidence_reviewed_at IS NOT NULL
        AND inferred_evidence_reviewed_by_user_id IS NOT NULL
      ));