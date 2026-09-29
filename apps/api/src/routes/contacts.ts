import { Router } from "express";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  growActivities,
  growCommitments,
  growConsentDecisions,
  growConsentPolicyVersions,
  growContactChannelConsents,
  growContactChannelSuppressions,
  growContactDncrStatuses,
  growContactRelationships,
  growContactRoles,
  growOpportunities,
  growRelationships,
  parties,
  properties,
  GROW_CONSENT_CHANNELS,
  GROW_CONTACT_ROLES,
  GROW_CONTACT_RELATIONSHIP_TYPES,
  PARTY_TYPES,
  type GrowConsentChannel,
} from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { getRelationshipTimeline } from "../lib/relationshipTimeline.js";
import { getContactIntelligenceSummary } from "../lib/contactIntelligence.js";
import { assertPropertyVisibleForWrite, restrictedPropertyIdsFor, visibleLinkedPropertySql } from "../lib/propertyVisibility.js";
import { logAudit } from "../lib/audit.js";
import {
  noteGrowCommitmentIsolationRejection,
  noteGrowContactRelationshipIsolationRejection,
  noteGrowContactRoleIsolationRejection,
  noteGrowOpportunityIsolationRejection,
  noteGrowPartyIsolationRejection,
  noteGrowPropertyIsolationRejection,
} from "../lib/grow/isolationRejection.js";
// AE GROW Completion W3-A (A-6) — Contact 360's contactability read model. See
// buildContactability() below for why these three imports and no others.
import { isWithinConsentHours } from "../lib/consentControls.js";
import { evaluateConsentDecisionReadOnly } from "../lib/consentControlsPersistence.js";
import { PHONE_CALL_CONSENT_PURPOSE, PHONE_CALL_CONSENT_SCOPE } from "../lib/telephony/eligibility.js";
import { validateRecord } from "../lib/import/validate.js";

// AE GROW Priority 2 — Contact Intelligence & Relationship Timeline.
//
// Mounted at /grow/contacts (routes/index.ts) — nested under Grow's own namespace, not a new
// top-level surface, since Contact 360 is a Grow-specific view onto the canonical `parties`
// table (packages/db/src/schema/property.ts), never a second contact database. Every read here
// uses grow.contacts.read; every mutation this priority introduces (role assignment/removal,
// household-relationship create/remove) uses grow.contacts.manage — both keys were already
// reserved but unused (packages/db/src/schema/billing.ts). Commitments reuse
// grow.activities.manage, exactly as growActivities writes already do — no new entitlement key
// was needed for this priority. Existing POST/PATCH /grow/relationships (routes/grow.ts)
// continue to be the only way to create/update a contact<->property relationship; this file
// only adds a partyId-scoped READ over that same table for Contact 360, never a duplicate
// mutation path.

export const contactsRouter = Router();

// AE GROW Pilot Readiness WP1 (P2-4): free-text length bounds, matching the 2000-character
// ceiling routes/ai.ts already applies to free text a user types into Grow.
const CONTACT_FREE_TEXT_MAX = 2000;

/** A positive integer id, or null when the value is not one (so callers can 400 instead of
 * handing NaN to Postgres and surfacing a 500).
 *
 * Bounded by MAX_SIGNED_INT4, matching routes/grow.ts and routes/communications.ts: every id
 * this router resolves is a `serial` column, i.e. int4. Without the ceiling a value like
 * "99999999999999999999" or "2147483648" IS an integer as far as Number.isInteger is
 * concerned, so it passed the guard and reached Postgres as an unbindable bind value —
 * producing exactly the 500 this helper exists to prevent. */
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

// AE GROW Pilot Readiness WP1 (P2-1): every contact-intelligence mutation below is audited via
// logAudit (lib/audit.ts) with ids/enum values only -- never free text (descriptions, notes,
// cancel reasons), matching routes/grow.ts's own audit conventions.

function displayName(party: { firstName: string | null; lastName: string | null; organisationName: string | null }): string {
  if (party.organisationName) return party.organisationName;
  const name = `${party.firstName ?? ""} ${party.lastName ?? ""}`.trim();
  return name.length > 0 ? name : "Unnamed contact";
}

// G-UAT-2 — POST /grow/contacts. A contact is a parties row and may exist
// with no property. The identifiability rule is import's CONTACT_UNIDENTIFIABLE
// (name, email, or phone), not a second definition of "who is a contact".

function readOptionalText(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "Contact fields must be text." };
  const trimmed = value.trim();
  if (trimmed.length > CONTACT_FREE_TEXT_MAX) {
    return { ok: false, error: `Contact fields must be ${CONTACT_FREE_TEXT_MAX} characters or fewer.` };
  }
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

function contactIsUnidentifiable(person: {
  firstName: string | null;
  lastName: string | null;
  organisationName: string | null;
  email: string | null;
  mobile: string | null;
}): boolean {
  const result = validateRecord({
    person: {
      firstName: person.firstName ?? undefined,
      lastName: person.lastName ?? undefined,
      company: person.organisationName ?? undefined,
      email: person.email ?? undefined,
      mobile: person.mobile ?? undefined,
    },
    meta: {
      sourceRowNumber: 1,
      originalValues: {},
      mappingConfidence: "manual",
      warnings: [],
    },
  });
  return result.issues.some((issue) => issue.code === "CONTACT_UNIDENTIFIABLE");
}

function splitContactName(name: string): { firstName: string; lastName: string | null } {
  const collapsed = name.replace(/\s+/g, " ").trim();
  const space = collapsed.indexOf(" ");
  if (space === -1) return { firstName: collapsed, lastName: null };
  return { firstName: collapsed.slice(0, space), lastName: collapsed.slice(space + 1) };
}

type ParsedContactCreate =
  | { ok: false; error: string; code?: string }
  | {
      ok: true;
      partyType: (typeof PARTY_TYPES)[number];
      firstName: string | null;
      middleName: string | null;
      lastName: string | null;
      organisationName: string | null;
      email: string | null;
      mobile: string | null;
    };

