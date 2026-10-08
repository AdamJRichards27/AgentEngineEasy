import type { HTMLAttributes, ReactNode, Ref } from "react";

// UAT D4 — a Grow table is often wider than a phone. This box is the only
// thing that scrolls sideways. The page itself stays within the viewport
// (see .grow-table-scroll and the min-width: 0 flex chain in styles.css).
// Extra attributes (a vertical window, a keyboard region) stay on this same
// box so the table still has one scrollport. A second overflow wrapper would
// trap the mouse wheel on the horizontal axis.
export function GrowTableScroll({
  children,
  className,
  viewportRef,
  ...rest
}: { children: ReactNode; viewportRef?: Ref<HTMLDivElement> } & HTMLAttributes<HTMLDivElement>) {
  const classes = className ? `grow-table-scroll ${className}` : "grow-table-scroll";
  return (
    <div ref={viewportRef} className={classes} {...rest}>
      {children}
    </div>
  );
}
