# Interaction architecture verification

## Scope

Frontend-only changes on `feat/ae-p0-interaction-architecture`.
The application database, API contracts, backend permissions, opportunity scoring/ranking,
Contact Intelligence, migrations, dependency versions, and shared AskAgentEngine component
are unchanged in the delivered diff.

## Requested items

1. **Complete:** real password and development login now resolve the full authenticated
   session before navigating. Grow-entitled users land in `/grow`, Pit Crew retains `/`,
   and other users land in `/today`. Home remains directly reachable at `/`.
2. **Complete within existing destinations:** Today; Grow tabs and Communications; Run
   Home/Properties/Exceptions/Financial; Support/Pit Crew; System Settings.
   Existing Financial and Pit Crew role visibility stays unchanged.
   Appraisals and Documents have no standalone routed pages and were not invented.
   New import navigation uses existing granular import entitlements.
3. **Partial, intentionally bounded:** accessible Quick Action menu with Start Property first
   and existing Grow import for users with execute permission. There are no standalone
   creation destinations for Add Contact, Create Appraisal, Add Opportunity, Send SMS,
   Send Email, or Create Task; these were not presented as fake shortcuts. Existing
   record-specific actions remain in their original screens.
4. **Complete, bounded to real capability:** global Ask AE entry and accessible drawer.
   The wrapper explains that business context provides active-property/upcoming-settlement
   counts, and directs record-specific questions to the existing property/Grow Ask AE.
   **Zero lines changed in `components/AskAgentEngine.tsx`**, avoiding the separate microphone work.
   Existing inner component copy/placeholder is deliberately untouched.
5. **Complete:** Today actions precede visual emphasis on counts; all seven counts remain
   in an expandable summary. Nonempty urgent groups stand out, zero groups collapse.
6. **Complete:** reusable ActionCard presents textual status, title/context, explanation,
   existing suggested next step, and supported primary/secondary actions.
7. **Complete:** Grow uses the same card presentation and quiet empty buckets. Data,
   ordering, existing forms/mutations, ranking, and action gates stay unchanged.
8. **Complete:** Contact360 detail implementation is byte-identical to the base commit.
   Existing contact actions remain in place. Added query-state deep links reach the same
   contact detail; Grow priority View Contact and Email paths were exercised.
9. **Deferred:** no Quick Action creation drawer; those flows need record selection and
   would exceed a small presentation-only change. The Ask AE drawer is separate from creation.

## Automated checks

Node 24.13.0, existing pnpm 8.15.5 and installed dependencies:

| Check | Result |
| --- | --- |
| Workspace recursive typecheck | Passed |
| Web tests | 26 passed, 0 failed, 0 skipped |
| Events tests | 63 passed, 0 failed, 0 skipped |
| Web production build | Passed |
| API production build | Passed |
| Existing migration chain on empty disposable database | Passed; migration files unchanged |
| Full API suite | 953 tests: 934 passed, 18 failed, 1 existing skip |

The Events package's standalone script initially could not find `tsx`; it passed after
putting the already-installed API `node_modules/.bin` on PATH. No dependencies were changed.

The API failures are setup failures in unchanged `growAppraisals.test.ts` (5) and
`propertyIntelligence.test.ts` (13). Their before hooks use dev-login, which returns 404
under the test environment unless explicitly enabled. Those suites do not set
`ALLOW_DEV_AUTH=true` themselves. Tests were not deleted, weakened, or given a bypass.
The full API suite is **not green**. No backend/test fixes were folded into this UX work.

Tests and browser fixtures used separate disposable PostgreSQL databases in a local
instance under `/tmp`, never the application or legacy database. Only synthetic records
were created. Existing migrations were executed unchanged against those disposable databases.

## Browser verification

Rendered Chromium click-through with synthetic accounts and real API responses:

- Password login: Grow Administrator → Grow; Run Agent → Today; Pit Crew → Home.
- Development quick login also works.
- Today and Grow nonempty cards render from real test fixtures.
- Properties, Financial, Pit Crew, Settings, and direct property links render.
- Contact360 query deep link, Grow priority View Contact/Email, and Add Note form work.
- Browser back/forward restores Contact360 and opportunity tab state.
- Home deep link remains `/`.
- Run-only Grow remains locked; Agent cannot see Financial/Pit Crew; Pit Crew sees only its original role links.
- Quick Action opens Start Property, Escape closes, Tab exits; drawer initially focuses
  Close, traps Shift+Tab, and restores focus on Escape.
- Desktop 1440px, tablet 768px, mobile 390px: no horizontal overflow; mobile/tablet Menu
  exposes navigation; Quick Action fits viewport.
- No HTTP 5xx or uncaught browser exceptions during the final click-through.
- All seven Today count tiles remain available when the summary is expanded.

Screenshots in this directory use synthetic test data:
`today-desktop.png`, `today-tablet.png`, `today-mobile.png`, `grow.png`,
`quick-action.png`, `ask-ae.png`, `nav-390.png`, `nav-768.png`, `contact360.png`.

## Follow-up recommendations

- Repair the two API test setup failures separately.
- Design record-aware creation shortcuts for contacts/appraisals/opportunities/tasks and
  contextual SMS/email composition before adding creation drawers.
- Align existing Grow import-page upload controls and its old in-page links with granular
  review/execute visibility in a separately authorized permission-UX pass. This change
  deliberately leaves those pre-existing rules intact; the new creation shortcut requires execute.
- Coordinate context-specific wording/placeholders in the shared Ask AE component after
  the separate voice-input draft has been reviewed.