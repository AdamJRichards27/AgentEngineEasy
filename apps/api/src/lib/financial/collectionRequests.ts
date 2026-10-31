// Owner t212u item 1: Pit Crew may initiate a collection REQUEST but never execute a payment.
//
// Every provider step for the Pit Crew service fee (a direct-debit schedule or a stored-card
// charge) goes through here:
//   1. requestServiceFeeCollection RECORDS a request (pc_fee_collection_requests). Recording
//      never calls a provider. One open request per fee (partial unique index).
//   2. executeCollectionRequest is the authorised payment workflow. It runs under the SYSTEM
//      identity, reloads everything from the database by request id (nothing the requester
//      supplied is trusted) and re-runs every gate in collectPitCrewServiceFee: settlement
//      confirmed, written authority valid, fee eligible (finalised, matches, within cap),
//      issued statement, collection timing (notice period vs express immediate). Only then is
//      the provider called, in performProviderStep below.
// lib/pitCrewServiceFee.ts and the Pit Crew collect route never reference a provider.
import { and, eq, inArray } from "drizzle-orm";
import { db, pcFeeCollectionRequests, type PcFeeCollectionRequest } from "@aee/db";
import {
  collectPitCrewServiceFee,
  ServiceFeeCollectionError,
  verifyServiceFeeCollection,
  type ServiceFeeCaller,
  type ServiceFeeCollectionCode,
  type ServiceFeeCollectionResult,
  type VerifiedServiceFee,
} from "../pitCrewServiceFee.js";
import { scheduleDebitForPaymentRequest } from "./paymentOutbox.js";
import { mandateProviderPermitted } from "./provider.js";
import { CardChargeRefusal, chargeServiceFeeStoredCard, type CardChargeTrigger } from "./pcFeeCardCharges.js";

export const SYSTEM_PAYMENT_WORKFLOW = "SYSTEM_PAYMENT_WORKFLOW";
const OPEN = ["PENDING", "EXECUTING"];

export type CollectionExecution =
  | { status: "EXECUTED"; outcome: string | null; result?: ServiceFeeCollectionResult }
  | { status: "REFUSED"; code: string; error?: ServiceFeeCollectionError }
  | { status: "FAILED"; code: string; error?: unknown }
  | { status: "EXECUTING" | "PENDING" };

