// AE GROW Priority 6 Stage F2 step 2 — the route layer over the F2 consent
// model.
//
// WHY THIS FILE EXISTS. Stage F2 step 1 landed the consent model
// (packages/db/src/schema/consentControls.ts), a strict fail-closed evaluator
// (lib/consentControls.ts) and a complete persistence boundary
// (lib/consentControlsPersistence.ts) — and then stopped, by design: that
// step's own header says "No route is required for this step." Nothing
// resumed it. The result was that all four state writers
// (captureConsentState, recordConsentPolicy, recordDncrStatus,
// recordConsentSuppression) had no non-test caller anywhere in the
// application: no route imported them, no script imported them, no scheduled
// job called them. Consent and DNC state could therefore only be set by a
// test, which made the whole Do Not Contact control inert in production —
// lib/propertyIntelligence/contactability.ts and evaluateConsentDecision()
// both read tables that nothing running in production could populate.
// (contactability.ts's own header records this as the state of the world:
// "their only writers are on the telephony path".)
//
// WHAT THIS FILE IS. The missing transport, and nothing else. Every write
// below calls the existing library function UNCHANGED. There is no new
// persistence logic here: no insert, no update, no transaction, no advisory
// lock, no audit write. The library keeps ownership of the append-only
// semantics, the supersede-the-head rule, the brokerage advisory lock, the
// evidence validation and the audit trail; this file only parses a request,
// resolves the tenant from the session, and maps the library's outcomes onto
// HTTP.
//
// WHAT THIS FILE DELIBERATELY IS NOT.
//
//   * It does not seed or default a consent policy row. timeZone,
//     allowedHoursStart/End and quietHoursStart/End are deliberately null
//     pending AU/NZ legal approval, and with them unset the evaluator
//     correctly returns POLICY_INVALID_WINDOW -> REVIEW_REQUIRED. That is the
//     correct pilot state, not a bug to paper over, so POST /grow/consent/
//     policies passes exactly what the caller sends and every read below
//     works with policy rows entirely absent.
//
//   * It does not implement contact-wide withdrawal. Withdrawal in step 1 is
//     scoped to one (channel, purpose, scope) head stream, and whether it
//     should instead apply across a whole contact is an open Project Owner
//     decision. This router leaves the existing narrow behaviour exactly as
//     it is rather than pre-empting that decision in the transport.
//
//   * It does not work around the no-re-consent rule.
//     consentControlsPersistence.ts refuses to append after a WITHDRAWN head
//     ("step 1 does not support re-consent"). That refusal is surfaced here
//     as a clean 409, not routed around.
//
// TENANCY. brokerageId is always req.authedUser.brokerageId — never a route
// param, never a body field. Every writer in consentControlsPersistence.ts
// then re-asserts the party and every referenced user against that same
// brokerage inside its own transaction (assertPartyInBrokerage /
// assertUserInBrokerage), so a partyId belonging to another tenant is
// rejected before any row is written. This matches routes/growCalls.ts and
// routes/growAppraisals.ts, which re-resolve their own party/session against
// req.authedUser's brokerageId rather than trusting a client-supplied id.
//
// GATING. Writes require grow.contacts.manage; the read requires
// grow.contacts.read; policy-version writes require grow.admin.configure —
// managing a brokerage's consent policy is an administrative configuration
// act, not contact management. All three are existing canonical keys in
// packages/db/src/schema/billing.ts, applied through the existing
// requireEntitlement middleware exactly as the neighbouring Grow routers do.
//
// NAMING FOOTGUN, RECORDED SO IT IS NOT REPEATED. There are two unrelated
// exported functions called recordConsent in this codebase:
// lib/consentControlsPersistence.ts's (an alias of captureConsentState, over
// grow_contact_channel_consents) and lib/communications/consent.ts's (a
// different feature over a different table entirely). This file imports the
// F2 writers by their full, unambiguous names from an explicit path and never
// touches the communications one.

