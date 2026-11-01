import { Link } from "wouter";
import { logCallHref, type PendingCall } from "./mobileCalling";

// AE Mobile (CC Task #64, M4/M5): the quiet offer shown when the agent comes back after a call. Presentational: no hooks, no network.
// It never saves anything. "Log call" opens the existing call form (on Contact 360) or Contact 360 itself (from a property).

export function CallReturnPrompt({ offer, onLog, onDismiss }: { offer: PendingCall; onLog?: () => void; onDismiss: () => void }) {
  return (
    <div className="mob-c-card mob-c-callback" role="status" data-ae-call-return>
      <p className="mob-c-next-title">
        Back from calling {offer.name}? <span className="mob-c-row-sub">({offer.label.toLowerCase()} {offer.display})</span>
      </p>
      <div className="mob-c-form-actions">
        {onLog ? (
          <button type="button" className="mob-c-primary" onClick={onLog}>
            Log call
          </button>
        ) : (
          <Link href={logCallHref(offer.partyId)} className="mob-c-primary mob-c-linkbutton" onClick={onDismiss}>
            Log call
          </Link>
        )}
        <button type="button" className="mob-c-button" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
