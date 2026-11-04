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
  kind: "email" | "phone";
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

export function createNewBody(propertyId: number, fields: Record<string, unknown>, confirmed: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { propertyId, ...fields, duplicateGuard: "confirm" };
  if (confirmed) out.confirmNewContact = true;
  return out;
}
