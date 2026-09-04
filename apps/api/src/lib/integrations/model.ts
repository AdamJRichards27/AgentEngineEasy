// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// The connection lifecycle service — every exported mutation here is the
// only way integration_connections/integration_connection_transitions is
// ever written; routes never touch them directly (mirrors
// lib/launch/model.ts / lib/exceptions/model.ts function-for-function).
// Section 4's "no connection without approval" is enforced by the
// transition table alone (types.ts's isValidConnectionTransition) — there
// is no way to reach ACTIVE except DRAFT -> PENDING_APPROVAL -> APPROVED ->
// CONFIGURING -> VALIDATING -> ACTIVE, with a real human decision (a
// different actor than the requester — see requestApproval/decideApproval
// below) required at the PENDING_APPROVAL step and a real adapter
// validation call required at VALIDATING.

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  integrationConnections,
  integrationConnectionTransitions,
  integrationCredentials,
  type IntegrationConnection,
  type IntegrationConnectionStatus,
} from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { logAudit } from "../audit.js";
import { getAdapter, getProvider } from "./registry.js";
import { IntegrationError, isValidConnectionTransition, type ActorRef, type IntegrationCapability } from "./types.js";

async function recordTransition(
  connectionId: string,
  brokerageId: number,
  transitionType: string,
  opts: { fromValue?: string | null; toValue?: string | null; reason?: string | null; actorType: "SYSTEM" | "USER"; actorUserId?: number | null; metadata?: Record<string, unknown> | null },
): Promise<void> {
  await db.insert(integrationConnectionTransitions).values({
    connectionId,
    brokerageId,
    transitionType,
    fromValue: opts.fromValue ?? null,
    toValue: opts.toValue ?? null,
    reason: opts.reason ?? null,
    actorType: opts.actorType,
    actorUserId: opts.actorUserId ?? null,
    metadata: opts.metadata ?? null,
  });
}

async function emit(eventType: string, connection: IntegrationConnection, actor: ActorRef | null, source: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await publishDomainEvent({
      eventType: eventType as any,
      occurredAt: new Date(),
      propertyId: null,
      transactionId: null,
      partyId: null,
      brokerageId: connection.brokerageId,
      agentId: null,
      actorType: actor ? "USER" : "SYSTEM",
      actorId: actor ? actor.id : null,
      source,
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `${eventType}:${connection.id}:${connection.version}`,
      payload,
      metadata: {},
    });
  } catch (err) {
    console.error(`publishDomainEvent(${eventType}) failed`, err);
  }
}

/** Tenant chokepoint — identical NOT_FOUND whether missing or cross-tenant (mirrors launch/model.ts's loadLaunchPlanInBrokerage). */
export async function loadConnectionInBrokerage(connectionId: string, brokerageId: number): Promise<IntegrationConnection> {
  const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, connectionId));
  if (!row || row.brokerageId !== brokerageId) throw new IntegrationError("NOT_FOUND", "Integration connection not found.");
  return row;
}

async function transition(
  connectionId: string,
  brokerageId: number,
  expectedVersion: number,
  toStatus: IntegrationConnectionStatus,
  patch: Record<string, unknown>,
  transitionType: string,
  actor: ActorRef | null,
  reason?: string | null,
): Promise<IntegrationConnection> {
  const existing = await loadConnectionInBrokerage(connectionId, brokerageId);
  if (existing.version !== expectedVersion) throw new IntegrationError("CONCURRENCY", "This connection was modified by someone else — reload and try again.");
  if (!isValidConnectionTransition(existing.status as IntegrationConnectionStatus, toStatus)) {
    throw new IntegrationError("INVALID_STATUS", `Cannot move a connection from ${existing.status} to ${toStatus}.`);
  }

  const [row] = await db
    .update(integrationConnections)
    .set({ status: toStatus, version: existing.version + 1, updatedAt: new Date(), ...patch })
    .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.version, expectedVersion)))
    .returning();
  if (!row) throw new IntegrationError("CONCURRENCY", "This connection was modified by someone else — reload and try again.");

  await recordTransition(connectionId, brokerageId, transitionType, {
    fromValue: existing.status,
    toValue: toStatus,
    reason: reason ?? null,
    actorType: actor ? "USER" : "SYSTEM",
    actorUserId: actor?.id ?? null,
  });
  await logAudit({
    userId: actor?.id,
    action: `integration_connection_${transitionType.toLowerCase()}`,
    recordType: "integration_connection",
    recordId: connectionId,
    previousValue: existing.status,
    updatedValue: toStatus,
  });

  return row;
}

