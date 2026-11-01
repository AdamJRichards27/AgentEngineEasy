import { Link } from "wouter";
import { MOBILE_COMING_SOON } from "./mobileLabels";
import { MOBILE_MORE_LABEL, type MobileNav } from "./mobileNavModel";

// AE Mobile (CC Task #64, M2): the More screen. It draws the grouped list the PR #280 navigation model
// returns (moreGroups: Grow, Run, Workspace). Presentational: no hooks, no network.
//   - Run links appear only for Run subscribers, by role (the model decides).
//   - A Grow-only subscriber sees one "Add Run" row in the Run group. It is words only: no link. The model's
//     placeholder address (Settings with a marker) is not used, because no Add Run screen exists and nothing
//     is pretended. Link it when that screen is built.
//   - Marketing is shown as "Coming soon", not a link, as the desktop sidebar shows it. It is a placeholder in
//     the code; no Marketing workflow is invented here.
//   - Whatever else the model lists (for example Business Coach, with grow.ai.use) is drawn as the link it is.

export const ADD_RUN_DESCRIPTION = "A Brokerage Administrator can add it.";

export function MobileMoreView({ nav }: { nav: MobileNav }) {
  if (nav.moreGroups.length === 0) return null;
  const upgradeKey = nav.upgrade?.key ?? null;
  return (
    <div className="mob-more" data-ae-more="mobile">
      <h1 className="mob-more-title">{MOBILE_MORE_LABEL}</h1>
      {nav.moreGroups.map((group) => (
        <section key={group.key} className="mob-more-group" aria-label={group.label}>
          <h2 className="mob-more-group-title">{group.label}</h2>
          <div className="mob-list">
            {group.items
              .filter((item) => item.key !== upgradeKey)
              .map((item) => (
                <Link key={item.key} href={item.href} className="mob-row mob-row-plain">
                  {item.label}
                </Link>
              ))}
            {group.key === "grow" ? (
              <div className="mob-row mob-row-static">
                <span>Marketing</span>
                <span className="mob-chip">{MOBILE_COMING_SOON}</span>
              </div>
            ) : null}
            {nav.upgrade && group.items.some((item) => item.key === upgradeKey) ? (
              <div className="mob-row mob-row-static">
                <span className="mob-row-main">
                  <span className="mob-row-title">{nav.upgrade.label}</span>
                  <span className="mob-row-sub">{ADD_RUN_DESCRIPTION}</span>
                </span>
              </div>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}
