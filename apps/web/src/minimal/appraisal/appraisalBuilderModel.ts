import { appraisalPricingLockedMessage, appraisalReadOnlyMessage } from "../../lib/appraisalUi";

// AE Minimal A — seven-step Appraisal Builder, manual path.
//
// Source: UX repo a49f7717, artifacts/mockup-sandbox/.../AppraisalBuilder.tsx
// (APPRAISAL_STEPS and handleStepContinue), narrowed by the feasibility
// report v3 §4 pilot scope: no Pricefinder enrichment, no simulated range
// (D2), no distance map or building-area filter (D4: those columns do not
// exist). The builder edits a SERVER appraisal through the existing
// /grow/appraisals routes. It keeps no browser drafts: a draft is a server
// appraisal in DRAFT status. The step-2, step-4 and range-approval
// confirmations are UI-only gates (D7) and are not stored, so a resumed
// appraisal asks for them again.

export interface MinimalAppraisalStep {
  n: number;
  key: "property" | "enrich" | "comparables" | "competition" | "range" | "build" | "save";
  title: string;
  short: string;
  summary: string;
}

export const MINIMAL_APPRAISAL_STEPS: readonly MinimalAppraisalStep[] = [
  { n: 1, key: "property", title: "Select Property", short: "Property", summary: "Confirm the property and the contact this appraisal is for." },
  {
    n: 2,
    key: "enrich",
    title: "Enrich Property",
    short: "Enrich",
    summary: "Check the property facts AE holds. No property-data provider is connected, so nothing is filled in for you.",
  },
  { n: 3, key: "comparables", title: "Review Comparables", short: "Sold comps", summary: "Add the sold evidence that belongs in this appraisal." },
  { n: 4, key: "competition", title: "Review Competition", short: "Competition", summary: "Keep current asking prices separate from sold evidence." },
  { n: 5, key: "range", title: "Establish Appraisal Range", short: "Range", summary: "Enter a range from your evidence, explain it, and approve it yourself." },
  { n: 6, key: "build", title: "Build Appraisal", short: "Preview", summary: "Add market commentary and build the document preview." },
  { n: 7, key: "save", title: "Save and Follow Up", short: "Save", summary: "Book the follow-up. The appraisal is already linked to its contact and property." },
];

export const MINIMAL_APPRAISAL_STEP_COUNT = MINIMAL_APPRAISAL_STEPS.length;

export const APPRAISAL_BUILDER_DISCLAIMER =
  "This is an agent-prepared market appraisal, not a formal valuation or a guaranteed selling price.";

export interface BuilderComparableSale {
  id: number;
  address: string;
  salePrice: string | null;
  saleDate: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  notes: string | null;
}

export interface BuilderCompetitionItem {
  id: number;
  address: string;
  askingPriceDisplay: string | null;
  status: string | null;
  daysOnMarket: number | null;
  notes: string | null;
}

export interface BuilderAppraisal {
  id: number;
  propertyId: number;
  partyId: number | null;
  status: string;
  isFinalised: boolean;
  priceRangeLow: string | null;
  priceRangeHigh: string | null;
  pricingCommentary: string | null;
  marketPositionNarrative: string | null;
  presentationDocumentId: number | null;
  followUpAt: string | null;
}

/** The subset of GET /grow/appraisals/:id the builder reads. */
export interface BuilderWorkspace {
  appraisal: BuilderAppraisal;
  comparableSales: BuilderComparableSale[];
  marketCompetition: BuilderCompetitionItem[];
}

export interface BuilderAttestations {
  propertyFactsConfirmed: boolean;
  competitionReviewed: boolean;
  rangeApproved: boolean;
}

export interface RangeDraft {
  low: string;
  high: string;
  commentary: string;
}

export interface BuilderContext {
  workspace: BuilderWorkspace;
  attest: BuilderAttestations;
  rangeDraft: RangeDraft;
}

export interface BuilderState {
  step: number;
  highestStep: number;
}

export const NO_ATTESTATIONS: BuilderAttestations = {
  propertyFactsConfirmed: false,
  competitionReviewed: false,
  rangeApproved: false,
};

export const RANGE_RATIONALE_MIN = 20;

export function initialBuilderState(): BuilderState {
  return { step: 1, highestStep: 1 };
}

/** Whole-appraisal lock, or the pricing lock once finalised. Null when editable. */
export function builderReadOnlyMessage(appraisal: Pick<BuilderAppraisal, "status" | "isFinalised">): string | null {
  return appraisalReadOnlyMessage(appraisal) ?? appraisalPricingLockedMessage(appraisal);
}

