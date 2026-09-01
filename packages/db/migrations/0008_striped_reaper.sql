CREATE TABLE "audit_return_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"jurisdiction" text DEFAULT 'AU' NOT NULL,
	"reporting_entity_name" text,
	"reporting_period_start" timestamp NOT NULL,
	"reporting_period_end" timestamp NOT NULL,
	"due_date" timestamp NOT NULL,
	"reminder_offsets_days" jsonb DEFAULT '[60,30,14,7]'::jsonb NOT NULL,
	"reminders_sent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"responsible_user_id" integer,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"required_records_note" text,
	"submission_reference" text,
	"submitted_at" timestamp,
	"submitted_by_user_id" integer,
	"evidence_ref" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_agreements" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"supersedes_id" integer,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"method" text NOT NULL,
	"rate_bps" integer,
	"fixed_amount_cents" integer,
	"tiers" jsonb,
	"minimum_amount_cents" integer,
	"manual_reason" text,
	"gst_applicable" boolean DEFAULT true NOT NULL,
	"gst_rate_bps" integer DEFAULT 1000 NOT NULL,
	"referral_fee_cents" integer DEFAULT 0 NOT NULL,
	"brokerage_split_bps" integer,
	"agent_split_bps" integer,
	"seeded_from_agency_agreement_terms_id" integer,
	"source_document_ref" text,
	"effective_date" timestamp,
	"approved_by_user_id" integer,
	"approved_at" timestamp,
	"cancelled_by_user_id" integer,
	"cancelled_at" timestamp,
	"cancel_reason" text,
	"notes" text,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_calculations" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"commission_agreement_id" integer NOT NULL,
	"calculation_version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'ESTIMATE' NOT NULL,
	"supersedes_id" integer,
	"superseded_reason" text,
	"sale_price_cents_input" integer NOT NULL,
	"method_used" text NOT NULL,
	"rate_bps_used" integer,
	"tiers_used" jsonb,
	"gross_commission_cents" integer NOT NULL,
	"minimum_applied_cents" integer,
	"referral_fee_cents" integer DEFAULT 0 NOT NULL,
	"commission_ex_gst_cents" integer NOT NULL,
	"gst_cents" integer DEFAULT 0 NOT NULL,
	"gst_rate_bps_used" integer DEFAULT 1000 NOT NULL,
	"brokerage_component_cents" integer,
	"agent_component_cents" integer,
	"rounding_adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculation_rule_version" integer DEFAULT 1 NOT NULL,
	"calculated_by_user_id" integer,
	"calculated_at" timestamp DEFAULT now() NOT NULL,
	"finalised_at" timestamp,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE "financial_deposits" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"status" text DEFAULT 'EXPECTED' NOT NULL,
	"required_amount_cents" integer,
	"due_date" timestamp,
	"reported_received_amount_cents" integer DEFAULT 0 NOT NULL,
	"reported_received_at" timestamp,
	"external_holder_type" text,
	"external_holder_name" text,
	"external_trust_account_ref" text,
	"evidence_ref" text,
	"reported_released_at" timestamp,
	"disbursement_reference" text,
	"reconciliation_status" text DEFAULT 'UNRECONCILED' NOT NULL,
	"reconciled_at" timestamp,
	"recorded_by_user_id" integer,
	"verified_by_user_id" integer,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_disputes" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"payment_request_id" integer NOT NULL,
	"disputed_amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"raised_by_user_id" integer,
	"raised_at" timestamp DEFAULT now() NOT NULL,
	"evidence_ref" text,
	"internal_owner_user_id" integer,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolution" text,
	"resolved_by_user_id" integer,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_ledger_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer,
	"transaction_id" integer,
	"event_type" text NOT NULL,
	"amount_cents" integer,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"source_record_type" text NOT NULL,
	"source_record_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" integer,
	"reason" text,
	"correlation_id" text,
	"causation_id" text,
	"reversal_of_event_id" integer,
	"metadata" jsonb,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_payment_provider_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"payment_request_id" integer,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processing_status" text DEFAULT 'PENDING' NOT NULL,
	"processing_error" text
);
--> statement-breakpoint
CREATE TABLE "financial_payment_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"kind" text DEFAULT 'PC_SUCCESS_FEE' NOT NULL,
	"pc_fee_calculation_id" integer,
	"pc_fee_authority_id" integer,
	"payee_user_id" integer,
	"payer_user_id" integer,
	"status" text DEFAULT 'NOT_CALCULATED' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"invoice_number" text,
	"invoice_issued_at" timestamp,
	"notice_sent_at" timestamp,
	"notice_communication_message_id" integer,
	"provider" text,
	"provider_request_ref" text,
	"provider_status" text,
	"scheduled_at" timestamp,
	"processing_started_at" timestamp,
	"paid_at" timestamp,
	"failed_at" timestamp,
	"failure_reason" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"reversed_at" timestamp,
	"reversal_reason" text,
	"waived_at" timestamp,
	"waived_by_user_id" integer,
	"waive_reason" text,
	"written_off_at" timestamp,
	"written_off_by_user_id" integer,
	"write_off_reason" text,
	"reconciliation_status" text DEFAULT 'NOT_REQUIRED' NOT NULL,
	"reconciled_at" timestamp,
	"idempotency_key" text,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_reconciliations" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"expected_amount_cents" integer,
	"reported_amount_cents" integer,
	"evidence_amount_cents" integer,
	"difference_cents" integer,
	"status" text DEFAULT 'UNRECONCILED' NOT NULL,
	"source" text,
	"external_reference" text,
	"evidence_ref" text,
	"notes" text,
	"reconciled_by_user_id" integer,
	"reconciled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"default_gst_rate_bps" integer DEFAULT 1000 NOT NULL,
	"default_pc_fee_rate_bps" integer DEFAULT 690 NOT NULL,
	"default_pc_fee_gci_definition" text DEFAULT 'COMMISSION_EX_GST' NOT NULL,
	"default_pc_fee_notice_required_days" integer DEFAULT 7 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "financial_settings_brokerage_id_unique" UNIQUE("brokerage_id")
);
--> statement-breakpoint
CREATE TABLE "marketing_payment_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"campaign_item_id" text NOT NULL,
	"status" text DEFAULT 'PLANNED' NOT NULL,
	"supplier_name" text,
	"invoice_reference" text,
	"invoiced_amount_cents" integer,
	"invoiced_at" timestamp,
	"reported_paid_amount_cents" integer,
	"reported_paid_at" timestamp,
	"payment_source" text,
	"evidence_ref" text,
	"reconciliation_status" text DEFAULT 'NOT_REQUIRED' NOT NULL,
	"reconciled_at" timestamp,
	"reconciled_by_user_id" integer,
	"recorded_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pc_fee_authorities" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"agent_user_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" integer,
	"status" text DEFAULT 'NOT_PROVIDED' NOT NULL,
	"fee_basis" text DEFAULT 'PERCENTAGE_OF_GCI' NOT NULL,
	"rate_bps" integer,
	"fixed_amount_cents" integer,
	"gci_definition" text DEFAULT 'COMMISSION_EX_GST' NOT NULL,
	"gst_applicable" boolean DEFAULT true NOT NULL,
	"payment_trigger" text DEFAULT 'SETTLEMENT_COMPLETED' NOT NULL,
	"authorised_payment_method" text DEFAULT 'GENERAL_ACCOUNT_DEBIT_MANDATE' NOT NULL,
	"mandate_provider_ref" text,
	"mandate_provider" text,
	"maximum_amount_cents" integer,
	"notice_required_days" integer DEFAULT 7 NOT NULL,
	"signed_evidence_ref" text,
	"effective_date" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by_user_id" integer,
	"revoke_reason" text,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pc_fee_calculations" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"commission_calculation_id" integer,
	"pc_fee_authority_id" integer,
	"calculation_version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'ESTIMATE' NOT NULL,
	"supersedes_id" integer,
	"fee_basis_used" text NOT NULL,
	"gci_basis_cents" integer NOT NULL,
	"rate_bps_used" integer,
	"gross_fee_cents" integer NOT NULL,
	"gst_cents" integer DEFAULT 0 NOT NULL,
	"total_fee_cents" integer NOT NULL,
	"is_disputed" boolean DEFAULT false NOT NULL,
	"is_provisional" boolean DEFAULT true NOT NULL,
	"calculated_by_user_id" integer,
	"calculated_at" timestamp DEFAULT now() NOT NULL,
	"finalised_at" timestamp,
	"correlation_id" text
);
--> statement-breakpoint
ALTER TABLE "audit_return_reminders" ADD CONSTRAINT "audit_return_reminders_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_return_reminders" ADD CONSTRAINT "audit_return_reminders_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_return_reminders" ADD CONSTRAINT "audit_return_reminders_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_agreements_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_agreements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_agreements_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_agreements_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_agreements_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_agreements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_calculations" ADD CONSTRAINT "commission_calculations_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_calculations" ADD CONSTRAINT "commission_calculations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_calculations" ADD CONSTRAINT "commission_calculations_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_calculations" ADD CONSTRAINT "commission_calculations_commission_agreement_id_commission_agreements_id_fk" FOREIGN KEY ("commission_agreement_id") REFERENCES "public"."commission_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_calculations" ADD CONSTRAINT "commission_calculations_calculated_by_user_id_users_id_fk" FOREIGN KEY ("calculated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_deposits" ADD CONSTRAINT "financial_deposits_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_deposits" ADD CONSTRAINT "financial_deposits_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_deposits" ADD CONSTRAINT "financial_deposits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_deposits" ADD CONSTRAINT "financial_deposits_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_deposits" ADD CONSTRAINT "financial_deposits_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_disputes" ADD CONSTRAINT "financial_disputes_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_disputes" ADD CONSTRAINT "financial_disputes_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_disputes" ADD CONSTRAINT "financial_disputes_raised_by_user_id_users_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_disputes" ADD CONSTRAINT "financial_disputes_internal_owner_user_id_users_id_fk" FOREIGN KEY ("internal_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_disputes" ADD CONSTRAINT "financial_disputes_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_ledger_events" ADD CONSTRAINT "financial_ledger_events_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_ledger_events" ADD CONSTRAINT "financial_ledger_events_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_ledger_events" ADD CONSTRAINT "financial_ledger_events_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_ledger_events" ADD CONSTRAINT "financial_ledger_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_provider_events" ADD CONSTRAINT "financial_payment_provider_events_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_pc_fee_calculation_id_pc_fee_calculations_id_fk" FOREIGN KEY ("pc_fee_calculation_id") REFERENCES "public"."pc_fee_calculations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_pc_fee_authority_id_pc_fee_authorities_id_fk" FOREIGN KEY ("pc_fee_authority_id") REFERENCES "public"."pc_fee_authorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_payee_user_id_users_id_fk" FOREIGN KEY ("payee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_waived_by_user_id_users_id_fk" FOREIGN KEY ("waived_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_written_off_by_user_id_users_id_fk" FOREIGN KEY ("written_off_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD CONSTRAINT "financial_payment_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_reconciliations" ADD CONSTRAINT "financial_reconciliations_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_reconciliations" ADD CONSTRAINT "financial_reconciliations_reconciled_by_user_id_users_id_fk" FOREIGN KEY ("reconciled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_settings" ADD CONSTRAINT "financial_settings_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_payment_records" ADD CONSTRAINT "marketing_payment_records_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_payment_records" ADD CONSTRAINT "marketing_payment_records_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_payment_records" ADD CONSTRAINT "marketing_payment_records_reconciled_by_user_id_users_id_fk" FOREIGN KEY ("reconciled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_payment_records" ADD CONSTRAINT "marketing_payment_records_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_calculations" ADD CONSTRAINT "pc_fee_calculations_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_calculations" ADD CONSTRAINT "pc_fee_calculations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_calculations" ADD CONSTRAINT "pc_fee_calculations_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_calculations" ADD CONSTRAINT "pc_fee_calculations_commission_calculation_id_commission_calculations_id_fk" FOREIGN KEY ("commission_calculation_id") REFERENCES "public"."commission_calculations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_calculations" ADD CONSTRAINT "pc_fee_calculations_pc_fee_authority_id_pc_fee_authorities_id_fk" FOREIGN KEY ("pc_fee_authority_id") REFERENCES "public"."pc_fee_authorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_calculations" ADD CONSTRAINT "pc_fee_calculations_calculated_by_user_id_users_id_fk" FOREIGN KEY ("calculated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_return_reminders_brokerage_period_idx" ON "audit_return_reminders" USING btree ("brokerage_id","reporting_period_start","reporting_period_end");--> statement-breakpoint
CREATE INDEX "audit_return_reminders_brokerage_status_idx" ON "audit_return_reminders" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "audit_return_reminders_due_date_idx" ON "audit_return_reminders" USING btree ("due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_agreements_transaction_version_idx" ON "commission_agreements" USING btree ("transaction_id","version");--> statement-breakpoint
CREATE INDEX "commission_agreements_transaction_status_idx" ON "commission_agreements" USING btree ("transaction_id","status");--> statement-breakpoint
CREATE INDEX "commission_agreements_brokerage_status_idx" ON "commission_agreements" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_calculations_transaction_version_idx" ON "commission_calculations" USING btree ("transaction_id","calculation_version");--> statement-breakpoint
CREATE INDEX "commission_calculations_transaction_state_idx" ON "commission_calculations" USING btree ("transaction_id","state");--> statement-breakpoint
CREATE INDEX "commission_calculations_brokerage_idx" ON "commission_calculations" USING btree ("brokerage_id","calculated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_deposits_transaction_idx" ON "financial_deposits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "financial_deposits_brokerage_status_idx" ON "financial_deposits" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "financial_disputes_payment_request_idx" ON "financial_disputes" USING btree ("payment_request_id");--> statement-breakpoint
CREATE INDEX "financial_disputes_brokerage_status_idx" ON "financial_disputes" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "financial_ledger_events_brokerage_occurred_idx" ON "financial_ledger_events" USING btree ("brokerage_id","occurred_at");--> statement-breakpoint
CREATE INDEX "financial_ledger_events_transaction_occurred_idx" ON "financial_ledger_events" USING btree ("transaction_id","occurred_at");--> statement-breakpoint
CREATE INDEX "financial_ledger_events_source_record_idx" ON "financial_ledger_events" USING btree ("source_record_type","source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_payment_provider_events_dedup_idx" ON "financial_payment_provider_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_payment_requests_transaction_kind_idx" ON "financial_payment_requests" USING btree ("transaction_id","kind");--> statement-breakpoint
CREATE INDEX "financial_payment_requests_brokerage_status_idx" ON "financial_payment_requests" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_payment_requests_idempotency_key_idx" ON "financial_payment_requests" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "financial_reconciliations_record_idx" ON "financial_reconciliations" USING btree ("record_type","record_id");--> statement-breakpoint
CREATE INDEX "financial_reconciliations_brokerage_status_idx" ON "financial_reconciliations" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_payment_records_campaign_item_idx" ON "marketing_payment_records" USING btree ("campaign_item_id");--> statement-breakpoint
CREATE INDEX "marketing_payment_records_property_status_idx" ON "marketing_payment_records" USING btree ("property_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pc_fee_authorities_agent_version_idx" ON "pc_fee_authorities" USING btree ("agent_user_id","version");--> statement-breakpoint
CREATE INDEX "pc_fee_authorities_agent_status_idx" ON "pc_fee_authorities" USING btree ("agent_user_id","status");--> statement-breakpoint
CREATE INDEX "pc_fee_authorities_brokerage_status_idx" ON "pc_fee_authorities" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pc_fee_calculations_transaction_version_idx" ON "pc_fee_calculations" USING btree ("transaction_id","calculation_version");--> statement-breakpoint
CREATE INDEX "pc_fee_calculations_transaction_state_idx" ON "pc_fee_calculations" USING btree ("transaction_id","state");