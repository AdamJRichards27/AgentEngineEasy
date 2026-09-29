# AE UAT Round 1 — Core Agent Journey readiness

Read-only audit of staging tip `32c2800931663e0dc9595eb985cb54fd00e0682d` (`32c2800`, R-F29). Source is the code, tests, and docs in this tree. Replit and the live database were not used.

The journey audited, in order:

Account creation → sign-in → first-time orientation → Today → contact creation/search → contact/property relationship → property creation → activity/conversation → commitments/follow-up → opportunity → appraisal → future seller → won/lost listing → property history → overdue/rescheduled/completed actions → duplicate/incomplete records → search → mobile use → end-of-day/start-of-day continuity.

Each step has exactly one classification:

| Classification | Meaning used here |
| --- | --- |
| READY | The UI route, API route, and persistence all exist, are wired end to end, and have test coverage. |
| PARTIAL | Some of those layers exist, but a person cannot finish the step in the UI. |
| MISSING | No meaningful implementation. |
| EXTERNAL API DEPENDENT | The step needs a third-party integration or credential. Named below. |
| RUNTIME VERIFICATION REQUIRED | The code looks complete, and only a running environment can confirm it (flag, env var, migration, or layout). |

Size on the smallest follow-up is S (one screen or one route), M (a screen plus an existing route, or a new small route), or L (a new workflow or provider).

## 1. Summary

| Step | Classification | One-line reason | Smallest work | Size |
| --- | --- | --- | --- | --- |
| Account creation | EXTERNAL API DEPENDENT | Accept-invitation is wired; the only auth-email provider implemented is sandbox, and the token is never returned to the UI. | Hand-deliver the sandbox log link (flag already specified). A real inbox needs a provider that does not exist in code. | S (ops) / L (provider) |
| Sign-in | READY | Email/password login, session cookie, logout, and reset-confirm are wired and API-tested. | — | — |
| First-time orientation | PARTIAL | Grow shows an empty state when the brokerage has no Grow data. There is no orientation flow. | None beyond using that empty state. A guided tour is not specified. | — |
| Today | READY | `/today` and Grow’s Today tab are separate, cross-linked, backed by APIs, and tested. | — | — |
| Contact creation/search | PARTIAL | Contact search works on Grow. Nothing on that screen creates a contact. | A “New contact” form that inserts a `parties` row with no property, then shows it in search. | M |
| Contact/property relationship | PARTIAL | Adding a party on a property works. Contact 360’s property list is read-only, and it does not read `property_parties`. | A “Link property” form on Contact 360 calling existing `POST /grow/relationships`. | M |
| Property creation | READY | `/properties/start` creates a property, optionally captures sellers, and opens the workspace. Address search defaults to the mock provider. | — | — |
| Activity/conversation | READY | A note, an in-app call outcome, and an internal note can be recorded without a live provider. | — | — |
| Commitments/follow-up | READY | Contact 360 can add, complete, and cancel a commitment with no AI proposal. | — | — |
| Opportunity | PARTIAL | Opportunities can be listed, noted, and given a next action. Nothing in the UI calls `POST /grow/opportunities`. | A create form (contact, type, reason) on the Opportunities tab and Contact 360. | M |
| Appraisal | PARTIAL | A property appraisal can be started, saved, and finalised in the workspace. The Grow appraisal API has no page. | Buttons that call the existing from-contact / from-opportunity and outcome routes. | M |
| Future seller | PARTIAL | `prospective_seller` is a real relationship type and feeds Grow Today signals. No screen sets it. | The same link-property form, with that type in the list. | S |
| Won/lost listing | PARTIAL | Appraisal WON/LOST/DEFERRED exists on the API only. A property can be taken to Listed. No listing-lost status exists. | The appraisal outcome control above. Do not add a listing-lost status until the Owner picks a meaning (see §3). | M |
| Property history | READY | Property Workspace renders `GET /properties/:id/timeline`, which is persistence-backed and tested. | — | — |
| Overdue / rescheduled / completed | PARTIAL | Overdue and completed are visible, and a commitment can be completed on Contact 360. Commitment reschedule is rejected by the API. | Add Complete on the Grow Today commitment card, reusing the existing PATCH. | S |
| Duplicate / incomplete records | PARTIAL | Import review can use an existing contact, create new, or skip. Merge is implemented and not offered. Manual party add does not check duplicates. | Add Merge on the existing duplicate row; the API already accepts it. | S |
| Search | PARTIAL | Contact search and Start Property address search work. The property list has no search. There is no global search. | A query on `GET /properties` and a box on the property list. Not a new global search. | M |
| Mobile use | RUNTIME VERIFICATION REQUIRED | Mobile-first CSS and a collapsing sidebar are in the stylesheet. No layout test exists. | Exercise the journey at a phone width in a browser. | S |
| End-of-day / start-of-day continuity | PARTIAL | Open work stays open and is re-read by both Today screens. Those screens do not share a day boundary, and there is no close-the-day step. | UAT check only, until the Owner picks the clock (see §3). | S |

## 2. Detail

