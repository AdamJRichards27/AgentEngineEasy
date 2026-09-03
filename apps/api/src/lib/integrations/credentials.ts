// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// The credential-reference boundary (Section 4/18). This module is the
// ONLY place integration_credentials is ever written, and it is
// structurally incapable of persisting a real secret: there is no "value"
// parameter anywhere in this file's exported functions, only an opaque
// identifier this module itself generates. mintMockAuthFlow is this
// build's entire "auth flow" — a deterministic, in-process stand-in for
// what would later be a real OAuth/API-key exchange with a secrets manager
// on the other end, never a real provider session.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, integrationCredentials, type IntegrationCredential } from "@aee/db";
import { logAudit } from "../audit.js";
import { IntegrationError, type ActorRef } from "./types.js";

/**
 * A pattern any real credential value (an API key, a bearer token, a
 * password) would very likely match, used only defensively by the test
 * suite (__tests__/credentials.test.ts) to assert this module never comes
 * close to producing something that looks like one. Not used to validate
 * input here — this module simply never accepts a secret value as input
 * in the first place, which is the actual guarantee.
 */
export const SECRET_IDENTIFIER_PREFIX = "mock-secret-ref:";

export async function mintMockAuthFlow(connectionId: string, actor: ActorRef): Promise<IntegrationCredential> {
  const [existing] = await db.select().from(integrationCredentials).where(eq(integrationCredentials.connectionId, connectionId));
  if (existing && existing.status === "ACTIVE") {
    throw new IntegrationError("VALIDATION", "This connection already has an active credential reference.");
  }

  const secretIdentifier = `${SECRET_IDENTIFIER_PREFIX}${randomUUID()}`;
  const [row] = existing
    ? await db
        .update(integrationCredentials)
        .set({ referenceType: "MOCK_AUTH_FLOW", secretIdentifier, status: "ACTIVE", revokedAt: null, revokedBy: null, createdAt: new Date(), createdBy: actor.id })
        .where(eq(integrationCredentials.id, existing.id))
        .returning()
    : await db.insert(integrationCredentials).values({ connectionId, referenceType: "MOCK_AUTH_FLOW", secretIdentifier, createdBy: actor.id }).returning();

  await logAudit({ userId: actor.id, action: "integration_credential_reference_minted", recordType: "integration_connection", recordId: connectionId, updatedValue: "MOCK_AUTH_FLOW" });
  return row;
}

/** Never returns secretIdentifier — callers that only need "does a reference exist" use this rather than reading the row directly. */
export async function hasActiveCredentialReference(connectionId: string): Promise<boolean> {
  const [row] = await db.select({ status: integrationCredentials.status }).from(integrationCredentials).where(eq(integrationCredentials.connectionId, connectionId));
  return row?.status === "ACTIVE";
}

/**
 * Server-side only — used by routes/integrationsWebhooks.ts to compute the
 * expected HMAC for an inbound mock-portal webhook, and directly by tests
 * that need to simulate what "the mock portal" would sign with (the same
 * direct-module-access convention every other test suite in this codebase
 * already uses, e.g. calling runScheduledScan directly rather than going
 * through HTTP). Never exposed through the admin HTTP API — see
 * routes/integrations.ts's own connection-detail handler, which omits this
 * value entirely (Section 10: "never display credential values").
 */
export async function getSecretIdentifierForSigning(connectionId: string): Promise<string | null> {
  const [row] = await db.select({ secretIdentifier: integrationCredentials.secretIdentifier, status: integrationCredentials.status }).from(integrationCredentials).where(eq(integrationCredentials.connectionId, connectionId));
  return row && row.status === "ACTIVE" ? row.secretIdentifier : null;
}