import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { logger } from "@aee/events";
import {
  db,
  growContactChannelConsents,
  growContactChannelSuppressions,
  growContactDncrStatuses,
  parties,
  GROW_CONSENT_CHANNELS,
  GROW_CONSENT_STATES,
  GROW_CONSENT_SUPPRESSION_STATES,
  GROW_DNCR_STATUSES,
} from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { ConsentControlsValidationError } from "../lib/consentControls.js";
import {
  ConsentControlsNotFoundError,
  captureConsentState,
  evaluateConsentDecisionReadOnly,
  recordConsentPolicy,
  recordConsentSuppression,
  recordDncrStatus,
} from "../lib/consentControlsPersistence.js";

export const growConsentRouter = Router();

/* ---------------------------------------------------------------------
 * Shared guards
 * -----------------------------------------------------------------*/

// Route-id validation, the same bounded guard routes/growAppraisals.ts and
// routes/grow.ts already use (deliberately duplicated locally, as they
// duplicate it from each other). Bounded by MAX_SIGNED_INT4 because every id
// resolved here is a `serial` column, i.e. int4 — an id past that range
// reaches Postgres as an unbindable value, turning an ordinary client error
// into a 500.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_CONSENT_ERROR = "An unexpected error occurred. Please try again or contact support if the problem persists.";

/**
 * consentControlsPersistence.ts signals its domain rules with plain `Error`s
 * carrying user-meaningful messages, and its tenancy/reference failures with
 * the typed ConsentControlsNotFoundError. Plain `Error` cannot be caught by
 * instanceof, and blanket-returning `err.message` for it is exactly the
 * internal-error leak routes/__tests__/internalErrorLeak.test.ts exists to
 * prevent — a driver fault would be echoed verbatim to any authenticated
 * caller, mislabelled as a client error.
 *
 * So this is an explicit allow-list of that library's OWN domain messages,
 * each mapped to the status it deserves, and nothing else. A message not on
 * this list is by definition not one of the library's rules: it is an
 * unrecognised server fault and becomes a logged, generic 500. Keeping the
 * list literal (rather than matching on substrings) means a future library
 * message cannot silently start being reported as a client error.
 *
 * 409 is used for the rules that depend on CURRENT STREAM STATE — the caller's
 * payload may be perfectly well-formed and still be refused because of what
 * was already appended. 400 is used for rules about the payload itself.
 */
const LIBRARY_RULE_STATUSES = new Map<string, number>([
  // Stream-state rules (append-only consent model).
  ["Consent purpose/scope stream is withdrawn; step 1 does not support re-consent.", 409],
  ["Every append after the first consent must supersede the current purpose/scope head.", 409],
  ["WITHDRAWN consent must supersede the current consent for the same purpose and scope.", 409],
  ["A withdrawn consent cannot be superseded.", 409],
  // Payload rules.
  ["Consent source, capture method, purpose, and scope are required.", 400],
  ["INFERRED evidence review time cannot be in the future.", 400],
  ["Consent policy version is required.", 400],
  ["DNCR source and a supported consent channel are required.", 400],
  ["CLEARED DNCR status requires a provider-neutral supporting reference.", 400],
  ["CLEARED DNCR status requires validity and review timestamps.", 400],
  ["Suppression requires a reason.", 400],
  ["Consent decision purpose and scope are required.", 400],
]);

/** Postgres SQLSTATEs this transport maps, without ever echoing the driver's own text. */
const PG_UNIQUE_VIOLATION = "23505";
const PG_CHECK_VIOLATION = "23514";

/**
 * Walks the `cause` chain for a Postgres SQLSTATE. Drizzle does not rethrow
 * the driver's own error object: it wraps it in its own Error whose message is
 * the full query text and whose `cause` is the original — so reading `.code`
 * off the top-level error alone finds nothing and a constraint violation
 * becomes an unrecognised 500. Depth-bounded so a self-referential cause
 * cannot spin.
 */
function pgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function handleConsentRouteError(err: unknown, res: import("express").Response, route: string): void {
  if (err instanceof ConsentControlsNotFoundError) {
    // The library raises this both for "contact not in this brokerage" and
    // for an unresolvable superseded-consent reference. 404 keeps a
    // foreign-tenant partyId indistinguishable from a non-existent one.
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ConsentControlsValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof Error) {
    const status = LIBRARY_RULE_STATUSES.get(err.message);
    if (status !== undefined) {
      res.status(status).json({ error: err.message });
      return;
    }
    // Enum guards the library repeats after this router's zod schemas
    // already rejected the value. Unreachable through HTTP, mapped anyway so
    // a schema/library drift surfaces as a client error rather than a 500.
    if (/^Unsupported (consent channel|consent state|consent policy jurisdiction|DNCR status|suppression state|channel): /.test(err.message)) {
      res.status(400).json({ error: err.message });
      return;
    }
  }

  const code = pgErrorCode(err);
  if (code === PG_UNIQUE_VIOLATION) {
    // Today the only unique index these writers can violate is
    // grow_consent_policy_versions (brokerageId, jurisdiction, version).
    // A generic message: the constraint name is internal detail.
    res.status(409).json({ error: "That record already exists." });
    return;
  }
  if (code === PG_CHECK_VIOLATION) {
    // A CHECK constraint fired that the library's own evidence validation did
    // not catch first (schema/consentControls.ts:122-143 — INFERRED evidence,
    // NOT_REQUIRED justification, withdrawal metadata). The database is the
    // last line of defence and it held; log loudly, because reaching here
    // means the application-level validation and the constraint have drifted.
    logger.error("grow_consent_route_check_constraint_violation", { route });
    res.status(400).json({ error: "The consent record is missing metadata this state requires." });
    return;
  }

  logger.error("grow_consent_route_unhandled_error", {
    route,
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? err.name : typeof err,
  });
  res.status(500).json({ error: GENERIC_CONSENT_ERROR });
}

/**
 * Resolves :partyId AND proves it belongs to the caller's brokerage before
 * any writer runs. Each library writer re-asserts this itself inside its own
 * transaction (that check, not this one, is the security boundary), but doing
 * it here too means a foreign-tenant id is answered 404 by the same code path
 * whether or not the writer is reached — and, for the read below, without a
 * second round trip.
 */
async function resolvePartyForBrokerage(
  res: import("express").Response,
  rawPartyId: unknown,
  brokerageId: number,
): Promise<number | null> {
  const partyId = parsePositiveId(rawPartyId);
  if (partyId === null) {
    res.status(400).json({ error: "Invalid contact id." });
    return null;
  }
  const [party] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)))
    .limit(1);
  if (!party) {
    res.status(404).json({ error: "Contact not found." });
    return null;
  }
  return partyId;
}

const nonBlank = (label: string) => z.string().min(1).refine((v) => v.trim().length > 0, { message: `${label} must not be blank.` });

const consentChannel = z.enum(GROW_CONSENT_CHANNELS);

/* ---------------------------------------------------------------------
 * POST /grow/contacts/:partyId/consent — capture consent state.
 *
 * This is the ONLY way consent state reaches the database outside a test.
 * Withdrawal is not a separate route and not a mutation: it is a capture with
 * state WITHDRAWN that supersedes the current head of its own (channel,
 * purpose, scope) stream, which is precisely what the append-only model in
 * schema/consentControls.ts:110 was built for.
 * -----------------------------------------------------------------*/
