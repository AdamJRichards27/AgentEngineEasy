ALTER TABLE "financial_payment_outbox" ADD COLUMN "held_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "financial_payment_outbox" ADD COLUMN "held_at" timestamp;--> statement-breakpoint
ALTER TABLE "financial_payment_outbox" ADD CONSTRAINT "financial_payment_outbox_held_by_user_id_users_id_fk" FOREIGN KEY ("held_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pc_fee_authorities_one_active_per_agent_idx" ON "pc_fee_authorities" USING btree ("agent_user_id") WHERE "pc_fee_authorities"."status" = 'ACTIVE';
--> statement-breakpoint
-- Owner t211u item 1: database safeguards for finalised financial records.
-- A finalised record refuses UPDATE/DELETE. The single exception is an UPDATE made through the
-- audited Brokerage Administrator correction service (apps/api/src/lib/financial/corrections.ts):
-- in ONE transaction it inserts an audit_logs row (action financial_record_correction, naming
-- this table and row), sets the transaction-local flag aee.financial_correction_audit_id to that
-- audit row's id, and makes the update. The flag is honoured only when that audit row was
-- written by the current transaction, so it cannot be replayed or forged from another one.
-- DELETE of a finalised record is never allowed.
CREATE OR REPLACE FUNCTION financial_correction_authorised(p_table text, p_id integer) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE v text := current_setting('aee.financial_correction_audit_id', true);
BEGIN
  IF v IS NULL OR v !~ '^[0-9]{1,18}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM audit_logs a
    WHERE a.id = v::bigint
      AND a.action = 'financial_record_correction'
      AND a.record_type = p_table
      AND a.record_id = p_id::text
      AND a.xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text
  );
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION financial_record_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finalised financial record: % % cannot be deleted', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
-- Ledger events: append-only.
CREATE OR REPLACE FUNCTION financial_ledger_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND financial_correction_authorised(TG_TABLE_NAME, OLD.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finalised financial record: financial_ledger_events % is immutable (use the audited correction service)', OLD.id USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER financial_ledger_events_guard_trg BEFORE UPDATE OR DELETE ON "financial_ledger_events" FOR EACH ROW EXECUTE FUNCTION financial_ledger_events_guard();
--> statement-breakpoint
-- Receipts (0042): keep UPDATE refused except an audited correction; refuse DELETE.
CREATE OR REPLACE FUNCTION financial_receipts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF financial_correction_authorised(TG_TABLE_NAME, OLD.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'financial receipt % is immutable', OLD.id USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER financial_receipts_no_delete_trg BEFORE DELETE ON "financial_receipts" FOR EACH ROW EXECUTE FUNCTION financial_record_no_delete();
--> statement-breakpoint
-- Settlement statements (0041): same rules plus an audited correction; an issued or superseded statement cannot be deleted.
CREATE OR REPLACE FUNCTION settlement_statements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'ISSUED' AND NEW.status = 'SUPERSEDED'
     AND NEW.superseded_at IS NOT NULL AND NEW.superseded_by_user_id IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['status','superseded_at','superseded_by_user_id','updated_at'])
       = (to_jsonb(OLD) - ARRAY['status','superseded_at','superseded_by_user_id','updated_at']) THEN
    RETURN NEW;
  END IF;
  IF financial_correction_authorised(TG_TABLE_NAME, OLD.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settlement statement % is % and immutable', OLD.id, OLD.status USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_statements_no_delete_trg BEFORE DELETE ON "settlement_statements" FOR EACH ROW WHEN (OLD.status <> 'DRAFT') EXECUTE FUNCTION financial_record_no_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION settlement_statement_lines_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM settlement_statements WHERE id = OLD.statement_id;
  IF parent_status IS NULL OR parent_status = 'DRAFT' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'finalised financial record: lines of settlement statement % (%) cannot be deleted', OLD.statement_id, parent_status USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_statement_lines_no_delete_trg BEFORE DELETE ON "settlement_statement_lines" FOR EACH ROW EXECUTE FUNCTION settlement_statement_lines_no_delete();
--> statement-breakpoint
-- Payment authorities: once activated (any status other than NOT_PROVIDED/PENDING) the terms are
-- fixed. ACTIVE may move once to REPLACED, REVOKED (with its revoke fields), EXPIRED or INVALID;
-- those are terminal. A terms change is a new authority version. No DELETE after activation.
CREATE OR REPLACE FUNCTION pc_fee_authorities_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[] := ARRAY['status','revoked_at','revoked_by_user_id','revoke_reason','updated_at'];
BEGIN
  IF OLD.status IN ('NOT_PROVIDED', 'PENDING') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finalised financial record: pc_fee_authorities % (%) cannot be deleted', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF financial_correction_authorised(TG_TABLE_NAME, OLD.id) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'finalised financial record: pc_fee_authorities % terms are immutable after activation (issue a new version)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ACTIVE' THEN
    IF NEW.status NOT IN ('ACTIVE', 'REPLACED', 'REVOKED', 'EXPIRED', 'INVALID') THEN
      RAISE EXCEPTION 'finalised financial record: pc_fee_authorities % cannot move from ACTIVE to %', OLD.id, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'REVOKED' AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
      RAISE EXCEPTION 'finalised financial record: pc_fee_authorities % revoke fields change only on revocation', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason THEN
    RAISE EXCEPTION 'finalised financial record: pc_fee_authorities % is % (terminal)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pc_fee_authorities_guard_trg BEFORE UPDATE OR DELETE ON "pc_fee_authorities" FOR EACH ROW EXECUTE FUNCTION pc_fee_authorities_guard();
--> statement-breakpoint
-- Waiver and write-off records: once a fee is waived or written off, the decision (status, who,
-- when, why) and the amount are fixed, and the request cannot be deleted. Other bookkeeping
-- columns (reconciliation status, updated_at) may still change.
CREATE OR REPLACE FUNCTION financial_payment_requests_adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.waived_at IS NULL AND OLD.written_off_at IS NULL AND OLD.status NOT IN ('WAIVED', 'WRITTEN_OFF') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finalised financial record: financial_payment_requests % (%) cannot be deleted', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF financial_correction_authorised(TG_TABLE_NAME, OLD.id) THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.waived_at IS DISTINCT FROM OLD.waived_at OR NEW.waived_by_user_id IS DISTINCT FROM OLD.waived_by_user_id OR NEW.waive_reason IS DISTINCT FROM OLD.waive_reason
     OR NEW.written_off_at IS DISTINCT FROM OLD.written_off_at OR NEW.written_off_by_user_id IS DISTINCT FROM OLD.written_off_by_user_id OR NEW.write_off_reason IS DISTINCT FROM OLD.write_off_reason THEN
    RAISE EXCEPTION 'finalised financial record: financial_payment_requests % is % and its adjustment record is immutable', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER financial_payment_requests_adjustment_guard_trg BEFORE UPDATE OR DELETE ON "financial_payment_requests" FOR EACH ROW EXECUTE FUNCTION financial_payment_requests_adjustment_guard();
