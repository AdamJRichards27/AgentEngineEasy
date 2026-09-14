# AE GROW Priority 6 — Stage F: Contact Calling, Consent, Recording and Relationship Intelligence

**Status: READ-ONLY DISCOVERY AND ARCHITECTURE. No Stage F code, no real calls, no recording or audio upload, no provider account, no credential, no purchased number, and no accepted provider contract exists as a result of this document.** Nothing here activates anything. Every dollar figure, legal characterisation, and provider claim below is dated to **14 September 2026** and must be re-verified before any commercial or legal commitment is made on its basis.

This document is the required output of AE GROW Priority 6 Stage F discovery, produced immediately after Stage E ("Voice as Input") merged to `staging` and its post-merge CI succeeded. It follows the same documentation-safe editing and byte-fidelity verification discipline used throughout this engagement: this file is fetched and re-compared after every push.

---

## 0. Scope and boundaries of this document

Stage F's intended customer experience is: an agent opens a contact, selects Call, AE retrieves the authorised phone number, the agent confirms the contact and number before dialling, the call is placed through an approved telephony provider, the call is recorded only when consent and jurisdictional rules are satisfied, the recording is transcribed, a reviewable summary is generated, key points/commitments/follow-ups are identified, the agent reviews and edits every output, approved information is attached to the Relationship Timeline, and any next action is *proposed* — never auto-executed — through the existing Stage D governance path.

Seven capabilities are named here because they are legally and architecturally distinct, and Stage F must never fuse them into a single inseparable feature:

1. Click-to-call without recording.
2. Call recording.
3. Live disclosure/consent at the start of a call.
4. Transcription.
5. Summary/relationship-intelligence generation.
6. Storage/retention of the recording and transcript.
7. Human-reviewed CRM updates and governed action proposals.

This document does not build any of them. It researches and architects all seven, and it explicitly separates the parts that are safe to build now with mocks (no external account, no real audio, no real number) from the parts that must stay disabled until a named human — the Project Owner, a lawyer, or a telephony vendor — makes a decision this document cannot make on its own.

---

## 1. Current-state findings

Read directly from the `staging` branch (post-Stage-E-merge) via the GitHub API, not assumed from memory:

**Contact / phone-number source of truth.** The canonical contact record is the `parties` table (`packages/db/src/schema/property.ts`), read and written through `apps/api/src/routes/contacts.ts` ("AE GROW Priority 2 — Contact Intelligence & Relationship Timeline"). A party carries `mobile` as a plain nullable text column. There is **no E.164 normalisation, no verification step, and no "which number did we actually dial" audit field** anywhere in the schema or route code read for this discovery. `communications/consent.ts` has its own, separate, lightweight phone-normalisation helper (`normalizeDestination`, strips everything but digits and a leading `+`) used only for SMS consent-record keys — it is not applied to `parties.mobile` and is not a validated E.164 formatter. **Gap:** Stage F's "AE retrieves the authorised phone number" and "confirms the number before dialling" steps have no existing verified-number infrastructure to call into; F1 must add one (see §6, §9).

**Contact 360 / Relationship Timeline integration points.** `GET /grow/contacts/:partyId` already assembles a single Contact 360 view: canonical identity, Grow roles, household relationships, property relationships, opportunities, recent `growActivities`/`growCommitments`, the Relationship Timeline (`getRelationshipTimeline()`, `apps/api/src/lib/relationshipTimeline.ts`), and a deterministic Contact Intelligence Summary. This is the natural mount point for a "Call" action and for a call's eventual timeline entry — Stage F does not need a new contact surface, only a new activity/event type feeding the existing timeline and a new commitment-creation path feeding the existing `growCommitments` table exactly as `POST /grow/contacts/:partyId/commitments` already does.

**Existing communications architecture.** `apps/api/src/lib/communications/` (Priority 8, "Communications Hub") already contains: `consent.ts` (opt-in/opt-out gate for EMAIL/SMS), `webhooks.ts` (HMAC-SHA256-verified, idempotent, tenant-scoped inbound webhook processing), `outbox.ts` (status-transition/state-machine pattern for a message's lifecycle), `providers/` (currently only `sandboxEmail.ts` and `sandboxSms.ts` — **no real HTTP provider and no voice/telephony provider exists today**), `quietHours.ts` (configurable, timezone-aware, opt-in send-time restriction), `costControl.ts`, `recipientResolution.ts`, `settings.ts`, `templates.ts`, `messages.ts`. This is the closest existing analogue to what Stage F needs for calls, and §6 deliberately reuses its patterns (idempotent webhook processing, an outbox-style state machine, a provider abstraction with a sandbox default) rather than inventing new ones.

**Consent / privacy fields — the most important finding of this discovery.** The `communicationConsent` table and `checkConsent()` gate cover **EMAIL and SMS only**. Read directly from `consent.ts`'s own doc comment: *"PHONE_CALL / EXTERNAL_MESSAGE / INTERNAL_NOTE carry no consent record and are always allowed here — INTERNAL_NOTE never leaves the app at all, and PHONE_CALL/EXTERNAL_MESSAGE are records of something that already happened outside this app, not a send this app is about to perform."* In other words: **the codebase today has no concept of call-recording consent, no field for it, and the one channel-consent gate that exists explicitly does not apply to phone calls at all.** There is also no field anywhere for: consent version/source/date/scope, withdrawal of a specific recording consent, participant identity capture for a call, whether a disclosure was played/spoken, or one-call-vs-standing-future-calls consent. This finding is the direct evidence behind, and fully justifies, the standing instruction not to assume marketing consent equals call-recording consent — the two are not just conceptually different, they are *architecturally* unconnected in this codebase today.

**Document/audio storage architecture.** `apps/api/src/lib/documentStorage.ts` plus `packages/integrations/object-storage` already implement exactly the storage pattern Stage F's recordings would need: `OBJECT_STORAGE_PROVIDER` (`local` for dev/test, `s3` required in production), server-side encryption (`AES256` or `aws:kms`), a signed-download-URL flow (`DOCUMENT_STORAGE_SIGNED_DOWNLOAD_SECONDS`), named retention classes (`legal-pending, transaction, signed-agreement, general`), and a pending-upload reconciliation/quarantine job. Stage E deliberately does *not* use this: voice audio is held in memory for one request and never persisted (`apps/api/src/routes/aiVoice.ts`'s own header comment). Stage F recordings, if ever authorised, are a new retention class on this same existing infrastructure, not a new storage system.

