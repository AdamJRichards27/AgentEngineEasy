CREATE TABLE "appraisal_comparable_sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"appraisal_id" integer NOT NULL,
	"address" text NOT NULL,
	"sale_price" numeric(12, 2),
	"sale_date" timestamp,
	"bedrooms" integer,
	"bathrooms" integer,
	"car_spaces" integer,
	"land_size_sqm" numeric(10, 2),
	"property_type" text,
	"notes" text,
	"image_url" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_provenance" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appraisal_market_competition" (
	"id" serial PRIMARY KEY NOT NULL,
	"appraisal_id" integer NOT NULL,
	"address" text NOT NULL,
	"asking_price_display" text,
	"asking_price_low" numeric(12, 2),
	"asking_price_high" numeric(12, 2),
	"status" text,
	"days_on_market" integer,
	"attributes_summary" text,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_provenance" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "party_id" integer;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "opportunity_id" integer;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "owner_user_id" integer;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "created_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "status" text DEFAULT 'DRAFT' NOT NULL;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "price_range_currency" text DEFAULT 'AUD' NOT NULL;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "pricing_commentary" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "market_position_narrative" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "selling_strategy" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "marketing_proposal" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "commission_rate_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "commission_proposal" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "recommended_next_steps" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "appointment_at" timestamp;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "presentation_at" timestamp;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "viewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "follow_up_at" timestamp;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "follow_up_notes" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "outcome_reason" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "outcome_notes" text;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "outcome_at" timestamp;--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "presentation_document_id" integer;--> statement-breakpoint
ALTER TABLE "appraisal_comparable_sales" ADD CONSTRAINT "appraisal_comparable_sales_appraisal_id_appraisals_id_fk" FOREIGN KEY ("appraisal_id") REFERENCES "public"."appraisals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_market_competition" ADD CONSTRAINT "appraisal_market_competition_appraisal_id_appraisals_id_fk" FOREIGN KEY ("appraisal_id") REFERENCES "public"."appraisals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;