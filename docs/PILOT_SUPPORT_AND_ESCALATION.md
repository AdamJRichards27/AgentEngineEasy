# Pilot Support and Escalation

`docs/PILOT_SUPPORT_AND_ESCALATION.md`

This document covers the day-to-day operating model for supporting the controlled pilot
(5-10 invited agents, real workflows, synthetic/test data, no public signup, no live
customer money). It complements `docs/INCIDENT_RESPONSE_RUNBOOK.md`, which owns the
per-scenario technical response detail — this document does not repeat that content. Use
this one for "how does support work day to day," and the incident runbook for "exactly
what do we do when scenario X happens."

Roles are accountable functions, never named individuals (see the incident runbook's own
note on this) — each pilot cohort keeps its own internal roster of who currently holds
each role.

## 1. How pilot participants report issues

One designated channel, communicated to every participant at pilot kickoff and repeated
in the welcome material: a shared email address or messaging channel monitored by **AE
Support Lead** (e.g. a dedicated pilot-support inbox or channel — the specific tool is a
pilot-setup detail, not fixed by this document). Participants are told explicitly:

- Use this one channel for anything — a bug, a question, a data request — rather than
  contacting an individual engineer directly. This keeps intake, triage, and the tracker
  in sync, and avoids a report getting lost in a personal inbox.
- Include what they were trying to do, what happened instead, and the property/transaction
  involved if applicable, so triage doesn't require a back-and-forth just to start.
- For anything that feels like a security or privacy concern specifically, say so plainly
  in the report — those get routed faster (see §3 and Incident Runbook scenario 13).

There is no self-service status page or ticket portal in this build; acknowledgement and
status updates happen directly in the same channel the participant used.

## 2. Supported hours

The pilot runs with **defined support hours**, communicated up front so participants know
what to expect — this is a controlled pilot with a small, known cohort, not a 24/7
production service:

- **Business hours coverage** (the pilot's local business day) — AE Support Lead
  monitors the channel and triages within the response times in §3.
- **After-hours**: Critical-severity conditions only (data exposure, data loss, total
  outage, an active security incident) reach **AE Backend Engineering (on-call)**
  directly — the on-call arrangement is a pilot-specific commitment, not a standing
  24/7 rotation, and its exact hours/reachability method are set in the pilot's own
  kickoff plan, not in this document.
- Anything Medium or Low severity reported outside business hours is acknowledged the
  next business day — participants are told this explicitly so an unanswered evening
  message isn't mistaken for being ignored.

## 3. Severity triage definitions

Same four levels used throughout the incident runbook, restated here for the support
intake role doing first triage:

| Severity | What it looks like at intake | Target first response |
|---|---|---|
| **Critical** | Participant sees another participant's data; total outage; suspected data loss; an active security/AML concern; anything matching Incident Runbook scenarios 1, 2, 4, 5, 6, 7, or 15 | 15 minutes |
| **High** | The participant is blocked from completing something on a specific transaction, with no workaround; a suspected account-takeover attempt; a confirmed security event with no active exposure | 1 hour |
| **Medium** | A workaround exists; affects one participant or one workflow; a data export/deletion request; a webhook/integration delay that hasn't yet blocked a milestone | 4 business hours |
| **Low** | Cosmetic issue; a question; a non-urgent request | 2 business days |

**Triage rule of thumb for AE Support Lead**: when unsure between two levels, triage up,
not down — it's cheaper to stand an engineer down after a quick look than to leave a
real Critical sitting at Medium overnight. Anything that even might be a security or
privacy concern is triaged as at least High on receipt, per Incident Runbook scenario 13,
and reclassified only after AE Security/Compliance Owner has actually looked at it.

## 4. Escalation path

```
Participant report
      │
      ▼
AE Support Lead  (intake, first triage, all participant communication)
      │
      ├── Low / Medium, no security angle ─────────────► AE Backend Engineering
      │                                                    (normal queue)
      │
      ├── High, or Medium with a security/AML angle ───► AE Backend Engineering (on-call)
      │
      └── Critical, or any confirmed security/privacy ─► AE Backend Engineering (on-call)
              incident, or a stop-pilot candidate              + AE Security/Compliance Owner
                                                                 (in parallel, not sequentially)
                                                                       │
                                                                       ▼
                                                          AE Project Owner
                                                 (informed on every Critical; makes the
                                                  call on anything affecting more than
                                                  one participant, or a stop-pilot decision)
```

Two rules that keep this path from bottlenecking:

- **AE Support Lead never sits on a Critical report waiting for their own diagnosis.**
  A report that sounds Critical is routed to AE Backend Engineering (on-call) immediately,
  triage refined afterward if it turns out to be less severe than first described.
- **AE Project Owner is the only role that can pause the pilot** (Incident Runbook
  scenario 15) or make a participant-facing disclosure decision on a confirmed security
  incident (Incident Runbook scenario 2). Every other escalation step below that is a
  normal technical hand-off and doesn't need Project Owner sign-off to proceed.

If AE Backend Engineering (on-call) doesn't acknowledge within the target response time
for the severity in question, AE Support Lead escalates directly to AE Project Owner
without waiting further — this mirrors Incident Runbook scenario 16 (on-call
unreachable).

## 5. Review cadence during the pilot

- **Daily (business days), 15 minutes**: AE Support Lead and AE Backend Engineering (on-call)
  review anything open from the last 24 hours — status of each open item, whether any
  Medium is trending toward High (e.g. a workaround stopped working), and whether
  anything needs to move up the escalation path. This is a standup, not a written report.
- **Weekly, with AE Project Owner**: a short written or verbal summary covering — new
  issues this week by severity, issues closed, anything still open past its target
  resolution time and why, any incident-log entries from the Incident Response Runbook
  (even if fully resolved — Project Owner sees every Critical/High regardless of outcome),
  and a explicit call-out of anything trending toward a stop-pilot condition before it
  gets there. This weekly review is also where participant-reported patterns (e.g. the
  same confusion from two different agents) get flagged as possible product gaps, not
  just one-off bugs.
- **End of pilot**: a single retrospective covering every incident-log entry, every
  stop-pilot consideration (triggered or not), and open items carried forward — this
  feeds directly into the go/no-go conversation for anything beyond the pilot, and is
  the natural home for the AI/AML compliance note the Incident Runbook's scenario 6 calls
  for if that scenario was ever triggered.

## 6. How issues get tracked to closure

- Every participant report gets one entry in a shared **pilot issue tracker** (a
  lightweight tracker or spreadsheet is sufficient for this cohort size — the specific
  tool is a pilot-setup detail). Minimum fields: date reported, participant, severity,
  one-line description, owner (role), status, resolution summary, closed date.
- An issue is not marked closed until **AE Support Lead confirms with the reporting
  participant** that it's actually resolved from their side — a code fix shipping is
  not the same as the participant's problem being confirmed gone. For Low-severity
  cosmetic items where a response was already sent explaining the item is by design or
  deferred, AE Support Lead may close without a participant round-trip, but should say
  so in the resolution summary.
- Anything that also triggered an Incident Response Runbook scenario carries a
  cross-reference both ways: the pilot issue tracker entry names the incident-log entry
  id, and the incident-log entry names the tracker item — so a Critical/High incident is
  never visible in only one of the two records.
- Issues still open at the weekly review (§5) are explicitly called out, not just
  visible in the tracker — an open item that nobody actively discusses tends to stall.