function parseContactCreateBody(body: unknown): ParsedContactCreate {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Expected a contact." };
  }
  const record = body as Record<string, unknown>;
  const textKeys = ["name", "firstName", "middleName", "lastName", "organisationName", "email", "mobile", "phone"] as const;
  const texts = {} as Record<(typeof textKeys)[number], string | null>;
  for (const key of textKeys) {
    const read = readOptionalText(record[key]);
    if (!read.ok) return { ok: false, error: read.error };
    texts[key] = read.value;
  }

  let partyType: (typeof PARTY_TYPES)[number] | null = null;
  if (record.partyType != null) {
    if (typeof record.partyType !== "string" || !(PARTY_TYPES as readonly string[]).includes(record.partyType)) {
      return { ok: false, error: `partyType must be one of: ${PARTY_TYPES.join(", ")}` };
    }
    partyType = record.partyType as (typeof PARTY_TYPES)[number];
  }

  let firstName = texts.firstName;
  let lastName = texts.lastName;
  const organisationName = texts.organisationName;
  if (!firstName && !lastName && !organisationName && texts.name) {
    const split = splitContactName(texts.name);
    firstName = split.firstName;
    lastName = split.lastName;
  }

  const email = texts.email;
  const mobile = texts.mobile ?? texts.phone;
  if (contactIsUnidentifiable({ firstName, lastName, organisationName, email, mobile })) {
    return {
      ok: false,
      error: "A contact needs a name, email, or phone.",
      code: "CONTACT_UNIDENTIFIABLE",
    };
  }

  return {
    ok: true,
    partyType: partyType ?? (organisationName ? "Organisation" : "Person"),
    firstName,
    middleName: texts.middleName,
    lastName,
    organisationName,
    email,
    mobile,
  };
}

/** Search list item and Contact 360 `contact` identity, for one new party. */
function createdContactPayload(party: typeof parties.$inferSelect) {
  return {
    contact: {
      id: party.id,
      displayName: displayName(party),
      partyType: party.partyType,
      email: party.email,
      mobile: party.mobile,
      roles: [] as string[],
      relatedPropertyCount: 0,
      firstName: party.firstName,
      middleName: party.middleName,
      lastName: party.lastName,
      organisationName: party.organisationName,
      residentialAddress: party.residentialAddress,
      createdAt: party.createdAt.toISOString(),
      updatedAt: party.updatedAt.toISOString(),
    },
  };
}

// GET /grow/contacts — list/search, for the Grow Contacts entry point and any "find a contact"
// picker elsewhere in Grow. Always scoped to the caller's own brokerage; a client-supplied
// brokerageId is never trusted (matches every other Grow route in routes/grow.ts).
contactsRouter.get("/", requireAuth, requireEntitlement("grow.contacts.read"), async (req, res) => {
  const brokerageId = req.authedUser!.brokerageId;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const role = typeof req.query.role === "string" ? req.query.role : undefined;

  const conditions = [eq(parties.brokerageId, brokerageId)];
  if (search.length > 0) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(parties.firstName, pattern),
        ilike(parties.lastName, pattern),
        ilike(parties.organisationName, pattern),
        ilike(parties.email, pattern),
      )!,
    );
  }

  // The role filter is a SQL predicate, applied BEFORE the limit. It used to run in JS over the
  // already-limited 200 rows, which made `?role=` search only the 200 most recently created
  // contacts in the brokerage: once a brokerage held more than 200 parties, a contact holding
  // that role simply stopped appearing in the picker, with no error and no indication that
  // anything had been cut. `limit(200)` now caps the contacts that actually match, which is what
  // it was always meant to mean. The subquery is covered by grow_contact_roles' own
  // (brokerage_id, party_id) and (party_id, role) indexes.
  if (role) {
    conditions.push(
      inArray(
        parties.id,
        db
          .select({ partyId: growContactRoles.partyId })
          .from(growContactRoles)
          .where(and(eq(growContactRoles.brokerageId, brokerageId), eq(growContactRoles.role, role))),
      ),
    );
  }

  const partyRows = await db.select().from(parties).where(and(...conditions)).orderBy(desc(parties.createdAt)).limit(200);

  // Enrichment is restricted to the parties actually being rendered. Both of these queries used
  // to read every role row and every relationship row in the brokerage (~25k relationship rows at
  // realistic size) to decorate at most 200 displayed contacts — `partyIds` was computed here and
  // then never used. Both tables are indexed (brokerage_id, party_id), so adding the party
  // predicate keeps the same index and just bounds how much of it is walked.
  const partyIds = partyRows.map((p) => p.id);
  const [roleRows, relationshipCountRows] = partyIds.length > 0
    ? await Promise.all([
        db
          .select()
          .from(growContactRoles)
          .where(and(eq(growContactRoles.brokerageId, brokerageId), inArray(growContactRoles.partyId, partyIds))),
        db.select({ partyId: growRelationships.partyId, propertyId: growRelationships.propertyId })
          .from(growRelationships)
          .where(and(eq(growRelationships.brokerageId, brokerageId), inArray(growRelationships.partyId, partyIds))),
      ])
    : [[], []];

  const rolesByParty = new Map<number, string[]>();
  for (const r of roleRows) {
    if (!rolesByParty.has(r.partyId)) rolesByParty.set(r.partyId, []);
    rolesByParty.get(r.partyId)!.push(r.role);
  }
  const propertyCountByParty = new Map<number, Set<number>>();
  for (const r of relationshipCountRows) {
    if (!r.propertyId) continue;
    if (!propertyCountByParty.has(r.partyId)) propertyCountByParty.set(r.partyId, new Set());
    propertyCountByParty.get(r.partyId)!.add(r.propertyId);
  }

  res.json({
    contacts: partyRows.map((p) => ({
      id: p.id,
      displayName: displayName(p),
      partyType: p.partyType,
      email: p.email,
      mobile: p.mobile,
      roles: rolesByParty.get(p.id) ?? [],
      relatedPropertyCount: propertyCountByParty.get(p.id)?.size ?? 0,
    })),
  });
});

// POST /grow/contacts — create a contact with no property. Inserts one parties
// row for the session brokerage. Does not write property_parties, grow_relationships,
// or grow_activities (import, the other property-less create, does not write an
// activity either). brokerageId in the body is ignored. A matching email in this
// brokerage is a 409; phone is not a duplicate key.
contactsRouter.post("/", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const parsed = parseContactCreateBody(req.body);
  if (!parsed.ok) {
    res.status(400).json(parsed.code ? { error: parsed.error, code: parsed.code } : { error: parsed.error });
    return;
  }

  if (parsed.email) {
    const normalizedEmail = parsed.email.toLowerCase();
    const [existing] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.brokerageId, user.brokerageId), sql`lower(btrim(${parties.email})) = ${normalizedEmail}`))
      .orderBy(asc(parties.id))
      .limit(1);
    if (existing) {
      res.status(409).json({
        error: "A contact with this email already exists.",
        contactId: existing.id,
      });
      return;
    }
  }

  const [party] = await db
    .insert(parties)
    .values({
      brokerageId: user.brokerageId,
      partyType: parsed.partyType,
      firstName: parsed.firstName,
      middleName: parsed.middleName,
      lastName: parsed.lastName,
      organisationName: parsed.organisationName,
      mobile: parsed.mobile,
      email: parsed.email,
    })
    .returning();

  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_created",
    recordType: "party",
    recordId: String(party.id),
  });

  res.status(201).json(createdContactPayload(party));
});

