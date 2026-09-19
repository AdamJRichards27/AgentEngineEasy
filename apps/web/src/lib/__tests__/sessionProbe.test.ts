import assert from "node:assert/strict";
import test from "node:test";
import { classifySessionProbe, isApiUnreachableError } from "../sessionProbe";
import { ApiError, NETWORK_ERROR_MESSAGE } from "../api";

// AE GROW Pilot Readiness WP8 — D-web-2: the initial GET /auth/me probe must
// tell "no session" apart from "the API never answered", so a hard reload
// against a down API shows a connectivity state instead of the sign-in form.

test("the first load, before any answer, is still just loading", () => {
  assert.equal(classifySessionProbe({ isLoading: true, hasUser: false }), "loading");
  assert.equal(classifySessionProbe({ isLoading: true, hasUser: false, error: null }), "loading");
});

test("a resolved session is signed in", () => {
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: true }), "signed-in");
  // A background refetch does not blank a session that is already in hand.
  assert.equal(classifySessionProbe({ isLoading: true, hasUser: true }), "signed-in");
});

test("a 401 from a reachable API is the genuine signed-out path, unchanged", () => {
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: false, error: { status: 401 } }), "signed-out");
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: false, error: { status: 403 } }), "signed-out");
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: false, error: { status: 404 } }), "signed-out");
  // A 500 the API itself authored (it said what went wrong) is a broken API,
  // not an unreachable one, and keeps its existing treatment.
  assert.equal(
    classifySessionProbe({ isLoading: false, hasUser: false, error: { status: 500, serverMessage: "Something went wrong." } }),
    "signed-out",
  );
  // No error and no user (e.g. a cleared cache) is signed out, not offline.
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: false }), "signed-out");
});

test("apiFetch's own no-response error (status 0) is a connectivity state, not sign-in", () => {
  const networkError = new ApiError(0, NETWORK_ERROR_MESSAGE, "API /auth/me failed: network error");
  assert.equal(isApiUnreachableError(networkError), true);
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: false, error: networkError }), "api-unreachable");
});

test("a proxy answering for a down API (502/503/504) is also a connectivity state", () => {
  for (const status of [502, 503, 504]) {
    assert.equal(classifySessionProbe({ isLoading: false, hasUser: false, error: { status } }), "api-unreachable", String(status));
  }
});

test("an empty-bodied 5xx is a hop in front of the API, not the API — e.g. Vite's dev proxy", () => {
  // Measured behaviour: with its target refusing the connection, Vite's dev
  // proxy answers /api/auth/me with 500 and an empty body. The API itself
  // always sends `{ "error": "…" }`, so "5xx with no server message" is a
  // reliable "the API never answered".
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: false, error: { status: 500 } }), "api-unreachable");
  assert.equal(isApiUnreachableError({ status: 500, serverMessage: "" }), true);
  assert.equal(isApiUnreachableError({ status: 500, serverMessage: "Something went wrong on our end." }), false);
  assert.equal(isApiUnreachableError({ status: 503, serverMessage: "Maintenance." }), true, "gateway statuses are unambiguous");
});

test("an empty-bodied 4xx is still a client answer from the API, never connectivity", () => {
  for (const status of [400, 401, 403, 404, 409, 429]) {
    assert.equal(isApiUnreachableError({ status }), false, String(status));
  }
});

test("a session already in hand survives a failed refetch of any kind", () => {
  // `hasUser` alone does not win: lib/session.ts's isSignedIn has always
  // required no error, so an errored query is classified on the error.
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: true, error: { status: 401 } }), "signed-out");
  assert.equal(classifySessionProbe({ isLoading: false, hasUser: true, error: { status: 0 } }), "api-unreachable");
});

test("isApiUnreachableError ignores anything that is not a transport failure", () => {
  assert.equal(isApiUnreachableError(null), false);
  assert.equal(isApiUnreachableError(undefined), false);
  assert.equal(isApiUnreachableError({}), false);
  assert.equal(isApiUnreachableError({ status: 401 }), false);
  assert.equal(isApiUnreachableError({ status: 500, serverMessage: "Something went wrong on our end." }), false);
});
