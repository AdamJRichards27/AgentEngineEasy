-- M3 revocable offer links (Owner t165u: approved for DEVELOPMENT AND REVIEW
-- as a pre-pilot capability). NOT EXECUTED in staging or production: that
-- needs separate Owner approval. Tested only on a local scratch PG16.
-- Migration number 0037 is a development placeholder: the local, unpublished
-- refund ledger (0037_payment_refunds, M5) and the PL-04 0035 repair proposal
-- also use 0037. Whichever is approved second is regenerated with
-- `db:generate` to the next number.
--
-- Additive only: one new table. offers.share_token is not altered or
-- rewritten. Every existing token is copied in as an active link with no
-- expiry, issued at the offer's created_at, so links already sent keep
-- working until revoked. Rollback: docs/migrations/M3-offer-share-links-ROLLBACK.md.
CREATE TABLE "offer_share_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"offer_id" integer NOT NULL,
	"token" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"issued_by_user_id" integer,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by_user_id" integer,
	"revoke_reason" text,
	CONSTRAINT "offer_share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "offer_share_links" ADD CONSTRAINT "offer_share_links_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_share_links_offer_idx" ON "offer_share_links" USING btree ("offer_id");
--> statement-breakpoint
-- Data preservation backfill: one active, non-expiring link per existing token.
INSERT INTO "offer_share_links" ("offer_id", "token", "issued_at")
SELECT "id", "share_token", "created_at" FROM "offers" WHERE "share_token" IS NOT NULL
ON CONFLICT ("token") DO NOTHING;
