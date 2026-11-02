import { Router } from "express";
import { eq, and, inArray, ne, asc } from "drizzle-orm";
import { z } from "zod";
import { db, parties, propertyParties, properties, workflows, auditLogs, PROPERTY_PARTY_ROLES, PROPERTY_PARTY_PRIMARY_EXEMPT_ROLES } from "@aee/db";
import { incrementCounter, logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { restrictedPropertyIdsFor, propertyHiddenFromCaller } from "../lib/propertyVisibility.js";
import { requireAnyEntitlement, requireRelationshipManage } from "../middlewares/entitlement.js";
import { explainEntitlementDecision } from "../lib/entitlements/resolver.js";
import { findDuplicateContact } from "./contacts.js";
import { logAudit } from "../lib/audit.js";
import { addPostCallNote, recordCallConsentConfirmation, tapToCallStatus } from "../lib/tapToCall.js";
import { reviewOwnershipForProperty } from "../lib/ownership.js";
import { initiateAmlIfNeeded } from "../lib/aml.js";
import { refreshReadyToListSteps } from "../lib/workflowSteps.js";

async function readyToListWorkflowExists(propertyId: number): Promise<boolean> {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, propertyId), eq(workflows.workflowType, "ReadyToList")));
  return Boolean(workflow);
}

// R-F9 — the party boundary of tenant_isolation_rejection_total.
// Scoped loads cannot tell a missing id from one in another brokerage.
// On a miss only, one existence lookup (never on the success path) checks
// whether the record belongs to another brokerage and, if so, increments
// once with boundary "party". The lookup selects no brokerage id and no
// other tenant's columns (no party PII). Callers still answer 404 either
// way. Same rule as routes/transactions.ts and routes/offers.ts: a missing
// row does not increment, and the other brokerage's id is not logged or
// returned.
async function notePartyPropertyIsolationRejection(propertyId: number, brokerageId: number): Promise<void> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) return;
  const [elsewhere] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), ne(properties.brokerageId, brokerageId)));
  if (elsewhere) {
    incrementCounter("tenant_isolation_rejection_total", { boundary: "party" });
  }
}

async function notePartyLinkIsolationRejection(linkId: number, brokerageId: number): Promise<void> {
  if (!Number.isInteger(linkId) || linkId <= 0) return;
  const [elsewhere] = await db
    .select({ id: propertyParties.id })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .where(and(eq(propertyParties.id, linkId), ne(properties.brokerageId, brokerageId)));
  if (elsewhere) {
    incrementCounter("tenant_isolation_rejection_total", { boundary: "party" });
  }
}

export const partiesRouter = Router();

// t234u (Owner): matching emails / mobiles are NOT rejected — shared household
// and business details are legitimate. Callers get potential-duplicate
// warnings (with the existing contact id when Contact 360 would show it) and
// are expected to offer "link existing" (POST /parties with partyId), which
// reuses the contact id instead of creating a second record.
export type PotentialDuplicateWarning = { code: "POTENTIAL_DUPLICATE_CONTACT"; kind: "email" | "phone"; contactId?: number };
export async function potentialDuplicateWarnings(
  brokerageId: number,
  email: string | undefined | null,
  mobile: string | undefined | null,
): Promise<PotentialDuplicateWarning[]> {
  const out: PotentialDuplicateWarning[] = [];
  for (const [kind, value] of [["email", email], ["phone", mobile]] as const) {
    if (!value) continue;
    const dup = await findDuplicateContact(brokerageId, kind, value, null);
    if (dup) out.push(dup.contactId === null ? { code: "POTENTIAL_DUPLICATE_CONTACT", kind } : { code: "POTENTIAL_DUPLICATE_CONTACT", kind, contactId: dup.contactId });
  }
  return out;
}

// t234u (Owner): at most one primary contact per property per role, where
// applicable ("Other" groups unrelated relationships, so it is exempt).
// Primary is optional and is a display/contact preference only: it carries
// NO legal or signing authority (agreements, AML and signing never read it).
export const PRIMARY_EXEMPT_ROLES: readonly string[] = PROPERTY_PARTY_PRIMARY_EXEMPT_ROLES;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Actor = NonNullable<Express.Request["authedUser"]>;

