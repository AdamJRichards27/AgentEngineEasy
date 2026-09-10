ALTER TABLE "communication_messages" ALTER COLUMN "property_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "communication_threads" ALTER COLUMN "property_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD COLUMN "party_id" integer;--> statement-breakpoint
ALTER TABLE "communication_threads" ADD COLUMN "party_id" integer;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_threads" ADD CONSTRAINT "communication_threads_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "communication_messages_party_id_idx" ON "communication_messages" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "communication_threads_party_id_idx" ON "communication_threads" USING btree ("party_id");--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_property_or_party_check" CHECK (property_id IS NOT NULL OR party_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "communication_threads" ADD CONSTRAINT "communication_threads_property_or_party_check" CHECK (property_id IS NOT NULL OR party_id IS NOT NULL);