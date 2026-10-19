// WS4-12: the API's property-data provider, built through the restored-environment outbound guard.
//
// routes/properties.ts used to call the package factory directly, so GooglePlacesProvider (a network adapter: it calls
// maps.googleapis.com through its injected fetchImpl) was the one outbound transport WS4-09/11 could not guard.
// The package factory's own selection rules (PROPERTY_DATA_PROVIDER, production pilot lock, missing key -> mock) are
// unchanged; this only wraps the result. In a restored environment (AEE_RESTORED_ENVIRONMENT) the network methods
// searchAddress/resolveAddress of a network or unclassified provider reject with RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED
// (HTTP 503 via middlewares/errorHandler.ts) unless `property_data:google-places` is in AEE_RESTORED_ENV_OUTBOUND_ALLOW.
// The in-process mock is allowed. lookupOwnership makes no network call in either adapter and is not wrapped.
import {
  createPropertyDataProvider,
  GooglePlacesProvider,
  MockPropertyDataProvider,
  type PropertyDataProvider,
} from "@aee/integration-property-data";
import { guardOutboundProvider } from "./outboundGuard.js";

/** The package adapters carry no name, so the seam names them (anything else is unclassified = network). */
export function propertyDataProviderId(p: object): string {
  return p instanceof MockPropertyDataProvider ? "mock" : p instanceof GooglePlacesProvider ? "google-places" : "unclassified";
}

export function createGuardedPropertyDataProvider(): PropertyDataProvider {
  return guardOutboundProvider("property_data", createPropertyDataProvider(), ["searchAddress", "resolveAddress"], propertyDataProviderId);
}
