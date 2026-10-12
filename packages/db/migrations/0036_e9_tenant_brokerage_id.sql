-- E-9 migration 0036. OA-E9-1 prepares this file. Do not apply it outside CI.
--
-- D-1/D-2: brokerage_id on appraisals and communication_participants only.
-- Comparable sales and market competition are unchanged.
-- D-3/D-4: nullable add, backfill from the parent, then NOT NULL.
-- A missing parent raises. Do not guess a brokerage.
-- D-5/D-6: composite foreign keys keep the stored brokerage equal to the
-- parent, and equal to parties.brokerage_id when party_id is set.
-- D-7: brokerage-leading indexes. Existing property, thread, and party
-- indexes are not dropped.
-- One transaction with the rest of this migrator run. Statement breakpoints
-- only split executes; they do not commit early.
ALTER TABLE "parties" ADD CONSTRAINT "parties_id_brokerage_uq" UNIQUE("id","brokerage_id");--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_id_brokerage_uq" UNIQUE("id","brokerage_id");--> statement-breakpoint
ALTER TABLE "communication_threads" ADD CONSTRAINT "communication_threads_id_brokerage_uq" UNIQUE("id","brokerage_id");--> statement-breakpoint
ALTER TABLE "appraisals" ADD COLUMN "brokerage_id" integer;--> statement-breakpoint
ALTER TABLE "communication_participants" ADD COLUMN "brokerage_id" integer;--> statement-breakpoint
UPDATE "appraisals" AS appraisal
SET "brokerage_id" = property."brokerage_id"
FROM "properties" AS property
WHERE appraisal."property_id" = property."id"
  AND appraisal."brokerage_id" IS NULL;--> statement-breakpoint
UPDATE "communication_participants" AS participant
SET "brokerage_id" = thread."brokerage_id"
FROM "communication_threads" AS thread
WHERE participant."thread_id" = thread."id"
  AND participant."brokerage_id" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "appraisals" WHERE "brokerage_id" IS NULL) THEN
    RAISE EXCEPTION '0036 stopped: appraisals.brokerage_id backfill left NULL rows. A property parent is missing. Do not guess a brokerage.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "appraisals" AS appraisal
    JOIN "parties" AS party ON party."id" = appraisal."party_id"
    WHERE appraisal."party_id" IS NOT NULL
      AND party."brokerage_id" IS DISTINCT FROM appraisal."brokerage_id"
  ) THEN
    RAISE EXCEPTION '0036 stopped: appraisals.party_id points at another brokerage. Fix those rows before apply.';
  END IF;
  IF EXISTS (SELECT 1 FROM "communication_participants" WHERE "brokerage_id" IS NULL) THEN
    RAISE EXCEPTION '0036 stopped: communication_participants.brokerage_id backfill left NULL rows. A thread parent is missing. Do not guess a brokerage.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "communication_participants" AS participant
    JOIN "parties" AS party ON party."id" = participant."party_id"
    WHERE participant."party_id" IS NOT NULL
      AND party."brokerage_id" IS DISTINCT FROM participant."brokerage_id"
  ) THEN
    RAISE EXCEPTION '0036 stopped: communication_participants.party_id points at another brokerage. Fix those rows before apply.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "appraisals" ALTER COLUMN "brokerage_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "communication_participants" ALTER COLUMN "brokerage_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_property_brokerage_fk" FOREIGN KEY ("property_id","brokerage_id") REFERENCES "public"."properties"("id","brokerage_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_party_brokerage_fk" FOREIGN KEY ("party_id","brokerage_id") REFERENCES "public"."parties"("id","brokerage_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_participants" ADD CONSTRAINT "communication_participants_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_participants" ADD CONSTRAINT "communication_participants_thread_brokerage_fk" FOREIGN KEY ("thread_id","brokerage_id") REFERENCES "public"."communication_threads"("id","brokerage_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_participants" ADD CONSTRAINT "communication_participants_party_brokerage_fk" FOREIGN KEY ("party_id","brokerage_id") REFERENCES "public"."parties"("id","brokerage_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appraisals_brokerage_idx" ON "appraisals" USING btree ("brokerage_id");--> statement-breakpoint
CREATE INDEX "communication_participants_brokerage_idx" ON "communication_participants" USING btree ("brokerage_id");