const captureConsentSchema = z.object({
  channel: consentChannel,
  state: z.enum(GROW_CONSENT_STATES).optional(),
  source: nonBlank("source"),
  captureMethod: nonBlank("captureMethod"),
  purpose: nonBlank("purpose"),
  scope: nonBlank("scope"),
  capturedAt: z.string().datetime().optional(),
  evidenceReference: z.string().max(512).nullish(),
  evidence: z.unknown().optional(),
  jurisdiction: z.string().max(64).nullish(),
  expiresAt: z.string().datetime().nullish(),
  reviewAt: z.string().datetime().nullish(),
  // Withdrawal metadata. withdrawnByUserId is deliberately ABSENT from this
  // schema: the actor who withdraws is the authenticated caller, never a
  // client-supplied user id. withdrawnAt and withdrawalReason are optional
  // HERE on purpose — see the handler.
  withdrawnAt: z.string().datetime().optional(),
  withdrawalReason: z.string().max(1000).optional(),
  // INFERRED evidence. The reviewer may legitimately be someone other than
  // the caller, so it IS accepted from the body — and the library asserts it
  // belongs to the caller's brokerage before use (assertUserInBrokerage).
  inferredReasoning: z.string().max(2000).nullish(),
  relationshipEvidence: z.unknown().optional(),
  inferredEvidenceReviewedAt: z.string().datetime().optional(),
  inferredEvidenceReviewedByUserId: z.number().int().positive().max(MAX_SIGNED_INT4).optional(),
  notRequiredJustification: z.string().max(2000).nullish(),
  supersedesConsentId: z.number().int().positive().max(MAX_SIGNED_INT4).optional(),
});

const optionalDate = (value: string | null | undefined): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(value);

growConsentRouter.post(
  "/contacts/:partyId/consent",
  requireAuth,
  requireEntitlement("grow.contacts.manage"),
  async (req, res) => {
    const parsed = captureConsentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const user = req.authedUser!;
    const partyId = await resolvePartyForBrokerage(res, req.params.partyId, user.brokerageId);
    if (partyId === null) return;

    const body = parsed.data;
    try {
      const consent = await captureConsentState({
        brokerageId: user.brokerageId,
        partyId,
        channel: body.channel,
        state: body.state,
        source: body.source,
        captureMethod: body.captureMethod,
        purpose: body.purpose,
        scope: body.scope,
        capturedAt: body.capturedAt ? new Date(body.capturedAt) : undefined,
        evidenceReference: body.evidenceReference ?? null,
        evidence: body.evidence,
        jurisdiction: body.jurisdiction ?? null,
        recordedByUserId: user.id,
        expiresAt: optionalDate(body.expiresAt) ?? null,
        reviewAt: optionalDate(body.reviewAt) ?? null,
        // WITHDRAWAL METADATA IS NOT DEFAULTED. The DB CHECK
        // grow_contact_channel_consents_withdrawal_fields_check (schema/
        // consentControls.ts:136-143) requires withdrawn_at, withdrawn_by_user_id
        // and a non-blank withdrawal_reason whenever state is WITHDRAWN, and
        // validateConsentCaptureEvidence() enforces the same rule in the
        // library. This transport supplies ONLY the actor — which is the
        // authenticated caller by definition, and must never come from the
        // body. It does not invent a withdrawal time and does not invent a
        // reason: a withdrawal request missing either is rejected by the
        // library with a 400, which is the point. Auto-filling them here
        // would turn a legally significant record into a rubber stamp.
        withdrawnAt: body.state === "WITHDRAWN" ? (body.withdrawnAt ? new Date(body.withdrawnAt) : null) : null,
        withdrawnByUserId: body.state === "WITHDRAWN" ? user.id : null,
        withdrawalReason: body.state === "WITHDRAWN" ? body.withdrawalReason ?? null : null,
        inferredReasoning: body.inferredReasoning ?? null,
        relationshipEvidence: body.relationshipEvidence,
        inferredEvidenceReviewedAt: body.inferredEvidenceReviewedAt ? new Date(body.inferredEvidenceReviewedAt) : null,
        inferredEvidenceReviewedByUserId: body.inferredEvidenceReviewedByUserId ?? null,
        notRequiredJustification: body.notRequiredJustification ?? null,
        supersedesConsentId: body.supersedesConsentId ?? null,
      });
      res.status(201).json({ consent });
    } catch (err) {
      handleConsentRouteError(err, res, "POST /grow/contacts/:partyId/consent");
    }
  },
);

