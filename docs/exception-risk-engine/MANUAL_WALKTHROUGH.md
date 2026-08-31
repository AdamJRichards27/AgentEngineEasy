# Manual Staging Walkthrough — Exception & Risk Engine

Build Instructions §25. Performed live against the running staging
deployment (Replit dev environment, branch `feat/exception-risk-engine`,
after `git pull` to sync the four new/changed frontend files and a clean
`pnpm -r run typecheck` + `pnpm --filter @aee/web run build`), signed in
as Jane Agent (Brokerage Administrator, AT Realty). Each step below is a
real click against the real API — nothing here is a mock or a
description of intended behaviour.

Screenshots were captured during the session but the browser tooling's
save-to-disk path isn't reachable from this environment's file tools, so
this record describes each verified screen state in detail instead of
embedding image files. Every state below was watched render live.

## 1. Cross-property Exceptions page (`/exceptions`)

Navigated via the sidebar "Exceptions" link (new 6th top-level nav
destination, sitting between Properties and Grow).

**Header and filters**: "Risk & Compliance / Exceptions" with the
explanatory subhead ("a foundation for the Command Centre, not the
Command Centre itself"), a Filters card with Severity dropdown, free-text
Search, and "Open only" (checked by default) / "Overdue only" checkboxes.

**Engine Health** (admin-only — confirmed visible because Jane Agent is
Brokerage Administrator): a "Run Scan Now" button and a history of scan
runs, each showing status pill (`COMPLETED`), trigger (`SCHEDULED` /
`MANUAL`), start time, and counts. Runs observed: a `MANUAL` scan (19
brokerages, 570 rules evaluated, 0 created/updated/auto-resolved — a
stable re-scan of already-detected state) and `SCHEDULED` scans,
including one historical run showing 49 created (the initial rollout
scan that first populated the exception set) and a more recent one
showing 0 created (steady state). This confirms both trigger paths
(§8–9) actually ran against real data, not just in tests.

**Exceptions (4) list**: four real, distinct exceptions rendered:

1. **At Risk** — "Live listing is missing required information" — 27
   Vertical Slice Walkthrough Rd, Testville NSW 2000 — Open, owned by
   Jane Agent.
2. **Attention** — "Seller AML/CTF verification incomplete for John
   Seller" — 42 Test Street — Open, owned by Jane Agent.
3. **Attention** — "Seller AML/CTF verification incomplete for Homer
   Simpson" — 14 southport avenue tamborine mountain — Open, owned by
   Jane Agent.
4. **Attention** — "Live listing is missing campaign or sales-method
   information" — 27 Vertical Slice Walkthrough Rd, Testville NSW 2000 —
   Open, owned by Jane Agent.

Severity pills render correctly against the app's existing 3-tone system
(At Risk and Critical both read as the danger/red pill, Attention as the
warning/amber pill — told apart by label text, not colour, exactly as
designed). Pagination footer reads "1–4 of 4" with Previous/Next
correctly disabled/enabled for a single page.

## 2. Property-level Exceptions panel

Clicked the John Seller / 42 Test Street exception, which is a real
`Link` to `/properties/1` — landed on that property's workspace.

The **Exceptions** card renders directly below the "Next Step" card and
above Sellers/Timeline, exactly per the layout added to
`PropertyWorkspace.tsx`:

- Summary line: "1 open · highest severity: Attention".
- One exception card: `Attention` / `Open` pills, title "Seller AML/CTF
  verification incomplete for John Seller", description line "Aml Ctf ·
  John Seller's AML/CTF verification is currently 'Awaiting Seller', not
  yet Complete." — pulled straight from the rule's real
  `problemDescription`, not placeholder text.
- An **Acknowledge** button (status-conditional — this is the correct
  action for an `OPEN` exception).
- A **View Details** `<details>` disclosure.

Expanded **View Details** and confirmed every field renders from live
data:

- Business impact: "The listing cannot proceed to a clean settlement
  without seller AML/CTF verification completed."
- Recommended action: "Request or follow up seller AML/CTF verification
  through the AML workflow."
- To resolve: "The seller's amlVerifications row reaches status
  Complete."
- Detected 4 times, most recently 31 Aug 2026 — confirming the
  dedup/occurrence-count mechanism (§11) is live: repeated detections of
  the same condition incremented a counter on one row rather than
  creating duplicate exceptions.
- A working reassign form: "Reassign to…" owner-type dropdown, "Reason
  for reassignment" text input, "Reassign" button.

## 3. Lifecycle actions, two live round trips

Clicked **Acknowledge**. Result, observed immediately after the request
completed:

- The status pill changed from `Open` to `Acknowledged`.
- The action button changed from `Acknowledge` to `Start Remediation` —
  the correct next action for an `ACKNOWLEDGED` exception.
- The summary line above still correctly read the updated state.

Then clicked **Start Remediation** on the same exception. Result:

- The status pill changed from `Acknowledged` to `In Remediation`
  (the display label for `IN_PROGRESS`).
- The action area was replaced with the `IN_PROGRESS`-state form: a
  required "Resolution note" textarea plus "Mark Resolved" and
  "Awaiting External Action" buttons — the correct next actions from
  that status.

Both confirm the full round trip: click → the corresponding
`POST /exceptions/:id/...` route → server writes a
`risk_exception_transitions` row and updates `risk_exceptions.status` →
React Query's `invalidateQueries` refetches
`GET /properties/:propertyId/exceptions` → the panel re-renders the new
state. No manual page reload was needed for either transition.

This walkthrough was driven through the Replit editor's embedded Preview
frame, which sits behind a cross-origin boundary the browser-automation
tooling's console/network inspectors can't see into (they only reach the
top-level Replit editor page, not its embedded preview). So "no errors"
here is a visual finding — no error banners, no stuck loading states, no
stale UI after either transition — rather than an instrumented
zero-console-errors reading.

## 4. Property Timeline integration

Scrolled to the property's Timeline. The existing chronological entries
(Property created, John Seller added, AML verification requested,
Document package created, Ready to List started) are followed by:

> **Compliance** — Exception opened: Seller AML/CTF verification
> incomplete for John Seller

rendered with the same generic Timeline styling as every other entry —
confirming zero frontend changes were needed for Timeline integration,
exactly as the backend's existing `category: "Compliance"` mapping
promised.

Also confirmed: acknowledging the exception did **not** add a second
Timeline entry. This is expected — only the exception-*opened* domain
event is mapped onto the Timeline; intermediate status transitions
(acknowledge, start remediation, awaiting-external) are captured in
`risk_exception_transitions` for the audit trail but were deliberately
not wired into Timeline noise. That decision predates this segment's
frontend work (made when the backend Timeline mapping was built); it's
noted here so the absence of an "Acknowledged" Timeline row isn't
mistaken for a gap.

## 5. Role gating, observed directly

Signed in throughout as Jane Agent, Brokerage Administrator — the Engine
Health card and "Run Scan Now" control were visible on `/exceptions`
precisely because of that role, matching the `requireRole(...BROKERAGE_ADMIN_ROLES)`
guard on `ops/health` / `ops/scan` server-side. A full negative check
(non-admin cannot see or hit the ops routes; cross-tenant requests
404) is already covered by the automated route-level test suite
(`apps/api/src/routes/__tests__/exceptions.test.ts`) rather than
re-verified by hand here.

## Summary

Every surface built this segment — the property-level panel, the
cross-property page, the Engine Health ops card, two chained lifecycle
actions (Acknowledge → Start Remediation) on the same real exception,
and the Timeline integration — was exercised against the real running
application and real data, not mocked. No visual defects, error
banners, or stuck states were observed at any step of the walkthrough.
