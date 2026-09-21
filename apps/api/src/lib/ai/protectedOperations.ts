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
//
// ---------------------------------------------------------------------------
// WHY THIS IS STILL CRUDE SUBSTRING MATCHING (W2-C remediation, reviewed).
//
// The obvious objection is real and is not disputed: matching fragments as
// substrings of the whole key refuses safe operations too. DRAFT_EMAIL_FOR_-
// REVIEW contains "EMAIL" and is refused, even though drafting for human
// review is precisely the alternative this module tells people to build.
// Replacing the matching with an explicit or canonical operation
// classification was evaluated as part of that review and DELIBERATELY NOT
// DONE, because every version of it is weaker than what is here:
//
//   Any classification scheme -- an `operationClass` field, a declared
//   capability, a canonical operation enum -- is a value the ACTION'S OWN
//   AUTHOR supplies. This module exists precisely because an author-supplied
//   categorisation cannot be trusted: policyEngine.ts already refuses
//   RESTRICTED actions by `riskLevel`, and that only helps if riskLevel is
//   set correctly, which is exactly the mistake this file is the backstop
//   for. Swapping a name-based tripwire the author cannot influence for a
//   declaration the author fills in reintroduces the single point of failure
//   it was built to cover. A miscategorised `operationClass: "INTERNAL"` on
//   a real send action would pass silently, where "SEND" in the name does
//   not.
//
// The cost of keeping it is a NAMING CONSTRAINT, not a lost capability: the
// draft-for-review feature is fully buildable as
// DRAFT_CONTACT_OUTREACH_FOR_REVIEW. Trading a naming constraint for a check
// that trusts nobody is the right side of that trade, so the matching stays
// and the ERROR MESSAGE carries the way forward instead (see
// assertNoProtectedOperationsRegistered below). The false positive is pinned
// as a tested, documented contract in __tests__/governance.test.ts so the
// next engineer meets it as a stated rule with a named alternative rather
// than as a surprise at startup.
//
// What this check does NOT do, stated so it is not mistaken for more than it
// is: it cannot catch an action whose name is innocuous but whose
// implementation sends (CREATE_CONTACT_OUTREACH that calls a provider). That
// is the Policy Engine's and code review's job. This is a tripwire on names,
// and its whole value is that it is dumb and untrusting.
// ---------------------------------------------------------------------------

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
