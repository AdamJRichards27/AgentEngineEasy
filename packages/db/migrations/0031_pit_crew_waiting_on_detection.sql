CREATE TABLE "pit_crew_waiting_on_sweep_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"cadence_ms" integer DEFAULT 1800000 NOT NULL,
	"window_start" text DEFAULT '08:00' NOT NULL,
	"window_end" text DEFAULT '18:00' NOT NULL,
	"window_weekdays" text DEFAULT '1,2,3,4,5' NOT NULL,
	"time_zone" text,
	"attention_threshold_hours" integer DEFAULT 2 NOT NULL,
	"elevated_threshold_hours" integer DEFAULT 4 NOT NULL,
	"last_detection_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pit_crew_waiting_on_sweep_settings_brokerage_id_unique" UNIQUE("brokerage_id")
);
--> statement-breakpoint
CREATE TABLE "pit_crew_waiting_on_sweep_sightings" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"assignment_id" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"tier" text NOT NULL,
	"priority_exception" boolean NOT NULL,
	"surfaced_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pit_crew_waiting_on_sweep_settings" ADD CONSTRAINT "pit_crew_waiting_on_sweep_settings_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_waiting_on_sweep_sightings" ADD CONSTRAINT "pit_crew_waiting_on_sweep_sightings_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_waiting_on_sweep_sightings" ADD CONSTRAINT "pit_crew_waiting_on_sweep_sightings_assignment_id_pit_crew_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."pit_crew_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pit_crew_waiting_on_sweep_sightings_assignment_uidx" ON "pit_crew_waiting_on_sweep_sightings" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "pit_crew_waiting_on_sweep_sightings_brokerage_idx" ON "pit_crew_waiting_on_sweep_sightings" USING btree ("brokerage_id");