// ---------------------------------------------------------------------
// DRAFT.
// ---------------------------------------------------------------------

export interface CreateDraftConnectionInput {
  providerId: string;
  displayName: string;
  purpose: string;
  requestedScopes: IntegrationCapability[];
}

export async function createDraftConnection(brokerageId: number, actor: ActorRef, input: CreateDraftConnectionInput): Promise<IntegrationConnection> {
  const provider = await getProvider(input.providerId);
  if (!provider || !provider.active) throw new IntegrationError("NOT_FOUND", `Provider ${input.providerId} not found or inactive.`);
  if (!input.purpose.trim()) throw new IntegrationError("VALIDATION", "purpose is required.");
  if (input.requestedScopes.length === 0) throw new IntegrationError("VALIDATION", "At least one requested scope is required.");
  const providerCapabilities = (provider.capabilities as unknown as string[]) ?? [];
  for (const scope of input.requestedScopes) {
    if (!providerCapabilities.includes(scope)) {
      throw new IntegrationError("CAPABILITY_NOT_SUPPORTED", `Provider ${provider.id} does not support capability ${scope}.`);
    }
  }

  const [created] = await db
    .insert(integrationConnections)
    .values({
      brokerageId,
      providerId: input.providerId,
      displayName: input.displayName,
      purpose: input.purpose,
      environmentClassification: provider.environmentClassification,
      requestedScopes: input.requestedScopes,
      approvedScopes: [],
      requestedBy: actor.id,
      status: "DRAFT",
    })
    .returning();

  await recordTransition(created.id, brokerageId, "CREATED", { toValue: "DRAFT", actorType: "USER", actorUserId: actor.id });
  await logAudit({ userId: actor.id, action: "integration_connection_created", recordType: "integration_connection", recordId: created.id, updatedValue: input.providerId });
  return created;
}

// ---------------------------------------------------------------------
// Approval.
// ---------------------------------------------------------------------

export async function requestApproval(connectionId: string, brokerageId: number, actor: ActorRef, expectedVersion: number): Promise<IntegrationConnection> {
  const updated = await transition(connectionId, brokerageId, expectedVersion, "PENDING_APPROVAL", { requestedAt: new Date() }, "APPROVAL_REQUESTED", actor);
  return updated;
}

/**
 * Route-gated to Brokerage Administrator only (Section 4's "authority")
 * — same weight class as Launch's decideVendorApproval / Financial's
 * commission-agreement second-approver precedent. Does NOT enforce
 * separation of duties from the requester in this build (no second-admin
 * fixture requirement is named in Section 14's acceptance scenarios for
 * this specific action) — a real production step would likely add that,
 * documented as deferred scope.
 */
export async function decideApproval(
  connectionId: string,
  brokerageId: number,
  actor: ActorRef,
  expectedVersion: number,
  decision: "APPROVED" | "REJECTED",
  approvedScopes: IntegrationCapability[] | null,
  authorityUserId: number | null,
  reason: string | null,
): Promise<IntegrationConnection> {
  if (decision === "APPROVED") {
    const existing = await loadConnectionInBrokerage(connectionId, brokerageId);
    const requested = (existing.requestedScopes as unknown as string[]) ?? [];
    const scopes = approvedScopes ?? (requested as IntegrationCapability[]);
    for (const s of scopes) {
      if (!requested.includes(s)) throw new IntegrationError("VALIDATION", `Cannot approve scope ${s} — it was never requested.`);
    }
    return transition(
      connectionId,
      brokerageId,
      expectedVersion,
      "APPROVED",
      { approvedBy: actor.id, approvedAt: new Date(), approvedScopes: scopes, authorityUserId: authorityUserId ?? actor.id },
      "APPROVED",
      actor,
      reason,
    );
  }
  return transition(connectionId, brokerageId, expectedVersion, "REJECTED", { rejectedBy: actor.id, rejectedAt: new Date(), rejectReason: reason }, "REJECTED", actor, reason);
}

// ---------------------------------------------------------------------
// Configure -> Validate -> Activate.
// ---------------------------------------------------------------------

export async function beginConfiguration(connectionId: string, brokerageId: number, actor: ActorRef, expectedVersion: number): Promise<IntegrationConnection> {
  return transition(connectionId, brokerageId, expectedVersion, "CONFIGURING", {}, "CONFIGURED", actor);
}

