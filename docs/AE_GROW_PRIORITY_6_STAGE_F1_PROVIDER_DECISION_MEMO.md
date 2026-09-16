# AE GROW Priority 6 Stage F1 — Telephony Provider Decision Memo

**Status: DECISION-SUPPORT MEMO ONLY.** This document does not select a provider, open a provider account, accept a provider contract, purchase a phone number, or configure any credential. F1's implementation contains exactly one telephony provider — `SandboxTelephonyProvider` — and no code path in F1 can reach a real telephony vendor. `LIVE_TELEPHONY_APPROVED` defaults to `false` and no F1 code sets it to `true` under any condition. This memo exists to satisfy the F1 authorisation's requirement for a provider comparison memo, so the Project Owner has a single, current reference to work from when a real provider decision is eventually made — that decision itself remains entirely open and is not made here.

This memo summarises and lightly updates the provider comparison already produced in PR #39 (`docs/AE_GROW_PRIORITY_6_STAGE_F_DISCOVERY_AND_ARCHITECTURE.md`, §5 and §19), rather than duplicating that research. Anyone making the actual provider decision should read that document's §5 (full comparison table), §18 item 1 (the decision itself, listed as a Project Owner decision this discovery could not make), and §19 (the discovery's own provisional, non-binding ranking) in full before proceeding — nothing below supersedes those sections.

---

## 1. Why this memo exists at F1, when F1 has no live provider

The governing F1 authorisation requires this comparison to exist before F1 is presented as complete, on the reasoning that the Project Owner should not have to wait for F2's authorisation request to start thinking about the provider decision — AU/NZ legal review (PR #39 §18 item 2) and provider selection can and should run in parallel with F1's build, not sequentially after it. This memo is that parallel-track artefact. It changes nothing about F1's scope: F1 ships with `SandboxTelephonyProvider` only, and the `TelephonyProvider` interface (`apps/api/src/lib/telephony/provider.ts`) is deliberately provider-neutral so that whichever vendor is eventually chosen plugs into the same interface without changing F1's call-session model, state machine, consent model, or webhook foundation.

## 2. Candidates carried forward from PR #39

The same five vendors named in the governing F1 authorisation are evaluated: Twilio, Plivo, Vonage, AWS Amazon Connect, and MessageMedia/Sinch Engage. No new vendor research was performed for this memo; pricing and capability figures below are restated from PR #39 §5 (sourced 14 September 2026) and are already flagged there as needing re-confirmation at commercial decision time — that caveat applies here too, unchanged.

| Provider | AU calling (list) | Recording | AU data residency | Voice capability | F1-relevant note |
|---|---|---|---|---|---|
| **Twilio** | Local $0.0252/min, mobile $0.0750/min | $0.0025/min + storage | AU1 region exists; Voice support "with limitations" not fully enumerated by the vendor's own docs — unconfirmed for recording specifically | Yes, mature | PR #39's provisional top pick: most mature webhook/signature tooling and built-in AMD, which is why F1's `SandboxTelephonyProvider` and webhook foundation (HMAC verification, idempotent `(provider, providerEventId)` handling) were deliberately modelled on Twilio-shaped semantics, so a future real adapter has the least structural distance to cross. |
| **Plivo** | Local $0.0230/min, mobile $0.0730/min | Listed at no additional per-minute charge | Not independently confirmed | Yes | Lower list pricing on the data points checked; would need its own security/compliance review before a production decision. Fits the same `TelephonyProvider` interface with no F1-side changes required. |
| **Vonage** | Not obtained from public sources | Not obtained | Not obtained | Yes (mature API) | Cannot be meaningfully compared without direct vendor engagement, which remains out of scope for this memo exactly as it was for PR #39. |
| **AWS Amazon Connect** | Not obtained in this pass | Built-in, with Contact Lens analytics | Strong — AU region(s) by design | Yes, but a full contact-centre platform rather than a simple calling API | Likely the strongest AU/NZ data-residency story, at materially higher integration/licensing weight than a single click-to-call feature needs at F1/F2 scope. |
| **MessageMedia / Sinch Engage** | — | — | AU-based | **No voice/calling API found** in PR #39's research | If already used or considered for SMS, this discovery's finding supports treating voice as a separate vendor relationship rather than an extension of the SMS one — subject to the vendor's own confirmation, which has not been sought. |

## 3. What F1's implementation already assumes, and does not assume, about the eventual choice

F1 deliberately keeps the provider question fully open at the code level:

- The `TelephonyProvider` interface (`initiateCall`, `getCallStatus`, `startRecording`/`stopRecording`, `fetchRecordingMedia`) has no Twilio-, Plivo-, Vonage-, or Connect-specific method shapes in it. Any of the four calling-capable vendors above could implement it without changing the interface.
- `SandboxTelephonyProvider`'s deterministic `providerCallId` format (`sandbox_call_<id>`) and its webhook payload shape are internal to F1 and are not a real vendor's payload shape — a real adapter will need its own payload mapping regardless of which vendor is chosen, so no vendor-specific assumption has been baked into F1's tests.
- The webhook ingress (`growCallsWebhooksRouter`, `POST /grow/calls/webhooks/sandbox`) reuses the Communications Hub's HMAC-verification pattern (`lib/communications/webhooks.ts`), which is vendor-neutral — Twilio's own request-signature scheme differs in detail (it is not raw HMAC-SHA256 over the body in the same way) and would need its own verifier function if Twilio is eventually chosen; this is flagged here so it is not mistaken for already-solved.
- No F1 code contains a phone number, account SID, API key placeholder, or vendor SDK dependency for any of the four calling-capable vendors. Adding any of them is entirely an F2-or-later activity, gated by `LIVE_TELEPHONY_APPROVED` plus the same three-flags-together pattern Stage E established for its transcription provider.

## 4. This memo's recommendation, and what it is not

Consistent with PR #39 §19's own framing, this memo repeats — without adding new independent research — that **Twilio is the most defensible starting point for a real adapter** among the five, on the strength of its documented AU1 region, mature signed-webhook tooling, and built-in answering-machine detection, with **Plivo** worth a direct pricing conversation as a lower-cost alternative before the final choice is made. **Amazon Connect** is noted as the strongest AU/NZ data-residency option if that consideration becomes decisive, at a materially higher integration cost. **Vonage** cannot be ranked without direct vendor engagement. **MessageMedia/Sinch Engage** is not currently a voice-capable option based on available research.

This is a provisional ranking carried forward from existing discovery, not a new vendor evaluation, and it is explicitly **not**:

- A recommendation to open any account, accept any contract, or purchase any number now.
- A substitute for the AU/NZ legal review named in PR #39 §18 item 2, which governs whether and how recording may ever be enabled regardless of which vendor is chosen.
- A commitment to Twilio's pricing, AU1 recording-residency status, or any other figure above without direct vendor re-confirmation at the time a real decision is made — several figures in the table above are explicitly marked "not obtained" or "not independently confirmed" in the source discovery and remain so here.

## 5. Recommended next step

Unchanged from PR #39 §18 item 1 and §20: the actual provider selection is a Project Owner commercial decision, to be made once (a) the AU/NZ legal review is complete or far enough along to know which jurisdictions' recording rules the product must support at launch, and (b) direct pricing/security/DPA conversations have been held with at least Twilio and Plivo, the two candidates public documentation supports comparing most directly. Nothing in F1 depends on this decision being made before F1 can be reviewed and merged — F1 runs entirely on `SandboxTelephonyProvider`.