async function recordRequest(caller: ServiceFeeCaller, verified: VerifiedServiceFee, trigger: string): Promise<{ row: PcFeeCollectionRequest; created: boolean }> {
  const [inserted] = await db
    .insert(pcFeeCollectionRequests)
    .values({
      brokerageId: caller.brokerageId,
      transactionId: verified.transactionId,
      paymentRequestId: verified.paymentRequest.id,
      requestedByUserId: caller.id > 0 ? caller.id : null,
      requestedByRole: caller.role,
      trigger,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted, created: true };
  const [open] = await db
    .select()
    .from(pcFeeCollectionRequests)
    .where(and(eq(pcFeeCollectionRequests.paymentRequestId, verified.paymentRequest.id), inArray(pcFeeCollectionRequests.status, OPEN)));
  if (!open) throw new Error(`collection request for payment request ${verified.paymentRequest.id} vanished`);
  return { row: open, created: false };
}

/** Record only (never calls a provider). The caller must pass every gate now; execution re-checks them all. */
export async function requestServiceFeeCollection(caller: ServiceFeeCaller, transactionId: number): Promise<{ id: number; status: string; created: boolean }> {
  const verified = await verifyServiceFeeCollection(caller, transactionId);
  const { row, created } = await recordRequest(caller, verified, "collect");
  return { id: row.id, status: row.status, created };
}

/** The authorised payment workflow: claim, re-validate everything as SYSTEM, then (only then) the provider step. */
export async function executeCollectionRequest(collectionRequestId: number): Promise<CollectionExecution> {
  const [claimed] = await db
    .update(pcFeeCollectionRequests)
    .set({ status: "EXECUTING", updatedAt: new Date() })
    .where(and(eq(pcFeeCollectionRequests.id, collectionRequestId), eq(pcFeeCollectionRequests.status, "PENDING")))
    .returning();
  if (!claimed) {
    const [row] = await db.select().from(pcFeeCollectionRequests).where(eq(pcFeeCollectionRequests.id, collectionRequestId));
    if (!row) throw new Error(`collection request ${collectionRequestId} not found`);
    if (row.status === "EXECUTED") return { status: "EXECUTED", outcome: row.outcome };
    if (row.status === "REFUSED" || row.status === "FAILED") return { status: row.status, code: row.refusalCode ?? "SERVICE_FEE_COLLECTION_FAILED" };
    return { status: row.status as "EXECUTING" | "PENDING" };
  }
  const finish = (set: Partial<PcFeeCollectionRequest>) =>
    db.update(pcFeeCollectionRequests).set({ ...set, executedBy: SYSTEM_PAYMENT_WORKFLOW, executedAt: new Date(), updatedAt: new Date() }).where(eq(pcFeeCollectionRequests.id, claimed.id));
  try {
    const system: ServiceFeeCaller = { id: 0, role: "System", brokerageId: claimed.brokerageId };
    const result = await collectPitCrewServiceFee(system, claimed.transactionId, {
      trigger: "collection_request",
      executing: { collectionRequestId: claimed.id, trigger: claimed.trigger, requestedByUserId: claimed.requestedByUserId },
    });
    await finish({ status: "EXECUTED", outcome: result.outcome });
    return { status: "EXECUTED", outcome: result.outcome, result };
  } catch (err) {
    if (err instanceof ServiceFeeCollectionError) {
      await finish({ status: "REFUSED", refusalCode: err.code });
      return { status: "REFUSED", code: err.code, error: err };
    }
    await finish({ status: "FAILED", refusalCode: "SERVICE_FEE_COLLECTION_FAILED" });
    return { status: "FAILED", code: "SERVICE_FEE_COLLECTION_FAILED", error: err };
  }
}

/** Used by collectPitCrewServiceFee for every non-workflow caller: record, then hand to the workflow. */
export async function requestAndExecute(caller: ServiceFeeCaller, verified: VerifiedServiceFee, settlementStatementId: number, trigger: string): Promise<ServiceFeeCollectionResult> {
  const { row } = await recordRequest(caller, verified, trigger);
  const exec = await executeCollectionRequest(row.id);
  if (exec.status === "EXECUTED") {
    const paymentRequest = exec.result?.paymentRequest ?? verified.paymentRequest;
    const outcome = (exec.result?.outcome ?? exec.outcome ?? "already_in_progress") as ServiceFeeCollectionResult["outcome"];
    // The caller's own verification (e.g. its Pit Crew assignment ids) is what the route audits.
    return { outcome, verified, paymentRequest, settlementStatementId };
  }
  if (exec.status === "REFUSED") throw exec.error ?? new ServiceFeeCollectionError(exec.code as ServiceFeeCollectionCode, undefined, verified.propertyId);
  if (exec.status === "FAILED") throw exec.error ?? new Error("collection request failed");
  return { outcome: "already_in_progress", verified, paymentRequest: verified.paymentRequest, settlementStatementId };
}

/** The ONLY provider step for the Pit Crew service fee. Reached only from executeCollectionRequest. */
export async function performProviderStep(input: {
  verified: VerifiedServiceFee;
  settlementStatementId: number;
  executing: { collectionRequestId: number; trigger: string; requestedByUserId: number | null };
}): Promise<ServiceFeeCollectionResult> {
  const { verified, settlementStatementId, executing } = input;
  const request = verified.paymentRequest;
  if (verified.paymentMethod.type === "STORED_CARD") {
    try {
      const trigger: CardChargeTrigger = executing.trigger === "statement_issued" || executing.trigger === "scheduler" ? executing.trigger : "collect";
      const r = await chargeServiceFeeStoredCard({ paymentRequestId: request.id, authority: verified.authority, actorUserId: executing.requestedByUserId, trigger });
      return { outcome: r.outcome, verified, paymentRequest: r.paymentRequest, settlementStatementId };
    } catch (err) {
      if (err instanceof CardChargeRefusal) {
        const code: ServiceFeeCollectionCode =
          err.code === "PROVIDER_NOT_PERMITTED" ? "SERVICE_FEE_PROVIDER_NOT_PERMITTED" : err.code === "RETRY_NOT_DUE" ? "SERVICE_FEE_RETRY_NOT_DUE" : err.code === "METHOD_INVALID" ? "SERVICE_FEE_AUTHORITY_INVALID" : "SERVICE_FEE_NOT_COLLECTABLE";
        throw new ServiceFeeCollectionError(code, err.message, verified.propertyId);
      }
      throw err;
    }
  }
  // t183u item 6: never hand a debit to anything but the sandbox mandate provider.
  if (!mandateProviderPermitted()) {
    throw new ServiceFeeCollectionError("SERVICE_FEE_PROVIDER_NOT_PERMITTED", "Only the sandbox mandate provider may process debits.", verified.propertyId);
  }
  const result = await scheduleDebitForPaymentRequest({ paymentRequestId: request.id, initiatedByUserId: executing.requestedByUserId });
  return { outcome: result.dispatched ? "debit_scheduled" : "debit_queued", verified, paymentRequest: result.paymentRequest, settlementStatementId };
}
