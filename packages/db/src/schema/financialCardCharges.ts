// Owner t180u(3) (slice 6, migration 0043): stored-card collection of the AE
// Pit Crew service fee. One row per charge ATTEMPT against the single
// payment method nominated on the PC fee authority (D8). The row is written
// PENDING before the provider is called (durable intent), so a crash or a
// concurrent caller can never cause a second debit:
//   * at most one SUCCEEDED charge per payment request;
//   * at most one PENDING/UNKNOWN (in-flight or unresolved) charge per request;
//   * unique (payment_request_id, attempt_no) and unique idempotency_key,
//     which is also the provider idempotency key.
// Holds token REFERENCES only by foreign key (payment_method_id); never a
// card number, token, customer reference or provider secret.
import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { brokerages, users } from "./users";
import { financialPaymentRequests, pcFeeAuthorities } from "./financial";
import { paymentMethods } from "./commerce";

export const FINANCIAL_CARD_CHARGE_STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "UNKNOWN"] as const;
export type FinancialCardChargeStatus = (typeof FINANCIAL_CARD_CHARGE_STATUSES)[number];

export const financialCardCharges = pgTable(
  "financial_card_charges",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    paymentRequestId: integer("payment_request_id").notNull().references(() => financialPaymentRequests.id),
    pcFeeAuthorityId: integer("pc_fee_authority_id").notNull().references(() => pcFeeAuthorities.id),
    paymentMethodId: integer("payment_method_id").notNull().references(() => paymentMethods.id),
    payerType: text("payer_type").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("AUD"),
    status: text("status").notNull().default("PENDING"),
    provider: text("provider").notNull(),
    providerChargeRef: text("provider_charge_ref"),
    failureMessage: text("failure_message"),
    trigger: text("trigger").notNull(),
    initiatedByUserId: integer("initiated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    idempotencyUq: uniqueIndex("financial_card_charges_idempotency_uq").on(t.idempotencyKey),
    attemptUq: uniqueIndex("financial_card_charges_attempt_uq").on(t.paymentRequestId, t.attemptNo),
    oneSucceeded: uniqueIndex("financial_card_charges_one_succeeded_uq").on(t.paymentRequestId).where(sql`${t.status} = 'SUCCEEDED'`),
    oneInFlight: uniqueIndex("financial_card_charges_one_in_flight_uq").on(t.paymentRequestId).where(sql`${t.status} in ('PENDING', 'UNKNOWN')`),
    brokerageIdx: index("financial_card_charges_brokerage_idx").on(t.brokerageId, t.createdAt),
    statusCheck: check("financial_card_charges_status_check", sql`${t.status} in ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')`),
    payerCheck: check("financial_card_charges_payer_check", sql`${t.payerType} in ('Agent', 'Brokerage')`),
    amountCheck: check("financial_card_charges_amount_check", sql`${t.amountCents} > 0 and ${t.attemptNo} >= 1`),
    triggerCheck: check("financial_card_charges_trigger_check", sql`${t.trigger} in ('collect', 'statement_issued')`),
  }),
);

export type FinancialCardCharge = typeof financialCardCharges.$inferSelect;
