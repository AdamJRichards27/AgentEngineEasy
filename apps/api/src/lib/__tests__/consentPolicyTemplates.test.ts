import { test } from "node:test";
import assert from "node:assert/strict";
import type { RecordConsentPolicyInput } from "../consentControlsPersistence.js";
import {
  GROW_AU_CONSENT_POLICY_TEMPLATE,
  GROW_CONSENT_POLICY_TEMPLATES,
  GROW_NZ_CONSENT_POLICY_TEMPLATE,
} from "../consentPolicyTemplates.js";
import { evaluateConsentDecision } from "../consentControls.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");

test("AU and NZ policy templates stay distinct and persistable without live writes", () => {
  assert.equal(GROW_CONSENT_POLICY_TEMPLATES.AU, GROW_AU_CONSENT_POLICY_TEMPLATE);
  assert.equal(GROW_CONSENT_POLICY_TEMPLATES.NZ, GROW_NZ_CONSENT_POLICY_TEMPLATE);
  assert.notEqual(GROW_AU_CONSENT_POLICY_TEMPLATE.version, GROW_NZ_CONSENT_POLICY_TEMPLATE.version);
  assert.notEqual(
    GROW_AU_CONSENT_POLICY_TEMPLATE.policyData.templateId,
    GROW_NZ_CONSENT_POLICY_TEMPLATE.policyData.templateId,
  );
  assert.equal(GROW_AU_CONSENT_POLICY_TEMPLATE.jurisdiction, "AU");
  assert.equal(GROW_NZ_CONSENT_POLICY_TEMPLATE.jurisdiction, "NZ");

  const auPersistenceInput: RecordConsentPolicyInput = {
    brokerageId: 1,
    effectiveAt: NOW,
    recordedByUserId: 2,
    ...GROW_AU_CONSENT_POLICY_TEMPLATE,
  };
  const nzPersistenceInput: RecordConsentPolicyInput = {
    brokerageId: 1,
    effectiveAt: NOW,
    recordedByUserId: 2,
    ...GROW_NZ_CONSENT_POLICY_TEMPLATE,
  };
  assert.deepEqual(auPersistenceInput.policyData, GROW_AU_CONSENT_POLICY_TEMPLATE.policyData);
  assert.deepEqual(nzPersistenceInput.policyData, GROW_NZ_CONSENT_POLICY_TEMPLATE.policyData);
  assert.equal(auPersistenceInput.timeZone, null);
  assert.equal(nzPersistenceInput.timeZone, null);
  assert.equal(auPersistenceInput.dncrRequired, true);
  assert.equal(nzPersistenceInput.dncrRequired, true);
  assert.equal(auPersistenceInput.allowInferredConsent, false);
  assert.equal(nzPersistenceInput.allowInferredConsent, false);
  assert.equal(auPersistenceInput.allowNotRequiredConsent, false);
  assert.equal(nzPersistenceInput.allowNotRequiredConsent, false);
  assert.equal(auPersistenceInput.suppressionEnabled, true);
  assert.equal(nzPersistenceInput.suppressionEnabled, true);
});

test("unapproved AU and NZ hours fail closed until reviewed configuration is supplied", () => {
  for (const template of [GROW_AU_CONSENT_POLICY_TEMPLATE, GROW_NZ_CONSENT_POLICY_TEMPLATE]) {
    const decision = evaluateConsentDecision({
      channel: "EMAIL",
      purpose: "outreach",
      scope: "standing",
      jurisdiction: template.jurisdiction,
      policy: {
        ...template,
        effectiveAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      dncr: {
        status: "CLEARED",
        jurisdiction: template.jurisdiction,
        reference: `${template.jurisdiction.toLowerCase()}-template-test`,
        checkedAt: NOW,
        validUntil: new Date("2026-02-15T12:00:00.000Z"),
        reviewAt: new Date("2026-02-01T12:00:00.000Z"),
      },
      consent: {
        state: "EXPRESS",
        jurisdiction: template.jurisdiction,
        purpose: "outreach",
        scope: "standing",
      },
      now: NOW,
    });
    assert.equal(decision.decision, "REVIEW_REQUIRED");
    assert.equal(decision.reasonCode, "POLICY_INVALID_WINDOW");
  }
});
