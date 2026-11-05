import { useEffect, useState } from "react";
import { getActingAuthority, subscribeActingAuthority, type ActingAuthority } from "./actingAuthority";

// t275u: re-render a screen when Pit Crew starts or stops acting for an owner, so
// authority-gated controls (Add Person, Remove, Record Grow interest) appear/disappear live.
// useState/useEffect only (no useSyncExternalStore) so lightweight React test doubles work.
export function useActingAuthority(): ActingAuthority | null {
  const [value, setValue] = useState<ActingAuthority | null>(() => getActingAuthority());
  useEffect(() => subscribeActingAuthority(() => setValue(getActingAuthority())), []);
  return value;
}
