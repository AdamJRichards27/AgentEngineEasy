# Agent Engine — Incident Response and Breach Notification Summary (Pilot Participants)

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | Incident Response and Breach Notification Summary |
| Version | 0.1 (draft) |
| Audience | Pilot Participants and the Brokerage (not internal engineering staff) |
| Contact | [PRIVACY CONTACT EMAIL] |

This is a short, plain-language summary for pilot participants. It intentionally does not repeat
the full technical detail in the internal engineering security-incident runbooks — it explains what
you can expect if something goes wrong, not how engineers diagnose it.

## 1. What counts as a security incident here

Examples relevant to this pilot include: someone gaining access to an account that isn't theirs;
a security control (like account lockout or session handling) being found to have a gap; a
suspected leak of a system secret; or any confirmed unauthorised access to, or loss of, personal
information held in the Platform.

## 2. What we will do if an incident is confirmed

1. **Contain it.** Engineering staff will take immediate steps to stop the exposure — for example,
   forcing a re-login for affected accounts, or rotating a compromised credential.
2. **Investigate.** We will work out what happened, which accounts or records were affected, and
   whether any personal information was actually accessed or only potentially exposed.
3. **Notify.** If personal information was involved, we will notify the Brokerage's nominated
   contact, and, where appropriate, directly affected Pilot Participants, without undue delay once
   we have enough information to give a meaningful notification. **Whether this pilot is, or will
   become, subject to the Notifiable Data Breaches scheme under Part IIIC of the Privacy Act 1988
   (Cth), and what that would require in terms of timing and OAIC notification, is to be confirmed
   by a qualified Australian lawyer** — this draft does not assume or claim that scheme's
   requirements are already being met.
4. **Fix.** We will address the underlying cause, consistent with our internal engineering
   practice of shipping a fix with a test proving the specific issue is closed.
5. **Tell you what to do, if anything.** For example, whether you need to change your password.

## 3. What we will tell you

For a notified incident, we aim to tell you: what happened, in plain language; what personal
information (if any) was involved; what we have done about it; and what, if anything, you should do
(e.g. reset your password).

## 4. Who is involved, in plain terms

An on-call engineer and a security lead handle the technical response; the Brokerage's own
nominated contact is kept informed as the point of contact between [LEGAL ENTITY NAME] and the
Brokerage's staff. Named individuals are not fixed here — these are roles, not people, and may be
filled by different staff depending on when an incident occurs.

## 5. What this pilot does not have yet

This is a controlled pilot, not a mature production operation. As at the date of this draft, there
is no dedicated 24/7 paging system and no dedicated privacy officer role formally appointed — an
incident is handled by the same small team building the Platform. This is disclosed here rather
than implied away; a larger-scale deployment would need to close this gap.

## 6. No trust money is at risk from a Platform incident

Because the Platform does not hold or transmit trust money, a Platform security incident cannot, by
itself, result in trust money being misappropriated from the Platform. Any incident affecting the
Brokerage's own trust account is a matter for the Brokerage's own trust account controls and
obligations, not the Platform.

## 7. If you suspect something yourself

Tell your Brokerage administrator and email [PRIVACY CONTACT EMAIL] straight away — don't wait for
a scheduled check-in. Reporting a suspicion early, even if it turns out to be nothing, is always the
right call.

---

### Assumptions requiring confirmation before legal review

- Assumes the Notifiable Data Breaches scheme's precise triggers and timeframes will be confirmed
  by a qualified Australian lawyer before this document claims any specific notification deadline.
- Assumes a small, non-24/7 pilot support model is acceptable and disclosed risk for this
  controlled pilot's size and duration — confirm with the Brokerage that this is understood and
  accepted.
- Assumes the Brokerage will nominate a single point of contact for incident communication —
  confirm who that is before the pilot begins.
- Assumes this participant-facing summary does not need to duplicate the internal engineering
  runbook's technical detail — confirm that split is appropriate rather than participants needing
  more detail.