/* ---------------------------------------------------------------------
 * POST /grow/contacts/:partyId/dncr — record a Do Not Call Register
 * observation. Provider-neutral: this route calls no DNCR service and implies
 * no vendor account, exactly as schema/consentControls.ts:188-190 describes.
 * It records what a check found.
 * -----------------------------------------------------------------*/
const recordDncrSchema = z.object({
  channel: consentChannel,
  status: z.enum(GROW_DNCR_STATUSES),
  source: nonBlank("source"),
  jurisdiction: z.enum(["AU", "NZ"]).nullish(),
  checkedAt: z.string().datetime().optional(),
  validUntil: z.string().datetime().nullish(),
  reviewAt: z.string().datetime().nullish(),
  reference: z.string().max(512).nullish(),
  responseMetadata: z.unknown().optional(),
});

growConsentRouter.post(
  "/contacts/:partyId/dncr",
  requireAuth,
  requireEntitlement("grow.contacts.manage"),
  async (req, res) => {
    const parsed = recordDncrSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const user = req.authedUser!;
    const partyId = await resolvePartyForBrokerage(res, req.params.partyId, user.brokerageId);
    if (partyId === null) return;

    const body = parsed.data;
    try {
      // CLEARED's extra requirements (a supporting reference, validity and
      // review timestamps) are the library's rules, deliberately not
      // re-implemented in the schema above — they stay enforced in one place.
      const dncrStatus = await recordDncrStatus({
        brokerageId: user.brokerageId,
        partyId,
        channel: body.channel,
        jurisdiction: body.jurisdiction ?? null,
        status: body.status,
        checkedAt: body.checkedAt ? new Date(body.checkedAt) : undefined,
        validUntil: optionalDate(body.validUntil) ?? null,
        reviewAt: optionalDate(body.reviewAt) ?? null,
        source: body.source,
        reference: body.reference ?? null,
        responseMetadata: body.responseMetadata,
        recordedByUserId: user.id,
      });
      res.status(201).json({ dncrStatus });
    } catch (err) {
      handleConsentRouteError(err, res, "POST /grow/contacts/:partyId/dncr");
    }
  },
);

/* ---------------------------------------------------------------------
 * POST /grow/contacts/:partyId/suppression — suppress or release one channel.
 *
 * RELEASED does not erase a suppression; it appends the newer event, and the
 * resolvers read the latest in-force row. This is the write that
 * lib/propertyIntelligence/contactability.ts has always read and that, until
 * now, nothing outside a test could produce.
 * -----------------------------------------------------------------*/
const recordSuppressionSchema = z.object({
  channel: consentChannel,
  state: z.enum(GROW_CONSENT_SUPPRESSION_STATES),
  reason: nonBlank("reason"),
  effectiveAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().nullish(),
  reference: z.string().max(512).nullish(),
});

growConsentRouter.post(
  "/contacts/:partyId/suppression",
  requireAuth,
  requireEntitlement("grow.contacts.manage"),
  async (req, res) => {
    const parsed = recordSuppressionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const user = req.authedUser!;
    const partyId = await resolvePartyForBrokerage(res, req.params.partyId, user.brokerageId);
    if (partyId === null) return;

    const body = parsed.data;
    try {
      const suppression = await recordConsentSuppression({
        brokerageId: user.brokerageId,
        partyId,
        channel: body.channel,
        state: body.state,
        reason: body.reason,
        effectiveAt: body.effectiveAt ? new Date(body.effectiveAt) : undefined,
        expiresAt: optionalDate(body.expiresAt) ?? null,
        reference: body.reference ?? null,
        recordedByUserId: user.id,
      });
      res.status(201).json({ suppression });
    } catch (err) {
      handleConsentRouteError(err, res, "POST /grow/contacts/:partyId/suppression");
    }
  },
);