// t238u (Owner): setting a new primary atomically REPLACES the old one within
// the same (property, role), inside the caller's transaction (which already
// holds the property FOR UPDATE lock). The previous contact keeps their
// relationship with isPrimary=false. Demotion happens BEFORE the new primary
// is written so the proposed partial unique index (0049) is never violated.
async function demoteOtherPrimaries(tx: Tx, propertyId: number, role: string, excludeLinkId: number | null) {
  if (PRIMARY_EXEMPT_ROLES.includes(role)) return [] as { id: number; partyId: number }[];
  const conds = [eq(propertyParties.propertyId, propertyId), eq(propertyParties.role, role), eq(propertyParties.isPrimary, true)];
  if (excludeLinkId !== null) conds.push(ne(propertyParties.id, excludeLinkId));
  return tx.update(propertyParties).set({ isPrimary: false }).where(and(...conds)).returning({ id: propertyParties.id, partyId: propertyParties.partyId });
}
// Same transaction as the change, so the demotion and its audit commit together.
async function auditPrimaryReplaced(tx: Tx, user: Actor, propertyId: number, role: string, demoted: { id: number; partyId: number }[], newLinkId: number) {
  for (const d of demoted) {
    await tx.insert(auditLogs).values({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "party_link_primary_replaced",
      recordType: "property_party",
      recordId: String(d.id),
      propertyId,
      previousValue: JSON.stringify({ role, isPrimary: true }),
      updatedValue: JSON.stringify({ role, isPrimary: false, replacedByLinkId: newLinkId }),
    });
  }
}
// Contract v2 §4.4: every link whose flag changed, as {id, role, isPrimary}
// (linkId kept as an alias). Demoted links first, then the target if it changed.
type ChangedLink = { id: number; linkId: number; role: string; isPrimary: boolean };
function changedBody(role: string, demoted: { id: number }[], target?: { id: number; role: string; isPrimary: boolean }): ChangedLink[] {
  const out: ChangedLink[] = demoted.map((d) => ({ id: d.id, linkId: d.id, role, isPrimary: false }));
  if (target) out.push({ id: target.id, linkId: target.id, role: target.role, isPrimary: target.isPrimary });
  return out;
}

// t228u Priority 1: property contacts belong to Grow (kept per t223u) and Run.
// An active grant for either product is required; an unsubscribed brokerage
// gets 403 on reads and writes. Mutations additionally need access to the
// specific property (own-property scope, #147): hidden properties answer 404,
// the same as a cross-brokerage id.
const canReadPropertyContacts = requireAnyEntitlement("grow.contacts.read", "run.access");
const canManagePropertyContacts = requireAnyEntitlement("grow.contacts.manage", "run.access");
// t242u (Owner): relationship management (link, unlink, role change, primary
// change) needs the explicit grow.relationships.manage permission PLUS access
// to the specific property (own-property scope, brokerage isolation: 404).
// run.access alone does NOT authorise these. t246u: a Run-entitled Agent or
// Brokerage Administrator (the roles with Run contact-management rights) is
// derived as authorised, so legacy Run brokerages keep link capability without
// #281 or a seeded grant; Pit Crew needs the explicit key. See
// middlewares/entitlement.ts requireRelationshipManage.
const canManageRelationships = requireRelationshipManage();

// t238u: one role vocabulary, owned by @aee/db (re-exported for existing importers).
export { PROPERTY_PARTY_ROLES };
// t238u contract item 5: an unknown role is 400 INVALID_ROLE with the allowed list.
function invalidRole(body: unknown): boolean {
  const role = (body as { role?: unknown } | null)?.role;
  return role !== undefined && !(PROPERTY_PARTY_ROLES as readonly unknown[]).includes(role);
}
function invalidRoleBody() {
  return { error: "Unknown role", code: "INVALID_ROLE", allowedRoles: PROPERTY_PARTY_ROLES };
}

