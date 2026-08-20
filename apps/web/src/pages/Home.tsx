import { Link } from "wouter";

// "What needs my attention today?" — Build Brief §13/§26 UI principle:
// one or two decisions, not a menu of modules. Phase 8 fleshes this out
// with real cross-property exceptions/next-actions once Phases 2-7 exist.
export default function Home() {
  return (
    <div>
      <h1>Home</h1>
      <p>What needs your attention today will appear here once properties exist.</p>
      <Link href="/properties/start">
        <button>+ Start Property</button>
      </Link>
    </div>
  );
}
