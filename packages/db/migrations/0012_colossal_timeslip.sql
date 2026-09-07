CREATE TABLE "document_object_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"package_id" integer,
	"storage_object_key" text NOT NULL,
	"version" integer NOT NULL,
	"previous_version_id" integer,
	"original_filename" text NOT NULL,
	"display_filename" text NOT NULL,
	"declared_mime_type" text NOT NULL,
	"detected_mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"source_provider" text,
	"provider_document_id" text,
	"webhook_verified" boolean DEFAULT false NOT NULL,
	"uploaded_by" integer,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"replacement_reason" text,
	"retention_class" text DEFAULT 'legal-pending' NOT NULL,
	"retention_status" text DEFAULT 'Active' NOT NULL,
	"retain_until" timestamp,
	"object_status" text DEFAULT 'Active' NOT NULL,
	"quarantined_at" timestamp,
	"deleted_at" timestamp,
	"destroyed_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "document_object_versions_document_id_version_unique" UNIQUE("document_id","version"),
	CONSTRAINT "document_object_versions_storage_object_key_unique" UNIQUE("storage_object_key")
);
--> statement-breakpoint
ALTER TABLE "document_object_versions" ADD CONSTRAINT "document_object_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_object_versions" ADD CONSTRAINT "document_object_versions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_object_versions" ADD CONSTRAINT "document_object_versions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_object_versions" ADD CONSTRAINT "document_object_versions_package_id_document_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."document_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_object_versions" ADD CONSTRAINT "document_object_versions_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_object_versions" ADD CONSTRAINT "document_object_versions_previous_version_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."document_object_versions"("id") ON DELETE no action ON UPDATE no action;