// G-UAT-7 — Getting started on Grow Today.
//
// Done/not-done comes from GET /grow/today's firstRun block, which the API
// derives from rows the caller can already see. This module only decides
// which existing control to offer. It does not store a dismissal, a
// preference, or a completed step.

import type { GrowTodayFirstRun } from "./growToday";

export type GrowFirstRunSection = "contacts" | "opportunities";

export interface GrowFirstRunStep {
  id: keyof GrowTodayFirstRun;
  title: string;
  hint: string;
  done: boolean;
  /** The existing control's label. Null when this caller does not hold its key. */
  actionLabel: string | null;
  section: GrowFirstRunSection;
  /** Alternate for the contact step. Null without grow.import.execute. */
  importHref: "/grow/import" | null;
  /** False when no action this caller can take is left to show. */
  available: boolean;
}

export function growFirstRunIncomplete(flags: GrowTodayFirstRun | null | undefined): boolean {
  if (!flags) return false;
  return (
    !flags.contact ||
    !flags.propertyLink ||
    !flags.activity ||
    !flags.commitment ||
    !flags.opportunity ||
    !flags.appraisal
  );
}

/**
 * One step per UAT action. The button opens the tab that already holds the
 * control (New contact, Link property, Add note, Add commitment, New
 * opportunity, Start appraisal). Import is an alternate on the contact step,
 * not a seventh step that has to be finished: a brokerage that adds contacts
 * by hand would otherwise keep the checklist forever.
 */
export function growFirstRunSteps(
  flags: GrowTodayFirstRun,
  hasEntitlement: (key: string) => boolean,
): GrowFirstRunStep[] {
  const canAddContact = hasEntitlement("grow.contacts.manage");
  const canImport = hasEntitlement("grow.import.execute");
  const canLink = hasEntitlement("grow.properties.link") && hasEntitlement("grow.relationships.manage");
  const canRecord = hasEntitlement("grow.activities.manage");
  const canOpportunities = hasEntitlement("grow.opportunities.manage");
  const canAppraise = hasEntitlement("grow.access") && canOpportunities;

  return [
    {
      id: "contact",
      title: "Add a contact",
      hint: "On the Contacts tab, choose New contact.",
      done: flags.contact,
      actionLabel: canAddContact ? "New contact" : null,
      section: "contacts",
      importHref: canImport ? "/grow/import" : null,
      available: canAddContact || canImport,
    },
    {
      id: "propertyLink",
      title: "Link a property to a contact",
      hint: "Open a contact, then choose Link property.",
      done: flags.propertyLink,
      actionLabel: canLink ? "Link property" : null,
      section: "contacts",
      importHref: null,
      available: canLink,
    },
    {
      id: "activity",
      title: "Log an activity or conversation",
      hint: "On the Opportunities tab, or on a contact's opportunities, choose Add note on the row.",
      done: flags.activity,
      actionLabel: canRecord ? "Add note" : null,
      section: "opportunities",
      importHref: null,
      available: canRecord,
    },
    {
      id: "commitment",
      title: "Create a commitment / follow-up",
      hint: "Open a contact, then choose Add commitment.",
      done: flags.commitment,
      actionLabel: canRecord ? "Add commitment" : null,
      section: "contacts",
      importHref: null,
      available: canRecord,
    },
    {
      id: "opportunity",
      title: "Create an opportunity",
      hint: "On the Opportunities tab, choose New opportunity.",
      done: flags.opportunity,
      actionLabel: canOpportunities ? "New opportunity" : null,
      section: "opportunities",
      importHref: null,
      available: canOpportunities,
    },
    {
      id: "appraisal",
      title: "Start an appraisal",
      hint: "Open an opportunity, or a contact with a linked property, then choose Start appraisal.",
      done: flags.appraisal,
      actionLabel: canAppraise ? "Start appraisal" : null,
      section: "opportunities",
      importHref: null,
      available: canAppraise,
    },
  ];
}
