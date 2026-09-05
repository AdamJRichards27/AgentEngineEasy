// Agent Engine 2.0 — Run Transaction Vertical Slice.
//
// Closes a confirmed WAE Stage 2 gap: templates.ts's five workflow
// templates (installStage2WorkflowCatalogue) had zero production call
// sites anywhere in this codebase before this change — installed nowhere,
// activated nowhere, so no Stage 2 task was ever created by a real
// transaction, regardless of how many AGENCY_AGREEMENT_SIGNED/
// OFFER_ACCEPTED/CONTRACT_SIGNED/SETTLEMENT_SCHEDULED/SETTLEMENT_COMPLETED
// events fired. Mirrors the established idempotent boot-seed pattern
// (lib/billing/catalogue.ts's ensureCatalogueSeeded): safe to call on
// every boot, check-then-insert, never a blind re-install and never a
// blind re-version.
//
// A rule version can only ever be activated by a genuine Brokerage
// Administrator — rules.ts's approveAndActivateRuleVersion enforces this
// with a real users-table lookup, and this sweep does not weaken that: it
// finds each brokerage's earliest active Brokerage Administrator to act as
// installer/approver. A brokerage with no Brokerage Administrator yet is
// skipped entirely, not defaulted to some other actor — fails closed, and
// is retried automatically on the next boot once one exists.
//
// Safe to call repeatedly: templates.ts's individual install*() functions
// are NOT idempotent on their own (each unconditionally inserts a new
// automationRules row and a new automationRuleVersions row) — every call
// below is guarded by a getAutomationRuleByTemplateKey() existence check
// first, so a rule/version is only ever created once per brokerage per
// template, and re-running this sweep against an already-seeded brokerage
// is a fast series of no-ops.

import { eq, and, asc, desc } from "drizzle-orm";
import { db, brokerages, users, automationRuleVersions, type AutomationRule } from "@aee/db";
import { logger } from "@aee/events";
import { getAutomationRuleByTemplateKey, approveAndActivateRuleVersion } from "./rules.js";
import {
  installAgencyAgreementSignedStage2Version,
  installOfferAcceptedTemplate,
  installContractSignedTemplate,
  installSettlementScheduledTemplates,
  installSettlementCompletedTemplate,
  AGENCY_AGREEMENT_SIGNED_TEMPLATE_KEY,
  OFFER_ACCEPTED_TEMPLATE_KEY,
  CONTRACT_SIGNED_TEMPLATE_KEY,
  SETTLEMENT_SCHEDULED_PREPARE_TEMPLATE_KEY,
  SETTLEMENT_SCHEDULED_MISSING_DATE_TEMPLATE_KEY,
  SETTLEMENT_COMPLETED_TEMPLATE_KEY,
} from "./templates.js";

async function activateLatestVersionIfNeeded(rule: AutomationRule, brokerageId: number, adminUserId: number): Promise<void> {
  if (rule.status === "ACTIVE") return;
  const [latest] = await db
    .select()
    .from(automationRuleVersions)
    .where(eq(automationRuleVersions.ruleId, rule.id))
    .orderBy(desc(automationRuleVersions.version))
    .limit(1);
  if (!latest || latest.status === "ACTIVE" || latest.status === "SUPERSEDED" || latest.status === "ARCHIVED") return;
  await approveAndActivateRuleVersion({ versionId: latest.id, brokerageId, approvedByUserId: adminUserId }).catch((err) =>
    logger.error("catalogue_bootstrap_activate_rule_failed", { ruleId: rule.id, brokerageId, error: err }),
  );
}

async function ensureRuleInstalledAndActive(
  brokerageId: number,
  templateKey: string,
  adminUserId: number,
  install: () => Promise<{ rule: AutomationRule; version: { id: number } }>,
): Promise<void> {
  const existingRule = await getAutomationRuleByTemplateKey(brokerageId, templateKey);
  if (!existingRule) {
    const { version } = await install();
    await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminUserId }).catch((err) =>
      logger.error("catalogue_bootstrap_activate_newly_installed_template_failed", { templateKey, brokerageId, error: err }),
    );
    return;
  }
  await activateLatestVersionIfNeeded(existingRule, brokerageId, adminUserId);
}