### Account creation — EXTERNAL API DEPENDENT

Auth email. Only `sandboxAuthEmailProvider` is implemented. `getAuthEmailProvider()` in `apps/api/src/lib/auth/email.ts` always returns it. `assertAuthEmailProviderConfigured()` will boot production when `AUTH_EMAIL_PROVIDER` is set to any other name, and mail still goes to that sandbox. With `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED=true`, the hand-deliverable URL is logged as `pilot_mode_sandbox_email_link`. The plaintext token is not in the API response (`apps/api/src/routes/auth.ts`, `POST /admin/invitations`).

What is wired:

- UI: `/accept-invitation/:token` (`apps/web/src/pages/AcceptInvitation.tsx`), admin invite on `/settings/users` (`apps/web/src/pages/SettingsUsers.tsx`). There is no self-serve signup (`apps/web/src/pages/Login.tsx`).
- API: `POST /auth/admin/invitations`, `GET /auth/invitations/:token/status`, `POST /auth/invitations/:token/accept`.
- Persistence: `users`, `brokerages` (`packages/db/src/schema/users.ts`); `invitations` (`packages/db/src/schema/authTokens.ts`); migration `packages/db/migrations/0010_invitation_auth.sql`. Accept also writes consent (`packages/db/src/schema/privacy.ts`).
- Tests: `apps/api/src/routes/__tests__/authSecurity.test.ts`. No web test covers Accept Invitation or Settings → Users.
- First admin: CLI `apps/api/src/scripts/bootstrapAdmin.ts`. Invitations are issued by an existing Brokerage Administrator, so an empty database cannot start from the UI.
- Gates: invite/revoke/list require Brokerage Administrator. `brokerageId` comes from the admin session, not the body. Accept copies role and brokerage from the invitation row.
- Env: `FRONTEND_BASE_URL` (link base), `AUTH_EMAIL_PROVIDER`, `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED`, and in production the approved-legal-document set (`LEGAL_DOCUMENTS_APPROVED` and the artifact path/hash variables). Accept stores `firstName` and `lastName` as empty strings.

Smallest work: for this UAT round, create the first admin with the bootstrap script, invite from Settings → Users, and hand-deliver the sandbox log URL. Building a real provider is the large follow-up; naming one in the env var does not send mail today.

### Sign-in — READY

