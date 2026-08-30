# WAE Operator Runbook

Practical, task-oriented guide to operating the Workflow Automation Engine
day to day, once WF4 (Operational Readiness) is live. Every action below is
a Brokerage Administrator-only HTTP call under `/api/automation/ops`
(see `docs/stage-wf/WF4_OPERATIONAL_READINESS.md` for the full design and
rationale). This document assumes no dedicated admin UI exists yet — every
example is the raw request an eventual UI page would make.

## 1. How do I see what's stuck?

Two starting points, depending on how much you already know:

**"Is anything wrong right now?"** — `GET /api/automation/ops/health`.
Returns:

```json
{
  "healthy": true,
  "degraded": false,
  "checks": {
    "databaseReachable": true,
    "staleRunningActions": 0,
    "retryBacklog": 3,
    "terminalFailuresLast24h": 1,
    "approvalBacklog": 2
  }
}
```

`healthy: false` means the database itself is unreachable — a real outage.
`degraded: true` means at least one backlog is nonzero (see §5) — normal
operating noise, not necessarily an emergency, but worth a look if it's
been climbing.

**"Show me the stuck ones."** — `GET /api/automation/ops/executions?status=RETRY_SCHEDULED`
(or `AWAITING_APPROVAL`, `BLOCKED`, `FAILED_TERMINAL`). Add `ruleId`,
`correlationId`, `executionId`, `propertyId`, or `transactionId` to narrow
further; `limit`/`offset` for paging (default 25, max 100). Each row
includes the triggering event's `eventType`/`propertyId`/`transactionId`,
so you can tell at a glance which property or transaction is affected
without a second lookup.

To drill into one execution — its full action list, each action's
classification, attempt count, and next-eligible-retry time —
`GET /api/automation/ops/executions/:id`.

## 2. How do I retry something?

`POST /api/automation/ops/actions/:id/retry` (no body). This is the exact
same claim-and-execute path the engine itself uses — it will tell you
plainly why a retry was refused rather than silently doing nothing:

| HTTP status | `reason` | Meaning |
| --- | --- | --- |
| 200 | — | Retried; the response's `status` is the fresh outcome (`SUCCEEDED`, `RETRY_SCHEDULED` again, `FAILED_TERMINAL`, etc.). |
| 404 | `NOT_FOUND` | No such action in your brokerage. |
| 409 | `NOT_RETRY_ELIGIBLE` | This action's failure was classified as a policy/validation denial or a non-retryable technical failure — retrying it is refused on purpose, not a bug. Check `lastFailureClassification` on the execution/action detail to see why. |
| 409 | `NOT_YET_ELIGIBLE` | Its backoff window (`nextRetryEligibleAt`) hasn't passed yet. |
| 409 | `MAX_ATTEMPTS_REACHED` | It has already used all its attempts (`attemptCount` ≥ `maxAttempts`). |
| 409 | `LOST_CLAIM_RACE` | Someone (or something) else claimed it in the same instant — safe to check its current status and move on. |

A `409` here is the system working as designed, not an error to escalate on
its own — it always means one of the two safety properties (never retry a
policy denial; never exceed the attempt cap) did its job.

## 3. How do I cancel something?

`POST /api/automation/ops/executions/:id/cancel` or
`POST /api/automation/ops/actions/:id/cancel`, body `{ "reason": "..." }`
(required, 1–2000 characters — always record why). Cancelling an execution
also cancels its still-cancellable actions.

Cancellation is only permitted before anything irreversible has happened:

| HTTP status | `reason` | Meaning |
| --- | --- | --- |
| 200 | — | Cancelled. |
| 404 | `NOT_FOUND` | No such execution/action in your brokerage. |
| 409 | `NOT_CANCELLABLE` | Its current status isn't one of the cancellable ones (an execution must be `PENDING`/`EVALUATING`/`AWAITING_APPROVAL`/`RETRY_SCHEDULED`; an action must be `PENDING`/`AWAITING_APPROVAL`/`RETRY_SCHEDULED`/`FAILED`). It has either already finished or already been cancelled. |
| 409 | `IRREVERSIBLE_PROGRESS` | The linked approval request has already started or finished executing — cancelling now would not undo real work, so it is refused rather than giving a false sense of safety. |

