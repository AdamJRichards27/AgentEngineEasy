export type DenialReasonCode =
  | "NOT_AUTHENTICATED"
  | "TENANT_CONTEXT_REQUIRED"
  | "TENANT_MISMATCH"
  | "ROLE_FORBIDDEN"
  | "ENTITLEMENT_MISSING"
  | "ENTITLEMENT_EXPIRED"
  | "SUBSCRIPTION_INACTIVE"
  | "SEAT_NOT_ALLOCATED"
  | "LIMIT_REACHED";

export interface EntitlementActor {
  id: number;
  role: string;
  brokerageId: number;
}

export interface EntitlementDecision {
  allowed: boolean;
  reason: DenialReasonCode | "OK";
  entitlementKey: string;
  limitValue: number | null;
  grantId: number | null;
}

export class EntitlementError extends Error {
  reason: DenialReasonCode;
  entitlementKey: string;
  constructor(reason: DenialReasonCode, entitlementKey: string) {
    super(`Entitlement denied: ${entitlementKey} (${reason})`);
    this.reason = reason;
    this.entitlementKey = entitlementKey;
  }
}
