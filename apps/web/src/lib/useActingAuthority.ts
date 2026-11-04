import { useSyncExternalStore } from "react";
import { getActingAuthority, subscribeActingAuthority, type ActingAuthority } from "./actingAuthority";

// t275u: re-render a screen when Pit Crew starts or stops acting for an owner, so
// authority-gated controls (Add Person, Remove, Record Grow interest) appear/disappear live.
let cache: { raw: string; value: ActingAuthority | null } = { raw: "null", value: null };
function snapshot(): ActingAuthority | null {
  const v = getActingAuthority();
  const raw = JSON.stringify(v);
  if (raw !== cache.raw) cache = { raw, value: v };
  return cache.value;
}
export function useActingAuthority(): ActingAuthority | null {
  return useSyncExternalStore(subscribeActingAuthority, snapshot, () => null);
}