// One-time party capture (Build Brief §4): minimum fields only; entity
// structure detail (trust/company/estate) is requested only when needed.
// Multi-seller capture (ARCHITECTURE.md §10 Phase 2): a property can have
// any number of Seller links — nothing here caps it to one.
const addPartySchema = z.object({
  propertyId: z.number(),
  role: z.enum(PROPERTY_PARTY_ROLES),
  partyType: z.enum(["Person", "Organisation", "Trust", "Estate", "Other"]).default("Person"),
  isPrimary: z.boolean().optional().default(false),
  firstName: z.string().optional(),
  middleName: z.string().optional(),
  lastName: z.string().optional(),
  organisationName: z.string().optional(),
  mobile: z.string().optional(),
  email: z.string().email().optional(),
  rejectDuplicateContact: z.boolean().optional(),
  // t236u: the creating agent's confirmation that the contact agreed to be called.
  callConsent: z
    .object({ confirmed: z.boolean(), restrictions: z.string().max(500).optional(), doNotCall: z.boolean().optional() })
    .strict()
    .optional(),
  residentialAddress: z.string().optional(),
  // AE Minimal v1.0 (Owner t149u): link an EXISTING contact instead of
  // creating one. When present, no contact fields are read and no party row
  // is inserted. Omitted = the original create-and-link behaviour.
  partyId: z.number().int().positive().optional(),
});

// Party boundary twin of notePartyPropertyIsolationRejection: on a miss only.
async function notePartyIsolationRejection(partyId: number, brokerageId: number): Promise<void> {
  const [elsewhere] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, partyId), ne(parties.brokerageId, brokerageId)));
  if (elsewhere) incrementCounter("tenant_isolation_rejection_total", { boundary: "party" });
}

// t238u (Owner): Grow-only agents may record Seller relationships. The Run
// side effects (ownership review, AML initiation, Ready-to-List refresh) only
// run when the caller holds run.access; a Grow-only Seller link is a plain
// relationship. Pit Crew is never triggered from here (no path does).
async function callerHasRun(user: Actor): Promise<boolean> {
  // Same uncached decision the route middleware uses (requireAnyEntitlement),
  // so the gate and the side-effect decision can never disagree.
  return explainEntitlementDecision(user, "run.access").then((d) => d.allowed).catch(() => false);
}
async function runSellerSideEffects(propertyId: number, partyId: number, user: Actor) {
  if (!(await callerHasRun(user))) {
    logger.info("seller_side_effects_skipped_no_run_access", { propertyId, partyId, brokerageId: user.brokerageId });
    return;
  }
  // Re-run the ownership review-not-block check now that a seller exists
  // to compare against (Build Brief §8) — see apps/api/src/lib/ownership.ts.
  await reviewOwnershipForProperty(propertyId).catch((err) =>
    logger.error("review_ownership_for_property_failed", { propertyId, error: err }),
  );
  // If Ready to List already ran for this property, a seller added
  // afterwards still needs AML initiated and the workflow steps recomputed.
  if (await readyToListWorkflowExists(propertyId)) {
    await initiateAmlIfNeeded({ propertyId, partyId, userId: user.id, brokerageId: user.brokerageId }).catch((err) =>
      logger.error("initiate_aml_if_needed_failed", { propertyId, partyId, error: err }),
    );
    await refreshReadyToListSteps(propertyId).catch((err) =>
      logger.error("refresh_ready_to_list_steps_failed", { propertyId, error: err }),
    );
  }
}
// A Seller link removed (or re-roled away from Seller). Same Run gate.
async function runSellerRemovedEffects(propertyId: number, user: Actor) {
  if (!(await callerHasRun(user))) return;
  await reviewOwnershipForProperty(propertyId).catch((err) =>
    logger.error("review_ownership_for_property_failed", { propertyId, error: err }),
  );
  if (await readyToListWorkflowExists(propertyId)) {
    // The seller's existing AML verification record is left in place —
    // it's history, not deleted — but the workflow steps need to reflect
    // the current seller list.
    await refreshReadyToListSteps(propertyId).catch((err) =>
      logger.error("refresh_ready_to_list_steps_failed", { propertyId, error: err }),
    );
  }
}


