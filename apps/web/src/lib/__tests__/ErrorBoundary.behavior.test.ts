import assert from "node:assert/strict";
import test from "node:test";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ApiError } from "../api";
import {
  INITIAL_ERROR_BOUNDARY_STATE,
  correlationIdOf,
  deriveErrorBoundaryState,
  makeClientReferenceId,
  shouldResetOnKeyChange,
  type ErrorBoundaryState,
} from "../errorBoundary";

// AE GROW Pilot Readiness WP5 — ErrorBoundary. There is no DOM renderer in
// this node harness, so (like the other *.behavior tests) the real component
// is exercised directly: React's getDerivedStateFromError is called with a
// thrown error, render() output is inspected as a plain element tree, and the
// "Try again" button's onClick is invoked to prove it resets.

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object") return "";
  return textContent((node as ElementNode).props?.children);
}

function findAll(node: unknown, predicate: (element: ElementNode) => boolean): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!node || typeof node !== "object") return [];
  const element = node as ElementNode;
  const own = predicate(element) ? [element] : [];
  return own.concat(findAll(element.props?.children, predicate));
}

function button(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "button" && textContent(element).includes(label))[0];
}

// A boundary instance whose setState applies synchronously (no renderer).
function mount(props: ConstructorParameters<typeof ErrorBoundary>[0]) {
  const boundary = new ErrorBoundary(props);
  boundary.setState = ((update: Partial<ErrorBoundaryState>) => {
    boundary.state = { ...boundary.state, ...update } as ErrorBoundaryState;
  }) as typeof boundary.setState;
  return boundary;
}

// What React does when a child throws during render.
function throwInChild(boundary: ErrorBoundary, error: unknown) {
  boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(error) };
}

const CHILD = { type: "p", props: { children: "Contact detail" } };

test("renders children while healthy", () => {
  const boundary = mount({ label: "Contact 360", children: CHILD });
  assert.equal(boundary.render(), CHILD);
});

test("a throwing child shows an accessible fallback with reference and a working Try again", () => {
  const boundary = mount({ label: "Contact 360", children: CHILD });
  const error = new ApiError(500, "friendly", "TypeError: cannot read properties of undefined (reading 'x')\n    at GrowContactDetail", undefined, {
    correlationId: "3f9c2a1b-7d4e-4c2a-9b1e-0a1b2c3d4e5f",
  });
  throwInChild(boundary, error);

  const tree = boundary.render();
  const alert = findAll(tree, (element) => element.props?.role === "alert");
  assert.equal(alert.length, 1, "fallback is announced (role=alert)");
  const text = textContent(tree);
  assert.match(text, /Something went wrong showing Contact 360/);
  assert.match(text, /Reference: 3f9c2a1b/);
  assert.doesNotMatch(text, /TypeError|GrowContactDetail|reading 'x'/, "never renders the raw error or stack");

  const tryAgain = button(tree, "Try again");
  assert.ok(tryAgain, "Try again button is shown");
  (tryAgain.props!.onClick as () => void)();
  assert.deepEqual(boundary.state, INITIAL_ERROR_BOUNDARY_STATE);
  assert.equal(boundary.render(), CHILD, "reset re-renders the children");
});

test("non-API render errors get a client-generated reference", () => {
  const boundary = mount({ children: CHILD });
  throwInChild(boundary, new Error("boom"));
  assert.match(textContent(boundary.render()), /Reference: [0-9a-f]{8}/);
});

test("secondary action (e.g. Back to contacts) is offered when provided", () => {
  let backs = 0;
  const boundary = mount({ label: "Contact 360", children: CHILD, secondaryAction: { label: "Back to contacts", onClick: () => backs++ } });
  throwInChild(boundary, new Error("boom"));
  const back = button(boundary.render(), "Back to contacts");
  assert.ok(back);
  (back.props!.onClick as () => void)();
  assert.equal(backs, 1);
});

test("page variant offers Reload page as well as Try again", () => {
  const boundary = mount({ variant: "page", label: "Agent Engine", children: CHILD });
  throwInChild(boundary, new Error("boom"));
  const tree = boundary.render();
  assert.ok(button(tree, "Try again"));
  assert.ok(button(tree, "Reload page"));
  assert.equal(findAll(tree, (element) => element.type === "h1").length, 1);
});

test("changing resetKey while the fallback shows resets the boundary", () => {
  const boundary = mount({ resetKey: "/grow", children: CHILD });
  throwInChild(boundary, new Error("boom"));
  boundary.props = { ...boundary.props, resetKey: "/properties" } as typeof boundary.props;
  boundary.componentDidUpdate({ resetKey: "/grow", children: CHILD });
  assert.equal(boundary.state.hasError, false);
});

test("pure helpers", () => {
  assert.equal(correlationIdOf({ correlationId: "abc" }), "abc");
  assert.equal(correlationIdOf({ correlationId: "  " }), undefined);
  assert.equal(correlationIdOf(new Error("x")), undefined);
  assert.equal(correlationIdOf(null), undefined);
  assert.equal(makeClientReferenceId(() => 0.999), "ffffffff");
  assert.deepEqual(deriveErrorBoundaryState(new Error("x"), () => "deadbeef"), { hasError: true, reference: "Reference: deadbeef" });
  assert.equal(shouldResetOnKeyChange({ hasError: true }, 1, 2), true);
  assert.equal(shouldResetOnKeyChange({ hasError: true }, 1, 1), false);
  assert.equal(shouldResetOnKeyChange({ hasError: false }, 1, 2), false);
});