/* =====================================================================
 * AE GROW Completion W3-A (A-6) — Contact 360's contactability read model.
 *
 * WHY THIS EXISTS. The F2 consent/DNC engine has been complete for some time
 * — five append-only tables (schema/consentControls.ts), a strict fail-closed
 * evaluator with 28 reason codes (lib/consentControls.ts), a persistence
 * boundary (lib/consentControlsPersistence.ts) and, since PR #52, HTTP writers
 * (routes/growConsent.ts). What it never had was a place a human could SEE it.
 * Contact 360's response carried zero consent, DNC, suppression or
 * contactability fields, so the only way to learn why a contact could not be
 * emailed was to read the database. This block is that read model.
 *
 * THIS READ WRITES NOTHING, AND THAT IS A DELIBERATE DEPARTURE FROM AN
 * EXISTING DEFECT. GET /grow/calls/contacts/:partyId/eligibility calls the
 * MUTATING evaluator, so every UI poll takes a brokerage advisory lock and
 * appends a grow_consent_decisions row — a read that manufactures enforcement
 * evidence. This block calls evaluateConsentDecisionReadOnly() instead, which
 * is the library's own presentation path: identical current-state lookups
 * (latestConsent / policyFor / latestDncr / latestSuppression) and the identical
 * pure evaluator, with no decision row, no audit row and no advisory lock.
 * routes/__tests__/contactability.test.ts asserts that N reads of this endpoint
 * add zero grow_consent_decisions rows and hold no consent advisory lock.
 *
 * WHY THE EVALUATOR AND NOT A SECOND RESOLVER. Every row this block renders is
 * already in memory from the three history queries below, so the decisions
 * could have been computed without another round trip. They deliberately are
 * not: "current row" in this model means serial-id append order plus, for a
 * suppression, effective_at <= now, and inventing a third implementation of
 * that rule is exactly the drift lib/propertyIntelligence/contactability.ts
 * documents itself having already suffered. The evaluator stays the single
 * definition; this file only presents what it returns. The cost is one
 * evaluator call per channel — a fixed five, issued in parallel and
 * independent of how much consent history a contact has — which is the price
 * of having one implementation of "current" rather than two.
 *
 * THE PILOT STATE IS RENDERED HONESTLY, NOT WORKED AROUND. No consent policy
 * row is approved: timeZone and the allowed/quiet hours are deliberately null
 * pending AU/NZ legal sign-off, and with them unset the evaluator correctly
 * returns POLICY_INVALID_WINDOW -> REVIEW_REQUIRED. Nothing here seeds,
 * defaults or infers a policy, and nothing here fabricates an ELIGIBLE state.
 * The block instead reports the inputs that produce that answer — which policy
 * versions are in force, whether any of them actually defines a calling window
 * (awaitingPolicyApproval), and the per-channel reason code — so the screen can
 * explain WHY a channel is unavailable rather than showing a bare failure.
 * ===================================================================*/

/** Consent/DNC/suppression events returned for the audit history, newest first. */
const CONTACTABILITY_HISTORY_LIMIT = 200;

/** Recorded enforcement decisions scanned to find the latest one per channel. */
const CONTACTABILITY_DECISION_SCAN_LIMIT = 100;

/**
 * The (purpose, scope) pair a channel is evaluated with when the contact has
 * NO recorded consent stream on that channel at all.
 *
 * This is a label, not a policy choice, and it cannot change any answer: with
 * zero consent rows for the channel the evaluator exits at its `!consent`
 * guard with UNKNOWN_CONSENT whatever pair it is handed. It exists so the
 * response can name the stream an evaluation refers to instead of reporting a
 * decision with no subject. When the contact DOES have recorded streams the
 * pair is taken from the recorded row and this map is not consulted.
 *
 * PHONE_CALL reuses lib/telephony/eligibility.ts's canonical pair rather than
 * restating it, so the reason this screen shows for "why can't I call" is the
 * same stream the outbound call boundary itself evaluates.
 */
const CHANNEL_PROBE_STREAM: Record<GrowConsentChannel, { purpose: string; scope: string }> = {
  PHONE_CALL: { purpose: PHONE_CALL_CONSENT_PURPOSE, scope: PHONE_CALL_CONSENT_SCOPE },
  EMAIL: { purpose: "EMAIL", scope: "OUTBOUND" },
  SMS: { purpose: "SMS", scope: "OUTBOUND" },
  VOICE_CALL: { purpose: "VOICE_CALL", scope: "OUTBOUND" },
  EXTERNAL_MESSAGE: { purpose: "EXTERNAL_MESSAGE", scope: "OUTBOUND" },
};

type ConsentRow = typeof growContactChannelConsents.$inferSelect;
type DncrRow = typeof growContactDncrStatuses.$inferSelect;
type SuppressionRow = typeof growContactChannelSuppressions.$inferSelect;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * One (channel, purpose, scope) stream's head. `evidence` and
 * `relationshipEvidence` are deliberately NOT returned: they are free-form
 * jsonb an importer may have filled with arbitrary third-party payload, and
 * Contact 360 needs the evidence REFERENCE, not the evidence blob. Whether a
 * payload exists is reported so the screen can say so.
 */
function consentStreamView(row: ConsentRow) {
  return {
    consentId: row.id,
    channel: row.channel,
    purpose: row.purpose,
    scope: row.scope,
    state: row.state,
    source: row.source,
    captureMethod: row.captureMethod,
    jurisdiction: row.jurisdiction,
    capturedAt: row.capturedAt.toISOString(),
    expiresAt: iso(row.expiresAt),
    reviewAt: iso(row.reviewAt),
    evidenceReference: row.evidenceReference,
    hasEvidencePayload: row.evidence !== null,
    inferredReasoning: row.inferredReasoning,
    notRequiredJustification: row.notRequiredJustification,
    withdrawnAt: iso(row.withdrawnAt),
    withdrawnByUserId: row.withdrawnByUserId,
    withdrawalReason: row.withdrawalReason,
    supersedesConsentId: row.supersedesConsentId,
    recordedByUserId: row.recordedByUserId,
    recordedAt: row.createdAt.toISOString(),
  };
}

function dncrView(row: DncrRow) {
  return {
    dncrStatusId: row.id,
    channel: row.channel,
    status: row.status,
    jurisdiction: row.jurisdiction,
    checkedAt: row.checkedAt.toISOString(),
    validUntil: iso(row.validUntil),
    reviewAt: iso(row.reviewAt),
    source: row.source,
    reference: row.reference,
    recordedByUserId: row.recordedByUserId,
    recordedAt: row.createdAt.toISOString(),
  };
}