// t242u PII minimisation: the property-contact endpoints return only what the
// web panel, Contact 360 and mobile v5 rows read. residentialAddress,
// entityDetails (trust deed / ACN), middleName, brokerageId and timestamps are
// never returned here; the full record stays behind the Grow contact routes.
export type PartySummary = { id: number; partyType: string; firstName: string | null; lastName: string | null; organisationName: string | null; email: string | null; mobile: string | null };
export function partySummary(p: typeof parties.$inferSelect, full = true): PartySummary {
  return { id: p.id, partyType: p.partyType, firstName: p.firstName, lastName: p.lastName, organisationName: p.organisationName, email: full ? p.email : maskEmail(p.email), mobile: full ? p.mobile : maskPhone(p.mobile) };
}
// t244u E: full email/mobile only for callers with contact-read access
// (grow.contacts.read). Others (e.g. Run without Grow contacts) see a mask.
export function maskEmail(e: string | null): string | null {
  if (!e) return e;
  const at = e.indexOf("@");
  return at > 0 ? `${e[0]}***${e.slice(at)}` : "***";
}
export function maskPhone(m: string | null): string | null {
  if (!m) return m;
  const digits = m.replace(/\D/g, "");
  return digits.length >= 3 ? `***${digits.slice(-3)}` : "***";
}
async function callerCanReadContacts(user: Actor): Promise<boolean> {
  return explainEntitlementDecision(user, "grow.contacts.read").then((d) => d.allowed).catch(() => false);
}