export async function ensureStage2CatalogueSeededForBrokerage(brokerageId: number): Promise<void> {
  const [admin] = await db
    .select()
    .from(users)
    .where(and(eq(users.brokerageId, brokerageId), eq(users.role, "Brokerage Administrator"), eq(users.isActive, true)))
    .orderBy(asc(users.id))
    .limit(1);
  // No genuine Brokerage Administrator yet — cannot safely establish
  // authority for an activation (rules.ts's approveAndActivateRuleVersion
  // requires one). Fail closed rather than substitute any other actor;
  // this brokerage is retried on the next boot.
  if (!admin) return;

  const installInput = { brokerageId, createdByUserId: admin.id };

  await ensureRuleInstalledAndActive(brokerageId, AGENCY_AGREEMENT_SIGNED_TEMPLATE_KEY, admin.id, () =>
    installAgencyAgreementSignedStage2Version(installInput),
  );
  await ensureRuleInstalledAndActive(brokerageId, OFFER_ACCEPTED_TEMPLATE_KEY, admin.id, () => installOfferAcceptedTemplate(installInput));
  await ensureRuleInstalledAndActive(brokerageId, CONTRACT_SIGNED_TEMPLATE_KEY, admin.id, () => installContractSignedTemplate(installInput));
  await ensureRuleInstalledAndActive(brokerageId, SETTLEMENT_COMPLETED_TEMPLATE_KEY, admin.id, () =>
    installSettlementCompletedTemplate(installInput),
  );

  // installSettlementScheduledTemplates installs BOTH the prepare rule and
  // the missing-date fail-safe rule in one call — only safe to call when
  // NEITHER half exists yet. If exactly one half already exists (a prior
  // boot's install call crashed between the two synchronous inserts — rare,
  // but not impossible), this deliberately does not call the installer
  // again (which would duplicate the half that does exist); it activates
  // whichever half is present and leaves the missing half for manual
  // follow-up rather than guessing.
  const prepareRule = await getAutomationRuleByTemplateKey(brokerageId, SETTLEMENT_SCHEDULED_PREPARE_TEMPLATE_KEY);
  const missingDateRule = await getAutomationRuleByTemplateKey(brokerageId, SETTLEMENT_SCHEDULED_MISSING_DATE_TEMPLATE_KEY);
  if (!prepareRule && !missingDateRule) {
    const { prepare, missingDateFailsafe } = await installSettlementScheduledTemplates(installInput);
    await approveAndActivateRuleVersion({ versionId: prepare.version.id, brokerageId, approvedByUserId: admin.id }).catch((err) =>
      logger.error("catalogue_bootstrap_activate_settlement_scheduled_prepare_rule_failed", { brokerageId, error: err }),
    );
    await approveAndActivateRuleVersion({ versionId: missingDateFailsafe.version.id, brokerageId, approvedByUserId: admin.id }).catch((err) =>
      logger.error("catalogue_bootstrap_activate_settlement_scheduled_missing_date_rule_failed", { brokerageId, error: err }),
    );
  } else {
    if (prepareRule) await activateLatestVersionIfNeeded(prepareRule, brokerageId, admin.id);
    if (missingDateRule) await activateLatestVersionIfNeeded(missingDateRule, brokerageId, admin.id);
  }
}

/** Fire-and-forget, non-blocking boot sweep — same pattern as lib/billing/catalogue.ts's ensureCatalogueSeeded, called from index.ts. */
export async function ensureStage2CatalogueSeeded(): Promise<void> {
  const allBrokerages = await db.select().from(brokerages);
  for (const brokerage of allBrokerages) {
    try {
      await ensureStage2CatalogueSeededForBrokerage(brokerage.id);
    } catch (err) {
      logger.error("catalogue_bootstrap_seed_for_brokerage_failed", { brokerageId: brokerage.id, error: err });
    }
  }
}
