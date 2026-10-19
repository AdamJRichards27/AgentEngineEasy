// #34 slice 2 — read-only Offer Centre client for GET /api/offers/centre.
// The API already omits share tokens and buyer contact details; the view
// model below is a second whitelist so a future API field cannot reach the
// page by accident.
import { ApiError, apiErrorMessage, apiFetch, formatSupportReference } from "./api";

export const OFFER_CENTRE_STATUSES = ["Received", "Accepted", "Declined", "Withdrawn"] as const;
export type OfferCentreStatus = (typeof OFFER_CENTRE_STATUSES)[number];
export const OFFER_CENTRE_PAGE_SIZE = 25;

export interface OfferCentreApiRow {
  id: number;
  propertyId: number;
  propertyAddress: string;
  buyerPartyId: number | null;
  buyerName: string | null;
  offerPriceCents: number;
  status: string;
  conditions: unknown;
  createdAt: string;
}

export interface OfferCentreResponse {
  offers: OfferCentreApiRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface OfferCentreView {
  id: number;
  propertyId: number;
  propertyAddress: string;
  buyerName: string | null;
  offerPriceCents: number;
  status: string;
  createdAt: string;
}

export interface OfferCentreFilters {
  status: OfferCentreStatus | "";
  propertyId: string;
  page: number;
}

export function buildOfferCentrePath(filters: OfferCentreFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.propertyId) params.set("propertyId", filters.propertyId);
  params.set("limit", String(OFFER_CENTRE_PAGE_SIZE));
  params.set("offset", String(Math.max(0, filters.page) * OFFER_CENTRE_PAGE_SIZE));
  return `/offers/centre?${params.toString()}`;
}

export function toOfferCentreView(row: OfferCentreApiRow): OfferCentreView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyAddress: row.propertyAddress,
    buyerName: row.buyerName,
    offerPriceCents: row.offerPriceCents,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export function offerCentrePaging(input: { total: number; limit: number; offset: number }): {
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
} {
  if (input.total === 0) return { from: 0, to: 0, hasPrev: false, hasNext: false };
  return {
    from: input.offset + 1,
    to: Math.min(input.offset + input.limit, input.total),
    hasPrev: input.offset > 0,
    hasNext: input.offset + input.limit < input.total,
  };
}

// Same four pill tones as the rest of the app (see lib/financial.ts).
export function offerStatusPillClass(status: string): string {
  if (status === "Accepted") return "pill pill-success";
  if (status === "Received") return "pill pill-warning";
  return "pill";
}

export function fetchOfferCentre(filters: OfferCentreFilters): Promise<OfferCentreResponse> {
  return apiFetch<OfferCentreResponse>(buildOfferCentrePath(filters));
}

// #34 slice 4 — Buyers tab over GET /api/offers/buyers. Names only; the
// view whitelist drops anything else a future API field might add.
export interface BuyerListApiRow {
  linkId: number;
  partyId: number;
  buyerName: string | null;
  propertyId: number;
  propertyAddress: string;
  linkedAt: string;
  offerCount: number;
}

export interface BuyerListResponse {
  buyers: BuyerListApiRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface BuyerView {
  linkId: number;
  buyerName: string | null;
  propertyId: number;
  propertyAddress: string;
  linkedAt: string;
  offerCount: number;
}

export interface BuyerListFilters {
  propertyId: string;
  page: number;
}

export function buildBuyerListPath(filters: BuyerListFilters): string {
  const params = new URLSearchParams();
  if (filters.propertyId) params.set("propertyId", filters.propertyId);
  params.set("limit", String(OFFER_CENTRE_PAGE_SIZE));
  params.set("offset", String(Math.max(0, filters.page) * OFFER_CENTRE_PAGE_SIZE));
  return `/offers/buyers?${params.toString()}`;
}

export function toBuyerView(row: BuyerListApiRow): BuyerView {
  return {
    linkId: row.linkId,
    buyerName: row.buyerName,
    propertyId: row.propertyId,
    propertyAddress: row.propertyAddress,
    linkedAt: row.linkedAt,
    offerCount: row.offerCount,
  };
}

export function fetchBuyerList(filters: BuyerListFilters): Promise<BuyerListResponse> {
  return apiFetch<BuyerListResponse>(buildBuyerListPath(filters));
}

// R-05 — loading, error and empty states shared by the Offers list and the
// Buyers tab. Error copy is the ApiError's friendly text (never the raw
// technical message) plus the short support reference when the server sent
// a correlation id; anything else falls back to a fixed sentence.
export type OfferCentreKind = "offers" | "buyers";
export type OfferCentreRegionState = "loading" | "error" | "empty" | "ready";

export function offerCentreRegionState(
  query: { isLoading: boolean; isError: boolean },
  rowCount: number | null | undefined,
): OfferCentreRegionState {
  if (query.isError) return "error";
  if (query.isLoading || rowCount == null) return "loading";
  return rowCount === 0 ? "empty" : "ready";
}

export function offerCentreEmptyMessage(kind: OfferCentreKind, filtered: boolean): string {
  if (kind === "offers")
    return filtered
      ? "No offers match these filters."
      : "No offers yet. Offers recorded on a property's Transaction panel appear here.";
  return filtered
    ? "No buyers match these filters."
    : "No buyers yet. Buyers linked to a property appear here.";
}

export function offerCentreErrorText(
  error: unknown,
  kind: OfferCentreKind,
): { message: string; reference?: string } {
  const message = apiErrorMessage(error, `Couldn't load ${kind}. Try again.`);
  const reference = error instanceof ApiError ? formatSupportReference(error.correlationId) : undefined;
  return reference ? { message, reference } : { message };
}
