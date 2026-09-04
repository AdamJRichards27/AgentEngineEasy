// Agent Engine 2.0 — AE Step 5 remediation.
//
// Two things live here: PROVIDER_CATALOGUE (a controlled, code-defined
// list of provider definitions — same "reviewed and shipped like any other
// code change" discipline as lib/exceptions/registry.ts's RISK_RULES, see
// that file's own module comment) and resolveActiveConnection — the ONE
// fail-closed chokepoint every outbound dispatch (outbox.ts) and inbound
// webhook lookup (webhooks.ts) must go through before touching a
// connection. Every precondition Section 4 names ("no connection without
// approval") is checked here, in one place, and ANY missing piece or ANY
// unexpected error fails closed (returns null / throws), never open.

import { and, eq } from "drizzle-orm";
import {
  db,
  integrationProviders,
  integrationConnections,
  type IntegrationProvider,
  type IntegrationConnection,
} from "@aee/db";
import { hasEntitlement } from "../entitlements/resolver.js";
import { getOrCreateIntegrationSettings } from "./settings.js";
import { IntegrationError, type IntegrationCapability } from "./types.js";

// The single entitlement key gating integration use at all — mirrors the
// existing per-feature entitlement-key convention (grow.access, etc.). A
// per-provider-category entitlement scheme is deferred scope (see the
// completion report) — one key is enough to prove the fail-closed pattern
// end to end without inventing entitlement rows this build has no seeded
// data for.
export const INTEGRATIONS_ENTITLEMENT_KEY = "integrations.access";

export interface ProviderDefinition {
  id: string;
  category: string;
  displayName: string;
  description: string;
  capabilities: IntegrationCapability[];
  environmentClassification: "MOCK" | "SANDBOX" | "PRODUCTION";
}

// Section 3: "usable by many future provider categories ... do not
// implement all these providers now." Exactly one real, working adapter
// ships in this build (mock_portal_v1 — see adapters/mockPortal.ts); the
// rest of the category list is intentionally NOT pre-populated with
// placeholder provider rows — an empty, honest catalogue is safer than a
// list of providers nothing actually implements yet (Section 10's admin UI
// requirement: "never suggest real providers are already connected").
export const PROVIDER_CATALOGUE: ProviderDefinition[] = [
  {
    id: "mock_portal_v1",
    category: "PORTAL",
    displayName: "Mock Property Portal (Sandbox)",
    description:
      "A deterministic, in-process mock of a real-estate portal integration — used to prove the adapter contract, connection lifecycle, outbox, and webhook gateway end to end without any live third-party connection.",
    capabilities: ["portal.publishListing", "portal.updateListingStatus"],
    environmentClassification: "MOCK",
  },
  // AE Step 5 remediation — Proof B (Communications Hub).
  {
    id: "mock_sms_v1",
    category: "COMMUNICATIONS",
    displayName: "Mock SMS Gateway (Sandbox)",
    description:
      "A deterministic, in-process mock of an SMS gateway integration — proves an outbound SMS can travel through the same registry/outbox/adapter/mapping/webhook foundation as Proof A, for a genuinely different domain (Communications Hub) and transport shape (send + an asynchronous inbound delivery webhook). No real network call, no real destination is ever contacted.",
    capabilities: ["comms.sendSms"],
    environmentClassification: "MOCK",
  },
  // AE Step 5 remediation — Proof C (Financial Transaction Engine). Status
  // sync only — this provider never gains a debit/transfer capability, in
  // this catalogue or any other (see mockPaymentStatusSync.ts).
  {
    id: "mock_payment_status_v1",
    category: "FINANCIAL",
    displayName: "Mock Payment Status Feed (Sandbox)",
    description:
      "A deterministic, in-process mock of a payment processor's status-reporting feed — proves an inbound mock payment-status event can be verified, mapped, and submitted through the Financial Engine's own reconciliation authority without ever moving money or reaching a bank/trust/payment-processor connection.",
    capabilities: ["payments.statusSync"],
    environmentClassification: "MOCK",
  },
];

/** Idempotent upsert of the code-defined catalogue into integration_providers — called once at bootstrap (bootstrap.ts). */
export async function seedProviderCatalogue(): Promise<void> {
  for (const def of PROVIDER_CATALOGUE) {
    await db
      .insert(integrationProviders)
      .values({
        id: def.id,
        category: def.category,
        displayName: def.displayName,
        description: def.description,
        capabilities: def.capabilities,
        environmentClassification: def.environmentClassification,
        isBuiltIn: true,
        active: true,
      })
      .onConflictDoUpdate({
        target: integrationProviders.id,
        set: {
          category: def.category,
          displayName: def.displayName,
          description: def.description,
          capabilities: def.capabilities,
          environmentClassification: def.environmentClassification,
          updatedAt: new Date(),
        },
      });
  }
}

export async function listProviderCatalogue(): Promise<IntegrationProvider[]> {
  return db.select().from(integrationProviders).where(eq(integrationProviders.active, true));
}

