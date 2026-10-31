# Items blocked on Grok (exclusive files) — local/grow-reliability

Nothing in this branch edits #241 / #248 files. Candidates found but not touched:

1. Classic nav highlight on Grow sub-pages — `apps/web/src/lib/productNav.ts:93-97` `navLinkIsActive` keeps Grow highlighted only on `/grow` and `/grow/contacts/:id`; `/grow/appraisals` and `/grow/appraisals/:id` show no active product. `/grow/import` is deliberately exact (asserted in `productNav.test.ts:76`). Whether appraisals should light Grow is a nav-design call that #241's Minimal A nav (`minimal/minimalNav.ts`, `minimal/minimalGrowNav.ts`) supersedes. Proposed: Grok decides in #241; no change here.
2. `apps/web/src/App.tsx` and `apps/web/src/pages/Grow.tsx` are both modified by #241, so any web workflow fix in the Grow page (Contacts/Opportunities tabs) would conflict. None was needed for the smoke to pass; recorded so a future fix goes to Grok.
3. Appraisal routes (`routes/growAppraisals.ts`) were excluded from the isolation matrix by scope (AB-3..AB-5). The matrix in `growRouteIsolationMatrix.test.ts` is table-driven; Grok can add appraisal cases there after #241 lands.
