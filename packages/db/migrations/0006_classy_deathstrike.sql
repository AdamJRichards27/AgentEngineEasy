CREATE TABLE "pit_crew_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_record_id" text NOT NULL,
	"property_id" integer NOT NULL,
	"status" text DEFAULT 'UNCLAIMED' NOT NULL,
	"assigned_to_user_id" integer,
	"claimed_at" timestamp,
	"waiting_on_party" text,
	"waiting_on_note" text,
	"waiting_on_since" timestamp,
	"waiting_on_expected_at" timestamp,
	"handoff_from_user_id" integer,
	"handoff_to_user_id" integer,
	"handoff_note" text,
	"handoff_at" timestamp,
	"completed_at" timestamp,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pit_crew_assignments" ADD CONSTRAINT "pit_crew_assignments_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_assignments" ADD CONSTRAINT "pit_crew_assignments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_assignments" ADD CONSTRAINT "pit_crew_assignments_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_assignments" ADD CONSTRAINT "pit_crew_assignments_handoff_from_user_id_users_id_fk" FOREIGN KEY ("handoff_from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_assignments" ADD CONSTRAINT "pit_crew_assignments_handoff_to_user_id_users_id_fk" FOREIGN KEY ("handoff_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pit_crew_assignments_source_unique" ON "pit_crew_assignments" USING btree ("source_type","source_record_id");--> statement-breakpoint
CREATE INDEX "pit_crew_assignments_brokerage_status_idx" ON "pit_crew_assignments" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "pit_crew_assignments_assigned_to_idx" ON "pit_crew_assignments" USING btree ("assigned_to_user_id");--> statement-breakpoint
CREATE INDEX "pit_crew_assignments_property_idx" ON "pit_crew_assignments" USING btree ("property_id");