function suppressionView(row: SuppressionRow, now: Date) {
  return {
    suppressionId: row.id,
    channel: row.channel,
    state: row.state,
    reason: row.reason,
    effectiveAt: row.effectiveAt.toISOString(),
    expiresAt: iso(row.expiresAt),
    reference: row.reference,
    // Mirrors activeSuppression() in lib/consentControls.ts: in force now, and
    // any state other than RELEASED counts as suppressing. A state this build
    // does not recognise must never read as "released".
    active: row.state !== "RELEASED" && row.effectiveAt.getTime() <= now.getTime() && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()),
    recordedByUserId: row.recordedByUserId,
    recordedAt: row.createdAt.toISOString(),
  };
}

/**
 * Builds the `contactability` block. Reads only; see the section header above.
 *
 * Failure is NOT swallowed. A compliance surface that silently degrades to
 * "no data" would render exactly the dishonest state this slice exists to
 * remove, so a fault here fails the Contact 360 request (forwarded to the
 * global error handler by lib/asyncRouteErrors.ts) rather than quietly
 * reporting a contact as un-evaluated.
 */
async function buildContactability(brokerageId: number, partyId: number) {
  const now = new Date();

  const [consentRows, dncrRows, suppressionRows, policyRows, decisionRows] = await Promise.all([
    // Ascending id: the append order, so the LAST row for a key is that
    // stream's head — the same definition latestConsent() uses.
    db
      .select()
      .from(growContactChannelConsents)
      .where(and(eq(growContactChannelConsents.brokerageId, brokerageId), eq(growContactChannelConsents.partyId, partyId)))
      .orderBy(growContactChannelConsents.id),
    db
      .select()
      .from(growContactDncrStatuses)
      .where(and(eq(growContactDncrStatuses.brokerageId, brokerageId), eq(growContactDncrStatuses.partyId, partyId)))
      .orderBy(growContactDncrStatuses.id),
    db
      .select()
      .from(growContactChannelSuppressions)
      .where(and(eq(growContactChannelSuppressions.brokerageId, brokerageId), eq(growContactChannelSuppressions.partyId, partyId)))
      .orderBy(growContactChannelSuppressions.id),
    // Policy versions in force for this brokerage right now, both
    // jurisdictions — the same effective/retired window policyFor() applies,
    // minus its jurisdiction filter, because the screen needs to say what IS
    // approved, not only what applies to one recorded jurisdiction.
    db
      .select()
      .from(growConsentPolicyVersions)
      .where(
        and(
          eq(growConsentPolicyVersions.brokerageId, brokerageId),
          lte(growConsentPolicyVersions.effectiveAt, now),
          or(isNull(growConsentPolicyVersions.retiredAt), gt(growConsentPolicyVersions.retiredAt, now)),
        ),
      )
      .orderBy(desc(growConsentPolicyVersions.effectiveAt), desc(growConsentPolicyVersions.id)),
    // Previously RECORDED enforcement decisions. Read-only: this endpoint
    // never appends one.
    db
      .select()
      .from(growConsentDecisions)
      .where(and(eq(growConsentDecisions.brokerageId, brokerageId), eq(growConsentDecisions.partyId, partyId)))
      .orderBy(desc(growConsentDecisions.id))
      .limit(CONTACTABILITY_DECISION_SCAN_LIMIT),
  ]);

  // Head per (channel, purpose, scope), then the most recently appended head
  // per channel — the stream this block evaluates for that channel's headline
  // decision. Every head is still returned under `streams`, so a channel
  // carrying several purposes is shown in full rather than reduced to one.
  const consentHeads = new Map<string, ConsentRow>();
  for (const row of consentRows) consentHeads.set(JSON.stringify([row.channel, row.purpose, row.scope]), row);
  const headsByChannel = new Map<string, ConsentRow[]>();
  for (const head of consentHeads.values()) {
    if (!headsByChannel.has(head.channel)) headsByChannel.set(head.channel, []);
    headsByChannel.get(head.channel)!.push(head);
  }

  const dncrHeads = new Map<string, DncrRow>();
  for (const row of dncrRows) dncrHeads.set(row.channel, row);

  // Only rows already in force count as the current suppression, matching
  // latestSuppression(): a RELEASED row dated in the future must not read as
  // the current state here while the consent engine still treats the contact
  // as suppressed.
  const suppressionHeads = new Map<string, SuppressionRow>();
  for (const row of suppressionRows) {
    if (row.effectiveAt.getTime() > now.getTime()) continue;
    suppressionHeads.set(row.channel, row);
  }

  const lastDecisionByChannel = new Map<string, (typeof decisionRows)[number]>();
  for (const row of decisionRows) if (!lastDecisionByChannel.has(row.channel)) lastDecisionByChannel.set(row.channel, row);

  const channels = await Promise.all(
    GROW_CONSENT_CHANNELS.map(async (channel) => {
      const heads = (headsByChannel.get(channel) ?? []).sort((a, b) => a.id - b.id);
      const primary = heads.length > 0 ? heads[heads.length - 1] : null;
      const stream = primary
        ? { purpose: primary.purpose, scope: primary.scope }
        : CHANNEL_PROBE_STREAM[channel];

      const evaluated = await evaluateConsentDecisionReadOnly({
        brokerageId,
        partyId,
        channel,
        purpose: stream.purpose,
        scope: stream.scope,
        // Never asserted from the caller: the recorded consent row's own
        // jurisdiction is canonical, exactly as the audited boundary treats it.
        jurisdiction: null,
      });

      const suppressionRow = suppressionHeads.get(channel) ?? null;
      const suppression = suppressionRow ? suppressionView(suppressionRow, now) : null;
      const suppressed = suppression?.active === true;

      // An active suppression is an explicit recorded instruction not to use
      // this channel. The fail-closed evaluator can exit EARLIER for a
      // different reason (with no consent on file it returns UNKNOWN_CONSENT
      // long before it reaches its suppression gate), so reporting only the
      // evaluator's reason would hide a recorded do-not-contact from the
      // person reading this screen. Folding suppression in can only ever
      // downgrade a channel to BLOCKED — it can never make one look more
      // permissive — so this cannot manufacture an eligible state. This is the
      // same reason lib/propertyIntelligence/contactability.ts reads the
      // suppression rows directly instead of going through the evaluator.
      const status = suppressed || evaluated.evaluation.decision === "BLOCKED" ? "BLOCKED" : evaluated.evaluation.decision;
      const reasonCode = suppressed && evaluated.evaluation.decision !== "BLOCKED" ? "SUPPRESSED" : evaluated.evaluation.reasonCode;

      const lastRecorded = lastDecisionByChannel.get(channel) ?? null;
      const dncrRow = dncrHeads.get(channel) ?? null;

      return {
        channel,
        status,
        reasonCode,
        // The freshly computed, unrecorded evaluation. `recorded: false` is
        // load-bearing documentation: this decision has no id because reading
        // a screen is not an enforcement decision.
        decision: {
          recorded: false,
          decision: evaluated.evaluation.decision,
          reasonCode: evaluated.evaluation.reasonCode,
          reasonCodes: evaluated.evaluation.reasonCodes,
          jurisdiction: evaluated.evaluation.jurisdiction,
          policyVersion: evaluated.evaluation.policyVersion,
          purpose: stream.purpose,
          scope: stream.scope,
          // False when no stream exists for this channel and the pair above is
          // only a label — see CHANNEL_PROBE_STREAM.
          streamRecorded: primary !== null,
          evaluatedAt: now.toISOString(),
        },
        // The latest decision that WAS recorded, by an actual outbound
        // attempt. Null for every contact nothing has tried to reach.
        lastRecordedDecision: lastRecorded
          ? {
              id: lastRecorded.id,
              decision: lastRecorded.decision,
              reasonCode: lastRecorded.reasonCode,
              jurisdiction: lastRecorded.jurisdiction,
              policyVersion: lastRecorded.policyVersion,
              evaluatedAt: lastRecorded.evaluatedAt.toISOString(),
              decidedByUserId: lastRecorded.decidedByUserId,
            }
          : null,
        consentState: primary ? primary.state : "UNKNOWN",
        consent: primary ? consentStreamView(primary) : null,
        streams: heads.map(consentStreamView),
        dncrStatus: dncrRow ? dncrRow.status : "NOT_CHECKED",
        dncr: dncrRow ? dncrView(dncrRow) : null,
        suppressed,
        suppression,
      };
    }),
  );

  const policies = policyRows.map((row) => ({
    policyVersionId: row.id,
    jurisdiction: row.jurisdiction,
    version: row.version,
    effectiveAt: row.effectiveAt.toISOString(),
    retiredAt: iso(row.retiredAt),
    allowInferredConsent: row.allowInferredConsent,
    allowNotRequiredConsent: row.allowNotRequiredConsent,
    dncrRequired: row.dncrRequired,
    suppressionEnabled: row.suppressionEnabled,
    timeZone: row.timeZone,
    allowedHoursStart: row.allowedHoursStart,
    allowedHoursEnd: row.allowedHoursEnd,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    // Reuses the evaluator's OWN window rule rather than restating it: a null
    // result there is precisely "this policy supplies no usable window", which
    // is what turns every channel into POLICY_INVALID_WINDOW -> REVIEW_REQUIRED.
    callingWindowConfigured: isWithinConsentHours(now, row) !== null,
  }));

  // Vacuously true when no policy version is in force at all, which is the
  // current pilot state for every tenant. Both readings are the same fact: no
  // approved policy defines a calling window, so nothing can be ELIGIBLE yet.
  const awaitingPolicyApproval = policies.every((p) => !p.callingWindowConfigured);

  const status = channels.every((c) => c.status === "BLOCKED")
    ? "BLOCKED"
    : channels.some((c) => c.status === "ELIGIBLE")
      ? "ELIGIBLE"
      : "REVIEW_REQUIRED";
  // Deterministic: the first channel, in GROW_CONSENT_CHANNELS order, that
  // actually carries the rolled-up status.
  const statusReasonCode = channels.find((c) => c.status === status)!.reasonCode;

  const history = [
    ...consentRows.map((row) => ({ kind: "CONSENT" as const, occurredAt: row.createdAt, id: row.id, ...consentStreamView(row) })),
    ...dncrRows.map((row) => ({ kind: "DNCR" as const, occurredAt: row.createdAt, id: row.id, ...dncrView(row) })),
    ...suppressionRows.map((row) => ({ kind: "SUPPRESSION" as const, occurredAt: row.createdAt, id: row.id, ...suppressionView(row, now) })),
  ]
    // Newest first. createdAt is database-assigned (defaultNow()), unlike the
    // caller-supplied capturedAt/checkedAt/effectiveAt evidence timestamps, so
    // it is the only honest ordering for "what happened when". Ties break on
    // the serial id, which is the append order.
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id)
    .slice(0, CONTACTABILITY_HISTORY_LIMIT)
    .map(({ occurredAt, ...entry }) => ({ ...entry, occurredAt: occurredAt.toISOString() }));

  return {
    evaluatedAt: now.toISOString(),
    status,
    statusReasonCode,
    // Nothing has ever been recorded for this contact. Distinct from "recorded
    // and unknown": the screen should offer to capture consent, not report a
    // review backlog.
    hasConsentRecords: consentRows.length > 0 || dncrRows.length > 0 || suppressionRows.length > 0,
    awaitingPolicyApproval,
    policies,
    channels,
    activeSuppressions: channels.filter((c) => c.suppressed).map((c) => c.suppression!),
    history,
    // The whole event stream is append-only with supersession — no row above
    // is ever updated or deleted — and the screen says so rather than leaving
    // the reader to assume an editable record.
    historyTruncated: consentRows.length + dncrRows.length + suppressionRows.length > CONTACTABILITY_HISTORY_LIMIT,
  };
}

