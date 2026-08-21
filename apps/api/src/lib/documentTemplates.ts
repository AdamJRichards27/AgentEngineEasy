import { DOCUMENT_RULE_SET_VERSION } from "./documentRules.js";

export interface TemplateContext {
  formattedAddress: string;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  sellerNames: string[];
  agencyTerms?: {
    commissionType: string;
    commissionRateBps: number | null;
    flatFeeCents: number | null;
    marketingFeeCents: number | null;
    agreementTermDays: number;
  } | null;
}

// Every rendered document carries this — Phase 5 builds the template
// population *pipeline*, it does not perform (and cannot substitute for) a
// legal review of AU real estate document content. Anything generated here
// must be reviewed by a licensed conveyancer/lawyer before it is ever sent
// to a real seller for signature.
const DISCLAIMER =
  "*** TEMPLATE PLACEHOLDER — NOT LEGAL ADVICE ***\n" +
  "This document was generated automatically by Agent Engine from an unverified template " +
  `(document rule set v${DOCUMENT_RULE_SET_VERSION}). It has NOT been reviewed for legal or ` +
  "regulatory accuracy against current state legislation. Do not send this to a client for " +
  "signature without review by a licensed conveyancer/lawyer.\n" +
  "---------------------------------------------------------------\n\n";

function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "[amount to be confirmed]";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatCommission(terms: TemplateContext["agencyTerms"]): string {
  if (!terms) return "[commission terms not yet captured]";
  if (terms.commissionType === "FlatFee") {
    return `a flat fee of ${formatMoney(terms.flatFeeCents)}`;
  }
  const pct = terms.commissionRateBps !== null && terms.commissionRateBps !== undefined ? (terms.commissionRateBps / 100).toFixed(2) : null;
  return pct ? `${pct}% of the sale price` : "[commission rate to be confirmed]";
}

function addressLine(ctx: TemplateContext): string {
  return [ctx.formattedAddress, [ctx.suburb, ctx.state, ctx.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function sellerLine(ctx: TemplateContext): string {
  return ctx.sellerNames.length ? ctx.sellerNames.join(", ") : "[seller(s) not yet captured]";
}

const today = () => new Date().toISOString().slice(0, 10);

function agencyAgreementTemplate(ctx: TemplateContext): string {
  return (
    `EXCLUSIVE AGENCY AGREEMENT\n\n` +
    `Property: ${addressLine(ctx)}\n` +
    `Seller(s): ${sellerLine(ctx)}\n` +
    `Date: ${today()}\n\n` +
    `The Seller(s) appoint the Agent as exclusive agent for the sale of the above property.\n\n` +
    `Commission: ${formatCommission(ctx.agencyTerms)}, payable on completion of a sale.\n` +
    `Marketing fee: ${formatMoney(ctx.agencyTerms?.marketingFeeCents ?? null)}.\n` +
    `Term of agreement: ${ctx.agencyTerms?.agreementTermDays ?? "[term not yet captured]"} days from the date above.\n\n` +
    `[Full agency agreement terms and conditions to be inserted — this is a structural placeholder only.]\n`
  );
}

function amlConsentTemplate(ctx: TemplateContext): string {
  return (
    `CLIENT IDENTIFICATION & AML CONSENT\n\n` +
    `Property: ${addressLine(ctx)}\n` +
    `Seller(s): ${sellerLine(ctx)}\n` +
    `Date: ${today()}\n\n` +
    `The above named seller(s) consent to identity verification being conducted for the purposes ` +
    `of anti-money-laundering / counter-terrorism-financing compliance in connection with the sale ` +
    `of the above property.\n\n` +
    `[Full consent text to be inserted — this is a structural placeholder only.]\n`
  );
}

function stateDisclosureTemplate(ctx: TemplateContext, title: string): string {
  return (
    `${title.toUpperCase()}\n\n` +
    `Property: ${addressLine(ctx)}\n` +
    `Seller(s): ${sellerLine(ctx)}\n` +
    `Date: ${today()}\n\n` +
    `[This document type requires state-specific legal content that has not been drafted. ` +
    `Do not use for an actual sale until the real disclosure content for ${ctx.state ?? "the relevant state"} ` +
    `has been reviewed and inserted by a licensed conveyancer/lawyer.]\n`
  );
}

/**
 * Renders placeholder document content for a documentType (Phase 5
 * "template population"). Real formatted output (PDF/DOCX layout) is
 * future scope — this produces the structured text content and proves the
 * generate → store → send pipeline end-to-end.
 */
export function populateTemplate(documentType: string, title: string, ctx: TemplateContext): string {
  let body: string;
  switch (documentType) {
    case "AgencyAgreement":
      body = agencyAgreementTemplate(ctx);
      break;
    case "AMLConsent":
      body = amlConsentTemplate(ctx);
      break;
    default:
      body = stateDisclosureTemplate(ctx, title);
      break;
  }
  return DISCLAIMER + body;
}