partiesRouter.post("/", requireAuth, canManageRelationships, async (req, res) => {
  if (invalidRole(req.body)) {
    res.status(400).json(invalidRoleBody());
    return;
  }
  const parsed = addPartySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  if (parsed.data.partyId !== undefined) {
    const { propertyId, partyId, role, isPrimary } = parsed.data;
    if (await propertyHiddenFromCaller(user, propertyId)) {
      res.status(404).json({ error: "Property not found" });
      return;
    }
    // One transaction; the property row is locked FOR UPDATE so concurrent
    // submissions for the same property serialise and the duplicate check
    // below cannot race. property_parties has no unique constraint and this
    // change adds no migration (Owner t149u), so the lock is the guard.
    const outcome = await db.transaction(async (tx) => {
      const [property] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)))
        .for("update");
      if (!property) return { kind: "property_missing" as const };
      const [party] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId)));
      if (!party) return { kind: "party_missing" as const };
      const [existing] = await tx
        .select()
        .from(propertyParties)
        .where(and(eq(propertyParties.propertyId, propertyId), eq(propertyParties.partyId, partyId), eq(propertyParties.role, role)));
      if (existing) return { kind: "exists" as const, party, link: existing };
      const demoted = isPrimary ? await demoteOtherPrimaries(tx, propertyId, role, null) : [];
      const [link] = await tx.insert(propertyParties).values({ propertyId, partyId, role, isPrimary }).returning();
      await auditPrimaryReplaced(tx, user, propertyId, role, demoted, link.id);
      return { kind: "created" as const, party, link, demoted };
    });
    if (outcome.kind === "property_missing") {
      await notePartyPropertyIsolationRejection(propertyId, user.brokerageId);
      res.status(404).json({ error: "Property not found" });
      return;
    }
    if (outcome.kind === "party_missing") {
      await notePartyIsolationRejection(partyId, user.brokerageId);
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    if (outcome.kind === "exists") {
      res.status(409).json({
        error: "This contact is already linked to the property with that role",
        code: "PROPERTY_PARTY_LINK_EXISTS",
        link: outcome.link,
      });
      return;
    }
    await logAudit({
      userId: user.id,
      action: "party_linked_existing",
      recordType: "party",
      recordId: String(partyId),
      propertyId,
    });
    if (role === "Seller") await runSellerSideEffects(propertyId, partyId, user);
    res.status(201).json({ party: partySummary(outcome.party), link: outcome.link, changed: changedBody(outcome.link.role, outcome.demoted) });
    return;
  }

  // Tenant-scoped in the same fetch that loads the property, not a check
  // bolted on after — a propertyId from another brokerage is
  // indistinguishable from a nonexistent one, matching
  // assertPropertyInBrokerage (lib/launch/model.ts) and
  // assertPartyOnPropertyInBrokerage (lib/aml.ts). Without this, a party
  // could be linked (and AML/ownership-review side effects triggered) on
  // an arbitrary cross-brokerage property.
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, parsed.data.propertyId), eq(properties.brokerageId, user.brokerageId)));
  if (!property || (await propertyHiddenFromCaller(user, property.id))) {
    if (!property) await notePartyPropertyIsolationRejection(parsed.data.propertyId, user.brokerageId);
    res.status(404).json({ error: "Property not found" });
    return;
  }

  // Creating a NEW contact additionally needs contact-creation rights
  // (grow.contacts.manage, or run.access as before): unchanged by t242u.
  const canCreate = await explainEntitlementDecision(user, "grow.contacts.manage");
  if (!canCreate.allowed && !(await callerHasRun(user))) {
    res.status(403).json({ error: "Not entitled", reason: canCreate.reason, entitlementKey: "grow.contacts.manage", upgrade: { action: "grow.checkout", productCode: "grow" } });
    return;
  }

  // t234u: never rejected for a matching email/mobile (rejectDuplicateContact
  // is accepted for compatibility and ignored); warnings are returned instead.
  const warnings = await potentialDuplicateWarnings(user.brokerageId, parsed.data.email, parsed.data.mobile);

  const created = await db.transaction(async (tx) => {
    // Same serialisation point as the link-existing path (primary rule).
    await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, property.id)).for("update");
    const demoted = parsed.data.isPrimary ? await demoteOtherPrimaries(tx, property.id, parsed.data.role, null) : [];
    const [party] = await tx
      .insert(parties)
      .values({
        brokerageId: user.brokerageId,
        partyType: parsed.data.partyType,
        firstName: parsed.data.firstName,
        middleName: parsed.data.middleName,
        lastName: parsed.data.lastName,
        organisationName: parsed.data.organisationName,
        mobile: parsed.data.mobile,
        email: parsed.data.email,
        residentialAddress: parsed.data.residentialAddress,
      })
      .returning();
    const [link] = await tx
      .insert(propertyParties)
      .values({
        propertyId: parsed.data.propertyId,
        partyId: party.id,
        role: parsed.data.role,
        isPrimary: parsed.data.isPrimary,
      })
      .returning();
    if (parsed.data.callConsent) {
      await recordCallConsentConfirmation(tx, { brokerageId: user.brokerageId, partyId: party.id, userId: user.id, ...parsed.data.callConsent });
    }
    await auditPrimaryReplaced(tx, user, property.id, parsed.data.role, demoted, link.id);
    return { party, link, demoted };
  });
  const { party, link, demoted } = created;

  await logAudit({
    userId: user.id,
    action: "party_added",
    recordType: "party",
    recordId: String(party.id),
    propertyId: parsed.data.propertyId,
  });

  if (parsed.data.role === "Seller") await runSellerSideEffects(parsed.data.propertyId, party.id, user);

  res.status(201).json({ party: partySummary(party), link, warnings, changed: changedBody(link.role, demoted) });
});

// t234u: pre-flight duplicate check for create forms (mobile + web). Body, not
// query string, so contact details stay out of URLs and access logs. Never
// blocks; returns warnings with reusable contact ids. Same gates as create.
const duplicateCheckSchema = z.object({ email: z.string().optional(), mobile: z.string().optional() }).strict();
partiesRouter.post("/duplicate-check", requireAuth, canManagePropertyContacts, async (req, res) => {
  const parsed = duplicateCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  const warnings = await potentialDuplicateWarnings(user.brokerageId, parsed.data.email, parsed.data.mobile);
  // t253u: matching stays brokerage-scoped. A caller without contact-read (e.g. Run-only, who sees masked
  // contact PII under #296) learns only that a match exists (kind), never which contact it is.
  const canRead = await callerCanReadContacts(user);
  res.json({ warnings: canRead ? warnings : warnings.map(({ code, kind }) => ({ code, kind })) });
});

