import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { parties } from "./property";

// AE GROW Priority 6 Stage F2 step 1 — consent recording and outbound
// controls. These are deliberately data-model values rather than PostgreSQL
// enums: policy versions can add a value only through a reviewed migration,
// while existing records remain readable.
export const GROW_CONSENT_CHANNELS = ["EMAIL", "SMS", "PHONE_CALL", "VOICE_CALL", "EXTERNAL_MESSAGE"] as const;
export type GrowConsentChannel = (typeof GROW_CONSENT_CHANNELS)[number];

export const GROW_CONSENT_STATES = ["EXPRESS", "INFERRED", "NONE", "WITHDRAWN", "UNKNOWN", "NOT_REQUIRED"] as const;
export type GrowConsentState = (typeof GROW_CONSENT_STATES)[number];

export const GROW_CONSENT_DECISION_STATUSES = ["ELIGIBLE", "BLOCKED", "REVIEW_REQUIRED"] as const;
export type GrowConsentDecisionStatus = (typeof GROW_CONSENT_DECISION_STATUSES)[number];

export const GROW_CONSENT_DECISION_REASON_CODES = [
  "WITHDRAWN",
  "NO_VALID_DNCR_CLEARED_CONSENT",
  "DNCR_LISTED",
  "DNCR_STATUS_UNKNOWN",
  "DNCR_JURISDICTION_UNKNOWN",
  "DNCR_REVIEW_DUE",
  "SUPPRESSED",
  "OUTSIDE_ALLOWED_HOURS",
  "UNKNOWN_CONSENT",
  "NO_CONSENT",
  "CONSENT_EXPIRED",
  "CONSENT_REVIEW_DUE",
  "UNKNOWN_JURISDICTION",
  "JURISDICTION_MISMATCH",
  "POLICY_NOT_FOUND",
  "POLICY_INVALID_WINDOW",
  "NOT_REQUIRED_JUSTIFIED",
  "NOT_REQUIRED_JUSTIFICATION_MISSING",
  "NOT_REQUIRED_NOT_ENABLED_BY_POLICY",
  "INFERRED_CONSENT_ELIGIBLE",
  "EXPRESS_CONSENT_ELIGIBLE",
  "INFERRED_EVIDENCE_MISSING",
  "INFERRED_NOT_ENABLED_BY_POLICY",
  "NO_VALID_CONSENT",
  "POLICY_INVALID_DNCR_CONFIG",
  "POLICY_INVALID_EFFECTIVE_AT",
  "POLICY_NOT_CURRENT",
  "UNSUPPORTED_CHANNEL",
] as const;
export type GrowConsentDecisionReasonCode = (typeof GROW_CONSENT_DECISION_REASON_CODES)[number];

export const GROW_CONSENT_POLICY_JURISDICTIONS = ["AU", "NZ"] as const;
export type GrowConsentPolicyJurisdiction = (typeof GROW_CONSENT_POLICY_JURISDICTIONS)[number];

export const GROW_DNCR_STATUSES = ["CLEARED", "LISTED", "UNKNOWN", "NOT_CHECKED"] as const;
export type GrowDncrStatus = (typeof GROW_DNCR_STATUSES)[number];

export const GROW_CONSENT_SUPPRESSION_STATES = ["SUPPRESSED", "RELEASED"] as const;
export type GrowConsentSuppressionState = (typeof GROW_CONSENT_SUPPRESSION_STATES)[number];