/* ---------------------------------------------------------------------
 * POST /grow/consent/policies — record a consent policy version.
 *
 * grow.admin.configure, not grow.contacts.manage: a policy version is
 * brokerage-wide configuration that changes how every contact is evaluated,
 * which is a different act from recording one contact's consent.
 *
 * NOTHING IS DEFAULTED OR SEEDED HERE. timeZone, allowedHoursStart/End and
 * quietHoursStart/End stay exactly as the caller sends them — including
 * absent. With those unset the evaluator returns POLICY_INVALID_WINDOW ->
 * REVIEW_REQUIRED, which is the correct pilot posture while AU/NZ legal
 * approval is outstanding (approvalStatus: "REVIEW_REQUIRED"). Choosing
 * calling hours is a legal decision this transport has no business making.
 * -----------------------------------------------------------------*/
const recordPolicySchema = z.object({
  jurisdiction: z.enum(["AU", "NZ"]),
  version: nonBlank("version"),
  effectiveAt: z.string().datetime(),
  retiredAt: z.string().datetime().nullish(),
  allowInferredConsent: z.boolean().optional(),
  allowNotRequiredConsent: z.boolean().optional(),
  dncrRequired: z.boolean(),
  suppressionEnabled: z.boolean().optional(),
  timeZone: z.string().max(64).nullish(),
  allowedHoursStart: z.string().max(16).nullish(),
  allowedHoursEnd: z.string().max(16).nullish(),
  quietHoursStart: z.string().max(16).nullish(),
  quietHoursEnd: z.string().max(16).nullish(),
  policyData: z.unknown().optional(),
});

growConsentRouter.post(
  "/consent/policies",
  requireAuth,
  requireEntitlement("grow.admin.configure"),
  async (req, res) => {
    const parsed = recordPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const user = req.authedUser!;
    const body = parsed.data;
    try {
      const policyVersion = await recordConsentPolicy({
        brokerageId: user.brokerageId,
        jurisdiction: body.jurisdiction,
        version: body.version,
        effectiveAt: new Date(body.effectiveAt),
        retiredAt: optionalDate(body.retiredAt) ?? null,
        allowInferredConsent: body.allowInferredConsent,
        allowNotRequiredConsent: body.allowNotRequiredConsent,
        dncrRequired: body.dncrRequired,
        suppressionEnabled: body.suppressionEnabled,
        timeZone: body.timeZone ?? null,
        allowedHoursStart: body.allowedHoursStart ?? null,
        allowedHoursEnd: body.allowedHoursEnd ?? null,
        quietHoursStart: body.quietHoursStart ?? null,
        quietHoursEnd: body.quietHoursEnd ?? null,
        policyData: body.policyData,
        recordedByUserId: user.id,
      });
      res.status(201).json({ policyVersion });
    } catch (err) {
      handleConsentRouteError(err, res, "POST /grow/consent/policies");
    }
  },
);

/* ---------------------------------------------------------------------
 * GET /grow/contacts/:partyId/consent — current consent state for a contact.
 *
 * "CURRENT" MEANS WHAT THE CONSENT MODEL SAYS IT MEANS. captured_at,
 * checked_at and effective_at are CALLER-SUPPLIED evidence metadata;
 * consentControlsPersistence.ts's own resolvers
 * (latestConsent/latestDncr/latestSuppression) therefore order by SERIAL id
 * DESC, because the serial is the append order and the only ordering the
 * database itself guarantees — and a suppression additionally only counts
 * once it is in force (effective_at <= now). This read follows those two
 * definitions exactly rather than inventing a third, for the same reason
 * lib/propertyIntelligence/contactability.ts says it does.
 *
 * The rows are reduced in JS rather than with DISTINCT ON: a single contact
 * has a handful of consent events, and the plainer form makes it obvious that
 * the ordering rule above is the one being applied.
 *
 * This read writes nothing. When channel+purpose+scope are supplied it also
 * returns an evaluation via evaluateConsentDecisionReadOnly(), which is the
 * library's explicit presentation path: it runs the same lookups and the same
 * pure evaluator as the audited decision boundary but deliberately appends no
 * grow_consent_decisions row, so a read can never manufacture an id that
 * looks like an enforcement decision.
 * -----------------------------------------------------------------*/