partiesRouter.get("/by-property/:propertyId", requireAuth, canReadPropertyContacts, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;

  // Same tenant chokepoint as POST / above — without it this route leaks
  // another brokerage's party PII (name/email/mobile) to any authenticated
  // caller who guesses/enumerates a propertyId.
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)));
  if (!property) {
    await notePartyPropertyIsolationRejection(propertyId, user.brokerageId);
    res.status(404).json({ error: "Not found" });
    return;
  }
  const restrictTo = await restrictedPropertyIdsFor(user);
  if (restrictTo !== null && !restrictTo.includes(property.id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const links = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));
  const partyIds = links.map((l) => l.partyId);
  const partyRows = partyIds.length ? await db.select().from(parties).where(inArray(parties.id, partyIds)) : [];

  const fullContact = await callerCanReadContacts(user);
  res.json({
    parties: links.map((link) => ({
      linkId: link.id,
      role: link.role,
      isPrimary: link.isPrimary,
      party: (() => { const p = partyRows.find((r) => r.id === link.partyId); return p ? partySummary(p, fullContact) : null; })(),
    })),
  });
});

// Removing a mis-added seller/buyer link (multi-seller capture polish,
// Phase 2) — removes the property↔party link only; the Party record itself
// is left intact since it may be linked elsewhere or worth keeping.
partiesRouter.delete("/link/:linkId", requireAuth, canManageRelationships, async (req, res) => {
  const linkId = Number(req.params.linkId);
  const user = req.authedUser!;

  // propertyParties carries no brokerageId of its own, so the lookup joins
  // onto properties and filters by brokerageId in that same query — not a
  // check performed after the row is loaded — mirroring
  // retryAmlVerification/resolveAmlException in lib/aml.ts. Without this, any
  // authenticated user could delete another brokerage's party-property link
  // (and trigger the ownership-review/workflow-refresh side effects below on
  // that brokerage's property) just by guessing/enumerating a linkId.
  const [row] = await db
    .select({ link: propertyParties })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .where(and(eq(propertyParties.id, linkId), eq(properties.brokerageId, user.brokerageId)));
  if (!row) {
    await notePartyLinkIsolationRejection(linkId, user.brokerageId);
    res.status(404).json({ error: "Not found" });
    return;
  }
  const link = row.link;
  if (await propertyHiddenFromCaller(user, link.propertyId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await db.delete(propertyParties).where(eq(propertyParties.id, linkId));

  await logAudit({
    userId: user.id,
    action: "party_link_removed",
    recordType: "property_party",
    recordId: String(linkId),
    propertyId: link.propertyId,
  });

  if (link.role === "Seller") await runSellerRemovedEffects(link.propertyId, user);

  res.status(204).end();
});

// t228u Priority 2: the contact side of property_parties (authoritative for
// contact <-> property). Lists every property the caller can see that this
// contact is linked to, with role and primary flag. The contact must be in
// the caller's brokerage (404 otherwise); links on properties hidden by
// own-property scope (#147) are omitted, not revealed.
export const BY_CONTACT_LIMIT = 100;
partiesRouter.get("/by-contact/:partyId", requireAuth, canReadPropertyContacts, async (req, res) => {
  const partyId = Number(req.params.partyId);
  const user = req.authedUser!;
  if (!Number.isInteger(partyId) || partyId <= 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [party] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId)));
  if (!party) {
    await notePartyIsolationRejection(partyId, user.brokerageId);
    res.status(404).json({ error: "Not found" });
    return;
  }
  const restrictTo = await restrictedPropertyIdsFor(user);
  const rows = await db
    .select({
      linkId: propertyParties.id,
      propertyId: propertyParties.propertyId,
      role: propertyParties.role,
      isPrimary: propertyParties.isPrimary,
      createdAt: propertyParties.createdAt,
      formattedAddress: properties.formattedAddress,
      suburb: properties.suburb,
      state: properties.state,
      postcode: properties.postcode,
    })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .where(and(eq(propertyParties.partyId, partyId), eq(properties.brokerageId, user.brokerageId)))
    .orderBy(asc(propertyParties.propertyId), asc(propertyParties.id));
  const visible = restrictTo === null ? rows : rows.filter((r) => restrictTo.includes(r.propertyId));
  // t238u contract item 4: additive `links` (nested property, capped at
  // BY_CONTACT_LIMIT, `truncated` when more exist). `properties` (flat) is kept
  // unchanged for the existing web client.
  const capped = visible.slice(0, BY_CONTACT_LIMIT);
  res.json({
    partyId,
    properties: visible,
    links: capped.map((r) => ({
      linkId: r.linkId,
      role: r.role,
      isPrimary: r.isPrimary,
      createdAt: r.createdAt,
      property: { id: r.propertyId, formattedAddress: r.formattedAddress, suburb: r.suburb, state: r.state, postcode: r.postcode },
    })),
    // t253u: reliable counts for the client. `total` counts ONLY links the caller may see
    // (after the own-property filter); hidden-property links are never counted or revealed.
    truncated: visible.length > BY_CONTACT_LIMIT,
    total: visible.length,
    limit: BY_CONTACT_LIMIT,
  });
});