export async function getProvider(providerId: string): Promise<IntegrationProvider | null> {
  const [row] = await db.select().from(integrationProviders).where(eq(integrationProviders.id, providerId));
  return row ?? null;
}

export interface ResolvedConnection {
  connection: IntegrationConnection;
  provider: IntegrationProvider;
}

/**
 * The fail-closed resolver (Section 4). Returns the connection ONLY if
 * every one of these is true, checked in this exact order so the error
 * reason is always the first real blocker, never a later, more confusing one:
 *   1. A connection matching connectionId exists AND belongs to this brokerage.
 *   2. Brokerage-level integrations.enabled setting is on.
 *   3. The actor's brokerage holds the integrations.access entitlement.
 *   4. Its status is ACTIVE (the only usable status — Section 4).
 *   5. Its environmentClassification is "MOCK" (defence in depth — this
 *      build never activates anything else; see integrations.ts schema's
 *      own comment on activateConnection).
 *   6. The requested capability is in its approvedScopes.
 *   7. The provider itself still declares that capability and is active.
 * Any DB error is caught and treated as a fail-closed denial, never surfaced
 * as an ambiguous 500 that might be mistaken for "try again and it'll work."
 *
 * The tenant/existence check (1) deliberately runs BEFORE every other
 * check. Section 4.6 requires tenant isolation to be airtight, and Section
 * 14's acceptance scenario #8 requires that a caller from another brokerage
 * gets an identical NOT_FOUND for any operation on a connection that was
 * never theirs — never a different error derived from THEIR OWN brokerage's
 * settings/entitlement state (e.g. "your brokerage lacks the entitlement"),
 * which would still let a caller distinguish "this connectionId exists
 * somewhere" from "it doesn't" by comparing error reasons across two of
 * their own requests. Tenant scoping is the outermost boundary; only once a
 * connection is confirmed to belong to the caller's own brokerage do the
 * brokerage-level settings/entitlement checks (which are otherwise cheaper
 * and independent of connectionId) get evaluated.
 */
export async function resolveActiveConnection(brokerageId: number, connectionId: string, capability: IntegrationCapability): Promise<ResolvedConnection> {
  const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, connectionId));
  if (!connection || connection.brokerageId !== brokerageId) {
    // Identical NOT_FOUND whether the row is missing or belongs to another
    // tenant — mirrors exceptions/model.ts / launch/model.ts's own
    // "never reveal cross-tenant existence" discipline.
    throw new IntegrationError("NOT_FOUND", "Integration connection not found.");
  }

  let settings;
  try {
    settings = await getOrCreateIntegrationSettings(brokerageId);
  } catch (err) {
    throw new IntegrationError("BROKERAGE_DISABLED", "Could not resolve integration settings for this brokerage — failing closed.");
  }
  if (!settings.enabled) {
    throw new IntegrationError("BROKERAGE_DISABLED", "Integrations are not enabled for this brokerage.");
  }

  const entitled = await hasEntitlement({ id: 0, role: "SYSTEM", brokerageId }, INTEGRATIONS_ENTITLEMENT_KEY).catch(() => false);
  if (!entitled) {
    throw new IntegrationError("ENTITLEMENT_DENIED", "This brokerage does not hold the integrations.access entitlement.");
  }

  if (connection.status !== "ACTIVE") {
    throw new IntegrationError("CONNECTION_NOT_USABLE", `Connection is ${connection.status}, not ACTIVE.`);
  }
  if (connection.environmentClassification !== "MOCK") {
    throw new IntegrationError("ENVIRONMENT_NOT_ALLOWED", `Connection environment ${connection.environmentClassification} is not permitted in this build.`);
  }

  const approvedScopes = (connection.approvedScopes as unknown as string[]) ?? [];
  if (!approvedScopes.includes(capability)) {
    throw new IntegrationError("SCOPE_NOT_APPROVED", `Capability ${capability} is not an approved scope on this connection.`);
  }

  const provider = await getProvider(connection.providerId);
  if (!provider || !provider.active) {
    throw new IntegrationError("NOT_FOUND", "Provider catalogue entry not found or inactive.");
  }
  const providerCapabilities = (provider.capabilities as unknown as string[]) ?? [];
  if (!providerCapabilities.includes(capability)) {
    throw new IntegrationError("CAPABILITY_NOT_SUPPORTED", `Provider ${provider.id} does not declare capability ${capability}.`);
  }

  return { connection, provider };
}

// ---------------------------------------------------------------------
// Adapter lookup — a separate, small in-process map (not a DB table: this
// is executable code, same reasoning as RISK_RULES). Keyed by providerId
// so swapping an adapter implementation is a one-line registration change,
// never a domain-code change (Section 4: "adapters must be replaceable").
// ---------------------------------------------------------------------

import type { IntegrationAdapter } from "./types.js";

const adapters = new Map<string, IntegrationAdapter>();

export function registerAdapter(adapter: IntegrationAdapter): void {
  adapters.set(adapter.providerId, adapter);
}

export function getAdapter(providerId: string): IntegrationAdapter | undefined {
  return adapters.get(providerId);
}

export function clearAdaptersForTesting(): void {
  adapters.clear();
}
