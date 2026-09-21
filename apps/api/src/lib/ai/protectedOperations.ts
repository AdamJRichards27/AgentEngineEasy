// AI Governance, Authority & Action Control Architecture -- Stage G9.
//
// Protected System Operations. This is the explicit denylist Build
// Instructions Part 3 describes: categories of operation that must NEVER
// be reachable through the AI Action Registry, regardless of role,
// entitlement, or approval. RESTRICTED-risk actions are already blocked
// structurally by the Policy Engine (policyEngine.ts refuses any action
// whose risk tier resolves to RESTRICTED), but that only helps if
// riskLevel is set correctly on every registry entry. This module is the
// second, independent line of defense: a name-based denylist plus a
// self-check that runs the moment the registry module loads, so a future
// entry that is miscategorised (e.g. an entitlement-changing action wired
// up with riskLevel 0 by mistake) fails the app at startup instead of
// silently shipping an AI-executable privilege escalation.
//
// This list is deliberately about *categories of operation*, not specific
// actionKeys -- it exists so a reviewer adding a new action to the
// registry has an explicit checklist of "this must never be here" to
// check the new actionKey's name against.

export const PROTECTED_OPERATION_CATEGORIES = [
  "AML/compliance determinations (verdicts, overrides, status changes)",
  "Financial ledger and commission changes",
  "Entitlement, role, or permission changes",
  "Database schema changes",
  "Security control changes (auth, session, encryption configuration)",
  "AI governance configuration itself (this registry, the Policy Engine, authority levels)",
  "User account creation, deletion, or credential changes",
  "Direct SQL, arbitrary API calls, or raw workflow-step edits",
  "Outbound communication to a person outside the app (email, SMS, push/notification, dialling)",
] as const;

// The outbound-messaging subset, named separately ONLY so the startup error
// can tell an engineer which way out they have. It is spread into the list
// below unchanged: this is not a second matching rule and nothing here
// narrows what is refused.
const OUTBOUND_MESSAGING_FRAGMENTS = ["SEND", "SMS", "EMAIL", "MESSAGE", "NOTIFY", "DIAL"];

// Name fragments that, if found in a registered actionKey (case-insensitive),
// indicate the action almost certainly belongs to a protected category above
// and must not be in the AI-executable registry.
const FORBIDDEN_ACTION_KEY_FRAGMENTS = [
  "AML",
  "COMPLIANCE",
  "LEDGER",
  "COMMISSION",
  "ENTITLEMENT",
  "ROLE",
  "PERMISSION",
  "SCHEMA",
  "SECURITY",
  "AUTH",
  "GOVERNANCE",
  "USER_DELETE",
  "USER_CREATE",
  "CREDENTIAL",
  "PASSWORD",
  "SQL",
  // Outbound messaging. AE's hard guarantee is that nothing leaves the
  // building addressed to a real person without a human deciding to send
  // it. Until these fragments existed that guarantee held only because no
  // provider was wired up -- an action registered as e.g.
  // "SEND_SMS_TO_CONTACT" with riskLevel 0 would have passed this
  // self-check and become automation-invokable. The guarantee is now
  // structural: a send-shaped actionKey cannot reach the AI Action Registry
  // at all, whatever riskLevel its author sets. An outbound message must be
  // DRAFTED for a human (a draft is not a send) and dispatched through the
  // Communications surface's own human-decision path, never through this
  // registry.
  //
  // Checked against every actionKey currently registered
  // (actions/registry.ts): PROPERTY_NOTE_ADD, WORKFLOW_CHANGE_PROPOSE,
  // WORKFLOW_VERSION_ACTIVATE, CREATE_INTERNAL_TASK, CREATE_REMINDER,
  // ASSIGN_TASK_OWNER, RAISE_ATTENTION_ITEM, REQUEST_ACTION_APPROVAL,
  // CREATE_GROW_COMMITMENT -- none collide. "NOTIFY" is deliberately here
  // while RAISE_ATTENTION_ITEM is not: raising an in-app attention item is
  // an internal record, not an outbound message to a person.
  ...OUTBOUND_MESSAGING_FRAGMENTS,
];

export interface RegisteredActionLike {
  actionKey: string;
  riskLevel: number;
}

/**
 * Fails closed and loudly: throws (crashing startup) rather than allowing
 * the API to boot with a protected operation reachable through the AI
 * Action Registry. Called once, synchronously, from actions/registry.ts
 * immediately after ACTION_REGISTRY is constructed.
 */
export function assertNoProtectedOperationsRegistered(actions: RegisteredActionLike[]): void {
  for (const action of actions) {
    const upperKey = action.actionKey.toUpperCase();
    const hit = FORBIDDEN_ACTION_KEY_FRAGMENTS.find((fragment) => upperKey.includes(fragment));
    if (hit) {
      // The refusal is deliberately fail-closed and deliberately crude: the
      // fragment is matched as a substring of the WHOLE key, so a legitimate
      // draft-for-review action like DRAFT_EMAIL_FOR_REVIEW is refused here
      // too. That is the correct trade — but an engineer who has just hit it
      // needs to be told where the sanctioned path is, not only that this one
      // is closed.
      const isOutboundMessaging = OUTBOUND_MESSAGING_FRAGMENTS.includes(hit);
      throw new Error(
        `AI Action Registry startup check failed: action "${action.actionKey}" matches forbidden fragment "${hit}". ` +
          `Protected operations (Part 3) must never be registered as AI-executable actions.` +
          (isOutboundMessaging
            ? ` Nothing addressed to a real person may leave the building without a human deciding to send it, ` +
              `so there is no riskLevel and no approval flag that makes this registrable. Build it instead as a ` +
              `DRAFT that a human reviews, and dispatch it through the Communications surface's own ` +
              `human-decision path (routes/communications.ts), which enforces consent and suppression. ` +
              `Note that this check matches "${hit}" anywhere in the key, so a draft-only action still has to ` +
              `avoid the fragment in its NAME — e.g. DRAFT_CONTACT_OUTREACH_FOR_REVIEW rather than ` +
              `DRAFT_EMAIL_FOR_REVIEW.`
            : ``),
      );
    }
    if (action.riskLevel >= 4) {
      throw new Error(
        `AI Action Registry startup check failed: action "${action.actionKey}" has riskLevel ${action.riskLevel} ` +
          `(RESTRICTED tier). RESTRICTED-risk actions must never be directly executable by AI (Part 3).`,
      );
    }
  }
}