const updateLinkSchema = z
  .object({ role: z.enum(PROPERTY_PARTY_ROLES).optional(), isPrimary: z.boolean().optional() })
  .strict();

// t228u Priority 2: change a link's role and/or primary flag. Same gates as
// unlink (Grow or Run manage, brokerage, own-property scope). Changing the
// role to one this contact already holds on the property is a 409, the same
// PROPERTY_PARTY_LINK_EXISTS answer as POST. Seller side effects run when the
// Seller set changes.
partiesRouter.patch("/link/:linkId", requireAuth, canManageRelationships, async (req, res) => {
  const linkId = Number(req.params.linkId);
  const user = req.authedUser!;
  if (invalidRole(req.body)) {
    res.status(400).json(invalidRoleBody());
    return;
  }
  const parsed = updateLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  // t238u contract item 6: an empty change is 400 NOTHING_TO_CHANGE.
  if (parsed.data.role === undefined && parsed.data.isPrimary === undefined) {
    res.status(400).json({ error: "role or isPrimary is required", code: "NOTHING_TO_CHANGE" });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ link: propertyParties })
      .from(propertyParties)
      .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
      .where(and(eq(propertyParties.id, linkId), eq(properties.brokerageId, user.brokerageId)));
    if (!row) return { kind: "missing" as const };
    const link = row.link;
    if (await propertyHiddenFromCaller(user, link.propertyId)) return { kind: "hidden" as const };
    // Same serialisation point as POST's duplicate guard.
    await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, link.propertyId)).for("update");
    const role = parsed.data.role ?? link.role;
    if (role !== link.role) {
      const [clash] = await tx
        .select({ id: propertyParties.id })
        .from(propertyParties)
        .where(and(eq(propertyParties.propertyId, link.propertyId), eq(propertyParties.partyId, link.partyId), eq(propertyParties.role, role)));
      if (clash) return { kind: "exists" as const };
    }
    const isPrimary = parsed.data.isPrimary ?? link.isPrimary;
    // Same values again: 200, no write, no audit row.
    if (role === link.role && isPrimary === link.isPrimary) return { kind: "unchanged" as const, link };
    const demoted = isPrimary ? await demoteOtherPrimaries(tx, link.propertyId, role, link.id) : [];
    const [updated] = await tx
      .update(propertyParties)
      .set({ role, isPrimary })
      .where(eq(propertyParties.id, linkId))
      .returning();
    await auditPrimaryReplaced(tx, user, link.propertyId, role, demoted, link.id);
    // t238u contract item 11: from/to on the update audit, same transaction.
    await tx.insert(auditLogs).values({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "party_link_updated",
      recordType: "property_party",
      recordId: String(linkId),
      propertyId: link.propertyId,
      previousValue: JSON.stringify({ role: link.role, isPrimary: link.isPrimary }),
      updatedValue: JSON.stringify({ role, isPrimary }),
    });
    return { kind: "updated" as const, before: link, link: updated, demoted };
  });
  if (outcome.kind === "missing") {
    await notePartyLinkIsolationRejection(linkId, user.brokerageId);
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (outcome.kind === "hidden") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (outcome.kind === "exists") {
    res.status(409).json({ error: "This contact is already linked to the property with that role", code: "PROPERTY_PARTY_LINK_EXISTS" });
    return;
  }
  if (outcome.kind === "unchanged") {
    res.json({ link: outcome.link, changed: [] });
    return;
  }
  if (outcome.before.role !== outcome.link.role) {
    if (outcome.link.role === "Seller") {
      await runSellerSideEffects(outcome.link.propertyId, outcome.link.partyId, user);
    } else if (outcome.before.role === "Seller") {
      await runSellerRemovedEffects(outcome.link.propertyId, user);
    }
  }
  res.json({ link: outcome.link, changed: changedBody(outcome.link.role, outcome.demoted, outcome.link) });
});

