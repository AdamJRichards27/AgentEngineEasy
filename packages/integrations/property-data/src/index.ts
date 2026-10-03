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

/** Suburb, state and postcode taken from a place's address components. */
export interface AddressParts {
  suburb?: string;
  state?: string;
  postcode?: string;
}

function componentText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Reads suburb, state and postcode out of a Place Details `address_components`
 * array. Australian suburbs are usually `locality` (Hamilton, Paddington);
 * `sublocality` covers the addresses Google files the suburb under a
 * neighbourhood instead. State is the short code (`QLD`), which is what
 * document rules match on.
 */
export function addressPartsFromComponents(
  components: ReadonlyArray<{ long_name?: string | null; short_name?: string | null; types?: readonly string[] | null }>,
): AddressParts {
  const find = (type: string) => components.find((component) => component.types?.includes(type));
  const state = find("administrative_area_level_1");
  const postcode = find("postal_code");
  return {
    suburb:
      componentText(find("locality")?.long_name) ??
      componentText(find("sublocality")?.long_name) ??
      componentText(find("postal_town")?.long_name),
    state: componentText(state?.short_name) ?? componentText(state?.long_name),
    postcode: componentText(postcode?.long_name) ?? componentText(postcode?.short_name),
  };
}

export interface OwnershipRecord {
  ownerName: string;
  ownershipType?: string; // e.g. "Individual", "Company", "Trust"
}

export interface PropertyDataProvider {
  searchAddress(query: string): Promise<AddressCandidate[]>;
  lookupOwnership(placeId: string): Promise<OwnershipRecord[] | null>;
  /**
   * Suburb, state and postcode for a place id. Null when this provider has
   * nothing to add. Implementations must not throw: a failed lookup must not
   * block creating the property.
   */
  resolveAddress(placeId: string): Promise<AddressParts | null>;
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

  async resolveAddress(placeId: string): Promise<AddressParts | null> {
    // Local-dev and test seam. searchAddress's own ids are
    // `mock-${encodeURIComponent(query)}`, which encodes ":" and "|", so a
    // suggestion from this provider does not take this path. A client can
    // already POST suburb/state/postcode; this only fills them when the body
    // leaves them out, which is what choosing a Places suggestion does.
    const prefix = "mock-address:";
    if (!placeId.startsWith(prefix)) return null;
    const [suburb, state, postcode] = placeId.slice(prefix.length).split("|");
    const part = (value: string | undefined) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    };
    const parts: AddressParts = { suburb: part(suburb), state: part(state), postcode: part(postcode) };
    if (!parts.suburb && !parts.state && !parts.postcode) return null;
    return parts;
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
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async searchAddress(query: string): Promise<AddressCandidate[]> {
    if (!query.trim()) return [];

    const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
    url.searchParams.set("input", query);
    // Precise addresses only. A street typed without a house number comes
    // back as the street; Google does not suggest numbered premises until
    // the number is in the query, and dropping this filter also returns
    // businesses. That behaviour is left as Google defines it.
    url.searchParams.set("types", "address");
    url.searchParams.set("components", "country:au");
    url.searchParams.set("key", this.apiKey);

    const res = await this.fetchImpl(url.toString());
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

  async resolveAddress(placeId: string): Promise<AddressParts | null> {
    if (!placeId.trim()) return null;
    const parts = await this.fetchAddressComponents(placeId);
    if (!parts.suburb && !parts.state && !parts.postcode) return null;
    return parts;
  }

  private async fetchAddressComponents(placeId: string): Promise<AddressParts> {
    const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    url.searchParams.set("place_id", placeId);
    // Place Details (Legacy) names this field `address_components`. The
    // singular form is not a valid fields value: Google returns no
    // components, and suburb/state/postcode are then empty.
    url.searchParams.set("fields", "address_components");
    url.searchParams.set("key", this.apiKey);

    try {
      const res = await this.fetchImpl(url.toString());
      if (!res.ok) return {};
      const body = (await res.json()) as {
        status?: string;
        result?: {
          address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>;
        };
      };
      if (body.status && body.status !== "OK") return {};
      return addressPartsFromComponents(body.result?.address_components ?? []);
    } catch (err) {
      logger.warn("google_places_address_components_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
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
