# AE GROW Priority 6 — Stage F4: Governed Call Follow-ups

This is the canonical governing record for Stage F4 (Project Owner decision D6). It replaces reliance on the unmerged Stage F discovery branch for this stage. It records the approved scope, the decisions it rests on, the architecture as built, and the verification evidence.

## Status

**Implementation in progress on `feat/ae-grow-priority-6-stage-f4-governed-followups`. Not merge-ready until independent review and GitHub CI are complete.** Merging requires an explicit Project Owner decision.

- Starting point: `staging` at `cd158996cf59bf3def5867317aa3ed85c56a663c` (F3 merged; post-merge CI #355 passed).
- Delivery on one branch, in order: F4.0 governance hardening (which also carries the F4.2 migration 0025, since the dedup index is part of the hardened proposal path), its security-gate remediation, F4.1 service/API, F4.3 UI, then final-review remediation and this report (F4.4).

## 1. Objective

Human-approved commitments and follow-ups from an F3 call review become Grow commitments **only** through the existing Stage D governance path:

F3 human-approved item → F4 human-confirmed due date → Stage D proposal → explicit human approval → governed execution → Grow commitment → Contact 360 / Relationship Timeline → audit evidence.

No other path from transcript or review data to `growCommitments` exists.

## 2. Project Owner decisions

| ID | Decision |
|---|---|
| D1 | Keep `CREATE_GROW_COMMITMENT` unchanged. The agent confirms or edits a due date per approved item; the AI-suggested `dueAt` may pre-fill the field but the human must confirm it. The server builds the payload. The proposal keeps `actorType: "AI"` because the recommendation originated from AI. The client never supplies brokerage, contact, authority or the commitment description. |
| D2 | Harden the Stage D governance pipeline first (F4.0), including database-level dedup protection (migration 0025) and a separate, explicit system execution path for existing automation. |
| D3 | No new provenance columns. Provenance is the action request (resource id and id-only evidence fields) plus audit records. |
| D4 | Proposal authority: call initiator or brokerage admin. Approval authority: original proposer or brokerage admin, with `grow.activities.manage`. Execution follows the hardened approval/execution rules. |
| D5 (F4 only) | If the call's capture consent is withdrawn, block new F4 proposals from that call. Do not cancel existing proposals. This does not decide the broader consent questions below. |
| D6 | This document is the canonical F4 record; the old Stage F discovery branch is not merged. |

Open, non-blocking consent questions, deliberately **not** decided by F4:

- A. Whether withdrawal applies contact-wide across multiple consent records.
- B. Whether withdrawal prevents a human saving an already-created transcription review / `call_summary`.

## 3. F4.0 — Stage D governance hardening

Security-sensitive changes to the shared AI-action pipeline (`lib/ai/actionRequests.ts`, `lib/ai/executionGateway.ts`, `routes/ai-actions.ts`, `lib/ai/orchestrator.ts`, `lib/automation/engine.ts`):

- **Execute**: an approval-required request can be executed only by its recorded approver or a brokerage admin, who must hold an allowed role and the action's required entitlement. Caller authority is checked before any status inspection or transition. The policy re-check against the original requester is unchanged. Requests stored as not needing approval are refused if the stored or current authority/risk now requires approval and no approver is recorded.
- **System path**: `executeAIActionAsSystem` is used only by the automation engine. It runs only `SYSTEM`-actor requests that need no approval and are auto-execute-eligible under both the stored and current definitions. Approval-required actions can never run through it. Existing risk-0 automation keeps working.
- **Approve / reject**: requester or brokerage admin only (others receive the same 404 as a missing id), then allowed role, then the action's required entitlement, re-checked at decision time.
- **Read**: `GET /ai/actions/requests/:id` is limited to the requester or an admin, so payloads are not exposed brokerage-wide.
- **Expiry**: conditional transitions to `EXPIRED`, audited with the new `AI_ACTION_EXPIRED` event. Expired requests are excluded from pending lists and dedup.
- **Tampering**: a changed payload at approval is rejected conditionally and audited (`AI_ACTION_BLOCKED`, stage `APPROVAL`).
- **Stuck execution**: `markFailed` and all post-execute transitions are conditional on the observed status. A bounded, throttled sweep from automation event handling marks requests stuck in `EXECUTING` for more than 15 minutes as `FAILED` with audit. It never re-executes. A late completion after recovery leaves the row `FAILED`, publishes no `AI_ACTION_EXECUTED`, and is audited (tenant-attributed) and reported with `sideEffectApplied`.
- **Ask AE proposals**: Grow commitment proposals from Ask AE are now keyed per user, and an existing or race-surviving request is only returned to its requester or an admin holding the entitlement.

## 4. F4.1 — Governed follow-up service and API

- `apps/api/src/lib/growCallFollowups.ts` (deliberately not named `callTranscription*`, so F3's import-boundary protections are unaffected).
- `apps/api/src/routes/growCallFollowups.ts`, mounted separately from `routes/growCalls.ts`; F3 modules do not import F4 code.
  - `GET /grow/calls/:callSessionId/transcription/:transcriptionId/followups` — approved COMMITMENT/FOLLOWUP items, the AI-suggested due date as a hint only, consent-blocked flag, and each item's proposal status (another user's proposal is reported as "already proposed" with no details).
  - `POST .../followups/propose` — strict body `{ items: [{ itemType, itemId, dueAt }] }`; any other field is rejected.
- Approved text comes only from the saved `call_summary` snapshot, cross-checked against APPROVED review decisions. The description is that text with surrounding whitespace trimmed; the contact is the call's party; no property or opportunity is inferred. `dueAt` comes only from the request.
- **Due-date confirmation is a UI guarantee.** The server accepts only a due date supplied in the request and never substitutes the AI suggestion, but it cannot distinguish a date the human confirmed from one a client copied from the suggestion. The web UI enforces explicit confirmation (§6).
- Proposals use `CREATE_GROW_COMMITMENT` with `actorType: "AI"` and the caller as the human requester; resource id `transcription:<id>:item:<type>:<itemId>`. An item is not proposed again while its proposal is open, once its commitment has been created, or when a proposal's side effect may have run after stuck-execution recovery.
- Access: `grow.calling.transcription` and `grow.activities.manage`; call initiator or brokerage admin. Same-brokerage non-owners are refused as in F3; cross-tenant ids are not found.
- Audit: a strict `grow_call_followup_proposal_requested` audit is written before proposing (failure proposes nothing) and a strict `grow_call_followup_proposed` outcome audit after. Propose-time refusals that reach the service after the entitlement checks (non-owner, wrong review state, consent withdrawn, invalid items) are audited as `grow_call_followup_rejected`; cross-tenant and not-found ids, entitlement refusals, route-level body validation and read (GET) refusals are not audited. Audit values contain ids only.
- Consent (D5) blocks on a withdrawn, missing or unresolvable capture consent. An expired (not withdrawn) consent does not block, because D5 covers withdrawal only.
- `GET /grow/ai-actions/pending-commitments` accepts an optional `partyId` filter (still the caller's own, non-expired requests).

## 5. F4.2 — Database-level dedup

Migration `0025` (additive only): a partial unique index on `ai_action_requests (action_key, brokerage_id, resource_id)` for open (`AWAITING_APPROVAL`, `APPROVED`, `EXECUTING`) `CREATE_GROW_COMMITMENT` requests with a non-null resource id. It is scoped to this action because automation and the generic propose route legitimately allow several open requests per resource. Proposal races return the existing open request (only to someone allowed to see it).

**Pre-deployment check**: before applying 0025 to any existing database, this query must return no rows, or the index creation fails without changing anything:

```sql
select action_key, brokerage_id, resource_id, count(*) from ai_action_requests
where action_key = 'CREATE_GROW_COMMITMENT' and resource_id is not null
  and status in ('AWAITING_APPROVAL', 'APPROVED', 'EXECUTING')
group by 1, 2, 3 having count(*) > 1;
```

## 6. F4.3 — UI

- **Follow-ups from this call** (`apps/web/src/components/GrowCallFollowupsSection.tsx`, shown in the saved call-review panel): each approved commitment/follow-up with its approved text (read-only), a status pill, a select checkbox, a due-date input pre-filled from the AI suggestion, and an explicit **Confirm due date** control. A pre-filled date never counts as confirmed; changing the date clears the confirmation. The request body is built only from selected, confirmed items and contains exactly `{ itemType, itemId, dueAt }` (`apps/web/src/lib/callFollowups.ts`). Consent-withdrawn calls show a clear message and cannot propose.
- **Due-date semantics** (final date remediation). A commitment due date is a calendar date. The AI suggestion is a UTC instant; its pre-fill is the calendar date on which that instant falls **in the agent's own time zone** — the same date Grow displays for that instant everywhere else (dates are shown with `toLocaleDateString` in the viewer's zone). For example, 2026-09-24T23:00:00Z (9am Friday 25 September in Brisbane) pre-fills 25 September. Previously the pre-fill used the UTC calendar date, which showed the 24th. The confirmed date is sent as UTC midnight of the chosen day, the same convention as Contact 360's manual "Add commitment" form, which every Australian zone (UTC+8 to +11) displays as that day. Covered for AEST, AEDT, ACDT, AWST, UTC and local-midnight boundaries, and both Sydney DST transitions; an API test confirms the stored commitment date falls on the confirmed day in every Australian zone.
- **Reusable proposal card** (`apps/web/src/components/GrowCommitmentProposalCard.tsx`, extracted from Ask AE): description, contact, due date, live status, "Expires in Xh" / "Expired", and "From call review" provenance. **Approve & create commitment** (approve, then execute) or **Reject** with an optional reason. Handles not-available, expired, not-authorised and completed-after-recovery outcomes; the last never offers a retry.
- **Pending commitment proposals** in Contact 360 (`apps/web/src/components/GrowPendingCommitmentProposals.tsx`), from `pending-commitments?partyId=`.
- The UI calls only the follow-ups endpoints, `pending-commitments`, and the existing `/ai/actions` approve/reject/execute endpoints. Nothing proposes, approves or executes without an explicit click, and the UI never creates commitments directly.

## 7. Boundaries (binding)

- No autonomous proposal creation, approval or execution.
- No outbound email or SMS, messaging drafts, automation tasks or reminders.
- No new AI call and no new external provider; no transcript re-processing.
- No change to the F3 review contract, F3 API modules or F3 API tests. Two F3-adjacent test edits: `support/f3ForbiddenCalls.ts` additionally forbids the new `executeAIActionAsSystem` (a tightening, F4.0), and the F3 web panel test stubs the router because the panel now renders the F4 section (F4.3).
- No new provenance columns; no commitment assignee/title changes.
- No F5 functionality.

## 8. Deferred / known items

- Consent questions A and B (§2).
- Stage D tamper hash is unkeyed (pre-existing gap).
- Consent is checked once per propose request; a withdrawal racing an in-flight request can still yield proposals, which remain human-approval-gated and are not auto-cancelled (consistent with D5).
- Due-date confirmation is enforced in the UI only (§4).
- The follow-ups section is shown without a client-side entitlement check; the server refuses unentitled users and the UI shows the error.
- `grow.calling.transcription` catalogue description is out of date (pre-existing).

## 9. Verification results

Local verification uses disposable PostgreSQL 16 in UTC, matching CI; GitHub CI results are recorded on the draft PR.

- **F4.0 security gate**: independent adversarial review found no material defect in the core authorisation; one material issue (Ask AE cross-user proposal disclosure) and minor issues were fixed and re-checked. Mutation checks confirmed tests fail if any of these protections is removed: request access, approver-only execution, the system-path guard, decision-maker entitlement, executor entitlement.
- **Independent final review (F4.1/F4.3)**: no material defects; concerns C1 (re-proposal after possible side effect), C3 (error accuracy), C4 (cross-check tests) fixed, and documentation corrected.
- **Full API suite** (CI command, fresh database, CI-like parallelism) before final-review remediation: 1267 tests, 1266 passed, 0 failed, 1 skipped (pre-existing placeholder).
- **Targeted suites after remediation** (F4 follow-ups, AI governance, AI actions routes, telephony, F3 call and transcription routes; fresh database, serial): 346 tests, 345 passed, 0 failed, 1 skipped.
- **Web tests**: 91 tests, 90 passed; the single failure is the pre-existing Stage E zero-byte recording test.
- **Workspace typecheck, API and web production builds, clean-database migration, schema drift check**: passing.

This document does not claim merge readiness; that requires the draft PR's GitHub CI and the Project Owner's merge decision.
