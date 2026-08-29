// Agent Engine brand marks — exported as data URIs so the app stays a
// single-bundle build with no extra network requests for logo assets.
// Two lockup variants are provided because the app has two background
// contexts: the dark sidebar and the light auth card. Only the flat gear
// mark (not the photorealistic 3D render also supplied) is used in-app —
// the flat glyph matches the app's existing flat design system and stays
// legible at the small sizes a sidebar brand and favicon actually render
// at; the photoreal version does not scale down cleanly.
//
// Split into apps/web/src/brand-assets/* (one image per file) rather than
// inlined here directly — keeps this file readable and each asset file a
// manageable, independently-diffable size.

export { LOGO_SIDEBAR } from "./brand-assets/logoSidebar";
export { LOGO_LOGIN } from "./brand-assets/logoLogin";
export { FAVICON_32, FAVICON_64 } from "./brand-assets/favicons";