**Stage D action governance.** `apps/api/src/lib/growCommitmentActions.ts` ("AE GROW Priority 6 Stage D") is reached only through `lib/ai/executionGateway.ts`'s AI Action Execution Gateway, after a Policy Engine has re-confirmed entitlement, role, and tamper-freedom, and after the function itself independently re-validates brokerage ownership of every referenced record (because an approval can sit queued for up to 24 hours — `actionRequests.ts`'s `DEFAULT_EXPIRY_MS` — during which a referenced record can be reassigned). This is the exact "propose, never auto-execute" path Stage F's commitment/follow-up proposals (§9 F4, §14) must reuse unmodified.

**Stage E transcription abstraction.** `apps/api/src/lib/ai/voice/` (this engagement's own prior work, now merged) provides a provider-neutral `TranscriptionProvider` interface, a deterministic mock default, and a fail-closed Deepgram adapter gated by three independent conditions (`AI_TRANSCRIPTION_PROVIDER=deepgram`, a configured `DEEPGRAM_API_KEY`, and a separate `LIVE_VOICE_TRANSCRIPTION_APPROVED=true`), with a hardcoded, non-overridable Australian (Sydney) endpoint. Stage F reuses this same interface for post-call transcription (§9 F3) rather than building a second one.

**Entitlements / audit logging.** Entitlement grants and role/tier resolution (`apps/api/src/lib/entitlements/`) are already the mechanism every Grow route (including Stage E's voice route) gates on; Stage F's own entitlement keys are new grants on the same system (§10), not a new mechanism. Audit logging (`apps/api/src/lib/audit.ts`) is a single `auditLogs` table insert wrapped in try/catch — **it is not tamper-evident** (no hash chaining, no append-only/WORM enforcement visible in this file). This is a real gap against the "tamper-evident audit history" requirement in §11/§17, inherited from the whole codebase, not introduced by Stage F, but one Stage F's call-consent and call-recording events make materially more important to close given the legal exposure a disputed consent record would carry.

**Webhook / provider / async-job framework suitable for calls.** `communications/webhooks.ts` is a complete, reusable pattern: HMAC-SHA256 signature verification with a constant-time comparison, a timestamp-freshness window (5 minutes) to resist replay, idempotency via a unique `(provider, providerEventId)` index, and tenant-safety by resolving `brokerageId` from the URL path (`/api/communications/webhooks/:brokerageId/:provider`) rather than trusting the payload. §11 specifies Stage F's telephony webhook route on this identical pattern.

**Existing subject-access/deletion process.** `apps/api/src/routes/privacy.ts` already implements a deliberately manual, never-automated data-request flow: a user creates a `privacyRequests` row; a brokerage admin resolves it by hand, through whatever process is appropriate to the data actually involved. The file's own header comment cites a Project Owner instruction that "regulated/AML records must never be auto-deleted." §12 recommends Stage F's recording/transcript deletion follow this identical manual-request-plus-admin-resolution pattern rather than an automated deletion job, at least until retention policy is legally settled.

---

## 2. Capability boundaries

What exists today and can be extended safely:

- A provider-neutral integration pattern (payments, AML, e-signature, property-data, billing, AI, voice transcription) that always defaults to mock/sandbox and requires an explicit, separately-named "live approved" flag before any real external call is possible. Stage F's telephony provider must follow this exact convention — a `LIVE_TELEPHONY_APPROVED` (or similarly named) flag, distinct from every other live-activation flag, exactly as `LIVE_VOICE_TRANSCRIPTION_APPROVED` was kept distinct from `LIVE_EXTERNAL_TRANSACTIONS_APPROVED`.
- A tenant-isolated, entitlement-gated route convention every Grow feature already follows.
- A working, tested transcription abstraction (Stage E) that Stage F's post-call pipeline can call unmodified.
- A working async/webhook processing pattern (Communications Hub) Stage F's call-event and recording-ready webhooks can follow unmodified.
- A working "propose, human-approves, re-validate at execution time" governance path (Stage D) Stage F's follow-up actions can feed into unmodified.
- A working encrypted object-storage system with named retention classes Stage F recordings can use as a new retention class.
- A working manual subject-access/deletion request process Stage F can reuse rather than building call-specific deletion tooling.

What does **not** exist today and Stage F must add, none of it as a side effect of anything else:

- Any notion of call-recording consent as a distinct, recorded fact (separate from marketing/SMS/email consent).
- Any verified/normalised phone number on a contact, or any record of which number was actually dialled.
- Any telephony provider integration, mock or real.
- Any call-session state machine.
- Any live-call disclosure/announcement mechanism.
- A cryptographically tamper-evident audit trail (a pre-existing gap, made higher-stakes by Stage F).
- Any AU/NZ jurisdiction-aware consent decision engine.

---

## 3. Legal and consent issues

**Everything in this section is an interpretation of publicly available legal and regulatory material as of 14 September 2026. None of it is legal advice, and every conclusion here that would gate a real call, a real recording, or a real disclosure script must be independently confirmed by an Australian and New Zealand lawyer before F2 is activated. Per the governing instruction for this discovery: a one-time standing recording consent is treated below as a hypothesis requiring legal review, not as an approved rule, and marketing consent is never treated as equivalent to call-recording consent.**

**What the current codebase can prove today: nothing, for calls.** As established in §1, there is no call-recording-consent field, no consent-version/source/date/scope tracking for calls, no withdrawal mechanism, no jurisdiction field on a contact or a call, no participant-identity capture, no record of whether a disclosure was played or spoken, and no distinction anywhere between "consented to this one call" and "consented to all future calls." Every one of these is a genuine gap, not a design choice, and F2 cannot activate recording until they are built (§9).

**Recording legality vs. Privacy Act notification — two separate tests.** Recording law (surveillance/listening-device statutes; Crimes Act 1961 s216B in NZ) governs whether making the recording is a criminal offence. Privacy law (Privacy Act 1988/APPs in Australia; Privacy Act 2020/Information Privacy Principles in NZ) separately governs whether *collecting* that recording as personal information was fair, notified, and secured. A call can be perfectly lawful to record under surveillance-devices law and still breach privacy law if the business never told the other party recording was happening and why. Stage F's disclosure step (§7, §8) exists to satisfy the second test, not only the first, and the two must not be conflated in the product or in this document.

**Australia — call-recording consent is not one national rule.** Based on a secondary-source state-by-state summary (recordinglaw.com, cross-checked against South Australia's own community-legal-service Law Handbook for SA specifically) of state/territory surveillance/listening-device statutes:

| Jurisdiction | Act (secondary-source citation — verify against the primary statute) | Effective regime for a business recording its own outbound/inbound call |
|---|---|---|
| Victoria | Surveillance Devices Act 1999 (Vic) s6(1) | Participant recording is outside the offence definition — the recording party being "not a party" is an element of the offence, so a participant recording their own call is not captured. |
| Queensland | Invasion of Privacy Act 1971 (Qld) s43 | Same structure — a party to the conversation is exempted from the offence. |
| Northern Territory | Surveillance Devices Act 2007 (NT) s11(1) | Same structure. |
| New South Wales | Surveillance Devices Act 2007 (NSW) s7(3) | Recording is prohibited, but excused where not made "for the purpose of communicating or publishing" to a non-party — a broad personal/business-record exception, still narrower than Group 1. |
| Tasmania | Listening Devices Act 1991 (Tas) s5(3) | Same structure as NSW. |
| Australian Capital Territory | Listening Devices Act 1992 (ACT) s4(3) | Same structure as NSW. |
| Western Australia | Surveillance Devices Act 1998 (WA) s5(3) | Prohibited with only a narrow consent/lawful-interest exception — **effectively requires the other party's consent**, no general personal-use carve-out. |
| South Australia | Surveillance Devices Act 2016 (SA) s4(2) (confirmed directly against the SA Law Handbook, current to commencement 18 Dec 2017) | Same as WA — **all-party consent required**; penalties up to $75,000 (body corporate) or $15,000/3 years imprisonment (individual). |

**Conclusion for AU: there is no single national answer.** A brokerage operating across states cannot adopt one recording rule; the jurisdiction of the *other* party (not the agent's own state) is very likely the legally relevant one for several of these regimes, and that determination — along with confirming every citation above against the current primary legislation, not this secondary summary — is exactly the kind of decision this discovery flags for legal review rather than resolving itself (§18).

**New Zealand — one-party consent for the recording offence, but a separate notification duty.** Crimes Act 1961 s216B's interception offence "does not apply" to "a party to the communication" — a business recording its own call, where an employee is a genuine party, is not committing the s216B offence. However, the Privacy Act 2020's Information Privacy Principles overlay a separate, non-criminal obligation: IPP 3 requires the agency to make the individual aware that collection (the recording) is occurring, its purpose, and who will see it; IPP 4 requires the collection method be fair and not unreasonably intrusive. A lawful recording under the Crimes Act can still be an unlawful *collection* under the Privacy Act if there is no notification. This is precisely why Stage F's disclosure step is proposed as mandatory before recording starts in every jurisdiction, not only where the recording-law test would otherwise require it.

**Australian Privacy Principles relevant regardless of recording-law outcome.** APP 1 (open and transparent management), APP 3 (collection must be reasonably necessary and by lawful, fair means), APP 5 (notify at or before collection: identity, purpose, access/correction rights, complaint process, likelihood of overseas disclosure), APP 8 (take reasonable steps to protect information before it is disclosed overseas — directly relevant to sending a recording to an overseas transcription/telephony vendor), and APP 11 (reasonable security steps) all apply to a voice recording and its transcript as personal information, independent of which state's recording-consent regime governs the recording itself.

**Do Not Call Register Act 2006 / ACMA Telemarketing and Research Calls Industry Standard — squarely relevant to Stage F's use case.** ACMA's own guidance for the real estate industry (a document published for this exact industry) states that free-appraisal offers, post-inspection follow-up calls, and listing solicitation calls **are** telemarketing calls subject to the Do Not Call Register Act; permitted calling windows are weekdays 9am–8pm and Saturdays 9am–5pm, no Sundays/public holidays for telemarketing; Calling Line Identification must be enabled and a callback number kept live for at least 30 days; the call must stop immediately on request. Consent can be express (strongest, but expires after 3 months unless a longer period is specified) or inferred from an existing relationship (an ongoing property-management relationship, for example) — merely having obtained a number is explicitly **not** sufficient to infer consent. A solicited call (the contact enquired first) is not telemarketing at all. **This means Stage F's "click to call" cannot be a blanket green light**: a call to a number on the Do Not Call Register, made for a telemarketing purpose, without current express or inferred consent, is a compliance breach regardless of whether recording happens at all — this gate sits in front of call-recording consent, not behind it, and is one more reason F1 (click-to-call, no recording) still needs a consent/eligibility check, not just F2.

**Cross-border calls.** A call between an AU-based agent and an NZ-based (or other-country) contact needs the more restrictive of the two jurisdictions' rules applied, and the transcription/storage location needs its own cross-border-disclosure assessment (APP 8) independent of the calling jurisdiction. This case is flagged for explicit legal confirmation in §18, not resolved here.

---

## 4. AU/NZ jurisdiction considerations requiring separate confirmation

Genuine decisions this discovery identifies but does not and cannot make:

- **Australia generally**: whether a single conservative "assume all-party consent required" default (aligning to the strictest states, WA/SA) is commercially acceptable, versus a jurisdiction-aware engine that varies by the *contact's* stated or inferred state.
- **Individual AU states/territories**: confirming each citation in the §3 table against the current, consolidated primary legislation (not the secondary summary used here), and confirming which party's jurisdiction controls for a cross-state call.
- **New Zealand**: confirming the Crimes Act 1961 s216B "party" exception's exact current wording (this discovery's fetch of the official legislation.govt.nz text was blocked by the site; the analysis above relies on a secondary source quoting the statute and must be checked against the primary text before go-live) and confirming what IPP 3/4-compliant disclosure wording NZ privacy counsel considers adequate.
- **Cross-jurisdiction calls**: which jurisdiction's consent rule governs, and whether the transcription/storage vendor's own location creates an additional cross-border-disclosure obligation.
- **Do Not Call Register interaction**: whether Stage F's initial scope (agent-initiated calls to a contact already in the CRM) is treated as "solicited" (the contact enquired) or "existing relationship" (inferred consent) by default, and what UI/record-keeping proves that classification if ACMA ever asks.

None of these block completion of this discovery; each is carried into §18 as a named decision for the Project Owner, AU/NZ legal counsel, or both.

---

## 5. Provider comparison (informational only — no account opened, no contract accepted, no number purchased)

All figures below are vendor-published list prices sourced 14 September 2026 and must be re-confirmed at commercial decision time; committed-volume, enterprise, or regional pricing can differ materially from list.

| Provider | AU numbers | NZ numbers | Outbound calling | Recording | Dual-channel | Webhooks | Data residency | Transcription | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **Twilio** | Yes — local $3.00/mo, mobile $8.25/mo (list) | Yes (not independently re-priced here) | Local $0.0252/min, mobile $0.0750/min (AU list) | $0.0025/min + $0.0005/min/mo storage | Yes, on by default per Twilio's own 2025 changelog | Mature, well-documented, HMAC-signed | AU1 region exists; Twilio's own regional-availability page confirms Programmable Voice is supported in AU1 "with limitations" (exact scope of the limitation not enumerated on that page), but does **not** explicitly state whether call recording specifically is AU1-resident or routes through a US region — this must be confirmed directly with Twilio before any AU-data-residency claim is made to the Project Owner or in a privacy notice | $0.0500/min built-in, or bring your own (e.g. Deepgram, reusing Stage E's adapter) | Largest ecosystem, most mature AMD (answering-machine detection) and compliance tooling of the options reviewed. |
| **Plivo** | Yes — local $2.50/mo (list) | Not separately confirmed | Local $0.0230/min, mobile $0.0730/min (AU list) | Listed at $0.0000/min (no additional recording charge) | Not independently confirmed in this pass | Available | Not independently confirmed for AU-specific data residency in this pass | Bring your own | Cheaper list pricing than Twilio on the few data points checked; smaller ecosystem; would need its own deeper security/compliance review before a production decision. |
| **Vonage (Voice API)** | Not obtained — Vonage's public pricing page did not expose AU-specific per-minute/number rates in this pass; requires a dashboard login or the vendor's downloadable global pricing sheet | Same limitation | Same limitation | Not obtained | Not obtained | Available (mature) | Not obtained | Bring your own | Cannot be meaningfully compared on price from public sources alone; would need direct vendor engagement, which this discovery is not authorised to initiate. |
| **AWS Amazon Connect** | AU region exists (Sydney, and a newer Melbourne region per AWS's own 2026 announcement) | Not independently confirmed | Not obtained in this pass | Built-in, with Contact Lens analytics | Yes | AWS-native eventing (EventBridge) rather than provider webhooks | Strong — data stays in the selected AWS region by design | Contact Lens (AWS) or bring your own | Heavier-weight contact-centre platform, not just an API; likely the most defensible AU/NZ data-residency story of the options reviewed, but a materially bigger integration and licensing lift than Twilio/Plivo for a "click to call one contact" feature. |
| **MessageMedia (now rebranding to Sinch Engage)** | AU-headquartered, strong for SMS | — | — | — | — | — | AU-based | — | **Does not appear to offer a voice/calling API** based on this pass's search — it is an SMS/messaging platform. If the business is already using or considering MessageMedia/Sinch Engage for SMS, that is a reason to plan Stage F's voice provider as a **separate** vendor relationship, not an extension of the SMS one — directly answering the "should an existing/contemplated SMS provider stay separate from voice" question in the affirmative, pending the vendor's own confirmation. |

**Implementation complexity, ranked from this pass's research (least to most integration effort for an F1-scope click-to-call feature):** Plivo/Twilio (comparable, mature REST + webhook APIs) < Vonage (comparable API shape, pricing opacity is the practical obstacle) < Amazon Connect (materially more setup — instance provisioning, contact flows — for a payoff, AU data residency, that may not be decisive at F1 scope). None of the four has been given a security questionnaire, a DPA has not been requested from any of them, and no vendor has been contacted — this table is built entirely from public documentation and must not be read as a vendor recommendation beyond the ranking stated in §19.

---

## 6. Recommended provider-neutral architecture

Mirroring Stage E's own `TranscriptionProvider` pattern and the Communications Hub's provider abstraction:

- **`TelephonyProvider` interface** (`apps/api/src/lib/ai/voice/telephony/` or a peer `lib/telephony/` module — naming TBD at implementation time): `initiateCall()`, `getCallStatus()`, `startRecording()`/`stopRecording()` (only ever invoked after the consent/disclosure gate passes), `fetchRecordingMedia()`. A mock provider is the only implementation built or enabled in F1; a real adapter (Twilio-shaped, based on §5's ranking) is written but held behind the same three-flags-together pattern Stage E uses for Deepgram, with its own uniquely-named live-approval flag.
- **Call-session state machine** — see §8 — persisted in a new `growCallSessions`-style table (naming TBD), keyed by brokerageId/partyId/initiating user, mirroring `growCommitments`'s existing tenant-scoping convention.
- **Webhook verification and idempotent event processing** — reuse `communications/webhooks.ts`'s exact pattern: HMAC verification over raw bytes, timestamp freshness window, idempotency via a unique `(provider, providerEventId)` index, brokerageId resolved from the URL path never the payload.
- **Explicit user confirmation before dialling** — a required, blocking UI step naming the resolved contact and the exact number about to be dialled, mirroring Stage E's own "voice only ever fills the text box, the agent must still press Send" non-automation discipline.
- **Server-side tenant/entitlement checks** — new entitlement keys (§10) checked exactly where every other Grow route checks them (`requireAuth` + `requireEntitlement`), never client-asserted.
- **Consent decision engine** — a new, dedicated module (not a reuse of `communications/consent.ts`, which is explicitly EMAIL/SMS-scoped) that evaluates, per contact/per call: Do Not Call Register status and classification (telemarketing vs. solicited vs. existing-relationship), and — only for F2 — jurisdiction-aware recording-consent status. Deliberately modelled on, but not sharing storage with, the existing consent gate, so a future audit can see call-consent and message-consent as clearly separate decisions.
- **Recording policy decision** — a pure function of the consent decision engine's output plus the call's resolved jurisdiction; recording is enabled only when this function says so, never by default.
- **Temporary media handling** — audio held in memory/short-lived temp storage only until the encrypted-storage write (or immediate discard, for F1's no-recording case) completes, following Stage E's "never write to disk unless explicitly persisting" discipline.
- **Encrypted storage if retention is authorised** — a new named retention class on the existing `apps/api/src/lib/documentStorage.ts` / `packages/integrations/object-storage` infrastructure (§1), not a new storage system.
- **Transcription through the Stage E abstraction** — the existing `TranscriptionProvider` interface, called on the completed recording rather than a live upload, no change to that interface required.
- **Summary generation** — a new AI role/prompt (following the existing `lib/ai/` role-flag convention — `AI_PITCREW_AI_ENABLED`-style per-role flag) producing a draft summary and candidate commitments, never persisted until a human reviews it.
- **Human review before CRM persistence** — a required draft/review UI step; nothing from the call pipeline writes to `growActivities`, `growCommitments`, or the Relationship Timeline without an explicit agent save action.
- **Relationship Timeline events** — once reviewed and saved, a new activity type feeding `getRelationshipTimeline()` exactly as existing activities do.
- **Stage D action proposals** — any recommended follow-up goes through the existing AI Action Execution Gateway/Policy Engine, using `growCommitmentActions.ts`'s existing `createApprovedGrowCommitment()` as the execution target for a "create commitment from a call" action, not a new execution path.
- **Retention/deletion jobs** — modelled on the existing manual privacy-request process (§1, §12), not a new automated deletion job, at least initially.
- **Audit trail** — every consent decision, recording start/stop, and access to a recording/transcript logged via the existing `logAudit()` call, with the tamper-evidence gap (§1, §17) flagged as a improvement to make before F2 activates, not a blocker to F1.
- **Failure recovery** — webhook retries and idempotency (already the Communications Hub pattern) cover provider-side delivery failures; a call session that never receives a terminal webhook needs a timeout/reconciliation job, mirroring `documentStorageReconciler.ts`'s existing pending-upload reconciliation pattern.
- **Cost/abuse controls** — a dedicated rate limiter per brokerage/user, mirroring Stage E's own `voiceRateLimiter.ts` (20/hour per brokerage, 8/hour per user, plus a concurrency guard) — calls are more expensive than a transcription request, so this ceiling should if anything be tighter, not equal.

---

## 7. Data-flow and storage model

1. Agent opens Contact 360 → selects Call → client requests the contact's authorised number from the server (never trusts a client-cached number) → server returns the verified number plus the consent/DNC classification for display.
2. Agent confirms contact + number in a blocking UI step → client calls `POST /grow/calls` (or similar) with only `partyId` and the resolved role/mode — no client-supplied number override, mirroring Stage E's `transcribeSchema`'s single-field discipline.
3. Server re-resolves the number itself, re-checks entitlement, tenant ownership, and the consent/DNC decision engine, creates a `growCallSessions` row in `requested` state, and — only for F1 — calls the mock telephony provider to place the call with recording disabled.
4. Telephony provider webhooks (signed, idempotent, tenant-scoped) drive the session through `dialling → ringing → connected → completed` (or `failed`).
5. **F2 only, once legally authorised**: before `connected` can transition to `recording`, the disclosure/consent workflow must reach `consent-confirmed`; if it cannot, the call proceeds in `recording-disabled` state — the call is never blocked from happening, only recording is gated.
6. On `completed`, if a recording exists, its media is fetched once (webhook-driven, idempotent) into short-lived temp storage, encrypted, and written to the new retention class on the existing object-storage infrastructure — never written to application logs, never kept in memory past the request.
7. The stored recording is handed to the Stage E `TranscriptionProvider` abstraction → a draft transcript.
8. A summary-generation step (new AI role) produces a draft summary and candidate commitments from the transcript — persisted nowhere yet.
9. Agent reviews/edits the draft in a UI step; only on explicit save does the reviewed summary become a Relationship Timeline event, and only an explicitly agent-approved commitment goes through Stage D's existing proposal path.
10. Retention/deletion follows the existing manual privacy-request process (§1, §12) unless and until an automated policy is separately authorised.

---

## 8. Proposed state machine

States, in the order a call session can reasonably move through them (not every path is linear — `failed` and `deletion-scheduled`/`deleted` are reachable from most states):

`requested → validating-contact → consent-check-required → ready-to-dial → dialling → ringing → connected → { recording-disabled | disclosure-required → consent-confirmed → recording } → completed → media-processing → transcribing → awaiting-agent-review → { approved | partially-approved | discarded } → [ deletion-scheduled → deleted ]`, with `failed` reachable from `validating-contact`, `dialling`, `ringing`, `connected`, `media-processing`, or `transcribing`.

Jurisdictional/consent transitions made explicit:

- `consent-check-required` evaluates DNC/telemarketing classification (§3) before the call can even be placed — this gate exists regardless of recording, and can itself resolve to a hard stop (no `ready-to-dial` transition) if the call would be an unlawful telemarketing call to a registered number with no current consent.
- `connected → disclosure-required` fires only when the jurisdiction/consent engine says recording is *potentially* available for this call; it is skipped straight to `recording-disabled` whenever the engine cannot establish consent, whenever the applicable jurisdiction's rule cannot be determined with confidence, or whenever F2 has not been activated at all (F1 scope).
- `disclosure-required → consent-confirmed` requires either a played/spoken disclosure the callee did not object to within a defined window, or an equivalent confirmed mechanism the eventual legal review approves — this discovery does not prescribe the exact UX for it, only that the state machine must not skip it.
- `awaiting-agent-review → partially-approved` exists because an agent may accept the transcript/summary but reject a proposed commitment, or vice versa — the two must be independently approvable, not a single all-or-nothing save.
- `deletion-scheduled → deleted` is reachable from `completed` onward and is intentionally modelled as a scheduled, reviewable transition (mirroring the manual privacy-request pattern), not an immediate hard delete.

---

## 9. Phased F1–F4 plan

**F1 — Click-to-call foundation.** Contact-number confirmation UI and server-side resolution/verification; provider-neutral call-session model and state machine (minus the recording branch); mock telephony provider only; new entitlement keys; strict tenant isolation; audit trail on every state transition; **no recording capability exists in the code at all, not merely disabled by a flag** — this is the safest possible F1 boundary and the one this discovery recommends. Can be built entirely with mocks, no external account, no real number, no legal sign-off beyond confirming the DNC/telemarketing classification logic in §3/§8 with counsel before F1 ships (this one check is recommended even for F1, since it gates whether the call may be placed at all, independent of recording).

**F2 — Consent/recording controls.** Jurisdiction-aware consent decision engine; disclosure/consent workflow; recording policy decision function; real provider's recording controls (still behind mock-by-default plus the three-flags-together live-approval pattern); encrypted storage on the new retention class; retention policy. **Requires completed AU/NZ legal review before the live-approval flag can ever be set to true in production** — this is the hard gate; F2's *code* can be built and tested entirely against the mock provider and synthetic consent scenarios without waiting for that review, but the live flag must not flip until it concludes.

**F3 — Transcription/review.** Reuse of the Stage E transcription abstraction against completed recordings; draft summary/commitment generation; the mandatory human-review/edit UI; Relationship Timeline persistence on explicit save. Buildable and testable entirely with mock recordings once F1/F2's plumbing exists; does not independently require new legal review beyond what F2 already required, since it only processes a recording F2 already gated.

**F4 — Governed follow-up intelligence.** Commitment/next-step extraction feeding the existing Stage D proposal path (`growCommitmentActions.ts`'s pattern, unmodified); no new execution path, no autonomous execution at any point. Buildable once F3's reviewed-summary data exists; carries no additional legal gate beyond F2/F3's, since Stage D's existing human-approval requirement already applies.

**What can be built safely with mocks before any commercial/legal approval:** all of F1's code, all of F2's and F3's code paths (against the mock telephony provider and synthetic/test consent data), and all of F4. **What must remain disabled in any real environment until named approvals land:** any live telephony call (needs a Project Owner provider decision, §18), any live recording (needs the AU/NZ legal review above, in addition to the provider decision), and any live transcription of a real call (needs Stage E's own already-established live-transcription approval to also cover call-sourced audio, since that approval was scoped to the voice-as-input feature, not calls — this is a decision for §18, not an assumption this document makes).

---

## 9a. Product safeguards (required, apply across every phase)

Restated here in full because they are binding on F1 through F4, not optional guidance: no automatic dialling from an AI suggestion — a human always initiates the call; visible confirmation of the contact and the exact phone number before dialling; no recording based solely on marketing consent (§3's central finding); no hidden or background recording — a call is either visibly/audibly recording or it is not; a clear, persistent recording indicator whenever recording is active; recording disabled whenever consent cannot be established, never defaulted to on; an agent must be able to continue a call without recording where that is lawful, rather than the system forcing an all-or-nothing choice; no automatic CRM update from raw AI output — every transcript, summary, and commitment is reviewed before saving (§6, §13); no automatic outbound message triggered by a call's summary; no automatic commitment creation — every proposed action is routed through Stage D's existing human-approval flow (§14) and none is executed autonomously; strict tenant isolation on every call-related record and route (§10); role/entitlement enforcement identical in rigor to every other Grow route (§10); a tamper-evident audit history — flagged in §1/§17 as a gap the existing `auditLogs` mechanism does not yet close, and one this discovery recommends closing before F2's live-approval flag is ever set; and deletion/subject-access support via the existing manual privacy-request process (§12) rather than a bespoke mechanism.

---

## 10. Entitlement and tenant model

New Grow entitlement keys, following the existing `grow.contacts.read` / `grow.contacts.manage` / `grow.activities.manage` convention (`packages/db/src/schema/billing.ts`'s reserved-but-unused pattern) rather than overloading an existing key: a call-initiation key (e.g. `grow.calls.place`) and a call-review/persistence key (e.g. `grow.calls.manage`), gated through the same `requireAuth` + `requireEntitlement` middleware chain every other Grow route uses, with brokerage ownership re-checked server-side on every request exactly as `contacts.ts` and `growCommitmentActions.ts` already do — a client-supplied brokerage, contact, or number is never trusted, matching Stage E's own `transcribeSchema` discipline of accepting the minimum possible client input.

---

## 11. Security and webhook controls

Telephony provider webhooks reuse `communications/webhooks.ts`'s exact, already-tested pattern: HMAC-SHA256 (or the specific provider's documented equivalent — Twilio, for example, uses its own request-signature scheme that would need its own verifier, following the same shape) over the raw request body, a timestamp-freshness window, idempotent processing keyed on `(provider, providerEventId)`, and a tenant-scoped URL so `brokerageId` is always server-resolved. Recording media fetches (a webhook-provided, time-limited URL in most providers' designs) must be fetched exactly once, server-side, immediately encrypted into the new storage retention class, and never proxied through a client-facing URL that bypasses signed-download expiry.

---

## 12. Retention and deletion approach

Recommended default: reuse the existing `privacyRequests` manual-request-plus-admin-resolution flow (§1) for call recordings and transcripts, at least until a specific, legally-reviewed retention period is set. A time-based retention job (auto-expire after N days) is a reasonable *later* addition once that period is legally confirmed, but should not be built as the initial mechanism, consistent with the Project Owner's existing instruction (found verbatim in `routes/privacy.ts`'s own header comment) that regulated records must never be auto-deleted without deliberate policy backing it.

---

## 13. Relationship Timeline integration

A new activity type (extending `GROW_ACTIVITY_TYPES`, the same enum `task_completion` already belongs to) fed into `getRelationshipTimeline()` on explicit agent save only — never automatically from a raw transcript or summary, mirroring the "no automatic CRM update from raw AI output" safeguard (§9a) exactly.

---

## 14. Stage D governance integration

Any follow-up action Stage F's summary step recommends is created as a *proposal*, executed only through the existing AI Action Execution Gateway → Policy Engine → `growCommitmentActions.ts`'s `createApprovedGrowCommitment()` path, which already independently re-validates brokerage ownership of every referenced record at execution time (not merely at proposal time) — this is not a new governance model, it is Stage D's existing one, unmodified, given a new AI-generated proposal source.

---

## 15. Tests and acceptance criteria (for when implementation begins — not run in this discovery)

Following the established pattern from Stage D/E (route-level HTTP tests against the real app, plus unit tests per module): consent/DNC decision engine unit tests covering every §3 jurisdiction branch and the "cannot determine jurisdiction" fallback; call-session state-machine tests covering every transition in §8 including the jurisdictional branches; webhook idempotency/signature tests mirroring `communications/webhooks.ts`'s own existing test style; a mock-provider end-to-end test of the full F1 happy path with no recording; F2 tests proving recording is impossible to enable without all three live-approval conditions simultaneously true, mirroring Stage E's own `mustForceMockVoiceTranscriptionProvider()` tests; review-gate tests proving no Relationship Timeline write or Stage D proposal can occur without an explicit agent save action, mirroring Stage E's own "never creates an aiInteractions row" proof test.

---

## 16. Cost scenarios

All figures are Twilio's AU list pricing (§5) — the most completely obtained data set in this pass — used as the illustrative baseline; Plivo's lower list figures would reduce these further, and neither vendor's number has been confirmed by direct contract. Assumptions (stated explicitly, all adjustable): each active agent makes an average of 8 outbound calls/day on days they work, roughly 20 working days/month (160 calls/agent/month); average call duration 4 minutes; recording enabled for 50% of calls once F2 is legally authorised (0% until then); every recorded call is transcribed.

Per-agent monthly estimate once F2 is live: outbound minutes 160 × 4 = 640 min × $0.0252–$0.0750/min (local/mobile mix, assume 60/40 local/mobile blend ≈ $0.0403/min average) ≈ **$25.79**; one AU mobile or local number rented per agent (assume shared brokerage numbers in practice, so this is a ceiling, not a per-agent certainty) ≈ **$3.00–$8.25**; recording at 50% of 640 min = 320 min × $0.0025/min ≈ **$0.80**, plus storage at $0.0005/min/mo on stored minutes ≈ **$0.16**; transcription at 320 min × Deepgram's own pre-recorded rate (not independently re-priced in this pass — Stage E's existing report should be the source for this figure) — flagged as **not independently confirmed here** rather than guessed. AI summarisation cost depends entirely on the model and prompt size chosen for F3/F4 and is not estimated here for the same reason. Webhook/infra overhead is treated as negligible incremental cost against existing compute.

| Active agents | Outbound minutes (est.) | Calling cost (est., ex-transcription/AI) | Number rental (shared, illustrative) |
|---|---|---|---|
| 10 | 6,400 | ≈ $258 | ≈ $30–$83 for a handful of shared numbers |
| 50 | 32,000 | ≈ $1,290 | scales sub-linearly if numbers are shared/pooled |
| 150 | 96,000 | ≈ $3,868 | scales sub-linearly |
| 500 | 320,000 | ≈ $12,893 | scales sub-linearly |

These figures exclude transcription, AI summarisation, storage beyond the trivial recording-storage line, and monitoring/alerting overhead — all of which are real but not independently priced with confidence in this pass — and must be re-derived against actual negotiated vendor pricing before any budget commitment.

---

## 17. Risk register

- **Legal risk — recording without valid consent.** The single highest-severity risk this discovery identifies: recording a call without satisfying the *correct* jurisdiction's consent rule is a criminal offence in several AU states and NZ, independent of any Privacy Act breach on top of it. Mitigated only by not shipping F2 until AU/NZ legal review is complete, and by F1 shipping with no recording capability in the code at all.
- **Legal risk — Do Not Call Register.** A blanket "call any contact" feature would make it trivial for an agent to place an unlawful telemarketing call to a registered number with no current consent. Mitigated by the DNC/telemarketing classification gate proposed in §3/§8/§9, which this discovery recommends applying even at F1, before recording is a factor at all.
- **Tamper-evident audit gap.** The existing `auditLogs` mechanism is not cryptographically tamper-evident. For ordinary Grow activity this is a modest risk; for a disputed "did we have consent to record this call" question, it materially weakens the brokerage's evidentiary position. Recommended as a cross-cutting hardening item to complete before F2's live-approval flag is ever set, not necessarily before F1 or F2's code ships.
- **Cross-border ambiguity.** A call between parties in different AU states, or between AU and NZ, has no settled "whose rule applies" answer in this discovery — flagged to legal review (§4, §18), not resolved.
- **Vendor lock-in / data-residency confidence.** None of the four providers compared in §5 has had a security questionnaire or DPA requested; Twilio's AU1 region's actual feature coverage for Voice specifically was not confirmed past a generic caution in Twilio's own docs. A wrong assumption here could mean recordings transiting or resting outside Australia despite an intended AU-residency requirement.
- **Cost/abuse risk.** Calls cost real money per minute in a way transcription-of-an-upload does not; without a call-specific rate limiter tighter than Stage E's existing voice limiter, a compromised or careless account could run up meaningful provider charges quickly.
- **Feature-fusion risk.** The single biggest product-safety risk named in the governing instruction: building click-to-call, recording, disclosure, transcription, summarisation, storage, and CRM-write as one inseparable feature would make it impossible to ship F1 safely while F2's legal review is pending. This document's phased plan (§9) exists specifically to prevent that fusion.

---

## 18. Genuine Project Owner / legal / provider decisions this discovery cannot make

1. **Telephony provider selection** — a commercial decision among (at minimum) Twilio, Plivo, Vonage (pending real pricing), and Amazon Connect, informed by §5 but not concluded by it; no account may be opened, no contract accepted, no number purchased, and no credential added until this decision is made.
2. **AU/NZ legal review of the entire §3 analysis** — every jurisdiction citation, the cross-border question, the adequacy of a proposed disclosure script, and specifically whether a "standing consent to all future calls" model is ever acceptable in any AU state or NZ, must be confirmed by qualified counsel before F2's live-approval flag can be set. This discovery's own legal content is an interpretation of public material, not legal advice, and is explicitly not a substitute for that review.
3. **Do Not Call Register classification methodology** — whether Stage F's initial contact set (existing CRM contacts) is treated as solicited/existing-relationship by default, and what evidence is kept to support that classification if challenged.
4. **Whether Stage E's existing live-transcription approval (once granted) extends to call-sourced audio**, or whether that is treated as a separate approval given the different risk profile (a call's audio was not necessarily volunteered by the person being transcribed, unlike Stage E's voice-as-input feature where the agent is transcribing their own speech).
5. **Retention period** for call recordings/transcripts once F2 is legally reviewed — this discovery recommends starting with the existing manual privacy-request process (§12) rather than picking a number, but a real retention period still needs to be set eventually.
6. **Budget ceiling** per the cost scenarios in §16, once vendor pricing is confirmed by direct engagement rather than public list prices.
7. **Whether an existing/contemplated SMS provider (MessageMedia/Sinch Engage) should be asked directly whether it offers, or plans to offer, voice** — this discovery's public-search finding that it does not is not a vendor-confirmed fact.

---

## 19. Recommended default path

Ship **F1 only**, with no recording capability present in the code at all (not merely flagged off), gated by the DNC/telemarketing classification check from day one. Begin AU/NZ legal review of §3/§18 in parallel with F1's build, so F2 is not blocked waiting for a review that could have started earlier. Among the providers compared in §5, Twilio is the most defensible starting point for a real (eventually-activated) adapter given its documented AU1 region, mature webhook/signature tooling, and built-in AMD — but this is a provisional ranking from public documentation only, not a vendor recommendation ready for a purchase order; Plivo remains a reasonable lower-cost alternative worth a direct pricing conversation before the final choice. Do not build F2, F3, or F4's *live* paths (their code can still be written and tested against mocks) until the legal review in §18 item 2 is complete and the provider decision in §18 item 1 is made.

---

## 20. Exact next implementation instruction

Once the Project Owner has reviewed this document: authorise F1 implementation explicitly and separately from any F2/F3/F4 authorisation, confirm the exact entitlement key names proposed in §10 (or provide alternates), and separately commission the AU/NZ legal review named in §18 item 2 so it can proceed in parallel with F1's build rather than after it. No further Stage F code should be written until that F1-specific authorisation is given in chat, in the same explicit, itemised style as the Stage E merge authorisation that governed this session — this document is discovery and architecture only, and deliberately stops here.