// GET /grow/contacts/:partyId — Contact 360. One response covers the whole view: canonical
// identity, Grow's multi-valued roles, household relationships, property relationships,
// opportunities, recent activities/commitments, the Relationship Timeline, and the
// deterministic Contact Intelligence Summary — matching the "understand this relationship in
// seconds" UX goal (§11) rather than a screen that fires off five separate requests.
contactsRouter.get("/:partyId", requireAuth, requireEntitlement("grow.contacts.read"), async (req, res) => {
  const user = req.authedUser!;
  const brokerageId = user.brokerageId;
  const partyId = parsePositiveId(req.params.partyId);
  if (!partyId) {
    res.status(400).json({ error: "Invalid contact id" });
    return;
  }

  const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId))).limit(1);
  if (!party) {
    await noteGrowPartyIsolationRejection(partyId, brokerageId);
    res.status(404).json({ error: "Contact not found in this brokerage" });
    return;
  }

  // The contact stays brokerage-wide. Only property-linked rows, and the
  // property-derived counts inside the timeline and intelligence summary,
  // are limited to properties this caller can see.
  const restrictTo = await restrictedPropertyIdsFor(user);

  const [
    householdRows,
    propertyRelRows,
    opportunityRows,
    roleRows,
    activityRows,
    commitmentRows,
    timeline,
    intelligence,
    contactability,
  ] = await Promise.all([
      // §5 — household relationships are recorded as a single directed row per pair+type (see
      // the dedup check in POST /:partyId/relationships below), but the relationship itself is
      // symmetric: "A is B's spouse" and "B is A's spouse" are the same fact. Querying by
      // partyId alone would only surface it on whichever contact happened to be `partyId` at
      // creation time — the other contact's own Contact 360 page would silently omit it. Both
      // directions are fetched here so either contact sees it.
      db
        .select()
        .from(growContactRelationships)
        .where(
          and(
            eq(growContactRelationships.brokerageId, brokerageId),
            or(eq(growContactRelationships.partyId, partyId), eq(growContactRelationships.relatedPartyId, partyId)),
          ),
        ),
      db
        .select({
          id: growRelationships.id,
          relationshipType: growRelationships.relationshipType,
          role: growRelationships.role,
          status: growRelationships.status,
          isPrimary: growRelationships.isPrimary,
          validFrom: growRelationships.validFrom,
          validTo: growRelationships.validTo,
          propertyId: growRelationships.propertyId,
          propertyAddress: properties.formattedAddress,
          createdBy: growRelationships.createdBy,
          createdAt: growRelationships.createdAt,
        })
        .from(growRelationships)
        .leftJoin(properties, eq(growRelationships.propertyId, properties.id))
        .where(
          and(
            eq(growRelationships.partyId, partyId),
            eq(growRelationships.brokerageId, brokerageId),
            visibleLinkedPropertySql(growRelationships.propertyId, restrictTo),
          ),
        )
        .orderBy(desc(growRelationships.createdAt)),
      db
        .select()
        .from(growOpportunities)
        .where(
          and(
            eq(growOpportunities.partyId, partyId),
            eq(growOpportunities.brokerageId, brokerageId),
            visibleLinkedPropertySql(growOpportunities.propertyId, restrictTo),
          ),
        )
        .orderBy(desc(growOpportunities.createdAt)),
      db.select().from(growContactRoles).where(and(eq(growContactRoles.partyId, partyId), eq(growContactRoles.brokerageId, brokerageId))),
      db
        .select()
        .from(growActivities)
        .where(
          and(
            eq(growActivities.partyId, partyId),
            eq(growActivities.brokerageId, brokerageId),
            visibleLinkedPropertySql(growActivities.propertyId, restrictTo),
          ),
        )
        .orderBy(desc(growActivities.occurredAt))
        .limit(50),
      db
        .select()
        .from(growCommitments)
        .where(
          and(
            eq(growCommitments.partyId, partyId),
            eq(growCommitments.brokerageId, brokerageId),
            visibleLinkedPropertySql(growCommitments.propertyId, restrictTo),
          ),
        )
        .orderBy(desc(growCommitments.dueAt)),
      getRelationshipTimeline(brokerageId, partyId, 100, restrictTo),
      getContactIntelligenceSummary(brokerageId, partyId, restrictTo),
      // AE GROW Completion W3-A (A-6). Read-only; see buildContactability().
      // The party has already been proven to belong to this brokerage above.
      buildContactability(brokerageId, partyId),
    ]);

  // Batch-resolve display info for whichever party is on "the other side" of each household
  // relationship row, regardless of which column (partyId or relatedPartyId) holds this contact.
  const otherPartyIds = Array.from(
    new Set(householdRows.map((h) => (h.partyId === partyId ? h.relatedPartyId : h.partyId))),
  );
  const otherPartyRows = otherPartyIds.length > 0
    ? await db
        .select({ id: parties.id, firstName: parties.firstName, lastName: parties.lastName, organisationName: parties.organisationName })
        .from(parties)
        .where(inArray(parties.id, otherPartyIds))
    : [];
  const otherPartyById = new Map(otherPartyRows.map((p) => [p.id, p]));

  // Derived, not canonical: `parties` has no owner/assigned-agent column of its own (§3 — Grow
  // extends the canonical model rather than adding fields to it for something this deterministic
  // to derive). The most recently created property relationship's createdBy is used as a
  // reasonable "who's been working this contact" signal, falling back to the most recently
  // created opportunity's owner when there is no relationship yet.
  const assignedAgentUserId =
    propertyRelRows.find((r) => r.createdBy !== null)?.createdBy ?? opportunityRows[0]?.ownerUserId ?? null;

  res.json({
    contact: {
      id: party.id,
      partyType: party.partyType,
      firstName: party.firstName,
      middleName: party.middleName,
      lastName: party.lastName,
      organisationName: party.organisationName,
      displayName: displayName(party),
      email: party.email,
      mobile: party.mobile,
      residentialAddress: party.residentialAddress,
      createdAt: party.createdAt.toISOString(),
      updatedAt: party.updatedAt.toISOString(),
    },
    assignedAgentUserId,
    roles: roleRows.map((r) => r.role),
    householdRelationships: householdRows.map((h) => {
      const otherPartyId = h.partyId === partyId ? h.relatedPartyId : h.partyId;
      const other = otherPartyById.get(otherPartyId);
      return {
        id: h.id,
        relatedPartyId: otherPartyId,
        relatedPartyDisplayName: other ? displayName(other) : "Unknown contact",
        relationshipType: h.relationshipType,
        note: h.note,
        createdAt: h.createdAt.toISOString(),
      };
    }),
    properties: propertyRelRows.map((r) => ({
      relationshipId: r.id,
      propertyId: r.propertyId,
      propertyAddress: r.propertyAddress,
      relationshipType: r.relationshipType,
      role: r.role,
      status: r.status,
      isPrimary: r.isPrimary,
      validFrom: r.validFrom.toISOString(),
      validTo: r.validTo ? r.validTo.toISOString() : null,
    })),
    opportunities: opportunityRows.map((o) => ({
      id: o.id,
      opportunityType: o.opportunityType,
      status: o.status,
      stage: o.stage,
      reason: o.reason,
      nextActionDueAt: o.nextActionDueAt ? o.nextActionDueAt.toISOString() : null,
      recommendedNextAction: o.recommendedNextAction,
      propertyId: o.propertyId,
    })),
    activities: activityRows.map((a) => ({
      id: a.id,
      activityType: a.activityType,
      occurredAt: a.occurredAt.toISOString(),
      summary: a.summary,
      propertyId: a.propertyId,
      opportunityId: a.opportunityId,
    })),
    commitments: commitmentRows.map((c) => ({
      id: c.id,
      description: c.description,
      dueAt: c.dueAt.toISOString(),
      status: c.status,
      propertyId: c.propertyId,
      opportunityId: c.opportunityId,
      completedAt: c.completedAt ? c.completedAt.toISOString() : null,
      cancelledAt: c.cancelledAt ? c.cancelledAt.toISOString() : null,
      cancelReason: c.cancelReason,
    })),
    timeline,
    intelligence,
    // AE GROW Completion W3-A (A-6) — consent, DNC, suppression and the
    // per-channel contactability decision, none of it recorded by this read.
    contactability,
  });
});

