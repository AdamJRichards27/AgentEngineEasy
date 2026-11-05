// AE 2.0: the held-imports workspace for Administrators and authorised Agents. Its own page (linked from the Import page) so the Import page itself
// carries no extra state. The panel decides what each person can do from the server's fields.
import { Link } from "wouter";
import { HeldImportsPanel } from "../components/HeldImportsPanel";

export default function GrowHeldImports() {
  return (
    <div data-ae-held-page>
      <h1>Imports held for review</h1>
      <HeldImportsPanel showEmpty />
      <p className="muted"><Link href="/grow/import">Back to Import</Link></p>
    </div>
  );
}