/**
 * Section 15's "test with mock adapter" controlled action. Calls the
 * registered adapter's own send() with a harmless, adapter-defined no-op
 * capability probe — this build uses the adapter's first declared
 * capability with an empty payload, which mockPortal.ts's own send()
 * treats as a pure connectivity check (see that file's own comment).
 * VALIDATION_FAILED never advances past CONFIGURING (types.ts's transition
 * table) — a failed validation can never be silently skipped.
 */
export async function validateConnection(connectionId: string, brokerageId: number, actor: ActorRef, expectedVersion: number): Promise<IntegrationConnection> {
  const beforeValidating = await transition(connectionId, brokerageId, expectedVersion, "VALIDATING", {}, "VALIDATING", actor);

  const adapter = getAdapter(beforeValidating.providerId);
  const approvedScopes = (beforeValidating.approvedScopes as unknown as string[]) ?? [];
  let ok = false;
  let detail = "No adapter registered for this provider.";
  if (adapter && approvedScopes.length > 0) {
    try {
      const probeCapability = approvedScopes[0] as IntegrationCapability;
      const result = await adapter.send(probeCapability, { __validationProbe: true }, { connectionId, brokerageId, idempotencyKey: `validate:${connectionId}:${randomUUID()}` });
      ok = result.status === "SENT";
      detail = result.responseSummary;
    } catch (err) {
      ok = false;
      detail = err instanceof Error ? err.message : "Validation probe threw an unexpected error.";
    }
  }

  const result = { ok, detail, at: new Date().toISOString() };
  if (ok) {
    return transition(connectionId, brokerageId, beforeValidating.version, "ACTIVE", { activatedAt: new Date(), activatedBy: actor.id, lastValidatedAt: new Date(), lastValidationResult: result, healthStatus: "HEALTHY", healthCheckedAt: new Date() }, "VALIDATED", actor).then(
      async (row) => {
        await emit("INTEGRATION_CONNECTION_ACTIVATED", row, actor, "api:integrations:validate", { connectionId, providerId: row.providerId });
        return row;
      },
    );
  }
  return transition(connectionId, brokerageId, beforeValidating.version, "VALIDATION_FAILED", { lastValidatedAt: new Date(), lastValidationResult: result }, "VALIDATION_FAILED", actor, detail);
}

// ---------------------------------------------------------------------
// Suspend / resume / revoke.
// ---------------------------------------------------------------------

export async function suspendConnection(connectionId: string, brokerageId: number, actor: ActorRef, expectedVersion: number, reason: string): Promise<IntegrationConnection> {
  const row = await transition(connectionId, brokerageId, expectedVersion, "SUSPENDED", { suspendedAt: new Date(), suspendedBy: actor.id, suspendReason: reason }, "SUSPENDED", actor, reason);
  await emit("INTEGRATION_CONNECTION_SUSPENDED", row, actor, "api:integrations:suspend", { connectionId, reason });
  return row;
}

export async function resumeConnection(connectionId: string, brokerageId: number, actor: ActorRef, expectedVersion: number): Promise<IntegrationConnection> {
  const row = await transition(connectionId, brokerageId, expectedVersion, "ACTIVE", { suspendedAt: null, suspendedBy: null, suspendReason: null }, "RESUMED", actor);
  await emit("INTEGRATION_CONNECTION_ACTIVATED", row, actor, "api:integrations:resume", { connectionId });
  return row;
}

export async function revokeConnection(connectionId: string, brokerageId: number, actor: ActorRef, expectedVersion: number, reason: string): Promise<IntegrationConnection> {
  const row = await transition(connectionId, brokerageId, expectedVersion, "REVOKED", { revokedAt: new Date(), revokedBy: actor.id, revokeReason: reason }, "REVOKED", actor, reason);
  await db.update(integrationCredentials).set({ status: "REVOKED", revokedAt: new Date(), revokedBy: actor.id }).where(eq(integrationCredentials.connectionId, connectionId));
  await emit("INTEGRATION_CONNECTION_REVOKED", row, actor, "api:integrations:revoke", { connectionId, reason });
  return row;
}

// ---------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------

export async function listConnectionsForBrokerage(brokerageId: number): Promise<IntegrationConnection[]> {
  return db.select().from(integrationConnections).where(eq(integrationConnections.brokerageId, brokerageId));
}

export async function getConnectionTransitions(connectionId: string, brokerageId: number) {
  await loadConnectionInBrokerage(connectionId, brokerageId);
  return db.select().from(integrationConnectionTransitions).where(eq(integrationConnectionTransitions.connectionId, connectionId));
}

export { newCorrelationId };
