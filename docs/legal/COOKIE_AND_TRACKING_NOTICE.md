# Agent Engine — Cookie and Tracking Notice

**STATUS: DRAFT — LEGAL REVIEW REQUIRED. This document has not been reviewed or approved by a
qualified Australian lawyer and must not be relied upon or distributed to real pilot participants
until it has been.**

| | |
|---|---|
| Document | Cookie and Tracking Notice |
| Version | 0.1 (draft) |
| Operator | [LEGAL ENTITY NAME] |

This notice describes cookie and tracking-technology use in the pilot build of the Platform, as
found by a review of the codebase at the time of drafting. It should be re-checked against the
actual deployed build before being relied upon, and updated if that build changes.

## 1. What we found

The pilot build sets exactly **one** cookie:

| Cookie | Purpose | Type | Attributes | Lifespan |
|---|---|---|---|---|
| `aee_session` | Keeps you signed in between requests | Strictly necessary (authentication) | `HttpOnly`, `SameSite=Lax`, `Secure` (in production) | Up to 30 days, or until you log out or your session is otherwise revoked (e.g. after a password reset) |

This cookie cannot be switched off without also signing you out — it is not an optional or
preference cookie.

## 2. What we did not find

As at the date of this draft, a review of the web application did not find any third-party
analytics, advertising, marketing, or behavioural-tracking script or cookie (for example, no
Google Analytics, no advertising pixel, no session-replay/heatmap tool). **This is the state of
the pilot build reviewed, not a permanent guarantee** — if a future build adds any such tool, this
notice must be updated before that build reaches real pilot participants.

## 3. Local browser storage

The Platform may use browser storage mechanisms other than cookies (for example, to remember a
user-interface preference) as part of ordinary web-application behaviour. Any such storage is
scoped to your own browser and is not shared with a third party. *[Placeholder: if a specific
browser-storage use is identified that carries privacy significance, describe it here explicitly.]*

## 4. Managing cookies

Because the Platform currently sets only one strictly necessary cookie required for you to be
signed in, there is no cookie-preference control in the product — blocking or deleting the `aee_
session` cookie will simply sign you out. General browser settings can be used to view or clear
cookies at any time.

## 5. Changes

If the Platform introduces analytics, marketing, or other non-essential tracking technology during
the pilot, this notice will be updated first, and, if required by law, appropriate consent will be
sought before that technology is activated for Australian users.

## 6. Contact

[PRIVACY CONTACT EMAIL].

---

### Assumptions requiring confirmation before legal review

- Assumes the codebase review performed for this draft (searching the web application's source for
  analytics/tracking libraries and cookie usage) reflects the actual deployed pilot build —
  reconfirm against the live deployment, not just the source tree, before relying on this notice.
- Assumes no analytics or tracking tool will be added during the pilot without this notice being
  updated first — confirm a change-control process exists.
- Assumes the single session cookie's classification as "strictly necessary" (and therefore not
  requiring separate consent) is correct — confirm with a qualified Australian lawyer, particularly
  if the Platform is ever accessed by users outside Australia.
