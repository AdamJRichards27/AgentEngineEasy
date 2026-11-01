import { useCallback, useEffect, useState } from "react";
import { markHidden, returned, startCall, type CallOption, type PendingCall } from "./mobileCalling";

// AE Mobile (CC Task #64, M4/M5): notices the agent coming back to the app after tapping a call link, so "Log call" can be offered.
// It records nothing and sends nothing: no request, no storage. It remembers one tap in memory only, so if the browser discards the page
// while the dialler is open there is simply no offer. The agent can always log a call from Contact 360.

let tracking: PendingCall | null = null;

export function useCallReturn() {
  const [offer, setOffer] = useState<PendingCall | null>(null);

  useEffect(() => {
    const onChange = () => {
      const now = Date.now();
      if (document.hidden) {
        tracking = markHidden(tracking, now);
        return;
      }
      const result = returned(tracking, now);
      tracking = result.keep;
      if (result.offer) setOffer(result.offer);
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  /** Call from the link's onClick. Does not prevent the link: the dialler opens as normal. */
  const begin = useCallback((who: { partyId: number; name: string }, option: Pick<CallOption, "label" | "display">) => {
    tracking = startCall({ partyId: who.partyId, name: who.name, label: option.label, display: option.display, startedAt: Date.now() });
    setOffer(null);
  }, []);

  return { offer, begin, dismiss: () => setOffer(null) };
}
