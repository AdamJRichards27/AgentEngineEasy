// AE Mobile (CC Task #64, M3): fixed settings for the phone Today screen. No React, no network.

/**
 * Ask AE is NOT offered on Today until its Minimal-shell routing is verified on staging. In the
 * code I can see, /grow?tab=askAE opens Today itself, so a link would land the agent back where
 * they started. Flip this only after Grok confirms the route, and change the test that guards it
 * in the same pull request.
 */
export const MOBILE_ASK_AE_ON_TODAY = false;

/**
 * The Grow section bar (Today, Opportunities, Contacts, Nurture, Performance, Ask AE) stays on
 * phone Today until every destination is verified and listed in More (specification decision 3).
 * Flip to false then.
 */
export const MOBILE_TODAY_SHOWS_GROW_SECTIONS = true;

/** Where My Momentum and Market Activity live. The sidebar uses the same addresses; a test keeps them in step. */
export const MOBILE_MOMENTUM_HREF = "/grow/momentum";
export const MOBILE_MARKET_HREF = "/grow/market-activity";

/** Priority rows shown before "Show all". */
export const TODAY_VISIBLE_ROWS = 5;
/** Signals shown on a phone. */
export const TODAY_SIGNAL_LIMIT = 3;
