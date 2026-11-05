import { Link } from "wouter";

// Shared by the AE Mobile view tests. Renders presentational components to an element tree by
// calling them, the same approach the existing Minimal view tests use. No DOM, no browser.
export interface El { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }

export function render(e: El): unknown {
  return (e.type as (p: unknown) => unknown)(e.props ?? {});
}
export function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node || typeof node !== "object") return "";
  const e = node as El;
  if (typeof e.type === "function" && e.type !== Link) return text(render(e));
  return text(e.props?.children);
}
export function all(node: unknown, pred: (e: El) => boolean): El[] {
  if (Array.isArray(node)) return node.flatMap((c) => all(c, pred));
  if (!node || typeof node !== "object") return [];
  const e = node as El;
  if (typeof e.type === "function" && e.type !== Link) return (pred(e) ? [e] : []).concat(all(render(e), pred));
  return (pred(e) ? [e] : []).concat(all(e.props?.children, pred));
}
export const links = (tree: unknown) => all(tree, (e) => e.type === Link);
export const hrefs = (tree: unknown) => links(tree).map((e) => String(e.props?.href));
export const byClass = (tree: unknown, cls: string) => all(tree, (e) => typeof e.props?.className === "string" && (e.props.className as string).split(" ").includes(cls));
