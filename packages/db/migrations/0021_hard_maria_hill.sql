ALTER TABLE "document_object_versions" ALTER COLUMN "property_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "property_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "brokerage_id" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "logical_owner_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "logical_owner_id" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_logical_owner_unique" ON "documents" USING btree ("brokerage_id","logical_owner_type","logical_owner_id");