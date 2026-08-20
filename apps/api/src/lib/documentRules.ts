export interface RequiredDocumentRule {
  documentType: string;
  title: string;
}

// Required-document determination (Build Brief §9-10, ARCHITECTURE.md §10
// Phase 3). This is a placeholder rule set — it exists so a DocumentPackage
// can be created and tracked through the workflow. The real per-state rule
// engine, template population, and legal/compliance content accuracy review
// are explicitly Phase 5 scope; nothing below has been verified against
// current state legislation and none of it should be treated as such.
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
