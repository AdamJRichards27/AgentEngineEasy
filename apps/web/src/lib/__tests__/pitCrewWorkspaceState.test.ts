import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../api.ts";
import {
  PIT_CREW_WORKSPACE_LOAD_ERROR_FALLBACK,
  PIT_CREW_WORKSPACE_LOADING_MESSAGE,
  pcWorkspaceLoadErrorMessage,
  pcWorkspaceStaleMessage,
  pcWorkspaceViewState,
} from "../pitCrew.ts";

// PC-C (P-01): the Pit Crew workspace polls every 30 s and the app's
// QueryClient has retry: false. React Query v5 keeps `data` when a
// background refetch fails and sets isError. Only a failure with no data
// to show is a full error; a failure with data is "ready-stale".

test("pcWorkspaceViewState: loading until there is data or an error", () => {
  assert.equal(pcWorkspaceViewState({ isLoading: true, isError: false, hasData: false }), "loading");
  assert.equal(pcWorkspaceViewState({ isLoading: false, isError: false, hasData: false }), "loading");
});

test("pcWorkspaceViewState: an error with no data is a first-load error", () => {
  assert.equal(pcWorkspaceViewState({ isLoading: false, isError: true, hasData: false }), "error");
});

test("pcWorkspaceViewState: an error while data exists keeps the workspace (ready-stale), not error", () => {
  assert.equal(pcWorkspaceViewState({ isLoading: false, isError: true, hasData: true }), "ready-stale");
});

test("pcWorkspaceViewState: data without error is ready, including after a stale error clears", () => {
  assert.equal(pcWorkspaceViewState({ isLoading: false, isError: false, hasData: true }), "ready");
  // isLoading is only true with no data in v5; data still wins if both are set.
  assert.equal(pcWorkspaceViewState({ isLoading: true, isError: false, hasData: true }), "ready");
});

test("pcWorkspaceLoadErrorMessage: ApiError friendly text, otherwise the fallback; never raw or 'undefined'", () => {
  assert.equal(pcWorkspaceLoadErrorMessage(new ApiError(503, "The server is busy. Try again shortly.")), "The server is busy. Try again shortly.");
  assert.equal(pcWorkspaceLoadErrorMessage(new ApiError(500, "   ")), PIT_CREW_WORKSPACE_LOAD_ERROR_FALLBACK);
  const raw = new TypeError("Failed to fetch: ECONNREFUSED 10.0.0.1:8080");
  assert.equal(pcWorkspaceLoadErrorMessage(raw), PIT_CREW_WORKSPACE_LOAD_ERROR_FALLBACK);
  assert.equal(pcWorkspaceLoadErrorMessage(undefined), PIT_CREW_WORKSPACE_LOAD_ERROR_FALLBACK);
  assert.equal(pcWorkspaceLoadErrorMessage(null), PIT_CREW_WORKSPACE_LOAD_ERROR_FALLBACK);
  for (const value of [raw, undefined, null, {}]) {
    assert.equal(pcWorkspaceLoadErrorMessage(value).includes("undefined"), false);
    assert.equal(pcWorkspaceLoadErrorMessage(value).includes("ECONNREFUSED"), false);
  }
  assert.equal(PIT_CREW_WORKSPACE_LOAD_ERROR_FALLBACK, "Couldn't load the Pit Crew workspace.");
  assert.equal(PIT_CREW_WORKSPACE_LOADING_MESSAGE, "Loading Pit Crew workspace…");
});

test("pcWorkspaceStaleMessage: says the refresh failed and when the shown data is from", () => {
  const fixed = (d: Date) => `T${d.toISOString().slice(11, 16)}`;
  assert.equal(
    pcWorkspaceStaleMessage("2026-10-19T12:15:00.000Z", fixed),
    "Couldn't refresh. Showing the workspace as of T12:15.",
  );
  assert.equal(pcWorkspaceStaleMessage("not a date", fixed), "Couldn't refresh. Showing the last loaded workspace.");
  assert.equal(pcWorkspaceStaleMessage(undefined, fixed), "Couldn't refresh. Showing the last loaded workspace.");
  assert.match(pcWorkspaceStaleMessage("2026-10-19T12:15:00.000Z"), /^Couldn't refresh\. Showing the workspace as of .+\.$/);
});