// Every consent capture is an event. A later state supersedes an earlier
// state via supersedesConsentId; old rows are never updated or deleted.
// This keeps withdrawal and review history explainable without a mutable
// "current consent" row.
export const growContactChannelConsents = pgTable(
  "grow_contact_channel_consents",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    channel: text("channel").notNull(),
    state: text("state").notNull().default("UNKNOWN"),

    source: text("source").notNull(),
    capturedAt: timestamp("captured_at").notNull().defaultNow(),
    captureMethod: text("capture_method").notNull(),
    purpose: text("purpose").notNull(),
    scope: text("scope").notNull(),

    evidenceReference: text("evidence_reference"),
    evidence: jsonb("evidence"),
    jurisdiction: text("jurisdiction"),

    recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id),
    expiresAt: timestamp("expires_at"),
    reviewAt: timestamp("review_at"),

    withdrawnAt: timestamp("withdrawn_at"),
    withdrawnByUserId: integer("withdrawn_by_user_id").references(() => users.id),
    withdrawalReason: text("withdrawal_reason"),

    inferredReasoning: text("inferred_reasoning"),
    relationshipEvidence: jsonb("relationship_evidence"),
    inferredEvidenceReviewedAt: timestamp("inferred_evidence_reviewed_at"),
    inferredEvidenceReviewedByUserId: integer("inferred_evidence_reviewed_by_user_id").references(() => users.id),
    notRequiredJustification: text("not_required_justification"),
    supersedesConsentId: integer("supersedes_consent_id").references((): AnyPgColumn => growContactChannelConsents.id),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePartyChannelIdx: index("grow_contact_channel_consents_brokerage_party_channel_idx").on(
      table.brokerageId,
      table.partyId,
      table.channel,
      table.capturedAt,
    ),
    stateIdx: index("grow_contact_channel_consents_brokerage_state_idx").on(table.brokerageId, table.state),
    inferredEvidenceCheck: check(
      "grow_contact_channel_consents_inferred_evidence_check",
      sql`state <> 'INFERRED' OR (
        length(trim(coalesce(inferred_reasoning, ''))) > 0
        AND length(trim(coalesce(evidence_reference, ''))) > 0
        AND relationship_evidence IS NOT NULL
        AND inferred_evidence_reviewed_at IS NOT NULL
        AND inferred_evidence_reviewed_by_user_id IS NOT NULL
      )`,
    ),
    notRequiredJustificationCheck: check(
      "grow_contact_channel_consents_not_required_justification_check",
      sql`state <> 'NOT_REQUIRED' OR length(trim(coalesce(not_required_justification, ''))) > 0`,
    ),
    withdrawalFieldsCheck: check(
      "grow_contact_channel_consents_withdrawal_fields_check",
      sql`state <> 'WITHDRAWN' OR (
        withdrawn_at IS NOT NULL
        AND withdrawn_by_user_id IS NOT NULL
        AND length(trim(coalesce(withdrawal_reason, ''))) > 0
      )`,
    ),
  }),
);

// AU and NZ policy data is represented as separate, versioned rows. The
// application selects the effective row; it never branches on a jurisdiction
// in a route. Policy fields are configuration inputs, not legal conclusions.
export const growConsentPolicyVersions = pgTable(
  "grow_consent_policy_versions",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    jurisdiction: text("jurisdiction").notNull(),
    version: text("version").notNull(),
    effectiveAt: timestamp("effective_at").notNull(),
    retiredAt: timestamp("retired_at"),

    allowInferredConsent: boolean("allow_inferred_consent").notNull().default(false),
    allowNotRequiredConsent: boolean("allow_not_required_consent").notNull().default(false),
    dncrRequired: boolean("dncr_required").notNull().default(true),
    suppressionEnabled: boolean("suppression_enabled").notNull().default(true),
    timeZone: text("time_zone"),
    allowedHoursStart: text("allowed_hours_start"),
    allowedHoursEnd: text("allowed_hours_end"),
    quietHoursStart: text("quiet_hours_start"),
    quietHoursEnd: text("quiet_hours_end"),
    policyData: jsonb("policy_data").notNull().default(sql`'{}'::jsonb`),

    recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    brokerageJurisdictionVersionUnique: uniqueIndex("grow_consent_policy_versions_brokerage_jurisdiction_version_unique").on(
      table.brokerageId,
      table.jurisdiction,
      table.version,
    ),
    effectiveIdx: index("grow_consent_policy_versions_brokerage_jurisdiction_effective_idx").on(
      table.brokerageId,
      table.jurisdiction,
      table.effectiveAt,
    ),
  }),
);

// DNCR is an intentionally provider-neutral, mockable observation. A new
// check appends a row; no vendor account, SDK, credential, or live lookup is
// implied by this table.
export const growContactDncrStatuses = pgTable(
  "grow_contact_dncr_statuses",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    channel: text("channel").notNull(),
    jurisdiction: text("jurisdiction"),
    status: text("status").notNull().default("NOT_CHECKED"),
    checkedAt: timestamp("checked_at").notNull().defaultNow(),
    validUntil: timestamp("valid_until"),
    reviewAt: timestamp("review_at"),
    source: text("source").notNull(),
    reference: text("reference"),
    responseMetadata: jsonb("response_metadata"),
    recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    latestIdx: index("grow_contact_dncr_statuses_brokerage_party_channel_idx").on(
      table.brokerageId,
      table.partyId,
      table.channel,
      table.checkedAt,
    ),
    statusIdx: index("grow_contact_dncr_statuses_brokerage_status_idx").on(table.brokerageId, table.status),
    clearedReferenceCheck: check(
      "grow_contact_dncr_statuses_cleared_reference_check",
      sql`status <> 'CLEARED' OR length(trim(coalesce(reference, ''))) > 0`,
    ),
  }),
);