// POST /grow/contacts/:partyId/roles — assign a relationship-classification role (§4). A party
// may hold several roles at once; assigning a role it already holds is a no-op (the unique
// index on (partyId, role) is the enforcement, this just makes re-assigning harmless rather than
// a 500).
contactsRouter.post("/:partyId/roles", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const partyId = parsePositiveId(req.params.partyId);
  const role = typeof req.body?.role === "string" ? req.body.role : undefined;
  if (!partyId || !role || !(GROW_CONTACT_ROLES as readonly string[]).includes(role)) {
    res.status(400).json({ error: `role must be one of: ${GROW_CONTACT_ROLES.join(", ")}` });
    return;
  }

  const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1);
  if (!party) {
    await noteGrowPartyIsolationRejection(partyId, user.brokerageId);
    res.status(404).json({ error: "Contact not found in this brokerage" });
    return;
  }

  const [existing] = await db
    .select()
    .from(growContactRoles)
    .where(and(eq(growContactRoles.partyId, partyId), eq(growContactRoles.role, role)))
    .limit(1);
  if (existing) {
    res.status(200).json({ role: existing });
    return;
  }

  const [inserted] = await db
    .insert(growContactRoles)
    .values({ brokerageId: user.brokerageId, partyId, role, assignedByUserId: user.id })
    .returning();
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_role_assigned",
    recordType: "grow_contact_role",
    recordId: String(inserted.id),
    updatedValue: JSON.stringify({ partyId, role }),
  });
  res.status(201).json({ role: inserted });
});

