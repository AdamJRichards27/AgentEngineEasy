// D6 (Owner direction t113u; spec orchestrator/specs/transaction-services.md, decision D6):
// service-order cancellation and an application-level duplicate-order guard.
//
// - Status stays a text column (no migration). "Cancelled" joins Ordered | InProgress | Completed | Failed.
// - History is preserved: a cancel is a conditional UPDATE of status plus an audit row in the SAME
//   transaction. Nothing is ever deleted, and a cancelled order is never revived by a webhook or retry.
// - Duplicate guard: callers that create a service order take a transaction-scoped advisory lock on
//   (brokerageId, hash(serviceType, propertyId, partyId)) and re-check for an open order inside it, so
//   concurrent requests serialise instead of each passing a check-then-insert race. The DB-level partial
//   unique index is drafted separately (evidence-d6/0001-service-orders-open-unique.sql.DRAFT) and is
//   NOT applied.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, serviceOrders, properties, payments, auditLogs } from "@aee/db";
import type { ServiceOrder } from "@aee/db";

export const SERVICE_ORDER_STATUSES = ["Ordered", "InProgress", "Completed", "Failed", "Cancelled"] as const;
export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number];
/** Statuses that count as "open" for the duplicate guard. */
export const OPEN_SERVICE_ORDER_STATUSES: ServiceOrderStatus[] = ["Ordered", "InProgress"];
/** Only an order that has not started with the provider may be cancelled. */
export const CANCELLABLE_SERVICE_ORDER_STATUSES: ServiceOrderStatus[] = ["Ordered"];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export function serviceOrderDedupeKey(input: { serviceType: string; propertyId: number; partyId: number | null }): string {
  return `service-order:${input.serviceType}:${input.propertyId}:${input.partyId ?? "none"}`;
}

/** Serialises every create for one (brokerage, serviceType, property, party). Released on commit/rollback. */
export async function lockServiceOrderDedupe(
  tx: Tx,
  input: { brokerageId: number; serviceType: string; propertyId: number; partyId: number | null },
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${input.brokerageId}, hashtext(${serviceOrderDedupeKey(input)}))`);
}

export async function findOpenServiceOrder(
  exec: Executor,
  input: { serviceType: string; propertyId: number; partyId: number | null },
): Promise<ServiceOrder | null> {
  const partyCond = input.partyId == null ? sql`${serviceOrders.partyId} is null` : eq(serviceOrders.partyId, input.partyId);
  const [row] = await exec
    .select()
    .from(serviceOrders)
    .where(
      and(
        eq(serviceOrders.serviceType, input.serviceType),
        eq(serviceOrders.propertyId, input.propertyId),
        partyCond,
        inArray(serviceOrders.status, OPEN_SERVICE_ORDER_STATUSES),
      ),
    )
    .orderBy(serviceOrders.id)
    .limit(1);
  return row ?? null;
}

export type ServiceOrderCancelErrorCode =
  | "SERVICE_ORDER_NOT_FOUND"
  | "SERVICE_ORDER_CANCEL_FORBIDDEN"
  | "SERVICE_ORDER_NOT_CANCELLABLE"
  | "SERVICE_ORDER_HAS_PAYMENT";

export class ServiceOrderCancelError extends Error {
  constructor(
    readonly code: ServiceOrderCancelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceOrderCancelError";
  }
}

export interface CancelActor {
  id: number;
  role: string;
  brokerageId: number;
}

/**
 * Who may cancel: a Brokerage Administrator (any order in their own brokerage) or the
 * property's own agent. Pit Crew and other agents may not (D5: Pit Crew don't order, so
 * they don't cancel). Cross-brokerage ids answer exactly like a missing id.
 */
export async function cancelServiceOrder(input: {
  serviceOrderId: number;
  actor: CancelActor;
  reason: string;
}): Promise<{ serviceOrder: ServiceOrder; cancelled: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ serviceOrder: serviceOrders, agentId: properties.agentId })
      .from(serviceOrders)
      .innerJoin(properties, eq(properties.id, serviceOrders.propertyId))
      .where(and(eq(serviceOrders.id, input.serviceOrderId), eq(properties.brokerageId, input.actor.brokerageId)))
      .for("update", { of: serviceOrders });
    if (!row) throw new ServiceOrderCancelError("SERVICE_ORDER_NOT_FOUND", `ServiceOrder ${input.serviceOrderId} not found`);

    const isAdmin = input.actor.role === "Brokerage Administrator";
    const isOwnAgent = input.actor.role === "Agent" && row.agentId === input.actor.id;
    if (!isAdmin && !isOwnAgent) {
      throw new ServiceOrderCancelError("SERVICE_ORDER_CANCEL_FORBIDDEN", "Only the property's agent or a Brokerage Administrator can cancel this order.");
    }

    const order = row.serviceOrder;
    // Repeat submit of the same cancel: idempotent, no second audit row.
    if (order.status === "Cancelled") return { serviceOrder: order, cancelled: false };
    if (!CANCELLABLE_SERVICE_ORDER_STATUSES.includes(order.status as ServiceOrderStatus)) {
      throw new ServiceOrderCancelError("SERVICE_ORDER_NOT_CANCELLABLE", `ServiceOrder ${order.id} can't be cancelled (status: ${order.status})`);
    }
    // Money first: a pending or succeeded charge must be refunded/resolved, never silently orphaned.
    const live = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.serviceOrderId, order.id), inArray(payments.status, ["Pending", "Succeeded"])));
    if (live.length > 0 || order.paymentStatus === "Charged") {
      throw new ServiceOrderCancelError("SERVICE_ORDER_HAS_PAYMENT", `ServiceOrder ${order.id} has a live payment; refund it before cancelling.`);
    }

    const [updated] = await tx
      .update(serviceOrders)
      .set({ status: "Cancelled", completedAt: new Date() })
      .where(and(eq(serviceOrders.id, order.id), inArray(serviceOrders.status, CANCELLABLE_SERVICE_ORDER_STATUSES)))
      .returning();
    if (!updated) {
      throw new ServiceOrderCancelError("SERVICE_ORDER_NOT_CANCELLABLE", `ServiceOrder ${order.id} changed state; refresh and retry.`);
    }
    await tx.insert(auditLogs).values({
      brokerageId: input.actor.brokerageId,
      userId: input.actor.id,
      action: "service_order_cancelled",
      recordType: "service_order",
      recordId: String(order.id),
      propertyId: order.propertyId,
      previousValue: order.status,
      updatedValue: JSON.stringify({ status: "Cancelled", reason: input.reason }),
    });
    return { serviceOrder: updated, cancelled: true };
  });
}
