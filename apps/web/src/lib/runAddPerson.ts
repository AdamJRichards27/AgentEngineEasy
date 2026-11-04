// t274u R03: Run "+ Add Person" — find and select an existing contact first;
// create a new contact only when none fits. Pure helpers (tested in
// lib/__tests__/runAddPerson.test.ts); the form lives in PropertyWorkspace.tsx.
//
// - Search: POST /parties/search { q } (brokerage scoped; email/mobile masked
//   for callers without contact-read).
// - Select: POST /parties { propertyId, partyId, role } — reuses the contact id.
// - Create: pre-flight POST /parties/duplicate-check, then POST /parties with
//   duplicateGuard "confirm" so the server also refuses a duplicate (409)
//   until "Create anyway" (confirmNewContact: true).
import { duplicatePanel, type DuplicatePanel } from "../minimal/properties/minimalPropertyContactsModel";

export interface DuplicateWarning {
  code: string;
  kind: "email" | "phone" | "name";
  contactId?: number;
}

export interface RunContactSummary {
  id: number;
  partyType: string;
  firstName: string | null;
  lastName: string | null;
  organisationName: string | null;
  email: string | null;
  mobile: string | null;
}

export const RUN_SEARCH_MIN_CHARS = 2;
export const RUN_NO_MATCH_TEXT = "No existing contact matches. Create a new contact below.";

export function runContactName(p: RunContactSummary): string {
  const person = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return person || p.organisationName || `Contact #${p.id}`;
}

export function runContactDetail(p: RunContactSummary): string {
  return [p.email, p.mobile].filter(Boolean).join(" · ");
}

export function shouldSearch(q: string): boolean {
  return q.trim().length >= RUN_SEARCH_MIN_CHARS;
}

/** The duplicate panel for the Run form (Open existing / Create anyway semantics, t261u contract). */
export function runDuplicatePanel(warnings: readonly DuplicateWarning[] | null | undefined, canManageRelationships: boolean): DuplicatePanel | null {
  if (!warnings || warnings.length === 0) return null;
  const withId = warnings.find((w) => typeof w.contactId === "number");
  return duplicatePanel({ status: 409, code: "POTENTIAL_DUPLICATE_CONTACT", contactId: withId?.contactId }, canManageRelationships);
}

export function linkExistingBody(propertyId: number, partyId: number, role: string): { propertyId: number; partyId: number; role: string } {
  return { propertyId, partyId, role };
}

// t275u: one server-side duplicate service blocks every create that matches an existing
// contact; "Create anyway" is an explicit override that needs a recorded reason.
export const OVERRIDE_REASON_MIN = 5;
export const OVERRIDE_REASON_MAX = 500;
export const OVERRIDE_REASON_LABEL = "Reason this is a different person";
export function validOverrideReason(reason: string | null | undefined): boolean {
  const r = (reason ?? "").trim();
  return r.length >= OVERRIDE_REASON_MIN && r.length <= OVERRIDE_REASON_MAX;
}

export function createNewBody(propertyId: number, fields: Record<string, unknown>, overrideReason: string | null = null): Record<string, unknown> {
  const out: Record<string, unknown> = { propertyId, ...fields };
  if (overrideReason !== null && validOverrideReason(overrideReason)) out.duplicateOverride = { reason: overrideReason.trim() };
  return out;
}
