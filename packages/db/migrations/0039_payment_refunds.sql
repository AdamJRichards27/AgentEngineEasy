-- 0039 payment refund ledger (orchestrator/specs/partial-refund-ledger.md).
-- Renumbered from the provisional 0037 (Owner t179u, slice 1): the journal `when` must be later
-- than M3 0037 (1792837396131) and 0038 (1792883726127), or Drizzle silently skips this file on any
-- database that already applied them. `when` = 1792908000000 (25 Oct 2026 16:00 AEST).
-- GATED: LOCAL development and scratch databases only. NOT applied to Replit, staging, pilot or
-- production. Applying it to any shared environment needs separate Owner approval.
-- Additive: a new table and a new defaulted column. Backfill: rows already 'Refunded' were full
-- refunds under the old code path (any refund set status Refunded), so refunded_cents = amount_cents.
-- That is conservative: it blocks further refunds on historical rows.
-- Rollback: packages/db/rollback/0039_payment_refunds.down.sql.
CREATE TABLE "payment_refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_id" integer NOT NULL,
	"brokerage_id" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider" text NOT NULL,
	"provider_refund_ref" text,
	"failure_reason" text,
	"reason" text,
	"requested_by_user_id" integer,
	"submitted_at" timestamp,
	"resolved_at" timestamp,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"next_reconcile_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payment_refunds_provider_refund_ref_unique" UNIQUE("provider_refund_ref"),
	CONSTRAINT "payment_refunds_amount_positive" CHECK ("amount_cents" > 0),
	CONSTRAINT "payment_refunds_status_check" CHECK ("status" IN ('PENDING','SUBMITTED','SUCCEEDED','FAILED','UNKNOWN','MANUAL_REVIEW'))
);
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_refunds_payment_idx" ON "payment_refunds" ("payment_id", "status");--> statement-breakpoint
CREATE INDEX "payment_refunds_reconcile_idx" ON "payment_refunds" ("status", "next_reconcile_at");--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "payments" SET "refunded_cents" = "amount_cents" WHERE "status" = 'Refunded' AND "refunded_cents" = 0;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refunded_cents_range" CHECK ("refunded_cents" >= 0 AND "refunded_cents" <= "amount_cents");
