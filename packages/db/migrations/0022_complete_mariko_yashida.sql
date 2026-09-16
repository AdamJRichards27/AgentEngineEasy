ALTER TABLE "documents" ADD CONSTRAINT "documents_ownership_mode_check" CHECK ((
        (
          "documents"."property_id" IS NOT NULL
          AND "documents"."brokerage_id" IS NULL
          AND "documents"."logical_owner_type" IS NULL
          AND "documents"."logical_owner_id" IS NULL
        )
        OR
        (
          "documents"."property_id" IS NULL
          AND "documents"."brokerage_id" IS NOT NULL
          AND "documents"."logical_owner_type" IS NOT NULL
          AND "documents"."logical_owner_id" IS NOT NULL
          AND "documents"."package_id" IS NULL
        )
      ));