## 4. How do I leave a note without changing anything?

`POST /api/automation/ops/executions/:id/notes`, body
`{ "note": "..." }` (1–4000 characters). This works regardless of the
execution's current status and never changes that status — use it to
record "investigated, this is expected" or "waiting on the buyer's
solicitor" so the next person who looks doesn't repeat the investigation.

## 5. What does "degraded" actually mean, and when should I worry?

`degraded: true` fires when any of:

- `staleRunningActions > 0` — at least one action has been `RUNNING` for
  longer than 15 minutes. This is the one worth checking first: nothing in
  this codebase currently recovers a stuck `RUNNING` row automatically
  (see §7), so it stays stuck until someone investigates.
- `retryBacklog > 10` — more than 10 actions are currently
  `RETRY_SCHEDULED`. Expected to rise and fall on its own as backoffs
  elapse; a number that only ever grows is worth investigating (a
  downstream dependency may be failing repeatedly).
- `approvalBacklog > 25` — more than 25 actions are `AWAITING_APPROVAL`.
  Usually means approvals simply need to be worked through
  (`/api/ai/actions/requests/:id/approve`, the existing AI Governance
  route — not part of this ops surface).

None of these thresholds are hard failures — `healthy` stays `true`. Treat
`degraded` as "worth a look, not necessarily urgent," and treat
`healthy: false` as "the database itself is down, escalate immediately."

## 6. How do I pause a misbehaving rule?

`POST /api/automation/ops/rules/:id/pause`, body `{ "reason": "..." }`.
This stops the rule from being evaluated against new events at all — it
does not touch any execution already in flight. Resume with
`POST /api/automation/ops/rules/:id/resume`, same body shape. Both return
`404` if the rule id doesn't belong to your brokerage, or if it doesn't
exist.

Pause a rule when you suspect it is producing wrong or unwanted actions and
you need time to investigate — it is the fastest way to stop the bleeding
without touching any data already written.

## 7. Where does the audit trail live?

Every mutation described above (retry, cancel, note, pause, resume) writes
an `audit_logs` row via the existing `logAudit` helper — the same audit
mechanism every other part of this codebase uses, not a second one. Cancel
and recovery actions additionally publish a domain event
(`AUTOMATION_ACTION_CANCELLED`, `AUTOMATION_EXECUTION_CANCELLED`,
`AUTOMATION_EXECUTION_RECOVERED`) into `domain_events`, carrying the
original execution's `correlationId` and `causationId` so it threads into
the same correlation chain as the triggering event and every action that
followed it. An approved/rejected retry's underlying action execution
still produces its own `aiActionRequests` row exactly as any other AI
Governance action does — nothing about the approval audit trail changed in
this stage.

## 8. What is NOT automated yet — know the limits

- **Nothing retries a `RETRY_SCHEDULED` action for you.** Once its
  backoff window passes, it sits there — eligible, but idle — until an
  operator calls retry, or until a future scheduler/worker is built to
  poll for eligible rows. There is no cron job in this codebase today.
- **Nothing recovers a stuck `RUNNING` action automatically.** The
  `recoverAbandonedRunning` function exists and is safe to run, but
  nothing currently calls it on a schedule. A `staleRunningActions` count
  above zero in `GET /health` will not resolve itself.
- **No metrics/alerting integration.** `GET /health` is a pull-based
  check — nothing pushes an alert when a threshold is crossed. Check it
  proactively, or wire it into your own monitoring until a real
  integration exists.
- **No admin UI.** Every action in this runbook is a raw HTTP call today.
