CREATE TABLE "platform_owners" (
  "user_id" integer PRIMARY KEY REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "platform_owner_audit" (
  "id" serial PRIMARY KEY,
  "owner_user_id" integer NOT NULL REFERENCES "users"("id"),
  "brokerage_id" integer REFERENCES "brokerages"("id"),
  "action" text NOT NULL,
  "method" text NOT NULL,
  "surface" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "platform_owner_audit_owner_time_idx" ON "platform_owner_audit" ("owner_user_id", "created_at");
