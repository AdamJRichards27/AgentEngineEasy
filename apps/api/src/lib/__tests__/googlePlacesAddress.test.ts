// D3 — Place Details address components become suburb, state and postcode.
// The fields parameter is the plural `address_components`; the singular form
// returns no components. No test here calls Google.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GooglePlacesProvider,
  MockPropertyDataProvider,
  addressPartsFromComponents,
} from "@aee/integration-property-data";

const HAMILTON = [
  { long_name: "300", short_name: "300", types: ["street_number"] },
  { long_name: "Racecourse Road", short_name: "Racecourse Rd", types: ["route"] },
  { long_name: "Hamilton", short_name: "Hamilton", types: ["locality", "political"] },
  { long_name: "Brisbane City", short_name: "Brisbane", types: ["administrative_area_level_2", "political"] },
  { long_name: "Queensland", short_name: "QLD", types: ["administrative_area_level_1", "political"] },
  { long_name: "Australia", short_name: "AU", types: ["country", "political"] },
  { long_name: "4007", short_name: "4007", types: ["postal_code"] },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("address components prefer locality, then sublocality, and the state short code", () => {
  assert.deepEqual(addressPartsFromComponents(HAMILTON), { suburb: "Hamilton", state: "QLD", postcode: "4007" });
  assert.deepEqual(
    addressPartsFromComponents([
      { long_name: "Paddington", short_name: "Paddington", types: ["sublocality_level_1", "sublocality", "political"] },
      { long_name: "Queensland", short_name: "QLD", types: ["administrative_area_level_1", "political"] },
      { long_name: "4064", short_name: "4064", types: ["postal_code"] },
    ]),
    { suburb: "Paddington", state: "QLD", postcode: "4064" },
  );
  assert.equal(
    addressPartsFromComponents([
      { long_name: "Sydney", short_name: "Sydney", types: ["locality", "political"] },
      { long_name: "Paddington", short_name: "Paddington", types: ["sublocality", "political"] },
    ]).suburb,
    "Sydney",
  );
  assert.deepEqual(addressPartsFromComponents([]), { suburb: undefined, state: undefined, postcode: undefined });
  assert.equal(addressPartsFromComponents([{ long_name: "  ", short_name: "  ", types: ["locality"] }]).suburb, undefined);
});

test("the mock resolves only an explicit mock-address place id", async () => {
  const provider = new MockPropertyDataProvider();
  assert.deepEqual(await provider.resolveAddress("mock-address:Hamilton|QLD|4007"), {
    suburb: "Hamilton",
    state: "QLD",
    postcode: "4007",
  });
  assert.deepEqual(await provider.resolveAddress("mock-address:||4007"), { suburb: undefined, state: undefined, postcode: "4007" });
  assert.equal(await provider.resolveAddress(`mock-${encodeURIComponent("300 Racecourse Road")}`), null);
  assert.equal(await provider.resolveAddress("ChIJhamilton"), null);
  assert.equal(await provider.resolveAddress("mock-address:||"), null);
});

test("Google Place Details is requested as address_components and mapped onto the suggestion", async () => {
  const calls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith("/autocomplete/json")) {
      return jsonResponse({
        status: "OK",
        predictions: [{ place_id: "ChIJhamilton", description: "300 Racecourse Road, Hamilton QLD, Australia" }],
      });
    }
    assert.equal(url.searchParams.get("fields"), "address_components");
    assert.equal(url.searchParams.get("place_id"), "ChIJhamilton");
    return jsonResponse({ status: "OK", result: { address_components: HAMILTON } });
  };
  const provider = new GooglePlacesProvider("test-key", fetchImpl);
  const candidates = await provider.searchAddress("300 Racecourse Road Hamilton");
  assert.deepEqual(candidates, [
    {
      placeId: "ChIJhamilton",
      formattedAddress: "300 Racecourse Road, Hamilton QLD, Australia",
      suburb: "Hamilton",
      state: "QLD",
      postcode: "4007",
    },
  ]);
  assert.equal(calls[0]?.searchParams.get("types"), "address");
  assert.deepEqual(await provider.resolveAddress("ChIJhamilton"), { suburb: "Hamilton", state: "QLD", postcode: "4007" });
});

test("a Place Details failure still returns the suggestion and resolveAddress returns null", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/autocomplete/json")) {
      return jsonResponse({
        status: "OK",
        predictions: [{ place_id: "ChIJbroken", description: "120 Given Terrace, Paddington QLD, Australia" }],
      });
    }
    if (url.searchParams.get("place_id") === "ChIJhttp") return jsonResponse({ status: "OK" }, 500);
    if (url.searchParams.get("place_id") === "ChIJthrow") throw new Error("network down");
    return jsonResponse({ status: "INVALID_REQUEST" });
  };
  const provider = new GooglePlacesProvider("test-key", fetchImpl);
  const candidates = await provider.searchAddress("120 Given Terrace");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.formattedAddress, "120 Given Terrace, Paddington QLD, Australia");
  assert.equal(candidates[0]?.suburb, undefined);
  assert.equal(candidates[0]?.postcode, undefined);
  assert.equal(await provider.resolveAddress("ChIJbroken"), null);
  assert.equal(await provider.resolveAddress("ChIJhttp"), null);
  assert.equal(await provider.resolveAddress("ChIJthrow"), null);
  assert.equal(await provider.resolveAddress("   "), null);
});
