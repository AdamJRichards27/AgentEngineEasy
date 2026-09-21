CREATE INDEX "property_parties_property_idx" ON "property_parties" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "appraisals_party_idx" ON "appraisals" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "offers_property_idx" ON "offers" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "transaction_conditions_transaction_idx" ON "transaction_conditions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_property_idx" ON "transactions" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "domain_events_property_brokerage_event_type_idx" ON "domain_events" USING btree ("property_id","brokerage_id","event_type");--> statement-breakpoint
CREATE INDEX "audit_logs_property_action_idx" ON "audit_logs" USING btree ("property_id","action");--> statement-breakpoint
CREATE INDEX "ai_interactions_brokerage_created_at_idx" ON "ai_interactions" USING btree ("brokerage_id","created_at");--> statement-breakpoint
CREATE INDEX "import_records_import_job_idx" ON "import_records" USING btree ("import_job_id");--> statement-breakpoint
CREATE INDEX "risk_exception_scan_runs_started_at_idx" ON "risk_exception_scan_runs" USING btree ("started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "risk_exception_scan_runs_running_idx" ON "risk_exception_scan_runs" USING btree ("status") WHERE "risk_exception_scan_runs"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "communication_participants_party_idx" ON "communication_participants" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "grow_signal_sweep_runs_started_at_idx" ON "grow_signal_sweep_runs" USING btree ("started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "grow_signal_sweep_runs_running_idx" ON "grow_signal_sweep_runs" USING btree ("status") WHERE "grow_signal_sweep_runs"."status" = 'RUNNING';