const consentQuerySchema = z.object({
  channel: consentChannel.optional(),
  purpose: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  jurisdiction: z.enum(["AU", "NZ"]).optional(),
});

growConsentRouter.get(
  "/contacts/:partyId/consent",
  requireAuth,
  requireEntitlement("grow.contacts.read"),
  async (req, res) => {
    const parsedQuery = consentQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "Invalid request", details: parsedQuery.error.flatten() });
      return;
    }
    const user = req.authedUser!;
    const partyId = await resolvePartyForBrokerage(res, req.params.partyId, user.brokerageId);
    if (partyId === null) return;

    const { channel, purpose, scope, jurisdiction } = parsedQuery.data;
    const wantsEvaluation = channel !== undefined && purpose !== undefined && scope !== undefined;
    if (!wantsEvaluation && (channel !== undefined || purpose !== undefined || scope !== undefined)) {
      res.status(400).json({ error: "channel, purpose and scope must be supplied together to evaluate a decision." });
      return;
    }

    try {
      const now = new Date();

      // Ascending id, then last-write-wins per key: the final row for a key is
      // the highest id, i.e. the head of that append-only stream.
      const consentRows = await db
        .select()
        .from(growContactChannelConsents)
        .where(
          and(
            eq(growContactChannelConsents.brokerageId, user.brokerageId),
            eq(growContactChannelConsents.partyId, partyId),
          ),
        )
        .orderBy(growContactChannelConsents.id);
      const consentHeads = new Map<string, (typeof consentRows)[number]>();
      for (const row of consentRows) consentHeads.set(JSON.stringify([row.channel, row.purpose, row.scope]), row);

      const dncrRows = await db
        .select()
        .from(growContactDncrStatuses)
        .where(
          and(eq(growContactDncrStatuses.brokerageId, user.brokerageId), eq(growContactDncrStatuses.partyId, partyId)),
        )
        .orderBy(growContactDncrStatuses.id);
      const dncrHeads = new Map<string, (typeof dncrRows)[number]>();
      for (const row of dncrRows) dncrHeads.set(row.channel, row);

      const suppressionRows = await db
        .select()
        .from(growContactChannelSuppressions)
        .where(
          and(
            eq(growContactChannelSuppressions.brokerageId, user.brokerageId),
            eq(growContactChannelSuppressions.partyId, partyId),
          ),
        )
        .orderBy(growContactChannelSuppressions.id);
      const suppressionHeads = new Map<string, (typeof suppressionRows)[number]>();
      // Only rows already in force count, matching latestSuppression(): a
      // RELEASED row dated in the future must not read as the current state
      // here while the consent engine still treats the contact as suppressed.
      for (const row of suppressionRows) {
        if (row.effectiveAt.getTime() > now.getTime()) continue;
        suppressionHeads.set(row.channel, row);
      }

      const evaluation = wantsEvaluation
        ? await evaluateConsentDecisionReadOnly({
            brokerageId: user.brokerageId,
            partyId,
            channel,
            purpose,
            scope,
            jurisdiction: jurisdiction ?? null,
          })
        : null;

      res.json({
        partyId,
        evaluatedAt: now.toISOString(),
        consents: [...consentHeads.values()],
        dncrStatuses: [...dncrHeads.values()],
        suppressions: [...suppressionHeads.values()],
        // Null, not an error, when no (channel, purpose, scope) was asked
        // for — and note the decision itself is always null here even when an
        // evaluation ran, because a read records no decision.
        evaluation: evaluation
          ? { decision: evaluation.decision, evaluation: evaluation.evaluation, evidence: evaluation.evidence }
          : null,
      });
    } catch (err) {
      handleConsentRouteError(err, res, "GET /grow/contacts/:partyId/consent");
    }
  },
);