// DELETE /grow/contacts/:partyId/roles/:role
contactsRouter.delete("/:partyId/roles/:role", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const partyId = parsePositiveId(req.params.partyId);
  const role = req.params.role;
  if (partyId === null) {
    res.status(400).json({ error: "Invalid contact id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(growContactRoles)
    .where(and(eq(growContactRoles.partyId, partyId), eq(growContactRoles.role, role), eq(growContactRoles.brokerageId, user.brokerageId)))
    .limit(1);
  if (!existing) {
    await noteGrowContactRoleIsolationRejection(partyId, role, user.brokerageId);
    res.status(404).json({ error: "Role assignment not found in this brokerage" });
    return;
  }

  await db.delete(growContactRoles).where(eq(growContactRoles.id, existing.id));
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_role_removed",
    recordType: "grow_contact_role",
    recordId: String(existing.id),
    previousValue: JSON.stringify({ partyId: existing.partyId, role: existing.role }),
  });
  res.status(204).send();
});

// POST /grow/contacts/:partyId/relationships — household / person-to-person relationships (§5).
// Deliberately does not merge records and does not auto-infer anything — every row here is an
// explicit user action. Both partyId and relatedPartyId are validated against the caller's own
// brokerage before the row is created.
contactsRouter.post("/:partyId/relationships", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const partyId = parsePositiveId(req.params.partyId);
  const relatedPartyId = parsePositiveId(req.body?.relatedPartyId);
  const relationshipType = typeof req.body?.relationshipType === "string" ? req.body.relationshipType : undefined;
  if (!partyId || !relatedPartyId || !relationshipType || !(GROW_CONTACT_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType)) {
    res.status(400).json({ error: `relatedPartyId and relationshipType (one of: ${GROW_CONTACT_RELATIONSHIP_TYPES.join(", ")}) are required` });
    return;
  }
  const note = req.body?.note;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > CONTACT_FREE_TEXT_MAX)) {
    res.status(400).json({ error: `note must be a string of at most ${CONTACT_FREE_TEXT_MAX} characters` });
    return;
  }
  if (partyId === relatedPartyId) {
    res.status(400).json({ error: "A contact cannot have a relationship with itself" });
    return;
  }

  const [party, relatedParty] = await Promise.all([
    db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1).then((r) => r[0]),
    db.select().from(parties).where(and(eq(parties.id, relatedPartyId), eq(parties.brokerageId, user.brokerageId))).limit(1).then((r) => r[0]),
  ]);
  if (!party || !relatedParty) {
    if (!party) await noteGrowPartyIsolationRejection(partyId, user.brokerageId);
    if (!relatedParty) await noteGrowPartyIsolationRejection(relatedPartyId, user.brokerageId);
    res.status(404).json({ error: "Both contacts must exist in this brokerage" });
    return;
  }

  // Dedup checked in both directions: A-related_contact-of-B and B-related_contact-of-A
  // describe the same fact even though they're stored as two directed rows at most once each.
  const existing = await db
    .select()
    .from(growContactRelationships)
    .where(
      and(
        eq(growContactRelationships.brokerageId, user.brokerageId),
        eq(growContactRelationships.relationshipType, relationshipType),
        or(
          and(eq(growContactRelationships.partyId, partyId), eq(growContactRelationships.relatedPartyId, relatedPartyId)),
          and(eq(growContactRelationships.partyId, relatedPartyId), eq(growContactRelationships.relatedPartyId, partyId)),
        ),
      ),
    );
  if (existing.length > 0) {
    res.status(200).json({ relationship: existing[0] });
    return;
  }

  const [inserted] = await db
    .insert(growContactRelationships)
    .values({
      brokerageId: user.brokerageId,
      partyId,
      relatedPartyId,
      relationshipType,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      createdBy: user.id,
    })
    .returning();
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_relationship_created",
    recordType: "grow_contact_relationship",
    recordId: String(inserted.id),
    updatedValue: JSON.stringify({ partyId, relatedPartyId, relationshipType }),
  });
  res.status(201).json({ relationship: inserted });
});

// DELETE /grow/contacts/relationships/:id — remove a household relationship. Does not affect
// either party record and does not cascade into any other Grow data.
contactsRouter.delete("/relationships/:id", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const id = parsePositiveId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid relationship id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(growContactRelationships)
    .where(and(eq(growContactRelationships.id, id), eq(growContactRelationships.brokerageId, user.brokerageId)))
    .limit(1);
  if (!existing) {
    await noteGrowContactRelationshipIsolationRejection(id, user.brokerageId);
    res.status(404).json({ error: "Relationship not found in this brokerage" });
    return;
  }
  await db.delete(growContactRelationships).where(eq(growContactRelationships.id, id));
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_relationship_removed",
    recordType: "grow_contact_relationship",
    recordId: String(existing.id),
    previousValue: JSON.stringify({
      partyId: existing.partyId,
      relatedPartyId: existing.relatedPartyId,
      relationshipType: existing.relationshipType,
    }),
  });
  res.status(204).send();
});