// ---------------------------------------------------------------------
// t236u Tap-to-Call. t242u: anyone who can VIEW the contact (grow.contacts.read
// or Run) gets the number and tel action; notes/consent stay manage-only.
// (unsubscribed callers get 403; another brokerage's contact is 404). Nothing
// here dials, records or completes a call.
// ---------------------------------------------------------------------
function readPartyId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

partiesRouter.get("/:partyId/tap-to-call", requireAuth, canReadPropertyContacts, async (req, res) => {
  const partyId = readPartyId(req.params.partyId);
  if (partyId === null) return void res.status(400).json({ error: "Invalid contact id" });
  const user = req.authedUser!;
  const status = await tapToCallStatus(user.brokerageId, partyId);
  if (!status) {
    await notePartyIsolationRejection(partyId, user.brokerageId);
    return void res.status(404).json({ error: "Contact not found" });
  }
  res.json(status);
});

const callConsentSchema = z
  .object({ confirmed: z.boolean(), restrictions: z.string().max(500).optional(), doNotCall: z.boolean().optional() })
  .strict();
partiesRouter.post("/:partyId/call-consent", requireAuth, canManagePropertyContacts, async (req, res) => {
  const partyId = readPartyId(req.params.partyId);
  if (partyId === null) return void res.status(400).json({ error: "Invalid contact id" });
  const parsed = callConsentSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const user = req.authedUser!;
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId)));
  if (!party) {
    await notePartyIsolationRejection(partyId, user.brokerageId);
    return void res.status(404).json({ error: "Contact not found" });
  }
  const id = await recordCallConsentConfirmation(db, { brokerageId: user.brokerageId, partyId, userId: user.id, ...parsed.data });
  if (id === null) return void res.status(400).json({ error: "Nothing to record", code: "CALL_CONSENT_EMPTY" });
  await logAudit({ userId: user.id, action: "call_consent_recorded", recordType: "party", recordId: String(partyId) });
  res.status(201).json(await tapToCallStatus(user.brokerageId, partyId));
});

const callNoteSchema = z.object({ note: z.string().trim().min(1).max(2000), propertyId: z.number().int().positive().optional() }).strict();
partiesRouter.post("/:partyId/call-notes", requireAuth, canManagePropertyContacts, async (req, res) => {
  const partyId = readPartyId(req.params.partyId);
  if (partyId === null) return void res.status(400).json({ error: "Invalid contact id" });
  const parsed = callNoteSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const user = req.authedUser!;
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId)));
  if (!party) {
    await notePartyIsolationRejection(partyId, user.brokerageId);
    return void res.status(404).json({ error: "Contact not found" });
  }
  const propertyId = parsed.data.propertyId ?? null;
  if (propertyId !== null) {
    const [prop] = await db.select({ id: properties.id }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)));
    if (!prop || (await propertyHiddenFromCaller(user, propertyId))) return void res.status(404).json({ error: "Property not found" });
  }
  const activity = await addPostCallNote({ brokerageId: user.brokerageId, partyId, propertyId, userId: user.id, note: parsed.data.note });
  res.status(201).json({ activity });
});
