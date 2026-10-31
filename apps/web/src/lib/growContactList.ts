// GET /grow/contacts list payload and the contact role vocabulary, shared by
// the AE Minimal contact list. GROW_CONTACT_ROLES mirrors the same-named array
// in packages/db/src/schema/contacts.ts (and the classic filter in
// pages/Grow.tsx); minimalContacts.test.ts fails if any of the three drift.

export const GROW_CONTACT_ROLES = [
  "Prospect",
  "PastClient",
  "CurrentClient",
  "Seller",
  "Buyer",
  "Landlord",
  "Tenant",
  "Investor",
  "PropertyOwner",
  "AppraisalProspect",
  "ReferralSource",
  "ProfessionalPartner",
  "Other",
] as const;

export interface GrowContactListItem {
  id: number;
  displayName: string;
  partyType: string;
  email: string | null;
  mobile: string | null;
  roles: string[];
  relatedPropertyCount: number;
}

export type GrowContactListPage = {
  contacts: GrowContactListItem[];
  nextCursor?: string | null;
  total?: number;
};
