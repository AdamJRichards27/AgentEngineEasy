import { useSyncExternalStore } from "react";

// AE Mobile (CC Task #64, M2): the one place that decides "this is a phone".
// 760 px is the Minimal shell's own bottom-bar breakpoint (`@media (max-width: 760px)` in
// minimal/minimal.css, locked by minimalContacts.test.ts), so every phone view and the bar switch
// together. lib/__tests__/minimalMobileSearchConfig.test.ts fails if the two ever differ.

export const PHONE_MAX_WIDTH_PX = 760;
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(PHONE_MEDIA_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_MEDIA_QUERY).matches;
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
