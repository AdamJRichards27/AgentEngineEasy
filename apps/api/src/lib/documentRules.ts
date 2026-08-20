export interface RequiredDocumentRule {
  documentType: string;
  title: string;
}

// Bumped whenever BASE_DOCUMENTS/STATE_DOCUMENTS changes shape in a way
// that affects which documents an already-created DocumentPackage was
// built from — stamped onto DocumentPackage.ruleSetVersion (Phase 5) so a
// package created under an older rule set is traceable, not silently
// reinterpreted as having been produced by the current one.
export const DOCUMENT_RULE_SET_VERSION = 1;

// Required-document determination (Build Brief §9-10, ARCHITECTURE.md §10
// Phase 3/5). This is still a placeholder rule set, now versioned — it
// exists so a DocumentPackage can be created, populated, and tracked
// through the workflow. Real legal/compliance content accuracy review
// against current state legislation has NOT happened; nothing below (or in
// lib/documentTemplates.ts's rendered output) should be treated as
// verified legal content or sent to a real client without review by a
// licensed conveyancer/lawyer.
const BASE_DOCUMENTS: RequiredDocumentRule[] = [
  { documentType: "AgencyAgreement", title: "Exclusive Agency Agreement" },
  { documentType: "AMLConsent", title: "Client Identification & AML Consent" },
];

const STATE_DOCUMENTS: Record<string, RequiredDocumentRule[]> = {
  NSW: [{ documentType: "VendorDisclosure", title: "Vendor Disclosure Statement (NSW)" }],
  VIC: [{ documentType: "VendorStatement", title: "Vendor Statement — Section 32 (VIC)" }],
  QLD: [{ documentType: "SellerDisclosure", title: "Seller Disclosure Statement (QLD)" }],
  SA: [{ documentType: "Form1Disclosure", title: "Form 1 — Vendor's Statement (SA)" }],
  WA: [{ documentType: "VendorStatement", title: "Vendor Disclosure Statement (WA)" }],
  TAS: [{ documentType: "VendorStatement", title: "Vendor Statement (TAS)" }],
  ACT: [{ documentType: "SellerStatement", title: "Seller's Statement — Section 17 (ACT)" }],
  NT: [{ documentType: "VendorStatement", title: "Vendor Disclosure Statement (NT)" }],
};

export function determineRequiredDocuments(state: string | null | undefined): RequiredDocumentRule[] {
  const stateKey = (state ?? "").trim().toUpperCase();
  const stateSpecific = STATE_DOCUMENTS[stateKey] ?? [
    { documentType: "VendorDisclosure", title: "Vendor Disclosure Statement (state to be confirmed)" },
  ];
  return [...BASE_DOCUMENTS, ...stateSpecific];
}