/** Null when the agent may continue past `step`; otherwise the reason. */
export function builderStepGate(step: number, ctx: BuilderContext): string | null {
  const { workspace, attest, rangeDraft } = ctx;
  const appraisal = workspace.appraisal;
  if (step === 1) {
    return appraisal.propertyId ? null : "Choose a property before continuing.";
  }
  if (step === 2) {
    return attest.propertyFactsConfirmed
      ? null
      : "Confirm you have checked the property facts. AE has no property-data provider connected, so check them against your own records.";
  }
  if (step === 3) {
    return workspace.comparableSales.length > 0
      ? null
      : "Add at least one relevant sold comparable with a verified sale price and date.";
  }
  if (step === 4) {
    return attest.competitionReviewed
      ? null
      : "Confirm you have reviewed the current competition, even if there are no listings to add.";
  }
  if (step === 5) {
    const invalid = rangeValidation(rangeDraft);
    if (invalid) return invalid;
    if (!rangeIsSaved(rangeDraft, appraisal)) return "Save the range and explanation before continuing.";
    if (!attest.rangeApproved) return "Only you can approve this range. Review it, then select Approve range.";
    return null;
  }
  if (step === 6) {
    return appraisal.presentationDocumentId != null ? null : "Build the document preview before continuing.";
  }
  return null;
}

export function continueBuilder(state: BuilderState, ctx: BuilderContext): { state: BuilderState; message: string | null } {
  if (state.step >= MINIMAL_APPRAISAL_STEP_COUNT) return { state, message: null };
  const readOnly = appraisalReadOnlyMessage(ctx.workspace.appraisal) !== null;
  const message = readOnly ? null : builderStepGate(state.step, ctx);
  if (message) return { state, message };
  const step = state.step + 1;
  return { state: { step, highestStep: Math.max(state.highestStep, step) }, message: null };
}

export function goToBuilderStep(state: BuilderState, step: number): BuilderState {
  if (!Number.isInteger(step) || step < 1 || step > state.highestStep) return state;
  return { ...state, step };
}

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