// Suppression is also an append-only event stream. RELEASED does not erase a
// previous suppression; the decision resolver uses the latest event for the
// tenant/contact/channel.
export const growContactChannelSuppressions = pgTable(
  "grow_contact_channel_suppressions",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    channel: text("channel").notNull(),
    state: text("state").notNull().default("SUPPRESSED"),
    reason: text("reason").notNull(),
    effectiveAt: timestamp("effective_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    reference: text("reference"),
    recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    latestIdx: index("grow_contact_channel_suppressions_brokerage_party_channel_idx").on(
      table.brokerageId,
      table.partyId,
      table.channel,
      table.effectiveAt,
    ),
  }),
);

// Immutable, append-only decision evidence. All foreign keys are additionally
// checked against brokerageId by the supporting library before insertion;
// this follows the repository's application-level cross-tenant convention.
export const growConsentDecisions = pgTable(
  "grow_consent_decisions",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    channel: text("channel").notNull(),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonCodes: jsonb("reason_codes").notNull().default(sql`'[]'::jsonb`),

    consentId: integer("consent_id").references(() => growContactChannelConsents.id),
    dncrStatusId: integer("dncr_status_id").references(() => growContactDncrStatuses.id),
    suppressionId: integer("suppression_id").references(() => growContactChannelSuppressions.id),
    policyVersionId: integer("policy_version_id").references(() => growConsentPolicyVersions.id),
    jurisdiction: text("jurisdiction"),
    policyVersion: text("policy_version"),

    evaluatedAt: timestamp("evaluated_at").notNull().defaultNow(),
    decidedByUserId: integer("decided_by_user_id").references(() => users.id),
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePartyChannelIdx: index("grow_consent_decisions_brokerage_party_channel_idx").on(
      table.brokerageId,
      table.partyId,
      table.channel,
      table.evaluatedAt,
    ),
    decisionIdx: index("grow_consent_decisions_brokerage_decision_idx").on(table.brokerageId, table.decision),
  }),
);

export const insertGrowContactChannelConsentSchema = createInsertSchema(growContactChannelConsents).omit({
  id: true,
  createdAt: true,
});
export const insertGrowConsentPolicyVersionSchema = createInsertSchema(growConsentPolicyVersions).omit({
  id: true,
  createdAt: true,
});
export const insertGrowContactDncrStatusSchema = createInsertSchema(growContactDncrStatuses).omit({ id: true, createdAt: true });
export const insertGrowContactChannelSuppressionSchema = createInsertSchema(growContactChannelSuppressions).omit({
  id: true,
  createdAt: true,
});
export const insertGrowConsentDecisionSchema = createInsertSchema(growConsentDecisions).omit({ id: true, createdAt: true });

export type InsertGrowContactChannelConsent = z.infer<typeof insertGrowContactChannelConsentSchema>;
export type InsertGrowConsentPolicyVersion = z.infer<typeof insertGrowConsentPolicyVersionSchema>;
export type InsertGrowContactDncrStatus = z.infer<typeof insertGrowContactDncrStatusSchema>;
export type InsertGrowContactChannelSuppression = z.infer<typeof insertGrowContactChannelSuppressionSchema>;
export type InsertGrowConsentDecision = z.infer<typeof insertGrowConsentDecisionSchema>;

export type GrowContactChannelConsent = typeof growContactChannelConsents.$inferSelect;
export type GrowConsentPolicyVersion = typeof growConsentPolicyVersions.$inferSelect;
export type GrowContactDncrStatus = typeof growContactDncrStatuses.$inferSelect;
export type GrowContactChannelSuppression = typeof growContactChannelSuppressions.$inferSelect;
export type GrowConsentDecision = typeof growConsentDecisions.$inferSelect;