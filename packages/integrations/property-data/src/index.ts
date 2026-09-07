// Provider abstraction (Build Brief §18-19). Route/UI code depends only on
// this interface, never on a specific provider — swapping providers later
// is a factory config change, not a redesign.

import { logger } from "@aee/events";

export interface AddressCandidate {
  placeId: string;
  formattedAddress: string;
  suburb?: string;
  state?: string;
  postcode?: string;
}

export interface OwnershipRecord {
  ownerName: string;
  ownershipType?: string; // e.g. "Individual", "Company", "Trust"
}

export interface PropertyDataProvider {
  searchAddress(query: string): Promise<AddressCandidate[]>;
  lookupOwnership(placeId: string): Promise<OwnershipRecord[] | null>;
}

/**
 * Ships by default so the app runs end-to-end with no credentials.
 * Swap for a real Google Places / Pricefinder-equivalent adapter behind the
 * same interface — see ARCHITECTURE.md §5, §7.
 */
export class MockPropertyDataProvider implements PropertyDataProvider {
  async searchAddress(query: string): Promise<AddressCandidate[]> {
    if (!query.trim()) return [];
    // Return a couple of plausible variants so the multi-candidate UI
    // (Build Brief §3 — "Not this address? → Create New Address") has
    // something real to render against without live credentials.
    return [
      {
        placeId: `mock-${encodeURIComponent(query)}`,
        formattedAddress: query,
        state: undefined,
      },
    ];
  }

  async lookupOwnership(_placeId: string): Promise<OwnershipRecord[] | null> {
    return null; // no ownership data available — caller must not hard-block on this
  }
}

/**
 * Real address search via the Google Places API (Phase 2 — Build Brief §3,
 * ARCHITECTURE.md §10). Google Places has no title/ownership data, so
 * lookupOwnership() intentionally returns null here too — ownership is a
 * separate concern (e.g. a state title-search provider) that can be wired
 * in later behind this same interface without touching calling code.
 */
export class GooglePlacesProvider implements PropertyDataProvider {
  constructor(private readonly apiKey: string) {}

  async searchAddress(query: string): Promise<AddressCandidate[]> {
    if (!query.trim()) return [];

    const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
    url.searchParams.set("input", query);
    url.searchParams.set("types", "address");
    url.searchParams.set("components", "country:au");
    url.searchParams.set("key", this.apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Google Places autocomplete failed: ${res.status}`);
    }
    const body = (await res.json()) as {
      status: string;
      predictions?: Array<{ place_id: string; description: string }>;
    };

    if (body.status !== "OK" && body.status !== "ZERO_RESULTS") {
      throw new Error(`Google Places autocomplete returned status=${body.status}`);
    }

    const predictions = body.predictions ?? [];
    // Autocomplete predictions don't break out suburb/state/postcode —
    // resolve those via Place Details for each candidate.
    return Promise.all(
      predictions.map(async (p) => {
        const parsed = await this.fetchAddressComponents(p.place_id);
        return {
          placeId: p.place_id,
          formattedAddress: p.description,
          ...parsed,
        };
      }),
    );
  }

  private async fetchAddressComponents(
    placeId: string,
  ): Promise<{ suburb?: string; state?: string; postcode?: string }> {
    const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    url.searchParams.set("place_id", placeId);
    url.searchParams.set("fields", "address_component");
    url.searchParams.set("key", this.apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) return {};
    const body = (await res.json()) as {
      result?: { address_components?: Array<{ long_name: string; short_name: string; types: string[] }> };
    };
    const components = body.result?.address_components ?? [];
    const find = (type: string) => components.find((c) => c.types.includes(type));

    return {
      suburb: find("locality")?.long_name ?? find("sublocality")?.long_name,
      state: find("administrative_area_level_1")?.short_name,
      postcode: find("postal_code")?.long_name,
    };
  }

  async lookupOwnership(_placeId: string): Promise<OwnershipRecord[] | null> {
    return null; // not available via Google Places — see class doc comment
  }
}

// Critical Blocker Remediation, Phase 10 — external-action lock. Same check
// (and same reasoning for why it's repeated locally rather than imported)
// as packages/integrations/payments/src/index.ts's own
// mustForceMockExternalProvider() — see that file's comment and
// docs/gate-evidence/PHASE10_BILLING_AND_EXTERNAL_ACTION_LOCKS.md.
function mustForceMockExternalProvider(): boolean {
  return process.env.NODE_ENV === "production" && process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED !== "true";
}

export function createPropertyDataProvider(): PropertyDataProvider {
  const provider = process.env.PROPERTY_DATA_PROVIDER ?? "mock";
  switch (provider) {
    case "google-places": {
      if (mustForceMockExternalProvider()) {
        logger.warn("property_data_provider_locked_to_mock_pilot_policy", {
          reason:
            "PROPERTY_DATA_PROVIDER=google-places was requested but LIVE_EXTERNAL_TRANSACTIONS_APPROVED is not \"true\" in production — no real property-data action is authorised for this pilot.",
        });
        return new MockPropertyDataProvider();
      }
      const apiKey = process.env.GOOGLE_PLACES_API_KEY;
      if (!apiKey) {
        logger.warn("property_data_provider_fallback_to_mock", {
          reason: "PROPERTY_DATA_PROVIDER=google-places but GOOGLE_PLACES_API_KEY is unset",
        });
        return new MockPropertyDataProvider();
      }
      return new GooglePlacesProvider(apiKey);
    }
    case "mock":
    default:
      return new MockPropertyDataProvider();
    // case "pricefinder": return new PricefinderProvider(...);
  }
}
