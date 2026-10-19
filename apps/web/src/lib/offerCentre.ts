// #34 slice 2 — read-only Offer Centre client for GET /api/offers/centre.
// The API already omits share tokens and buyer contact details; the view
// model below is a second whitelist so a future API field cannot reach the
// page by accident.
import { apiFetch } from "./api";

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