// POST /grow/contacts/:partyId/commitments — a future-dated promise (§8). Reuses
// grow.activities.manage, matching Priority 1's existing growActivities write gate, since a
// commitment is conceptually the same "structured Grow activity-adjacent record" surface.
contactsRouter.post("/:partyId/commitments", requireAuth, requireEntitlement("grow.activities.manage"), async (req, res) => {
  const user = req.authedUser!;
  const partyId = parsePositiveId(req.params.partyId);
  const description = typeof req.body?.description === "string" ? req.body.description : undefined;
  const dueAtRaw = req.body?.dueAt;
  const dueAt = typeof dueAtRaw === "string" ? new Date(dueAtRaw) : undefined;
  if (!partyId || !description || !dueAt || Number.isNaN(dueAt.getTime())) {
    res.status(400).json({ error: "description and a valid dueAt are required" });
    return;
  }
  if (description.length > CONTACT_FREE_TEXT_MAX) {
    res.status(400).json({ error: `description must be at most ${CONTACT_FREE_TEXT_MAX} characters` });
    return;
  }
  // Non-numeric ids are a client error (400), never a NaN handed to Postgres (500).
  const propertyIdSupplied = req.body?.propertyId !== undefined && req.body?.propertyId !== null;
  const propertyId = propertyIdSupplied ? parsePositiveId(req.body.propertyId) : null;
  const opportunityIdSupplied = req.body?.opportunityId !== undefined && req.body?.opportunityId !== null;
  const opportunityId = opportunityIdSupplied ? parsePositiveId(req.body.opportunityId) : null;
  if ((propertyIdSupplied && propertyId === null) || (opportunityIdSupplied && opportunityId === null)) {
    res.status(400).json({ error: "propertyId and opportunityId, if supplied, must be valid ids" });
    return;
  }

  const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1);
  if (!party) {
    await noteGrowPartyIsolationRejection(partyId, user.brokerageId);
    res.status(404).json({ error: "Contact not found in this brokerage" });
    return;
  }

  if (propertyId !== null) {
    const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId))).limit(1);
    if (!property) {
      await noteGrowPropertyIsolationRejection(propertyId, user.brokerageId);
      res.status(404).json({ error: "Property not found in this brokerage" });
      return;
    }
    if (!(await assertPropertyVisibleForWrite(user, propertyId))) {
      res.status(404).json({ error: "Property not found in this brokerage" });
      return;
    }
  }

  if (opportunityId !== null) {
    const [opportunity] = await db
      .select()
      .from(growOpportunities)
      .where(and(eq(growOpportunities.id, opportunityId), eq(growOpportunities.brokerageId, user.brokerageId)))
      .limit(1);
    if (!opportunity) {
      await noteGrowOpportunityIsolationRejection(opportunityId, user.brokerageId);
      res.status(404).json({ error: "Opportunity not found in this brokerage" });
      return;
    }
  }

  const [inserted] = await db
    .insert(growCommitments)
    .values({
      brokerageId: user.brokerageId,
      partyId,
      propertyId,
      opportunityId,
      description,
      dueAt,
      status: "Open",
      createdBy: user.id,
    })
    .returning();
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_commitment_created",
    recordType: "grow_commitment",
    recordId: String(inserted.id),
    propertyId,
    updatedValue: JSON.stringify({ partyId, propertyId, opportunityId, dueAt: dueAt.toISOString(), status: "Open" }),
  });
  res.status(201).json({ commitment: inserted });
});

// PATCH /grow/contacts/commitments/:id — complete or cancel a commitment. Completion also
// writes a growActivities row (activityType "task_completion", already reserved for exactly
// this by AE GROW Priority 1/0.5's GROW_ACTIVITY_TYPES) so the Relationship Timeline picks the
// completion up through the ordinary activity feed without any special-casing.
contactsRouter.patch("/commitments/:id", requireAuth, requireEntitlement("grow.activities.manage"), async (req, res) => {
  const user = req.authedUser!;
  const id = parsePositiveId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid commitment id" });
    return;
  }
  const status = req.body?.status;
  if (status !== "Completed" && status !== "Cancelled") {
    res.status(400).json({ error: "status must be Completed or Cancelled" });
    return;
  }
  const cancelReason = req.body?.cancelReason;
  if (cancelReason !== undefined && cancelReason !== null && (typeof cancelReason !== "string" || cancelReason.length > CONTACT_FREE_TEXT_MAX)) {
    res.status(400).json({ error: `cancelReason must be a string of at most ${CONTACT_FREE_TEXT_MAX} characters` });
    return;
  }

  const [existing] = await db
    .select()
    .from(growCommitments)
    .where(and(eq(growCommitments.id, id), eq(growCommitments.brokerageId, user.brokerageId)))
    .limit(1);
  if (!existing) {
    await noteGrowCommitmentIsolationRejection(id, user.brokerageId);
    res.status(404).json({ error: "Commitment not found in this brokerage" });
    return;
  }
  // Checked before the Open-status 409, so a hidden property-linked
  // commitment (complete or cancel) is a 404 and writes no task_completion
  // activity. A null property id stays writable. There is no reschedule
  // status on this route.
  if (!(await assertPropertyVisibleForWrite(user, existing.propertyId))) {
    res.status(404).json({ error: "Commitment not found in this brokerage" });
    return;
  }
  if (existing.status !== "Open") {
    res.status(409).json({ error: `Commitment is already ${existing.status}` });
    return;
  }

  // AE GROW Pilot Readiness WP1 (P2-1): the UPDATE is conditional on status = 'Open' (and the
  // caller's brokerage), so of two concurrent complete/cancel requests exactly one wins; the
  // loser gets 409 and -- because the task_completion activity is written in the same
  // transaction, only when the conditional UPDATE actually changed a row -- no duplicate
  // Timeline activity. growCommitments has no cancelled-by column, so the canceller is recorded
  // in the audit row below (userId + cancelledByUserId) rather than by adding a column.
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(growCommitments)
      .set(
        status === "Completed"
          ? { status, completedAt: now, completedByUserId: user.id, updatedAt: now }
          : { status, cancelledAt: now, cancelReason: typeof cancelReason === "string" ? cancelReason : null, updatedAt: now },
      )
      .where(and(eq(growCommitments.id, id), eq(growCommitments.brokerageId, user.brokerageId), eq(growCommitments.status, "Open")))
      .returning();
    if (!row) return null;

    if (status === "Completed") {
      await tx.insert(growActivities).values({
        brokerageId: user.brokerageId,
        partyId: existing.partyId,
        propertyId: existing.propertyId,
        opportunityId: existing.opportunityId,
        activityType: "task_completion",
        occurredAt: now,
        summary: `Commitment completed: ${existing.description}`,
        responsibleUserId: user.id,
        source: "manual",
      });
    }
    return row;
  });

  if (!updated) {
    const [current] = await db
      .select({ status: growCommitments.status })
      .from(growCommitments)
      .where(and(eq(growCommitments.id, id), eq(growCommitments.brokerageId, user.brokerageId)))
      .limit(1);
    res.status(409).json({ error: `Commitment is already ${current?.status ?? "closed"}` });
    return;
  }

  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: status === "Completed" ? "grow_commitment_completed" : "grow_commitment_cancelled",
    recordType: "grow_commitment",
    recordId: String(updated.id),
    propertyId: updated.propertyId,
    previousValue: JSON.stringify({ status: "Open" }),
    updatedValue: JSON.stringify(
      status === "Completed"
        ? { status, completedByUserId: user.id }
        : { status, cancelledByUserId: user.id },
    ),
  });

  res.json({ commitment: updated });
});