- UI: `/login` (`apps/web/src/pages/Login.tsx`), `/forgot-password`, `/reset-password/:token`, sidebar Sign out (`apps/web/src/App.tsx`).
- API: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password-reset/request`, `POST /auth/password-reset/confirm`. Session cookie `aee_session` (`apps/api/src/lib/session.ts`). Client probe: `apps/web/src/lib/session.ts`.
- Persistence: `users.passwordHash`, `failedLoginAttempts`, `lockedUntil`, `sessionEpoch`.
- Tests: `apps/api/src/routes/__tests__/authSecurity.test.ts`, `apps/api/src/routes/__tests__/auth.test.ts`. No web test covers the login form.
- Landing after sign-in: `resolveLandingRoute` in `apps/web/src/lib/productNav.ts`. Pit Crew goes to `/`. Anyone else with `grow.access` goes to `/grow`. Otherwise `/`. Tests: `apps/web/src/lib/__tests__/productNav.test.ts`.
- Env: `SESSION_SECRET` (required, at least 32 characters). `ALLOW_INSECURE_DEV_COOKIES` omits `Secure` on plain HTTP. `ALLOW_DEV_AUTH=true` shows the known-users picker; it is 404 otherwise (`Login.tsx`). If approved legal documents are not active, login returns 503. If stored consent versions do not match the active ones, login returns 428 `LEGAL_ACCEPTANCE_REQUIRED`.

Password reset uses the same sandbox email as invitations. A person who already has a password can sign in without it. `POST /auth/change-password` is tested and has no screen. `POST /legal/acceptance` exists in `apps/api/src/routes/privacy.ts` and no page handles 428. Neither blocks a first sign-in after accept, which records current consent.

### First-time orientation — PARTIAL

`hasAnyGrowData` on `GET /grow/today` (`apps/api/src/lib/growToday.ts`) distinguishes a brokerage that has never used Grow from one that is caught up. `apps/web/src/pages/Grow.tsx` renders “Let's find your next opportunity” and a link to `/grow/import` when that flag is false. Test: `apps/api/src/routes/__tests__/growToday.test.ts` (empty brokerage).

There is no tour, checklist, first-run column, or profile step. Invitation accept leaves the name blank, so the greeting has nothing to show. A Run-only user lands on `/` (`apps/web/src/pages/Home.tsx`), which is a dashboard, not an orientation. The Nurture tab is `GrowComingSoon` and is outside this step.

The empty state is testable as it stands. A richer orientation is not specified in code or docs, so it is not proposed here.

### Today — READY

Two screens, on purpose, with cross-links (`apps/web/src/lib/todaySurfaces.ts`, `apps/web/src/components/TodaySurfaceCrossLink.tsx`):

| Screen | Route | API | What it shows |
| --- | --- | --- | --- |
| RUN Command Centre, nav label “Today” | `/today` (`apps/web/src/pages/CommandCentre.tsx`) | `GET /command-centre` (`apps/api/src/routes/commandCentre.ts`) | Property work: Now, Overdue, Today, Waiting On, Coming Up, Pit Crew, Completed Today. Rows link to `/properties/:id`. Read-only. |
| Grow Today | `/grow` Today tab (`apps/web/src/pages/Grow.tsx`) | `GET /grow/today` (`apps/api/src/routes/grow.ts`) | Priority actions, due follow-ups and commitments, open opportunities, contacts needing attention. |

- Persistence is the underlying property, task, commitment, and relationship rows. Neither Today route writes them.
- Tests: `apps/api/src/routes/__tests__/commandCentre.test.ts`, `apps/api/src/routes/__tests__/growToday.test.ts`, `apps/api/src/routes/__tests__/growTodayCommitments.test.ts`, `apps/web/src/lib/__tests__/todaySurfaces.behavior.test.ts`.
- Gates: Command Centre is `requireAuth` only (no `run.access`). Grow Today is `requireAuth` plus `grow.access`. Property-intelligence cards on Grow Today also need `grow.propertyIntelligence.read`. Agents see only their own properties on Command Centre (`restrictedPropertyIdsFor` in `apps/api/src/routes/exceptions.ts`). Brokerage Administrators and Pit Crew see the brokerage. Home (`GET /home/summary`) is brokerage-wide for every role; that is a different page.

### Contact creation/search — PARTIAL

Search is end to end. Creation is not, on the Contacts screen.

- UI: `/grow` → Contacts (`Grow.tsx`). Search calls `GET /grow/contacts?search=`. Opening a row loads Contact 360 at `/grow?contact={partyId}`.
- API read: `apps/api/src/routes/contacts.ts`, mounted at `/grow/contacts`. There is no `POST /grow/contacts`.
- Creating a person today:
  - `POST /parties` (`apps/api/src/routes/parties.ts`) inserts `parties` and `property_parties`, and **requires** `propertyId`. Used by Start Property and the workspace Add party form.
  - Import (`/grow/import`, `apps/api/src/lib/import/execute.ts`) can insert a party with no property.
- Persistence: `parties` in `packages/db/src/schema/property.ts` (baseline `packages/db/migrations/0000_baseline_schema.sql`). Grow roles and household links: `packages/db/src/schema/contacts.ts`, migration `packages/db/migrations/0014_goofy_white_tiger.sql`.
- Tests: `apps/api/src/routes/__tests__/contacts.test.ts`, `contactReadScoping.test.ts`, `contactsHardening.test.ts`, `apps/api/src/routes/__tests__/parties.test.ts`.
- Gates: `grow.contacts.read` to list and open; `grow.contacts.manage` to assign roles and household links. `POST /parties` is `requireAuth` and brokerage-scoped, not a Grow entitlement. Queries filter `parties.brokerageId`.

Smallest work: a New contact form on the Contacts tab that inserts a `parties` row for this brokerage with no property, then returns that row from the existing search. Files: `apps/api/src/routes/contacts.ts` (or a property-less branch of `parties.ts`) and `apps/web/src/pages/Grow.tsx`. M. Import remains a valid way to load contacts for UAT before that form exists.

### Contact/property relationship — PARTIAL

Two links, not one view.

| Link | Table | How a person creates it | Where it shows |
| --- | --- | --- | --- |
| RUN party on a property | `property_parties` | Start Property seller step, or Add party on `/properties/:id`. `POST /parties`. | Property Workspace people section. |
| Grow relationship | `grow_relationships` | `POST /grow/relationships` (`apps/api/src/routes/grow.ts`). Property id is optional (migration `packages/db/migrations/0013_grow_relationship_property_optional.sql`). **No screen calls this route.** | Contact 360 Properties, read-only. `GET /grow/contacts/:partyId` reads `grow_relationships`, not `property_parties`. |

`POST /parties` does not insert `grow_relationships`. A seller added in the workspace does not appear on Contact 360 until a Grow relationship exists (import, or the API).

Household links (spouse, family, and so on) are a third thing: Contact 360 “Add related contact” posts to `POST /grow/contacts/:partyId/relationships`. Those types are in `GROW_CONTACT_RELATIONSHIP_TYPES` in `Grow.tsx`. They are not property links. `prospective_seller` is not in that list.

- Schema comment in `packages/db/src/schema/grow.ts`: Grow keeps its own relationship table and does not stretch `property_parties`.
- Entitlement `grow.properties.link` is in the catalogue (`packages/db/src/schema/billing.ts`, `apps/api/src/lib/billing/catalogue.ts`) and is not checked by any route. `POST /grow/relationships` uses `grow.relationships.manage`.
- Tests: `parties.test.ts`, `apps/api/src/routes/__tests__/grow.test.ts`, `apps/api/src/routes/__tests__/growRelationshipsValidation.test.ts`, import relationship tests.

Smallest work: on the Contact 360 Properties section, a form that posts `partyId`, `propertyId`, and `relationshipType` to `POST /grow/relationships`. M. `apps/web/src/pages/Grow.tsx` only. Do not merge the two tables in that change; the schema treats them as different.

### Property creation — READY

- UI: `/properties/start` (`apps/web/src/pages/StartProperty.tsx`), linked from the sidebar and from an empty property list (`apps/web/src/pages/PropertiesList.tsx`). Picking an address or “Create New Address” posts `POST /properties`, then an optional seller step posts `POST /parties`, then the app opens `/properties/:id`.
- API: `apps/api/src/routes/properties.ts` (`GET /properties/address-search`, `POST /properties`, `GET /properties`, `GET /properties/:id`, `GET /properties/:id/workspace`). Create publishes `PROPERTY_CREATED`.
- Persistence: `properties` (`packages/db/src/schema/property.ts`), baseline migration.
- Tests: many route tests create via `POST /properties` (including `apps/api/src/routes/__tests__/runPropertyPartyIsolationRejection.test.ts` and `propertyTimeline.test.ts`). There is no dedicated address-search route test and no web test for Start Property.
- Gates: `requireAuth`. The property must belong to the caller’s brokerage. Any agent in the brokerage who knows the id can open it; the list is not filtered to `agentId`.
- Address data: `PROPERTY_DATA_PROVIDER` defaults to `mock` (`packages/integrations/property-data/src/index.ts`). `google-places` also needs `GOOGLE_PLACES_API_KEY`, and in production `LIVE_EXTERNAL_TRANSACTIONS_APPROVED=true`, or it falls back to mock. The default path does not need Google.

### Activity / conversation — READY

Recording the interaction does not need a live provider.

- Note: Contact 360 and Grow Today “Add note” post `POST /grow/activities` with `activityType: "note"` (`useAddGrowNote` in `Grow.tsx`; route in `apps/api/src/routes/grow.ts`). `call_summary` is rejected on that route and is only written from transcription review.
- Call outcome and internal note: `apps/web/src/components/CommunicationsSection.tsx` on the property workspace and on Contact 360. `PHONE_CALL` “records an outcome only” (`packages/db/src/schema/communications.ts`). `INTERNAL_NOTE` is not sent.
- Sandbox call: Contact 360 call panel posts to `/grow/calls` (`apps/api/src/routes/growCalls.ts`). Provider is sandbox. Completing a session can insert a `grow_activities` row of type `call`.
- Persistence: `grow_activities` (`packages/db/src/schema/grow.ts`); `communication_messages` and related tables (`packages/db/src/schema/communications.ts`, migration `packages/db/migrations/0007_furry_moonstone.sql`).
- Tests: `apps/api/src/routes/__tests__/grow.test.ts`, `communications.test.ts`, `growCalls.test.ts`, `apps/web/src/lib/__tests__/communicationsHub.behavior.test.ts`.
- Gates: `grow.activities.manage` for the note. Property communications are `requireAuth` and brokerage-scoped. Contact-thread mutations use `grow.contacts.manage`. Sandbox calling uses `grow.calling.access`.

Sending a real email or SMS needs `LIVE_COMMUNICATIONS_APPROVED` plus `COMMUNICATIONS_EMAIL_PROVIDER` / `COMMUNICATIONS_SMS_PROVIDER` (`apps/api/src/lib/communications/providers/registry.ts`). A real phone call needs `LIVE_TELEPHONY_APPROVED`. Transcription needs `LIVE_CALL_TRANSCRIPTION_APPROVED` (and recording approval where a recording is stored). Those are outside this step’s classification: the in-app record is READY without them. The Communications Hub (`/communications`) is a read-only cross-property feed.

### Commitments / follow-up — READY

G-6 on staging already split the words: a commitment is an Open `grow_commitments` row; a due follow-up is an opportunity next action or an appraisal follow-up. This step is the commitment.

- UI: Contact 360 “Add commitment”, Complete, and Cancel (`Grow.tsx`).
- API: `POST /grow/contacts/:partyId/commitments` and `PATCH /grow/contacts/commitments/:id` (`apps/api/src/routes/contacts.ts`). PATCH accepts only `Completed` or `Cancelled`. Completion writes a `task_completion` activity in the same transaction.
- Persistence: `grow_commitments` (`packages/db/src/schema/contacts.ts`), migration `0014_goofy_white_tiger.sql`.
- Tests: `apps/api/src/routes/__tests__/contactsHardening.test.ts`, `growTodayCommitments.test.ts`.
- Gate: `grow.activities.manage`. Rows are brokerage-scoped.
- AI proposals (`GrowPendingCommitmentProposals`, `POST .../followups/propose`) create a proposal, not a commitment, until a person approves and executes. The manual form does not use that path.

Opportunity “Create follow-up” patches `recommendedNextAction` / `nextActionDueAt` on `grow_opportunities`. That is a different record. It is not required to finish this step.

### Opportunity — PARTIAL

- Persistence: `grow_opportunities` (`packages/db/src/schema/grow.ts`). Types include Listing, Appraisal, PropertyManagement, Other. Status Open / Converted / Lost / Closed. Stage New / Contacted / Qualified / AppraisalBooked / Converted / Lost. Migration `packages/db/migrations/0008_striped_reaper.sql`.
- API: `GET/POST /grow/opportunities`, `PATCH /grow/opportunities/:id` (`apps/api/src/routes/grow.ts`). Create requires `partyId`, `opportunityType`, and `reason`, entitlement `grow.opportunities.manage`.
- UI: Opportunities tab and the Contact 360 table list rows and can add a note or a next-action follow-up (`GrowOpportunitiesTab` in `Grow.tsx`). No control posts `POST /grow/opportunities`.
- The other create path is “Promote to opportunity” on a property-intelligence signal (`apps/web/src/components/PropertyIntelligencePanel.tsx` → `POST /grow/property-intelligence/signals/:id/promote`). It needs an existing signal, `grow.propertyIntelligence.manage`, and a linked contact. It is not a blank create.
- Tests: `apps/api/src/routes/__tests__/grow.test.ts`, `propertyIntelligence.test.ts`, `apps/web/src/lib/__tests__/growOpportunityActions.behavior.test.ts`.

Smallest work: a form on the Opportunities tab and on Contact 360 with contact, type, and reason, posting to the existing route. M. `Grow.tsx` only.

### Appraisal — PARTIAL

Two appraisals share `appraisals` (`packages/db/src/schema/appraisal.ts`) and are not the same screen.

| Surface | What the UI can do | API |
| --- | --- | --- |
| Property Workspace | Start, save price range and notes, finalise. | `apps/api/src/routes/appraisals.ts` (`/appraisals/by-property/:id`). `requireAuth` plus brokerage property check. |
| Grow Appraisal Workspace | No page. `apps/web` has no call to `/grow/appraisals`. | `apps/api/src/routes/growAppraisals.ts`: `POST /from-contact`, `POST /from-opportunity`, `GET /pipeline`, `POST /:id/outcome` (`WON`, `LOST`, `DEFERRED`), `POST /:id/follow-up`, `POST /:id/run-handoff`. Mutations need `grow.access` and `grow.opportunities.manage`. Run handoff also needs `run.access`. |

Tests: `apps/api/src/lib/__tests__/appraisals.test.ts`, `apps/api/src/routes/__tests__/growAppraisals.test.ts`, `growAppraisalsHardening.test.ts`, `apps/web/src/lib/__tests__/growTodayAppraisalActions.behavior.test.ts` (Today links to the property, not to a Grow appraisal page).

A UAT agent can finish a property-scoped price-range appraisal. They cannot open the Grow pipeline or record WON/LOST/DEFERRED from the UI.

Smallest work: on Contact 360 and on an opportunity row, call `POST /grow/appraisals/from-contact` or `from-opportunity`, and on the resulting appraisal call `POST /grow/appraisals/:id/outcome`. M. A full pipeline page is larger than this step needs.

### Future seller — PARTIAL

There is no `future_seller` column and no opportunity stage with that name.

The implemented meaning is relationship type `prospective_seller` in `GROW_RELATIONSHIP_TYPES` (`packages/db/src/schema/grow.ts`). Import maps “prospective seller”, “potential seller”, and “seller enquiry” to it (`apps/api/src/lib/import/normalise.ts`). Signal evaluation treats it as agent-recorded motivation (`AGENT_RECORDED_MOTIVATION_TYPES` in `apps/api/src/lib/propertyIntelligence/evaluation.ts`). Grow Today’s Emerging band is what surfaces that population (`apps/api/src/routes/__tests__/growToday.test.ts`).

The contact-role pills on Contact 360 include `AppraisalProspect` and not a future-seller role (`GROW_CONTACT_ROLES` in `Grow.tsx`). Nothing in the web app posts `relationshipType: "prospective_seller"`. Tests create it through `POST /grow/relationships` or a direct insert.

Smallest work: include `prospective_seller` on the link-property form from the relationship step. S, same files. Until that form exists, UAT can only reach this step through import or a direct API call.

### Won / lost listing — PARTIAL

The schema says listing is not a Grow table. `grow_opportunities.convertedAppraisalId` comment in `packages/db/src/schema/grow.ts`: listing is `properties.listingStatus` / `workflowStage`, and Grow’s handoff stops at the appraisal.

What exists:

- Appraisal outcomes `WON`, `LOST`, `DEFERRED` (`APPRAISAL_STATUSES` in `packages/db/src/schema/appraisal.ts`; `POST /grow/appraisals/:id/outcome`). Timeline event types `APPRAISAL_WON` / `APPRAISAL_LOST` (`apps/api/src/lib/relationshipTimeline.ts`). No web caller.
- Property stages Appraisal → Ready to List → Listed → Under Offer → Contract → Settlement → Closed (`packages/db/src/schema/property.ts`). Go live (`POST /properties/:id/go-live`, button on `PropertyWorkspace.tsx`) sets `listingStatus` to Listed (`apps/api/src/lib/goLive.ts`).
- `WITHDRAWN` exists on portal launch destinations (`packages/db/src/schema/launch.ts`), not as a property won/lost flag.

Smallest work that the code already defines: the appraisal outcome control in the appraisal step. M. A “listing lost” status is not defined; see §3. Do not add one in order to tick this step.

### Property history — READY

- UI: Property Workspace “Timeline” when `GET /properties/:id/timeline` returns rows (`PropertyWorkspace.tsx`). An empty timeline renders nothing (no empty-state sentence). That does not block the step once any milestone exists.
- API: `apps/api/src/routes/properties.ts` → `getPropertyTimeline` in `apps/api/src/lib/timeline.ts`. Reads `domain_events` plus a curated set of `audit_logs`. Financial figures are redacted unless the role is Brokerage Administrator.
- Persistence: `packages/db/src/schema/events.ts`, `packages/db/src/schema/audit.ts`, baseline migration, index in `packages/db/migrations/0028_ae_grow_wave1_operability_and_scale_indexes.sql`.
- Tests: `apps/api/src/routes/__tests__/propertyTimeline.test.ts` (lifecycle, order, redaction, tenant isolation).
- Contact 360 has a separate relationship timeline from `GET /grow/contacts/:partyId` (`apps/api/src/lib/relationshipTimeline.ts`). That is the contact history, not this step.

### Overdue / rescheduled / completed — PARTIAL

| Behaviour | Where it works |
| --- | --- |
| See overdue / due today | Grow Today (Open commitments with `dueAt <= endOfTodayUtc()`, `apps/api/src/lib/growToday.ts`). Command Centre Overdue, Today, and Completed Today (`apps/api/src/lib/commandCentre/queries.ts`). |
| Mark a commitment completed or cancelled | Contact 360 only. PATCH described under commitments. |
| Complete from Grow Today | Not offered. The commitment card’s actions are add note, view property (when the commitment has one), email, SMS, view contact, and Ask AE (`apps/api/src/lib/growToday.ts`). |
| Reschedule a commitment | Not supported. PATCH returns 400 unless status is Completed or Cancelled. |
| Reschedule something else | Opportunity next-action due time can be patched. Transaction conditions can be rescheduled in the Property Workspace. Appraisal follow-up exists on `POST /grow/appraisals/:id/follow-up` and has no page. |
| Complete a RUN automation task | `POST /tasks/:id/complete` (`apps/api/src/routes/tasks.ts`), brokerage-scoped. |

Tests: `growTodayCommitments.test.ts`, `commandCentre.test.ts`, `contactsHardening.test.ts`.

Smallest work inside the current API: a Complete button on the Grow Today commitment card that calls the same PATCH. S. `Grow.tsx` only. Changing `dueAt` would be a new transition; the route forbids it, so it is not in this backlog (see §3).

### Duplicate / incomplete records — PARTIAL

Import is the only duplicate review a person can operate.

- UI: `/grow/import` (`apps/web/src/pages/GrowImport.tsx`). Each duplicate row offers Use existing, Create new, and Skip.
- API and persistence: resolutions `use_existing | create_new | merge | skip` (`packages/db/src/schema/import.ts`). `apps/api/src/lib/import/execute.ts` fills empty fields when resolution is `merge`. The review screen never sends `merge`.
- Unidentifiable import rows (no name, email, or phone) fail validation (`CONTACT_UNIDENTIFIABLE` in `apps/api/src/lib/import/validate.ts`).
- Tests: `apps/api/src/lib/import/__tests__/pipeline.test.ts`, `executeBatching.test.ts`.
- Gates: `grow.import.review` and `grow.import.execute`.
- Outside import: `POST /parties` does not look for an existing email. Contact 360 does not warn on a blank name. `apps/api/src/routes/contacts.ts` states that person-to-person relationships do not merge records. Go-live blocks a property whose Ready-to-List steps are incomplete (`apps/api/src/lib/goLive.ts`); that is property completeness, not contact completeness.

Smallest work: a Merge button on `DuplicateRow` that posts resolution `merge` with the selected candidate. S. `GrowImport.tsx` only. A general in-app contact merge is not specified and is not proposed.

### Search — PARTIAL

| Search | UI | API |
| --- | --- | --- |
| Contacts | Grow → Contacts, and the household “Find contact” box | `GET /grow/contacts?search=` (optional `role`) |
| Address | Start Property autocomplete | `GET /properties/address-search?q=` |
| Property list | None. `/properties` lists the brokerage. | `GET /properties` has no search parameter |
| Global | None | None |

Exceptions has its own `search` query. It is not this step.

Smallest work: pass a query through `GET /properties` and add a box on `apps/web/src/pages/PropertiesList.tsx`. M. A single box that searches contacts and properties together is not specified and is not proposed. Contact search is already testable.

### Mobile use — RUNTIME VERIFICATION REQUIRED

- `apps/web/index.html` sets `viewport` to `width=device-width, initial-scale=1.0`.
- `apps/web/src/styles.css` says the base layout is phone width. Below `--sidebar-breakpoint` (900px) the sidebar becomes a horizontal scrolling top bar (`apps/web/src/App.tsx` uses the same nav). Stat tiles go to four columns from 640px up.
- The route table does not change by viewport. There is no layout or viewport test.

The stylesheet looks complete. Whether Start Property, Contact 360, the call panel, and the property workspace are usable at a phone width is only knowable in a browser. Smallest work is that pass, not a new mobile app. S.

### End-of-day / start-of-day continuity — PARTIAL

Unfinished work is not cleared at midnight. An Open commitment stays Open until Complete or Cancel, and both Today endpoints recompute on each GET. Command Centre’s own header says it writes nothing. Tests cover an overdue commitment still appearing on Grow Today (`growTodayCommitments.test.ts`) and Command Centre sections (`commandCentre.test.ts`).

There is no close-the-day or start-of-day route, table, or job.

The two screens do not share a clock:

- Grow Today uses `startOfTodayUtc` / `endOfTodayUtc` (`apps/api/src/lib/growToday.ts`).
- Command Centre uses `resolveTimeZone` (`apps/api/src/lib/commandCentre/timezone.ts`). No user or brokerage timezone column exists. The fallback is `Australia/Brisbane` (`source: "fallback"`). The file says that fallback is the specified behaviour until a column exists.

A Brisbane agent’s “today” on `/grow` and on `/today` can disagree. That is visible in code; a running clock is what shows it to a tester.

Smallest work for this round: a UAT check, not a code change. Leave an Open commitment due before now, sign in again, and confirm `/grow` still lists it and `/today` still lists unfinished property work. S. Aligning the two clocks is an Owner decision (§3), not a determined defect.

### Cross-cutting checks

**Tenant / brokerage.** The session loads `brokerageId` from the user row (`apps/api/src/middlewares/auth.ts`). Journey writes take that id from the session, not from the client body. Cross-brokerage ids on the routes reviewed answer 404. Rejection tests worth keeping in front of UAT: `authSecurity.test.ts` (invitations and users), `growTenantIsolationRejection.test.ts`, `runPropertyPartyIsolationRejection.test.ts`, `parties.test.ts`, `propertyTimeline.test.ts`, and the peer-agent case in `commandCentre.test.ts`.

**Role and entitlement gates used by this journey.**

| Step | Gate |
| --- | --- |
| Invite, user admin | `requireRole` Brokerage Administrator |
| Sign-in, Today (`/today`), properties, parties, RUN appraisal, tasks | `requireAuth`. Command Centre and Exceptions further limit Agents to `properties.agentId`. Home and the property list do not. |
| Grow Today, Grow relationships read | `grow.access` |
| Contact list and Contact 360 | `grow.contacts.read`; role and household edits `grow.contacts.manage` |
| Notes and commitments | `grow.activities.manage` |
| Create Grow relationship | `grow.relationships.manage` |
| Create or patch opportunity; Grow appraisal mutations | `grow.opportunities.manage` |
| Import | `grow.import.review`, `grow.import.execute` |
| Property-intelligence promote | `grow.propertyIntelligence.manage` |
| Sandbox call | `grow.calling.access` |

`run.access` is not checked on `/command-centre`, `/home/summary`, or `/properties`. It is checked on financial, Pit Crew, transactions, and Grow appraisal run-handoff. Nav hiding is not the security boundary (`apps/web/src/lib/productNav.ts`). Financial is shown for Brokerage Administrator. Pit Crew is shown for Pit Crew and Brokerage Administrator. Grow stays in the nav; the API still returns 403 without `grow.access`.

Roles are Agent, Brokerage Administrator, and Pit Crew (`packages/db/src/schema/users.ts`).

**Dead controls.** On the journey pages there is no `href="#"` and no empty click handler. Controls that look inactive and are explained by the code:

- Nurture (`Grow.tsx`, `GrowComingSoon`) is a labelled placeholder. It is not part of this journey. Do not build it to clear this audit.
- Contact 360 Properties and the opportunity tables have no create control. That is the PARTIAL finding above, not a button that fires and does nothing.
- “Promote to opportunity” is disabled when the signal has no contact, with a title that says why (`PropertyIntelligencePanel.tsx`).
- Home stat tiles for attention, next actions, and settlements are not links. Only Active Properties links to `/properties`. Nothing in Home’s code says the other tiles should navigate.

## 3. Product decisions for the Owner

These are places where the code or the docs do not say what UAT should treat as success. They are not new requirements.

1. **First-time orientation.** The only specified behaviour is Grow’s empty state plus an import link when `hasAnyGrowData` is false. Accept does not collect a name. Run-only users land on Home. Whether that empty state passes “orientation” is not written down.

2. **Which clock “today” uses, and whether a day has a closing step.** Grow Today buckets on UTC. Command Centre buckets on `Australia/Brisbane` because there is no stored timezone (`apps/api/src/lib/commandCentre/timezone.ts`). `todaySurfaces.ts` says the two screens stay separate. Nothing defines an end-of-day or start-of-day ritual, and nothing says the two day boundaries must match.

3. **What “won/lost listing” is.** Appraisal `WON` / `LOST` / `DEFERRED`, property stage through Listed and Closed, and portal `WITHDRAWN` are three different models. The opportunity schema says Grow does not copy RUN’s listing workflow. No field is defined as “listing won” or “listing lost”.

4. **`grow.properties.link`.** The key is sold in the catalogue and checked by no route. Linking a Grow relationship uses `grow.relationships.manage`. This is still open as G-7 / Owner question 12 in `docs/AE_GROW_COMPLETION_ROADMAP.md`: enforce the key, or remove it from the catalogue. This audit does not choose.

5. **Where a contact with no property is created.** `POST /grow/relationships` allows a missing property. `POST /parties` does not. There is no `POST /grow/contacts`. Import can create the party. The docs do not name one of those as the agent’s create-contact path.

6. **What “rescheduled” means.** A commitment due time cannot be changed. An opportunity next-action due time can. A transaction condition can be rescheduled on the property. The journey word is not tied to one of those.

7. **Whose properties an agent sees.** Command Centre and Exceptions limit an Agent to their own properties. Home and `GET /properties` show the brokerage. Each rule is local to that route. Nothing says the core journey should use only one of them. UAT should expect both until the Owner says otherwise.

## 4. Suggested safe hardening backlog

Ordered as regression tests, tenant isolation, state transitions, then UX paths. Every item is behaviour the current code, tests, or docs already define. None of §3 is in this list.

### Regression tests

- Web behaviour tests for the two screens UAT starts on. The server contract is already in `apps/api/src/routes/__tests__/authSecurity.test.ts`. Missing: a test that Login posts email and password to `POST /auth/login`, and that Accept Invitation posts the password and consent to `POST /auth/invitations/:token/accept`. M. New tests next to the existing web behaviour tests; pages `Login.tsx` and `AcceptInvitation.tsx`.
- A route test for `GET /properties/address-search` under the default mock provider (`packages/integrations/property-data`). The Start Property screen depends on it and no test calls it. S.
- A characterization test that `POST /parties` writes `property_parties` and does not write `grow_relationships`. That is what `apps/api/src/routes/parties.ts` does today. S. Stops a later change from making Contact 360 fill in during UAT without the Owner decision in §3.
- Fail closed when `AUTH_EMAIL_PROVIDER` is set to a name that has no implementation. `assertAuthEmailProviderConfigured()` currently treats any non-sandbox name as configured, and `getAuthEmailProvider()` still returns sandbox (`apps/api/src/lib/auth/email.ts`). The same file says only sandbox exists. A boot or send test should refuse that name instead of logging a link that was never sent. S.

### Tenant isolation

- Keep the rejection suites listed in §2 green. They already cover invitations, Grow rows, parties, properties, the timeline, and a peer agent on Command Centre. No journey route reviewed here returned another brokerage’s row.
- UAT and staging must leave `ALLOW_DEV_AUTH` unset. `GET /auth/known-users` and `POST /auth/dev-login` are 404 unless it is true, and Login hides the picker on that 404. S, environment check, not a code change.
- Do not “fix” Agent-versus-brokerage visibility on Home or the property list in a hardening pass. Both scopes are specified (§3.7).

### State transitions

- Leave commitment PATCH as Completed or Cancelled only. `apps/api/src/routes/contacts.ts` returns 400 otherwise, and `contactsHardening.test.ts` locks that. A reschedule transition is not specified.
- Grow appraisal outcome `WON` / `LOST` / `DEFERRED` is specified and tested (`growAppraisals.test.ts`) and has no web caller. The transition code should stay as it is; reachability is the UX item below.
- Property go-live → `listingStatus` Listed is already reachable from Property Workspace. Do not add a lost-listing status here.

### UX paths

These are existing routes with no control, not new workflows.

- Contact 360 Properties: a form posting to `POST /grow/relationships`. M. `Grow.tsx`.
- Opportunities tab and Contact 360: a form posting to `POST /grow/opportunities` with `partyId`, `opportunityType`, and `reason`. M. `Grow.tsx`.
- Contact 360 or the opportunity row: calls to `POST /grow/appraisals/from-contact` or `from-opportunity`, and `POST /grow/appraisals/:id/outcome`. M. No `/grow/appraisals` call exists anywhere under `apps/web`.
- Import duplicate row: send `merge`, which `IMPORT_RESOLUTIONS` and `execute.ts` already implement. The buttons today are Use existing, Create new, and Skip. S. `GrowImport.tsx`.
- Grow Today commitment card: Complete, calling `PATCH /grow/contacts/commitments/:id` the way Contact 360 already does. S. `Grow.tsx`.
- Settings: a change-password form calling `POST /auth/change-password`. The route and `authSecurity.test.ts` exist; no page calls it. S. `apps/web/src/pages/Settings.tsx`.
- Login: when the API returns 428 `LEGAL_ACCEPTANCE_REQUIRED`, a form that posts `POST /legal/acceptance`. M. `Login.tsx` and `apps/api/src/routes/privacy.ts`. Not needed for a first accept, which stores consent.

Leave the Nurture placeholder as it is. It is labelled coming soon and is not an unhandled button.