/** "$1,250,000" -> 1250000. Null for blank, non-numeric, zero or negative. */
export function parseMoney(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!MONEY_PATTERN.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function moneyString(value: number): string {
  return String(value);
}

export function rangeValidation(draft: RangeDraft): string | null {
  const low = parseMoney(draft.low);
  const high = parseMoney(draft.high);
  if (low === null) return "Enter a low price for the range.";
  if (high === null) return "Enter a high price for the range.";
  if (low > high) return "The low price must not be higher than the high price.";
  if (draft.commentary.trim().length < RANGE_RATIONALE_MIN) {
    return `Explain the range from your evidence in at least ${RANGE_RATIONALE_MIN} characters.`;
  }
  return null;
}

export function rangePatchBody(draft: RangeDraft): { priceRangeLow: string; priceRangeHigh: string; pricingCommentary: string } | null {
  if (rangeValidation(draft)) return null;
  return {
    priceRangeLow: moneyString(parseMoney(draft.low)!),
    priceRangeHigh: moneyString(parseMoney(draft.high)!),
    pricingCommentary: draft.commentary.trim(),
  };
}

function storedNumber(value: string | null): number | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function rangeDraftFrom(appraisal: Pick<BuilderAppraisal, "priceRangeLow" | "priceRangeHigh" | "pricingCommentary">): RangeDraft {
  const low = storedNumber(appraisal.priceRangeLow);
  const high = storedNumber(appraisal.priceRangeHigh);
  return {
    low: low === null ? "" : moneyString(low),
    high: high === null ? "" : moneyString(high),
    commentary: appraisal.pricingCommentary ?? "",
  };
}

export function rangeIsSaved(
  draft: RangeDraft,
  appraisal: Pick<BuilderAppraisal, "priceRangeLow" | "priceRangeHigh" | "pricingCommentary">,
): boolean {
  return (
    parseMoney(draft.low) === storedNumber(appraisal.priceRangeLow) &&
    parseMoney(draft.high) === storedNumber(appraisal.priceRangeHigh) &&
    draft.commentary.trim() === (appraisal.pricingCommentary ?? "").trim()
  );
}

type BodyResult<T> = { ok: true; body: T } | { ok: false; error: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validIsoDate(text: string): boolean {
  const m = ISO_DATE.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function optionalInt(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false };
  return { ok: true, value: Number(t) };
}

function optionalText(text: string): string | null {
  const t = text.trim();
  return t.length > 0 ? t : null;
}

export interface ComparableForm {
  address: string;
  salePrice: string;
  saleDate: string;
  bedrooms: string;
  bathrooms: string;
  carSpaces: string;
  landSizeSqm: string;
  propertyType: string;
  notes: string;
}

export const EMPTY_COMPARABLE_FORM: ComparableForm = {
  address: "",
  salePrice: "",
  saleDate: "",
  bedrooms: "",
  bathrooms: "",
  carSpaces: "",
  landSizeSqm: "",
  propertyType: "",
  notes: "",
};

/** Body for the existing POST /grow/appraisals/:id/comparable-sales. */
export function comparableBody(form: ComparableForm): BodyResult<{
  address: string;
  salePrice: string;
  saleDate: string;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  landSizeSqm: string | null;
  propertyType: string | null;
  notes: string;
  source: "manual";
}> {
  const address = form.address.trim();
  if (!address) return { ok: false, error: "Enter the sold property's address." };
  const price = parseMoney(form.salePrice);
  if (price === null) return { ok: false, error: "Enter the verified sale price." };
  const saleDate = form.saleDate.trim();
  if (!validIsoDate(saleDate)) return { ok: false, error: "Enter the sale date." };
  const beds = optionalInt(form.bedrooms);
  const baths = optionalInt(form.bathrooms);
  const cars = optionalInt(form.carSpaces);
  if (!beds.ok || !baths.ok || !cars.ok) return { ok: false, error: "Bedrooms, bathrooms and car spaces must be whole numbers." };
  const land = form.landSizeSqm.trim().replace(/,/g, "");
  if (land !== "" && !MONEY_PATTERN.test(land)) return { ok: false, error: "Land area must be a number of square metres." };
  const notes = form.notes.trim();
  if (!notes) return { ok: false, error: "Say why this sale is relevant to the property." };
  return {
    ok: true,
    body: {
      address,
      salePrice: moneyString(price),
      saleDate,
      bedrooms: beds.value,
      bathrooms: baths.value,
      carSpaces: cars.value,
      landSizeSqm: land === "" ? null : land,
      propertyType: optionalText(form.propertyType),
      notes,
      source: "manual",
    },
  };
}

export interface CompetitionForm {
  address: string;
  askingPriceDisplay: string;
  askingPriceLow: string;
  askingPriceHigh: string;
  status: string;
  daysOnMarket: string;
  notes: string;
}

export const EMPTY_COMPETITION_FORM: CompetitionForm = {
  address: "",
  askingPriceDisplay: "",
  askingPriceLow: "",
  askingPriceHigh: "",
  status: "",
  daysOnMarket: "",
  notes: "",
};

/** Body for the existing POST /grow/appraisals/:id/market-competition. */
export function competitionBody(form: CompetitionForm): BodyResult<{
  address: string;
  askingPriceDisplay: string | null;
  askingPriceLow: string | null;
  askingPriceHigh: string | null;
  status: string | null;
  daysOnMarket: number | null;
  notes: string | null;
  source: "manual";
}> {
  const address = form.address.trim();
  if (!address) return { ok: false, error: "Enter the listing's address." };
  const lowText = form.askingPriceLow.trim();
  const highText = form.askingPriceHigh.trim();
  const low = lowText ? parseMoney(lowText) : null;
  const high = highText ? parseMoney(highText) : null;
  if ((lowText && low === null) || (highText && high === null)) return { ok: false, error: "Asking prices must be amounts in dollars." };
  if (low !== null && high !== null && low > high) return { ok: false, error: "The low asking price must not be higher than the high one." };
  const dom = optionalInt(form.daysOnMarket);
  if (!dom.ok) return { ok: false, error: "Days on market must be a whole number." };
  return {
    ok: true,
    body: {
      address,
      askingPriceDisplay: optionalText(form.askingPriceDisplay),
      askingPriceLow: low === null ? null : moneyString(low),
      askingPriceHigh: high === null ? null : moneyString(high),
      status: optionalText(form.status),
      daysOnMarket: dom.value,
      notes: optionalText(form.notes),
      source: "manual",
    },
  };
}

/** Brisbane is UTC+10 all year (Queensland has no daylight saving). */
const BRISBANE_OFFSET_HOURS = 10;
const DEFAULT_FOLLOW_UP_TIME = "09:00";

export function followUpBody(input: { date: string; time: string; notes: string }): BodyResult<{
  followUpAt: string;
  followUpNotes: string | null;
}> {
  const date = input.date.trim();
  if (!validIsoDate(date)) return { ok: false, error: "Choose a follow-up date." };
  const time = input.time.trim() || DEFAULT_FOLLOW_UP_TIME;
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) return { ok: false, error: "Enter the time as HH:MM." };
  const [y, mo, d] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(y, mo - 1, d, Number(tm[1]) - BRISBANE_OFFSET_HOURS, Number(tm[2])));
  return { ok: true, body: { followUpAt: instant.toISOString(), followUpNotes: optionalText(input.notes) } };
}

export function builderPath(appraisalId: number): string {
  return `/grow/appraisals/${appraisalId}/build`;
}

/** Route selector for WS3: the builder renders only inside the Minimal shell. */
export function selectAppraisalBuilderView(minimalShell: boolean): "minimal" | "classic" {
  return minimalShell ? "minimal" : "classic";
}
