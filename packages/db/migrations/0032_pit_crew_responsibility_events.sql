CREATE TABLE "pit_crew_responsibility_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"assignment_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"kind" text NOT NULL,
	"reason_category" text NOT NULL,
	"severity" text,
	"note" text,
	"next_action" text NOT NULL,
	"originating_user_id" integer NOT NULL,
	"recipient_user_id" integer,
	"recipient_role" text,
	"resulting_responsibility" text NOT NULL,
	"expected_response_at" timestamp,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"acknowledged_at" timestamp,
	"acknowledged_by_user_id" integer,
	"closed_at" timestamp,
	"closed_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pit_crew_responsibility_events_kind_check" CHECK ("pit_crew_responsibility_events"."kind" in ('HAND_BACK', 'ESCALATION')),
	CONSTRAINT "pit_crew_responsibility_events_status_check" CHECK ("pit_crew_responsibility_events"."status" in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'RETURNED', 'SUPERSEDED')),
	CONSTRAINT "pit_crew_responsibility_events_resulting_responsibility_check" CHECK ("pit_crew_responsibility_events"."resulting_responsibility" in ('AGENT', 'BROKERAGE_ADMINISTRATOR')),
	CONSTRAINT "pit_crew_responsibility_events_one_recipient_check" CHECK (("pit_crew_responsibility_events"."recipient_user_id" is not null)::int + ("pit_crew_responsibility_events"."recipient_role" is not null)::int = 1),
	CONSTRAINT "pit_crew_responsibility_events_hand_back_shape_check" CHECK ("pit_crew_responsibility_events"."kind" <> 'HAND_BACK' OR (
        "pit_crew_responsibility_events"."severity" is null
        and "pit_crew_responsibility_events"."expected_response_at" is null
        and "pit_crew_responsibility_events"."resulting_responsibility" = 'AGENT'
        and "pit_crew_responsibility_events"."status" in ('OPEN', 'SUPERSEDED')
      )),
	CONSTRAINT "pit_crew_responsibility_events_escalation_shape_check" CHECK ("pit_crew_responsibility_events"."kind" <> 'ESCALATION' OR (
        "pit_crew_responsibility_events"."severity" is not null
        and "pit_crew_responsibility_events"."severity" in ('ATTENTION', 'AT_RISK', 'CRITICAL')
        and "pit_crew_responsibility_events"."resulting_responsibility" = 'BROKERAGE_ADMINISTRATOR'
        and "pit_crew_responsibility_events"."status" in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'RETURNED')
      )),
	CONSTRAINT "pit_crew_responsibility_events_next_action_check" CHECK (char_length(trim("pit_crew_responsibility_events"."next_action")) > 0),
	CONSTRAINT "pit_crew_responsibility_events_reason_nonempty_check" CHECK (char_length(trim("pit_crew_responsibility_events"."reason_category")) > 0),
	CONSTRAINT "pit_crew_responsibility_events_recipient_role_check" CHECK ("pit_crew_responsibility_events"."recipient_role" is null or "pit_crew_responsibility_events"."recipient_role" = 'Brokerage Administrator'),
	CONSTRAINT "pit_crew_responsibility_events_acknowledgement_check" CHECK ((
        "pit_crew_responsibility_events"."acknowledged_at" is null
        and "pit_crew_responsibility_events"."acknowledged_by_user_id" is null
      ) or (
        "pit_crew_responsibility_events"."acknowledged_at" is not null
        and "pit_crew_responsibility_events"."acknowledged_by_user_id" is not null
        and "pit_crew_responsibility_events"."status" in ('ACKNOWLEDGED', 'RESOLVED', 'RETURNED')
      )),
	CONSTRAINT "pit_crew_responsibility_events_closed_check" CHECK ((
        "pit_crew_responsibility_events"."status" in ('OPEN', 'ACKNOWLEDGED')
        and "pit_crew_responsibility_events"."closed_at" is null
        and "pit_crew_responsibility_events"."closed_by_user_id" is null
      ) or (
        "pit_crew_responsibility_events"."status" in ('RESOLVED', 'RETURNED', 'SUPERSEDED')
        and "pit_crew_responsibility_events"."closed_at" is not null
        and "pit_crew_responsibility_events"."closed_by_user_id" is not null
      )),
	CONSTRAINT "pit_crew_responsibility_events_reason_category_check" CHECK ((
        "pit_crew_responsibility_events"."kind" = 'HAND_BACK'
        and "pit_crew_responsibility_events"."reason_category" in ('WORK_COMPLETE', 'NEXT_ACTION_WITH_AGENT', 'INFORMATION_RETURNED', 'NOT_PIT_CREW_WORK')
      ) or (
        "pit_crew_responsibility_events"."kind" = 'ESCALATION'
        and "pit_crew_responsibility_events"."reason_category" in ('BLOCKED_DEPENDENCY', 'OVERDUE_THIRD_PARTY', 'SETTLEMENT_OR_COMPLIANCE_RISK', 'MISSING_AUTHORITY', 'MISSING_INFORMATION', 'OTHER_MATERIAL_EXCEPTION')
      ))
);
--> statement-breakpoint
ALTER TABLE "pit_crew_responsibility_events" ADD CONSTRAINT "pit_crew_responsibility_events_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_responsibility_events" ADD CONSTRAINT "pit_crew_responsibility_events_assignment_id_pit_crew_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."pit_crew_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_responsibility_events" ADD CONSTRAINT "pit_crew_responsibility_events_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_responsibility_events" ADD CONSTRAINT "pit_crew_responsibility_events_originating_user_id_users_id_fk" FOREIGN KEY ("originating_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_responsibility_events" ADD CONSTRAINT "pit_crew_responsibility_events_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_responsibility_events" ADD CONSTRAINT "pit_crew_responsibility_events_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_crew_responsibility_events" ADD CONSTRAINT "pit_crew_responsibility_events_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pit_crew_responsibility_events_one_open_uidx" ON "pit_crew_responsibility_events" USING btree ("assignment_id") WHERE "pit_crew_responsibility_events"."status" in ('OPEN', 'ACKNOWLEDGED');--> statement-breakpoint
CREATE INDEX "pit_crew_responsibility_events_brokerage_recipient_idx" ON "pit_crew_responsibility_events" USING btree ("brokerage_id","recipient_user_id","status");--> statement-breakpoint
CREATE INDEX "pit_crew_responsibility_events_brokerage_role_idx" ON "pit_crew_responsibility_events" USING btree ("brokerage_id","recipient_role","status");--> statement-breakpoint
CREATE INDEX "pit_crew_responsibility_events_assignment_created_idx" ON "pit_crew_responsibility_events" USING btree ("assignment_id","created_at");--> statement-breakpoint
CREATE INDEX "pit_crew_responsibility_events_property_idx" ON "pit_crew_responsibility_events" USING btree ("property_id");