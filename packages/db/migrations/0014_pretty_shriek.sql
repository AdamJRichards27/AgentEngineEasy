CREATE TABLE "grow_commitments" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"property_id" integer,
	"opportunity_id" integer,
	"description" text NOT NULL,
	"due_at" timestamp NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"completed_at" timestamp,
	"completed_by_user_id" integer,
	"cancelled_at" timestamp,
	"cancel_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_contact_relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"related_party_id" integer NOT NULL,
	"relationship_type" text NOT NULL,
	"note" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_contact_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"role" text NOT NULL,
	"assigned_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grow_commitments" ADD CONSTRAINT "grow_commitments_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_commitments" ADD CONSTRAINT "grow_commitments_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_commitments" ADD CONSTRAINT "grow_commitments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_commitments" ADD CONSTRAINT "grow_commitments_opportunity_id_grow_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."grow_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_commitments" ADD CONSTRAINT "grow_commitments_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_commitments" ADD CONSTRAINT "grow_commitments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_relationships" ADD CONSTRAINT "grow_contact_relationships_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_relationships" ADD CONSTRAINT "grow_contact_relationships_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_relationships" ADD CONSTRAINT "grow_contact_relationships_related_party_id_parties_id_fk" FOREIGN KEY ("related_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_relationships" ADD CONSTRAINT "grow_contact_relationships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_roles" ADD CONSTRAINT "grow_contact_roles_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_roles" ADD CONSTRAINT "grow_contact_roles_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_roles" ADD CONSTRAINT "grow_contact_roles_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grow_commitments_brokerage_party_idx" ON "grow_commitments" USING btree ("brokerage_id","party_id");--> statement-breakpoint
CREATE INDEX "grow_commitments_brokerage_status_due_idx" ON "grow_commitments" USING btree ("brokerage_id","status","due_at");--> statement-breakpoint
CREATE INDEX "grow_commitments_property_idx" ON "grow_commitments" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "grow_commitments_opportunity_idx" ON "grow_commitments" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "grow_contact_relationships_brokerage_party_idx" ON "grow_contact_relationships" USING btree ("brokerage_id","party_id");--> statement-breakpoint
CREATE INDEX "grow_contact_relationships_related_party_idx" ON "grow_contact_relationships" USING btree ("related_party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grow_contact_roles_party_role_unique" ON "grow_contact_roles" USING btree ("party_id","role");--> statement-breakpoint
CREATE INDEX "grow_contact_roles_brokerage_party_idx" ON "grow_contact_roles" USING btree ("brokerage_id","party_id");
