CREATE TABLE "brokerages" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"auth_provider_id" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'Agent' NOT NULL,
	"brokerage_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_provider_id_unique" UNIQUE("auth_provider_id")
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_type" text DEFAULT 'Person' NOT NULL,
	"first_name" text,
	"middle_name" text,
	"last_name" text,
	"organisation_name" text,
	"mobile" text,
	"email" text,
	"residential_address" text,
	"entity_details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"formatted_address" text NOT NULL,
	"place_id" text,
	"suburb" text,
	"state" text,
	"postcode" text,
	"is_manual_address" boolean DEFAULT false NOT NULL,
	"workflow_stage" text DEFAULT 'Appraisal' NOT NULL,
	"aml_status_summary" text DEFAULT 'Not Started' NOT NULL,
	"listing_status" text DEFAULT 'Not Listed' NOT NULL,
	"ownership_data" jsonb,
	"ownership_review_required" boolean DEFAULT false NOT NULL,
	"ownership_reviewed_by" integer,
	"ownership_reviewed_at" timestamp,
	"ownership_review_notes" text,
	"is_draft" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_parties" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"role" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appraisals" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"price_range_low" numeric(12, 2),
	"price_range_high" numeric(12, 2),
	"comparable_sales" jsonb,
	"is_finalised" boolean DEFAULT false NOT NULL,
	"finalised_snapshot" jsonb,
	"share_token" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "appraisals_share_token_unique" UNIQUE("share_token")
);
--> statement-breakpoint
CREATE TABLE "aml_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"verification_type" text DEFAULT 'Individual' NOT NULL,
	"status" text DEFAULT 'Not Started' NOT NULL,
	"requested_at" timestamp,
	"completed_at" timestamp,
	"outcome" text,
	"risk_level" text,
	"review_required" boolean DEFAULT false NOT NULL,
	"evidence_reference" text,
	"service_order_id" integer,
	"exception_resolved_by" integer,
	"exception_resolved_at" timestamp,
	"exception_notes" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agency_agreement_terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"commission_type" text DEFAULT 'Percentage' NOT NULL,
	"commission_rate_bps" integer,
	"flat_fee_cents" integer,
	"marketing_fee_cents" integer,
	"agreement_term_days" integer DEFAULT 90 NOT NULL,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agency_agreement_terms_property_id_unique" UNIQUE("property_id")
);
--> statement-breakpoint
CREATE TABLE "document_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"purpose" text NOT NULL,
	"state" text,
	"status" text DEFAULT 'Preparing' NOT NULL,
	"rule_set_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"package_id" integer,
	"document_type" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"object_storage_key" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signature_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"signatories" jsonb,
	"status" text DEFAULT 'Draft' NOT NULL,
	"sent_at" timestamp,
	"completed_at" timestamp,
	"completed_document_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"payer_type" text DEFAULT 'Agent' NOT NULL,
	"payer_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_ref" text NOT NULL,
	"provider_payment_method_ref" text NOT NULL,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_order_id" integer NOT NULL,
	"payment_method_id" integer,
	"provider" text NOT NULL,
	"provider_charge_ref" text,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"receipt_url" text,
	"failure_reason" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "service_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"party_id" integer,
	"service_type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"wholesale_cost_cents" integer NOT NULL,
	"customer_price_cents" integer NOT NULL,
	"gst_cents" integer DEFAULT 0 NOT NULL,
	"payment_status" text DEFAULT 'Pending' NOT NULL,
	"status" text DEFAULT 'Ordered' NOT NULL,
	"ordered_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"buyer_party_id" integer,
	"offer_price_cents" integer NOT NULL,
	"conditions" jsonb,
	"status" text DEFAULT 'Received' NOT NULL,
	"share_token" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "offers_share_token_unique" UNIQUE("share_token")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"accepted_offer_id" integer,
	"seller_party_ids" jsonb NOT NULL,
	"buyer_party_ids" jsonb NOT NULL,
	"purchase_price_cents" integer NOT NULL,
	"deposit_cents" integer,
	"contract_date" timestamp,
	"finance_approved_at" timestamp,
	"settlement_date" timestamp,
	"settlement_completed_at" timestamp,
	"legal_representatives" jsonb,
	"status" text DEFAULT 'ContractPreparation' NOT NULL,
	"gross_commission_cents" integer,
	"gst_cents" integer,
	"commission_calculated_at" timestamp,
	"funds_received_cents" integer DEFAULT 0 NOT NULL,
	"funds_received_at" timestamp,
	"agent_paid_at" timestamp,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_change_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer,
	"workflow_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"previous_version_id" integer,
	"proposed_steps" jsonb NOT NULL,
	"change_reason" text NOT NULL,
	"proposed_by_ai" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_source" text DEFAULT 'human' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"approved_by" integer,
	"approved_at" timestamp,
	"activated_at" timestamp,
	"rollback_reference" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"workflow_id" integer NOT NULL,
	"step_key" text NOT NULL,
	"label" text NOT NULL,
	"sequence" integer NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"blocked_reason" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"workflow_type" text NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"property_id" integer,
	"transaction_id" integer,
	"party_id" integer,
	"brokerage_id" integer,
	"agent_id" integer,
	"aggregate_type" text,
	"aggregate_id" text,
	"actor_type" text NOT NULL,
	"actor_id" integer,
	"source" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"idempotency_key" text,
	"payload" jsonb,
	"metadata" jsonb,
	"data_classification" text DEFAULT 'STANDARD' NOT NULL,
	"processing_status" text DEFAULT 'PROCESSED' NOT NULL,
	"handler_errors" jsonb,
	"attempt_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"user_email" text,
	"action" text NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"property_id" integer,
	"previous_value" text,
	"updated_value" text,
	"provider_reference" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_action_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"actor_type" text DEFAULT 'USER' NOT NULL,
	"interaction_id" integer,
	"session_id" text,
	"conversation_id" text,
	"action_key" text NOT NULL,
	"action_definition_version" integer DEFAULT 1 NOT NULL,
	"authority_level" integer NOT NULL,
	"risk_level" integer NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"input_payload" jsonb NOT NULL,
	"input_payload_hash" text NOT NULL,
	"proposed_changes" jsonb,
	"human_readable_summary" text NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"approved_by_user_id" integer,
	"approved_at" timestamp,
	"rejected_by_user_id" integer,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"expires_at" timestamp,
	"executed_at" timestamp,
	"execution_result" jsonb,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_configurations" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer,
	"provider" text DEFAULT 'mock' NOT NULL,
	"model" text,
	"temperature" numeric,
	"max_output_tokens" integer,
	"timeout_ms" integer,
	"retry_limit" integer,
	"fallback_provider" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_interactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"brokerage_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"ai_role" text NOT NULL,
	"context_type" text,
	"context_id" integer,
	"prompt_key" text,
	"prompt_version" integer,
	"question" text,
	"response_kind" text,
	"risk_level" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_interactions_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "ai_prompt_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"template" text NOT NULL,
	"default_risk_level" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"interaction_id" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"estimated_cost_usd" numeric,
	"latency_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'Received' NOT NULL,
	"payload" jsonb,
	"error" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "entitlement_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_definitions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "entitlement_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"entitlement_key" text NOT NULL,
	"grantee_type" text DEFAULT 'brokerage' NOT NULL,
	"grantee_id" integer,
	"source_type" text NOT NULL,
	"source_id" integer,
	"status" text DEFAULT 'Active' NOT NULL,
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"ends_at" timestamp,
	"limit_value" integer,
	"configuration" jsonb,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"billing_provider_price_id" text,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"amount_cents" integer NOT NULL,
	"billing_interval" text NOT NULL,
	"tax_behaviour" text DEFAULT 'unspecified' NOT NULL,
	"active_from" timestamp DEFAULT now() NOT NULL,
	"active_until" timestamp,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_entitlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"entitlement_definition_id" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit_value" integer,
	"configuration" jsonb,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"effective_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "billing_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_products_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "billing_subscription_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"price_id" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"effective_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"subscriber_type" text DEFAULT 'brokerage' NOT NULL,
	"subscriber_id" integer NOT NULL,
	"billing_customer_ref" text,
	"billing_subscription_ref" text,
	"status" text DEFAULT 'Trialing' NOT NULL,
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp,
	"trial_ends_at" timestamp,
	"grace_ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer,
	"property_id" integer,
	"opportunity_id" integer,
	"activity_type" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb,
	"responsible_user_id" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_opportunities" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"property_id" integer,
	"opportunity_type" text NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"stage" text DEFAULT 'New' NOT NULL,
	"owner_user_id" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"reason" text,
	"confidence_score" numeric,
	"score_explanation" text,
	"score_version" integer DEFAULT 1 NOT NULL,
	"recommended_next_action" text,
	"next_action_due_at" timestamp,
	"last_meaningful_contact_at" timestamp,
	"expected_timeframe" text,
	"converted_appraisal_id" integer,
	"converted_transaction_id" integer,
	"lost_reason" text,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"relationship_type" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"confidence_score" numeric,
	"valid_from" timestamp DEFAULT now() NOT NULL,
	"valid_to" timestamp,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"source_evidence" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"initiated_by_user_id" integer NOT NULL,
	"filename" text NOT NULL,
	"source_file_type" text NOT NULL,
	"detected_source_system" text,
	"status" text DEFAULT 'UPLOADED' NOT NULL,
	"mapping" jsonb,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"warning_rows" integer DEFAULT 0 NOT NULL,
	"rejected_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_candidates" integer DEFAULT 0 NOT NULL,
	"contacts_created" integer DEFAULT 0 NOT NULL,
	"contacts_updated" integer DEFAULT 0 NOT NULL,
	"properties_created" integer DEFAULT 0 NOT NULL,
	"properties_updated" integer DEFAULT 0 NOT NULL,
	"relationships_created" integer DEFAULT 0 NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"import_job_id" integer NOT NULL,
	"source_row_number" integer NOT NULL,
	"raw_data" jsonb NOT NULL,
	"normalized_data" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"errors" jsonb,
	"warnings" jsonb,
	"contact_match_type" text,
	"contact_match_candidate_id" integer,
	"contact_match_score" numeric,
	"contact_resolution" text,
	"property_match_type" text,
	"property_match_candidate_id" integer,
	"property_match_score" numeric,
	"property_resolution" text,
	"relationship_type" text,
	"result_party_id" integer,
	"result_property_id" integer,
	"result_relationship_id" integer,
	"party_was_created" boolean DEFAULT false NOT NULL,
	"property_was_created" boolean DEFAULT false NOT NULL,
	"relationship_was_created" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action_key" text NOT NULL,
	"params" jsonb NOT NULL,
	"authority_decision" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"ai_action_request_id" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"result" jsonb,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" integer NOT NULL,
	"rule_id" integer NOT NULL,
	"rule_version_id" integer NOT NULL,
	"triggering_event_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"condition_result" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rule_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"condition_group" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"created_by_user_id" integer,
	"created_by_ai" boolean DEFAULT false NOT NULL,
	"change_reason" text,
	"approved_by_user_id" integer,
	"approved_at" timestamp,
	"activated_at" timestamp,
	"superseded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_event_type" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"is_system_template" boolean DEFAULT false NOT NULL,
	"template_key" text,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_processing_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"handler_name" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_ownership_reviewed_by_users_id_fk" FOREIGN KEY ("ownership_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_parties" ADD CONSTRAINT "property_parties_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_parties" ADD CONSTRAINT "property_parties_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisals" ADD CONSTRAINT "appraisals_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aml_verifications" ADD CONSTRAINT "aml_verifications_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aml_verifications" ADD CONSTRAINT "aml_verifications_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aml_verifications" ADD CONSTRAINT "aml_verifications_service_order_id_service_orders_id_fk" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aml_verifications" ADD CONSTRAINT "aml_verifications_exception_resolved_by_users_id_fk" FOREIGN KEY ("exception_resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aml_verifications" ADD CONSTRAINT "aml_verifications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_agreement_terms" ADD CONSTRAINT "agency_agreement_terms_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_agreement_terms" ADD CONSTRAINT "agency_agreement_terms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_agreement_terms" ADD CONSTRAINT "agency_agreement_terms_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_packages" ADD CONSTRAINT "document_packages_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_package_id_document_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."document_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_package_id_document_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."document_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_service_order_id_service_orders_id_fk" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_buyer_party_id_parties_id_fk" FOREIGN KEY ("buyer_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accepted_offer_id_offers_id_fk" FOREIGN KEY ("accepted_offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_change_proposals" ADD CONSTRAINT "workflow_change_proposals_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_change_proposals" ADD CONSTRAINT "workflow_change_proposals_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_change_proposals" ADD CONSTRAINT "workflow_change_proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_change_proposals" ADD CONSTRAINT "workflow_change_proposals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_requests" ADD CONSTRAINT "ai_action_requests_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_requests" ADD CONSTRAINT "ai_action_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_requests" ADD CONSTRAINT "ai_action_requests_interaction_id_ai_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."ai_interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_requests" ADD CONSTRAINT "ai_action_requests_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_requests" ADD CONSTRAINT "ai_action_requests_rejected_by_user_id_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configurations" ADD CONSTRAINT "ai_configurations_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_interaction_id_ai_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."ai_interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_prices" ADD CONSTRAINT "billing_prices_product_id_billing_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."billing_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_entitlements" ADD CONSTRAINT "product_entitlements_product_id_billing_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."billing_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_entitlements" ADD CONSTRAINT "product_entitlements_entitlement_definition_id_entitlement_definitions_id_fk" FOREIGN KEY ("entitlement_definition_id") REFERENCES "public"."entitlement_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscription_items" ADD CONSTRAINT "billing_subscription_items_subscription_id_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."billing_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscription_items" ADD CONSTRAINT "billing_subscription_items_product_id_billing_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."billing_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscription_items" ADD CONSTRAINT "billing_subscription_items_price_id_billing_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."billing_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_activities" ADD CONSTRAINT "grow_activities_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_activities" ADD CONSTRAINT "grow_activities_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_activities" ADD CONSTRAINT "grow_activities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_activities" ADD CONSTRAINT "grow_activities_opportunity_id_grow_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."grow_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_activities" ADD CONSTRAINT "grow_activities_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunities" ADD CONSTRAINT "grow_opportunities_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunities" ADD CONSTRAINT "grow_opportunities_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunities" ADD CONSTRAINT "grow_opportunities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunities" ADD CONSTRAINT "grow_opportunities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunities" ADD CONSTRAINT "grow_opportunities_converted_appraisal_id_appraisals_id_fk" FOREIGN KEY ("converted_appraisal_id") REFERENCES "public"."appraisals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunities" ADD CONSTRAINT "grow_opportunities_converted_transaction_id_transactions_id_fk" FOREIGN KEY ("converted_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_relationships" ADD CONSTRAINT "grow_relationships_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_relationships" ADD CONSTRAINT "grow_relationships_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_relationships" ADD CONSTRAINT "grow_relationships_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_relationships" ADD CONSTRAINT "grow_relationships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_contact_match_candidate_id_parties_id_fk" FOREIGN KEY ("contact_match_candidate_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_property_match_candidate_id_properties_id_fk" FOREIGN KEY ("property_match_candidate_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_result_party_id_parties_id_fk" FOREIGN KEY ("result_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_result_property_id_properties_id_fk" FOREIGN KEY ("result_property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_result_relationship_id_grow_relationships_id_fk" FOREIGN KEY ("result_relationship_id") REFERENCES "public"."grow_relationships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_execution_id_automation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."automation_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_ai_action_request_id_ai_action_requests_id_fk" FOREIGN KEY ("ai_action_request_id") REFERENCES "public"."ai_action_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_rule_version_id_automation_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."automation_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_triggering_event_id_domain_events_id_fk" FOREIGN KEY ("triggering_event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_versions" ADD CONSTRAINT "automation_rule_versions_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_versions" ADD CONSTRAINT "automation_rule_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_versions" ADD CONSTRAINT "automation_rule_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_processing_receipts" ADD CONSTRAINT "event_processing_receipts_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_idempotency_key_idx" ON "domain_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_idx" ON "billing_webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_actions_execution_sequence_idx" ON "automation_actions" USING btree ("execution_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_executions_rule_version_event_idx" ON "automation_executions" USING btree ("rule_version_id","triggering_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_versions_rule_version_idx" ON "automation_rule_versions" USING btree ("rule_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "event_processing_receipts_event_handler_idx" ON "event_processing_receipts" USING btree ("event_id","handler_name");