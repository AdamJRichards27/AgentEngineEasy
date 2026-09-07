# Incident Response Runbook — Controlled Pilot

`docs/INCIDENT_RESPONSE_RUNBOOK.md`

## Scope and how to use this document

This runbook governs the **controlled pilot** of Agent Engine 2.0: 5-10 invited real-estate
agents, real transaction workflows, synthetic/test data only, no public signup, no live
customer money movement, no launch beyond this Queensland, Australia pilot, and no
multi-jurisdiction claim (jurisdiction confirmed by the AE Project Owner — see
`docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md`). It is written against what the system
actually does today, not an aspirational target state. Metrics and an `operationalAlerts`
webhook boundary exist, but external delivery and human acknowledgement have not been
evidenced; cooldown/deduplication is process-local and there is no durable alert outbox.

It complements, and does not replace, two existing engineering documents that this pilot
runbook assumes and points back to rather than re-deriving:

- `docs/SECURITY_INCIDENT_RUNBOOKS.md` — the engineering-level playbook for the twelve
  security/technical incident classes it covers (cross-tenant exposure, session/secret
  compromise, CORS, rate-limiting, webhook signature bypass, dependency vulnerabilities,
  database outage, import abuse, dev-login exposure, audit-log gaps) plus the backup/
  restore drill record. Where a scenario below overlaps one of those twelve, this document
  adds the **pilot-specific** layer (who tells the participant what, what target response
  time applies during a live pilot, what gets logged in the pilot's own incident log) and
  defers the technical root-cause procedure to that document.
- `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` — the real, wired metrics and named
  alert-ready conditions this runbook's "Trigger"/"Evidence to preserve" columns cite.
  Until external delivery and acknowledgement are evidenced, every signal must also be
  checked by a role manually through `GET /api/internal/metrics`, the admin views, or a
  log/exception scan.

**Roles used throughout** (accountable roles, not named individuals — see note at the end
of this section):

| Role | Accountable for |
|---|---|
| AE Project Owner | Overall pilot go/no-go, stop-pilot decisions, participant relationship, business-impact communications |
| AE Backend Engineering (on-call) | First technical response to any triggered scenario during the pilot window; the engineer holding on-call responsibility that week |
| AE Backend Engineering | Non-urgent fixes, code-level remediation, regression tests |
| AE Support Lead | Participant-facing communication, intake triage, tracking issues to closure |
| AE Security/Compliance Owner | Anything privacy/security/AML-adjacent; sign-off on disclosure decisions |

No specific human is named anywhere in this document. Each pilot cohort should record, in
its own internal roster (not this file), which individual currently holds each role and
how to reach them — that roster is operational contact information, not part of this
runbook's content.

**Severity definitions** (used consistently across both pilot documents):

| Severity | Meaning | Target first response |
|---|---|---|
| Critical | Active data exposure, data loss, AML/compliance failure, or total outage affecting all participants | 15 minutes |
| High | Single-participant-blocking defect, degraded service, confirmed security event with no active exposure | 1 hour |
| Medium | Workaround exists; affects one participant or one workflow | 4 business hours |
| Low | Cosmetic, non-blocking, or a request with no urgency | 2 business days |

"Target response time" below means: time to first acknowledgement and triage by the
accountable Owner role, not time to full resolution.

---

## 1. Confirmed or suspected cross-tenant data exposure

| | |
|---|---|
| **Trigger** | A pilot participant reports seeing another brokerage's/agent's data; an unusual pattern of unexpected "not found" responses is noticed; or `tenant_isolation_rejection_total{boundary}` shows a non-zero sustained rate (wired today only for the `communications`, `pit_crew`, and `integrations` boundaries — see `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` §4 item 1; every other domain's tenant check is inline and has to be checked directly, not via this counter). |
| **Severity** | Critical |
| **First response** | AE Backend Engineering (on-call) identifies the specific route/function involved and checks it against `docs/AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md`'s per-file matrix. Since pilot data is synthetic/test data, there is no real customer-privacy harm from the exposure itself, but the pilot is stopped from treating this as a technical-only issue — see Escalation. |
| **Owner** | AE Backend Engineering (on-call), with AE Security/Compliance Owner co-owning from the moment exposure is confirmed |
| **Escalation path** | AE Backend Engineering (on-call) → AE Security/Compliance Owner (immediately on confirmation, not after diagnosis) → AE Project Owner (within 30 minutes if confirmed live) |
| **Target response time** | 15 minutes to acknowledge; confirm/rule out exposure within 1 hour |
| **Evidence to preserve** | The specific request(s)/response(s) involved (from application logs, not participant screenshots alone), the affected brokerage/property/party ids, `tenant_isolation_rejection_total` values if the boundary is wired, and a copy of the relevant route code as it exists at the time of the incident (before any hotfix lands) |
| **Customer/participant communication approach** | AE Support Lead notifies only the affected participant(s), factually, once confirmed: what was exposed, to whom, and that it is being fixed. No participant is told about another participant's data in the process. If confirmed, all participants are told a fix is in progress before the next work day begins — pilot trust depends on this being visible, not hidden. |
| **Resolution steps** | Ship the fix following the exact convention in `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md` §3 (same-query brokerage filter, identical not-found response either way), with a regression test proving the specific exploit path is closed. If the exposure allowed a write (not just a read), the write is identified and manually reversed or corrected before the fix ships. |
| **Closure record** | Incident logged in the pilot incident log (see Deliverable 2) with: trigger, affected records, root cause, fix commit/PR reference, regression test added. A `logAudit` entry already exists for the underlying mutation (if any); the incident log entry cross-references it by record id/timestamp rather than duplicating it. |

---

## 2. A material privacy/security incident (credential compromise, unauthorized access)

| | |
|---|---|
| **Trigger** | A participant reports their account behaving unexpectedly; `auth_security_event_total{event="revoked_session_reused"}` or `{event="invalid_session_token"}` shows an unexplained spike correlated (via logs — no per-account label exists by design) to one account; or a `SESSION_SECRET`/provider-credential leak is suspected. |
| **Severity** | Critical |
| **First response** | AE Backend Engineering (on-call) follows the matching `SECURITY_INCIDENT_RUNBOOKS.md` procedure directly: #2 (compromised `SESSION_SECRET` — rotate and redeploy, which invalidates every session pilot-wide) or #4 (targeted session compromise — increment that user's `sessionEpoch`, which the existing `loadSession` epoch check already enforces, no code change needed) or #3 (leaked provider credential reference). |
| **Owner** | AE Backend Engineering (on-call); AE Security/Compliance Owner for anything beyond a single-account token issue |
| **Escalation path** | AE Backend Engineering (on-call) → AE Security/Compliance Owner (immediately) → AE Project Owner (if any participant's real personal information, as opposed to synthetic transaction data, was exposed — party PII such as name/email/mobile is real even though transaction *content* is synthetic) |
| **Target response time** | 15 minutes to acknowledge; containment (secret rotated or session revoked) within 1 hour |
| **Evidence to preserve** | The log lines showing the suspicious auth pattern, the affected user id(s), and — if a secret leaked — where it was found (log line, committed file, third-party notice) before that channel is closed |
| **Customer/participant communication approach** | Affected participant is told directly and asked to re-authenticate; if `SESSION_SECRET` was rotated (pilot-wide), all participants are told once, plainly, that they'll need to sign in again and why, without over-explaining the mechanism |
| **Resolution steps** | Rotate/revoke as above; confirm via a direct check (a pre-rotation token now 401s; a fresh login works); determine and close the actual exposure channel, not just the symptom |
| **Closure record** | Incident log entry with root cause of the exposure channel and the specific rotation/revocation action taken and confirmed. If PII (not just synthetic transaction data) was involved, AE Security/Compliance Owner records a one-line note on whether external notification obligations apply — a business/compliance decision this runbook does not resolve on its own. |

---

## 3. An incorrect financial charge or fee calculated

| | |
|---|---|
| **Trigger** | A participant reports a commission, fee, or charge amount that looks wrong; `financial_reconciliation_variance_total{source}` records an occurrence (wired at `lib/financial/mockPaymentStatusSync.ts`'s reconciliation chokepoint), or the `FIN05_RECONCILIATION_VARIANCE_UNRESOLVED` risk exception opens on the next scheduled exceptions scan. |
| **Severity** | High (Critical if a real payment was actually moved against the wrong amount — should not be possible in this pilot, since no live customer money moves; see the pilot's own guardrails). |
| **First response** | AE Backend Engineering (on-call) reproduces the calculation against the transaction's actual `agencyAgreementTerms` (`commissionRateBps`/`flatFeeCents` plus GST) and the recorded settlement figures — commission calculation is deterministic and re-runnable via `POST /transactions/:id/calculate-commission`, so the first check is always "does a recompute reproduce the same figure, or does it correct it." |
| **Owner** | AE Backend Engineering (on-call) for diagnosis; AE Backend Engineering for any correction requiring a Brokerage-Administrator-gated action (`agent-paid`, `close`, refund) |
| **Escalation path** | AE Backend Engineering (on-call) → AE Backend Engineering (if a code defect, not a data-entry issue, is the cause) → AE Project Owner (if the defect could have affected more than the one reported transaction) |
| **Target response time** | 1 hour to acknowledge and begin reproduction; 4 business hours to a determination (defect vs. data-entry vs. expected behavior) |
| **Evidence to preserve** | The transaction id, the `agencyAgreementTerms` row as it stood at calculation time, the `commissionCalculatedAt` timestamp, and the recompute's output for side-by-side comparison |
| **Customer/participant communication approach** | AE Support Lead tells the participant what was found (defect confirmed / data entry / working as designed) and the corrected figure, without asking them to "just trust it" — pilot participants entering real workflows on synthetic data still need to believe the numbers |
| **Resolution steps** | If a genuine calculation defect: fix it, add a regression test with the exact figures from this case, and force a recompute (`POST /transactions/:id/calculate-commission`) on every other transaction that could share the same defect (not just the one reported) — since this build has no live customer money, correcting the record is sufficient; no real refund/re-billing exists in this pilot. |
| **Closure record** | Incident log entry with before/after figures, root cause, fix reference, and the list of other transactions checked for the same exposure. `logAudit` already records the calculation event (`COMMISSION_CALCULATED`); the incident log cross-references it rather than re-describing the audit trail. |

---

## 4. Data loss or corruption discovered

| | |
|---|---|
| **Trigger** | A participant reports missing or garbled data on a property/transaction; a row-count or referential-integrity check turns up an anomaly; an unexpected `NULL`/orphaned foreign key is found. |
| **Severity** | Critical |
| **First response** | AE Backend Engineering (on-call) stops any process that might be actively writing to the affected rows and takes an immediate `pg_dump` snapshot of current state. Confirm whether the daily external backup scheduler completed and preserve its artifact/manifest evidence; do not assume an alert was received. |
| **Owner** | AE Backend Engineering (on-call), with AE Project Owner informed immediately. External scheduler, object-store/KMS, and alert-receiver accountable owners are **unassigned**. |
| **Escalation path** | AE Backend Engineering (on-call) → AE Project Owner (within 15 minutes) → AE Security/Compliance Owner (if corruption could be attacker-caused). If the failure is in scheduler, object storage, KMS, or alert receipt, escalate to its assigned external owner; until assigned, record the owner as unassigned and treat the gap as a stop-pilot candidate. |
| **Target response time** | 15 minutes to acknowledge; scope of loss/corruption identified within 2 hours |
| **Evidence to preserve** | The pre-remediation `pg_dump`, affected table/row ids, the most recent artifact and SHA-256 manifest if available, scheduler completion/failure record, and configuration-free evidence of KMS/object-store access. See `BACKUP_AND_RESTORE_RUNBOOK.md` for the current mechanical procedure. |
| **Customer/participant communication approach** | Affected participant(s) told promptly that an issue was found, what is being done, and — critically for a pilot — that this is exactly the kind of thing the pilot exists to surface before a wider launch, not something to downplay |
| **Resolution steps** | Restore and validate only to the configured fresh disposable restore environment first; verify manifest, inventory, and document integrity before any recovery decision. Reconcile any delta manually and obtain the AE Project Owner's explicit decision before an operator performs any separately planned cutover. Root-cause the corruption (application bug, infrastructure, or migration) before closure. Never restore over an active environment. |
| **Closure record** | Incident log entry with scope of loss (tables/rows/participants affected), which backup was restored from and its timestamp, the manual reconciliation steps taken, and root cause. This is also a **stop-pilot trigger candidate** (see scenario 15) if the cause is not immediately and confidently fixable. |

---

## 5. Unrecoverable service failure / extended outage

| | |
|---|---|
| **Trigger** | `GET /api/health/live` fails or times out (process wedged, not just DB) — see `routes/health.ts`'s split between liveness and readiness; or `health_check_duration_ms{status="unavailable"}` persists across repeated manual checks with no recovery after a restart attempt. |
| **Severity** | Critical |
| **First response** | AE Backend Engineering (on-call) checks liveness first, then readiness, per the existing convention documented in `SECURITY_INCIDENT_RUNBOOKS.md` #9 — a liveness failure means the process itself needs restarting, not a database investigation. Attempt one clean restart before escalating further. |
| **Owner** | AE Backend Engineering (on-call) |
| **Escalation path** | AE Backend Engineering (on-call) → AE Backend Engineering (if restart doesn't resolve it within 30 minutes) → AE Project Owner (at the 1-hour mark regardless of resolution, so a stop-pilot decision can be made if needed) |
| **Target response time** | 15 minutes to acknowledge; restart attempted within 30 minutes |
| **Evidence to preserve** | Process logs from immediately before the failure, the last successful health-check timestamp, and whatever environment/deploy change (if any) preceded the failure |
| **Customer/participant communication approach** | All participants notified of the outage as soon as it's confirmed to be more than a momentary blip (past ~10 minutes), with an honest estimate of resolution time, and a follow-up once restored |
| **Resolution steps** | Restart; if that fails, roll back the most recent deploy; if the cause is infrastructure (hosting platform outage), escalate outside the application entirely and communicate that dependency plainly to participants rather than implying an application bug |
| **Closure record** | Incident log entry with outage start/end time, root cause, and — if this is the second extended outage in the pilot window — flagged explicitly to AE Project Owner as a stop-pilot consideration (see scenario 15) |

---

## 6. An uncontained AML/identity-handling failure

| | |
|---|---|
| **Trigger** | An AML verification is found to have been marked `Complete`/verified when the underlying provider response was actually `Review Required`/`Failed` (an outcome the webhook processing is designed never to silently reinterpret — see Phase 4 in `ARCHITECTURE.md`); identity-document or provider-evidence fields are found exposed somewhere they shouldn't be (the AML/CTF exception rules are explicitly built to read/write only the safe 6-value operational status, never identity-document or provider-sensitive fields); or a Brokerage-Administrator exception-resolution bypass is found without the mandatory notes/role gate having actually been enforced. |
| **Severity** | Critical |
| **First response** | AE Backend Engineering (on-call), with AE Security/Compliance Owner joined immediately given the regulated-adjacent nature of AML data — this is never treated as a routine bug. Identify every AML verification record affected by the same code path, not just the one reported. |
| **Owner** | AE Security/Compliance Owner (accountable), AE Backend Engineering (on-call) executing the technical fix |
| **Escalation path** | AE Backend Engineering (on-call) → AE Security/Compliance Owner (immediately, no diagnosis-first delay) → AE Project Owner |
| **Target response time** | 15 minutes to acknowledge; full scope of affected records identified within 2 hours |
| **Evidence to preserve** | The affected `amlVerifications` rows (status history, `providerReference`, timestamps — never the underlying identity-document content itself beyond what's already in scope), the webhook payload that produced the incorrect status if available, and the exception-resolution audit trail if a bypass is implicated |
| **Customer/participant communication approach** | Because this is synthetic pilot data, there is no real identity subject to notify. AE Security/Compliance Owner still records this as if it were real, for the readiness assessment ahead of a wider launch — this scenario existing at all in a pilot is a signal, not just an isolated bug to close quietly. |
| **Resolution steps** | Correct every misclassified verification's status; fix the code path that allowed the misclassification (never a manual database edit alone — the fix must prevent recurrence); confirm the mandatory-notes/role gate on exception resolution is actually enforced, not just documented. |
| **Closure record** | Incident log entry plus a dedicated compliance note (owned by AE Security/Compliance Owner) assessing whether this defect would have been safe to carry into a real launch — this assessment is a required input to any go/no-go decision beyond the pilot. |

---

## 7. Inability to restore data from backup

| | |
|---|---|
| **Trigger** | A disposable restore using `backup:restore -- --artifact=<artifact-name> --confirm-disposable` fails; manifest/inventory/document validation fails; or it completes with unexpected discrepancies. A failed or missing daily external-scheduler record, durable artifact/manifest, or backup-failure alert is also a trigger because recovery readiness is not demonstrated. |
| **Severity** | Critical |
| **First response** | AE Backend Engineering (on-call) does **not** restore anywhere except a fresh configured disposable target. Preserve the command error and test the current provider-neutral procedure in `BACKUP_AND_RESTORE_RUNBOOK.md`: manifest before decrypt, empty-target preflight, `pg_restore --exit-on-error`, inventory, and documents. |
| **Owner** | AE Backend Engineering (on-call) for the application path. Scheduler, object-store/KMS, and alert-receiver accountable owners are **unassigned** until external ownership is recorded. |
| **Escalation path** | AE Backend Engineering (on-call) → AE Backend Engineering → AE Project Owner (within 1 hour). Route scheduler/object-store/KMS/receiver faults to the assigned external owner; where none exists, explicitly record unassigned ownership and escalate to AE Project Owner. |
| **Target response time** | 30 minutes to acknowledge; root cause of the failed restore identified within 4 hours |
| **Evidence to preserve** | Artifact and SHA-256 manifest, exact command error output, schema/migration state of origin and target, inventory/document-validation result, scheduler record, and any alert-dispatch result. Do not preserve secrets, tokens, connection URLs, or decrypted payloads in the incident log. |
| **Customer/participant communication approach** | Only escalate to participant communication if this restore failure is blocking recovery from an active data-loss incident (scenario 4) — otherwise this is an internal readiness gap, not something participants need to be told about mid-pilot |
| **Resolution steps** | Identify and fix the specific cause (corrupted dump, schema drift, missing extension/permission on the target); re-run the drill end to end and record a clean result before considering backup/restore trustworthy again |
| **Closure record** | Incident log entry; if this occurred while attempting to recover from an actual data-loss event, this becomes a **stop-pilot trigger** (scenario 15) until backup/restore is proven working again |

---

## 8. A critical defect discovered with no safe workaround

| | |
|---|---|
| **Trigger** | Any defect (functional or security) is found where continuing to use the affected feature poses a real risk (data corruption, incorrect financial figures, an AML gate that can be bypassed) and no configuration change or process workaround avoids it. |
| **Severity** | Critical |
| **First response** | AE Backend Engineering (on-call) confirms there truly is no workaround (a feature flag to disable just that path, a role restriction, a "don't do X for now" instruction to participants) before concluding the feature must be taken offline entirely. |
| **Owner** | AE Backend Engineering (on-call) for the technical call; AE Project Owner for the decision to disable a feature pilot-wide |
| **Escalation path** | AE Backend Engineering (on-call) → AE Project Owner (immediately — disabling a feature affects every participant's ability to work) → AE Security/Compliance Owner if the defect is security/AML-adjacent |
| **Target response time** | 30 minutes to acknowledge; decision to disable-or-accept-risk within 2 hours |
| **Evidence to preserve** | Steps to reproduce, the affected code path, and a written statement of why no workaround exists (for the eventual fix's regression test and for the pilot retrospective) |
| **Customer/participant communication approach** | All participants told plainly which feature is unavailable, why, and roughly when it's expected back — never leave a feature silently broken without explanation |
| **Resolution steps** | Disable the specific feature (env flag, route-level gate, or role restriction) rather than stopping the whole pilot if the blast radius is genuinely contained to that feature; fix and re-enable with a regression test; if the defect turns out to be broader than first scoped, treat as scenario 15 (stop-pilot). |
| **Closure record** | Incident log entry with the disable/re-enable timestamps, fix reference, and regression test added |

---

## 9. An integration/webhook outage (e.g. email or AML provider down)

| | |
|---|---|
| **Trigger** | `integration_connection_degraded_total{provider}` shows sustained transient-error behavior; `integration_dead_letter_total{source_type}` rate exceeds baseline; `job_repeated_failure_total{job}` fires for the outbox job in question; or a participant reports an expected notification/verification never arriving. |
| **Severity** | Medium (High if it blocks an active transaction milestone, e.g. AML verification stuck mid-transaction) |
| **First response** | AE Backend Engineering (on-call) checks the admin dead-letter view for the affected `(provider, capability)` pair and confirms whether this is a real provider outage, a webhook signature/config issue (see `SECURITY_INCIDENT_RUNBOOKS.md` #7), or — in this build, since every provider is `mock` by default per pilot configuration — a local fake-provider/test-harness issue rather than a real external dependency. |
| **Owner** | AE Backend Engineering (on-call) |
| **Escalation path** | AE Backend Engineering (on-call) → AE Backend Engineering (if retries/dead-letter replay don't resolve it within a few hours) → AE Project Owner (if a transaction is materially delayed for a participant) |
| **Target response time** | 1 hour to acknowledge; 4 business hours to a resolution or a clear workaround communicated to the affected participant |
| **Evidence to preserve** | The dead-lettered command/webhook payload, the `integration_connections` row's health state, and the retry history for the affected item |
| **Customer/participant communication approach** | Tell the affected participant directly if their transaction is stalled, with an honest timeline; don't wait for them to notice and ask |
| **Resolution steps** | Once the underlying cause clears, use the existing authorised dead-letter replay path (`replayDeadLetteredCommand`/`replayDeadLetteredWebhook`, Brokerage-Administrator-gated) to re-drive the specific stuck item(s) rather than manually reconstructing the effect by hand |
| **Closure record** | The replay itself is already audited (`markReplayed` records who replayed, when, and the outcome) — the incident log entry cross-references that replay record plus the root cause and duration of the outage |

---

## 10. A pilot participant reports a bug affecting their transaction

| | |
|---|---|
| **Trigger** | A participant contacts AE Support Lead through the pilot's designated support channel (see Deliverable 2) describing unexpected behavior on a specific property/transaction. |
| **Severity** | Triaged per the standard table (default High if it blocks the participant from proceeding on that transaction, Medium if a workaround exists, Low if cosmetic) |
| **First response** | AE Support Lead captures the report (participant, property/transaction id, what was expected vs. observed, screenshots if available) and does an initial severity triage before handing to AE Backend Engineering (on-call) |
| **Owner** | AE Support Lead for intake and communication; AE Backend Engineering (on-call) for diagnosis and fix |
| **Escalation path** | AE Support Lead → AE Backend Engineering (on-call) → AE Backend Engineering (if not resolvable same-day) → AE Project Owner (if it turns out to be systemic, i.e. affects more than the one participant/transaction) |
| **Target response time** | Per severity table (High: 1 hour; Medium: 4 business hours; Low: 2 business days) |
| **Evidence to preserve** | The property/transaction id, relevant `auditLog`/timeline entries for that record, and reproduction steps |
| **Customer/participant communication approach** | Acknowledge receipt within the target response time even if a fix isn't ready yet; tell the participant what was found and when to expect resolution; follow up once fixed and confirm with them it's actually resolved from their side, not just from the code |
| **Resolution steps** | Reproduce against the specific record where possible; fix; verify the fix against the participant's actual data (synthetic, but their specific test scenario) before declaring resolved |
| **Closure record** | Tracked in the pilot issue tracker per Deliverable 2's "issues get tracked to closure" process; incident log entry only if it turns out to reveal a Critical/High-severity systemic issue (in which case it's cross-referenced into the relevant scenario above) |

---

## 11. Suspected unauthorized login / account-takeover attempt

| | |
|---|---|
| **Trigger** | A participant reports a login they didn't perform; `auth_security_event_total{event="auth_rate_limited"}` or repeated 401/403 volume against `/auth/*` from one source; or `{event="invalid_session_token"}`/`{event="revoked_session_reused"}` shows an unexplained pattern. |
| **Severity** | High (Critical if account access is confirmed to have actually succeeded, not just attempted) |
| **First response** | AE Backend Engineering (on-call) follows `SECURITY_INCIDENT_RUNBOOKS.md` #6 (confirm `authRateLimiter` is actually mounted and not bypassed by IP-spoofing) and #4 (targeted session compromise — increment `sessionEpoch` for the affected user, which immediately invalidates every outstanding token for that account). |
| **Owner** | AE Backend Engineering (on-call); AE Security/Compliance Owner if takeover is confirmed rather than just attempted |
| **Escalation path** | AE Backend Engineering (on-call) → AE Security/Compliance Owner (on confirmation) → AE Project Owner (if confirmed) |
| **Target response time** | 15 minutes to acknowledge; contained (session revoked) within 30 minutes |
| **Evidence to preserve** | Source IP/user-agent pattern from access logs, the timeline of auth attempts, and whether any state-changing action occurred during the suspected window |
| **Customer/participant communication approach** | Notify the affected participant directly, ask them to confirm their own recent login activity, and advise them their session has been reset as a precaution |
| **Resolution steps** | Revoke the session (`sessionEpoch` bump — already a self-service action via `POST /auth/logout`, or operator-triggered if the participant can't act themselves); if takeover is confirmed, review everything that account touched during the suspected window for unauthorized changes |
| **Closure record** | Incident log entry; if a real takeover (not just an attempt) occurred, treat as overlapping with scenario 2 and cross-reference |

---

## 12. A pilot participant requests their data be exported or deleted

| | |
|---|---|
| **Trigger** | A participant emails or messages AE Support Lead asking for their data to be exported or removed, or submits a request in-app (`POST /privacy/requests`). |
| **Severity** | Medium (this is a routine, expected pilot request, not an emergency — but has a firm response-time commitment because it's a rights-adjacent request even against synthetic/test data) |
| **First response** | AE Support Lead confirms with the participant exactly what they're asking for (their own property/transaction records; not another participant's) and logs the request. **Updated under the Critical Blocker Remediation pass:** a tracked request queue now exists in-app (`POST /privacy/requests`, `GET /admin/privacy-requests`, `POST /admin/privacy-requests/:id/resolve` — see `docs/legal/DATA_ACCESS_CORRECTION_DELETION_PROCESS.md`), but resolving a request there only records a human decision; it never itself exports or deletes anything, and regulated/AML records are never auto-deleted. |
| **Owner** | AE Support Lead for intake and communication; AE Backend Engineering for execution |
| **Escalation path** | AE Support Lead → AE Backend Engineering → AE Security/Compliance Owner (sign-off before any deletion is executed, since deletion is irreversible and touches audit/event history) → AE Project Owner (informed, not required to approve, for a routine request) |
| **Target response time** | Acknowledge within 1 business day; fulfil within 5 business days (export) or 10 business days (deletion, given the manual cross-table work and compliance sign-off involved) |
| **Evidence to preserve** | A record of the request itself (who, what, when) and, for a deletion, a final export taken immediately before deletion in case of dispute or a later discovered need (e.g. an in-flight transaction another participant is also party to) |
| **Customer/participant communication approach** | Set expectations up front about manual turnaround time; confirm completion in writing once done, describing what was exported or removed at a high level |
| **Resolution steps** | **Export**: AE Backend Engineering queries the participant's own records (properties, parties, offers/transactions, documents, AML status — everything scoped to their `brokerageId`/user id) and delivers a structured extract. **Deletion**: AE Security/Compliance Owner first confirms no other still-active participant's transaction depends on the record being removed (e.g. a shared property/transaction with another pilot agent) — if it does, the request is only partially fulfillable and the participant is told which parts can and cannot be removed and why (audit-trail and other-party-record obligations); AE Backend Engineering then performs the actual export or deletion directly against the database, since no automated fulfillment exists today — the in-app request queue tracks and records the decision, it does not execute it. |
| **Closure record** | Incident/request log entry recording exactly what was exported or deleted, when, by whom (role), and the Security/Compliance sign-off — this record itself is retained even after the underlying data is deleted, as the proof the request was honored. The in-app request's own `resolve` action (with resolution notes) is the primary record; this log entry cross-references it. |

---

## 13. A security vulnerability is externally reported

| | |
|---|---|
| **Trigger** | A pilot participant, or anyone else, reports a security concern directly (not via the standard bug-report channel) — e.g. "I think I can see someone else's data" or a more technical finding. |
| **Severity** | Treat as Critical until triaged — do not downgrade a security report on receipt, only after assessment |
| **First response** | AE Support Lead routes immediately to AE Security/Compliance Owner and AE Backend Engineering (on-call) without first trying to reproduce it themselves — a security report gets faster hand-off than a normal bug report, not slower. |
| **Owner** | AE Security/Compliance Owner |
| **Escalation path** | AE Support Lead → AE Security/Compliance Owner + AE Backend Engineering (on-call), in parallel → AE Project Owner (within 1 hour regardless of initial severity assessment) |
| **Target response time** | 30 minutes to acknowledge receipt to the reporter; 4 hours to an initial severity assessment |
| **Evidence to preserve** | The reporter's original report verbatim, and everything scenario 1's evidence list already covers if the report turns out to be a cross-tenant issue (the most likely category in this build's own threat model) |
| **Customer/participant communication approach** | Thank the reporter, confirm receipt promptly, and — unless they explicitly want silence — tell them once it's fixed. Never ask an external reporter to "keep testing" against a suspected live vulnerability. |
| **Resolution steps** | Route to whichever numbered scenario above actually matches once triaged (most often #1 or #2); follow that scenario's resolution steps |
| **Closure record** | Incident log entry cross-referencing whichever specific scenario it turned out to be, plus a note on how the report arrived (since an externally-sourced report is itself a signal worth tracking separately for the pilot retrospective) |

---

## 14. Planned maintenance requiring downtime

| | |
|---|---|
| **Trigger** | AE Backend Engineering identifies a change that requires downtime (a schema migration outside the safe `drizzle-kit push` pattern, an infrastructure change, a dependency upgrade needing a restart window). |
| **Severity** | Low (this is planned, not an incident — included here so the communication and logging discipline is consistent) |
| **First response** | AE Backend Engineering proposes a maintenance window to AE Project Owner with expected duration and blast radius (all participants vs. a subset) |
| **Owner** | AE Backend Engineering; AE Project Owner approves the window |
| **Escalation path** | Not applicable unless the maintenance overruns its planned window — if it does, treat the overrun itself as scenario 5 (extended outage) from the moment the planned window's end time passes |
| **Target response time** | Participants notified at least 24 hours ahead of the window for anything expected to exceed 15 minutes |
| **Evidence to preserve** | The change being deployed (migration/PR reference), pre-maintenance `pg_dump` if the change touches schema |
| **Customer/participant communication approach** | Advance notice with the specific window (date/time/expected duration), a reminder shortly before it starts, and a confirmation once complete — treat pilot participants the way any production user would be treated, since this builds the muscle for a real launch |
| **Resolution steps** | Execute the change; verify `GET /api/health/ready` and a smoke-test of the core property/transaction flow before declaring the window closed |
| **Closure record** | Logged as a maintenance record (can live in the same log as incidents, tagged distinctly) with window start/end, what changed, and confirmation of post-maintenance verification |

---

## 15. A stop-pilot condition is triggered and the pilot must be paused

| | |
|---|---|
| **Trigger** | Any of: an unresolved Critical-severity incident from scenarios 1, 4, 6, or 7 above; two or more extended outages (scenario 5) within the pilot window; a defect that cannot be safely worked around (scenario 8) and materially affects most participants; or AE Project Owner's own judgment that continuing risks participant trust or data integrity beyond what the pilot is meant to accept. |
| **Severity** | Critical (by definition — this is the top-level circuit breaker) |
| **First response** | Whoever identifies the condition (any role) raises it directly to AE Project Owner — this is not something AE Backend Engineering (on-call) decides unilaterally, since pausing the pilot has business and relationship consequences beyond the technical fix |
| **Owner** | AE Project Owner (sole decision-maker on pausing/resuming the pilot) |
| **Escalation path** | Reporting role → AE Project Owner (immediately) → AE Project Owner consults AE Security/Compliance Owner and AE Backend Engineering (on-call) before deciding, but the decision itself rests with AE Project Owner |
| **Target response time** | Decision made within 1 hour of the condition being raised |
| **Evidence to preserve** | The specific triggering incident's own evidence (per its scenario above), plus a written record of the stop-pilot decision itself and its rationale |
| **Customer/participant communication approach** | All participants told directly, promptly, and honestly that the pilot is paused, why (at an appropriate level of detail — not necessarily full technical detail if security-sensitive), and what happens to their in-progress data/transactions during the pause |
| **Resolution steps** | Freeze new participant activity (communicate a hold, do not silently let people keep working against a system under a stop-pilot condition); fix the underlying issue; run whatever verification is appropriate to the specific condition (e.g. a fresh backup/restore drill if scenario 7 triggered the stop); AE Project Owner makes an explicit resume decision — a stop-pilot is never silently un-paused by the passage of time. |
| **Closure record** | A dedicated stop/resume record: trigger, pause timestamp, remediation taken, verification performed, resume decision and timestamp, and who (role) made the resume call. This record is a required input to any decision about proceeding beyond the pilot. |

---

## 16. Key on-call person unreachable during an active incident

| | |
|---|---|
| **Trigger** | AE Backend Engineering (on-call) does not acknowledge a Critical or High severity trigger within its target response time, or is confirmed unreachable mid-incident. |
| **Severity** | Escalation condition layered on top of whatever the underlying incident's own severity is — treat the underlying incident as at least one severity level more urgent while this condition holds, since it is now also under-resourced. |
| **First response** | Whoever is waiting on the on-call response (AE Support Lead in most cases) waits no longer than the scenario's own target response time before escalating past the unreachable person's role, not to a specific named backup — i.e. escalate to AE Backend Engineering generally (whoever else can pick it up) and AE Project Owner simultaneously. |
| **Owner** | AE Project Owner becomes the de facto incident owner until a technical responder is reached, coordinating whoever from AE Backend Engineering can be raised |
| **Escalation path** | Missed on-call ack → AE Project Owner (immediately) → any available AE Backend Engineering member → if genuinely no engineering responder can be reached within 2x the scenario's target response time, AE Project Owner makes an interim containment call (e.g. taking a feature offline, as in scenario 8, or invoking scenario 15) using only actions available without an engineer (env var change, restart, or a scenario-15 pause communication) |
| **Target response time** | Escalation triggered the moment the original target response time is missed — no additional grace period |
| **Evidence to preserve** | Timestamps of every outreach attempt to the on-call role (so the pilot's own operational readiness — not just the technical incident — can be reviewed afterward) |
| **Customer/participant communication approach** | If the underlying incident is participant-visible, communicate on the same schedule the underlying scenario calls for regardless of internal staffing trouble — a participant should never wait longer because of an internal coverage gap, even if the fix itself is delayed |
| **Resolution steps** | Once a responder is reached, they pick up the underlying incident's own resolution steps; separately, AE Project Owner reviews after the fact why on-call coverage failed (wrong contact info, no backup identified, genuine unavailability) and closes that gap for the rest of the pilot |
| **Closure record** | Logged as its own entry (coverage-gap record), separate from but cross-referenced to the underlying incident's own closure record — this is pilot operational-readiness data, tracked so it can inform staffing decisions before any wider launch |

---

## Where incidents get logged

Every scenario above writes to one shared **pilot incident log** (a simple structured
log — spreadsheet or lightweight tracker is sufficient for 5-10 participants; this
runbook does not mandate a specific tool). Each entry records at minimum: date/time,
scenario number, severity, trigger, owner (role), affected participant(s) if any,
resolution summary, and closure timestamp. This is distinct from, and does not replace,
the application's own `auditLog`/`domainEvents` tables, which continue to record every
in-application state change regardless of whether it became an incident — the incident
log is the human-facing operational record; the audit log is the system's own record.
Deliverable 2 (`docs/PILOT_SUPPORT_AND_ESCALATION.md`) describes the day-to-day intake
and review cadence that feeds this log.
