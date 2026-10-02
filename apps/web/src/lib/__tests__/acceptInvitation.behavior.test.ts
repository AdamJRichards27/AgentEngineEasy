// UAT-T1 — Accept Invitation behaviour.
//
// A valid invitation posts the trimmed name, the password, and both consent
// flags to POST /auth/invitations/:token/accept. The confirm-password field
// and the legal version strings stay on the page; they are not in the body.
// Success calls useCompleteSignIn() and then setLocation("/"). This page
// does not call resolveLandingRoute.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
}

interface Write {
  path: string;
  options?: { method?: string; body?: string };
}

interface MutationSlot {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  options: {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (result: unknown) => Promise<void> | void;
  };
}

const TOKEN = "tok_uat_1";

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
  return findAll(tree, (element) => element.type === "button" && textContent(element).trim() === label)[0];
}

function inputs(tree: unknown): ElementNode[] {
  return findAll(tree, (element) => element.type === "input");
}

function textInputs(tree: unknown): ElementNode[] {
  return inputs(tree).filter((element) => element.props?.type === "text");
}

function passwordInputs(tree: unknown): ElementNode[] {
  return inputs(tree).filter((element) => element.props?.type === "password");
}

function changeValue(element: ElementNode | undefined, value: string): void {
  const onChange = element?.props?.onChange;
  if (typeof onChange !== "function") throw new Error("missing change handler");
  onChange({ target: { value } });
}

function changeChecked(element: ElementNode | undefined, checked: boolean): void {
  const onChange = element?.props?.onChange;
  if (typeof onChange !== "function") throw new Error("missing change handler");
  onChange({ target: { checked } });
}

function click(element: ElementNode | undefined): void {
  const onClick = element?.props?.onClick;
  if (typeof onClick !== "function") throw new Error(`missing click handler for ${textContent(element)}`);
  onClick();
}

const virtualMocks: Plugin = {
  name: "uat-accept-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:uat-accept-react") return "\0uat-accept-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:uat-accept-jsx") return "\0uat-accept-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:uat-accept-query") return "\0uat-accept-query";
    if (source === "wouter" || source === "virtual:uat-accept-wouter") return "\0uat-accept-wouter";
    if (source === "../lib/api") return "\0uat-accept-api";
    if (source === "../lib/session") return "\0uat-accept-session";
    return null;
  },
  load(id) {
    if (id === "\0uat-accept-react") {
      return `
        export const useState = (...args) => globalThis.__uatAcceptHooks.useState(...args);
        export const Fragment = Symbol.for("uat-accept-fragment");
      `;
    }
    if (id === "\0uat-accept-jsx") {
      return `
        export const Fragment = Symbol.for("uat-accept-fragment");
        export const jsx = (type, props, key) => ({ type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0uat-accept-query") {
      return `
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__uatAcceptQueries || {};
          if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: false, isError: false, data: undefined, error: null };
        };
        export const useMutation = (options) => {
          const slot = globalThis.__uatAcceptHooks.useMutation(options);
          return {
            get isPending() { return slot.isPending; },
            get isError() { return slot.isError; },
            get isSuccess() { return slot.isSuccess; },
            get error() { return slot.error; },
            mutate() {
              const pending = Promise.resolve()
                .then(() => slot.options.mutationFn())
                .then(
                  async (result) => {
                    slot.isPending = false;
                    slot.isError = false;
                    slot.isSuccess = true;
                    slot.error = null;
                    if (slot.options.onSuccess) await slot.options.onSuccess(result);
                  },
                  (error) => {
                    slot.isPending = false;
                    slot.isError = true;
                    slot.isSuccess = false;
                    slot.error = error;
                  },
                );
              globalThis.__uatAcceptPending.push(pending);
            },
          };
        };
      `;
    }
    if (id === "\0uat-accept-wouter") {
      return `
        export function Link(props) { return props.children; }
        export const useLocation = () => [
          "/accept-invitation/${TOKEN}",
          (next) => { globalThis.__uatAcceptNavigations.push(next); },
        ];
      `;
    }
    if (id === "\0uat-accept-api") {
      return `
        export class ApiError extends Error {
          constructor(status, friendly) {
            super(friendly);
            this.name = "ApiError";
            this.status = status;
            this.friendly = friendly;
          }
        }
        globalThis.__uatAcceptApiError = ApiError;
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
        export const apiFetch = (path, options) => {
          globalThis.__uatAcceptWrites.push({ path, options });
          return globalThis.__uatAcceptApiFetch(path, options);
        };
      `;
    }
    if (id === "\0uat-accept-session") {
      return `
        export const useCompleteSignIn = () => async () => {
          globalThis.__uatAcceptCompleteSignIn += 1;
        };
      `;
    }
    return null;
  },
};

interface AcceptHooks {
  beginRender: () => void;
  reset: () => void;
  useState: (initial: unknown) => [unknown, (next: unknown) => void];
  useMutation: (options: MutationSlot["options"]) => MutationSlot;
}

let vite: ViteDevServer;
let Page: (props: { params: { token: string } }) => unknown;

const g = globalThis as typeof globalThis & {
  __uatAcceptHooks: AcceptHooks;
  __uatAcceptQueries: Record<string, unknown>;
  __uatAcceptWrites: Write[];
  __uatAcceptPending: Promise<unknown>[];
  __uatAcceptNavigations: string[];
  __uatAcceptCompleteSignIn: number;
  __uatAcceptApiFetch: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>;
  __uatAcceptApiError: new (status: number, friendly: string) => Error & { friendly: string };
};

function installHooks(): void {
  const state: unknown[] = [];
  let stateCursor = 0;
  const mutations: MutationSlot[] = [];
  let mutationCursor = 0;
  g.__uatAcceptHooks = {
    beginRender() {
      stateCursor = 0;
      mutationCursor = 0;
    },
    reset() {
      state.length = 0;
      mutations.length = 0;
      stateCursor = 0;
      mutationCursor = 0;
    },
    useState(initial: unknown) {
      const index = stateCursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [
        state[index],
        (next: unknown) => {
          state[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(state[index]) : next;
        },
      ];
    },
    useMutation(options: MutationSlot["options"]) {
      const index = mutationCursor++;
      if (!mutations[index]) {
        mutations[index] = { isPending: false, isError: false, isSuccess: false, error: null, options };
      }
      mutations[index].options = options;
      return mutations[index];
    },
  };
}

function validQueries(): Record<string, unknown> {
  return {
    [`["invitation-status","${TOKEN}"]`]: { isLoading: false, isError: false, data: { status: "valid" }, error: null },
    '["legal-versions"]': {
      isLoading: false,
      isError: false,
      data: { termsVersion: "terms-2026-01", privacyVersion: "privacy-2026-01" },
      error: null,
    },
  };
}

function resetInteraction(): void {
  g.__uatAcceptHooks.reset();
  g.__uatAcceptQueries = validQueries();
  g.__uatAcceptWrites = [];
  g.__uatAcceptPending = [];
  g.__uatAcceptNavigations = [];
  g.__uatAcceptCompleteSignIn = 0;
  g.__uatAcceptApiFetch = () => Promise.resolve({ user: { id: 4 } });
}

function render(): unknown {
  g.__uatAcceptHooks.beginRender();
  return Page({ params: { token: TOKEN } });
}

function fillNames(tree: unknown, first: string, last: string): unknown {
  changeValue(textInputs(tree)[0], first);
  let next = render();
  changeValue(textInputs(next)[1], last);
  return render();
}

function fillPasswords(tree: unknown, password: string, confirm: string): unknown {
  const fields = passwordInputs(tree);
  changeValue(fields[0], password);
  let next = render();
  changeValue(passwordInputs(next)[1], confirm);
  return render();
}

before(async () => {
  installHooks();
  resetInteraction();
  vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:uat-accept-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:uat-accept-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:uat-accept-query" },
        { find: /^wouter$/, replacement: "virtual:uat-accept-wouter" },
      ],
    },
    plugins: [virtualMocks],
  });
  Page = ((await vite.ssrLoadModule("/src/pages/AcceptInvitation.tsx")) as {
    default: (props: { params: { token: string } }) => unknown;
  }).default;
});

after(async () => {
  await vite?.close();
  for (const key of [
    "__uatAcceptHooks",
    "__uatAcceptQueries",
    "__uatAcceptWrites",
    "__uatAcceptPending",
    "__uatAcceptNavigations",
    "__uatAcceptCompleteSignIn",
    "__uatAcceptApiFetch",
    "__uatAcceptApiError",
  ]) {
    delete (g as Record<string, unknown>)[key];
  }
});

describe("UAT-T1 Accept Invitation", { concurrency: 1 }, () => {
  test("posts the password and both consent flags, then finishes sign-in on /", async () => {
    resetInteraction();
    const password = "a-long-enough-password";
    let tree = fillNames(render(), "  Ada  ", "  Lovelace  ");
    tree = fillPasswords(tree, password, password);
    const boxes = inputs(tree).filter((element) => element.props?.type === "checkbox");
    assert.equal(boxes.length, 2);
    changeChecked(boxes[0], true);
    tree = render();
    changeChecked(inputs(tree).filter((element) => element.props?.type === "checkbox")[1], true);
    tree = render();

    const text = textContent(tree);
    assert.match(text, /terms-2026-01/);
    assert.match(text, /privacy-2026-01/);
    assert.equal(button(tree, "Create account")?.props?.disabled, false);
    click(button(tree, "Create account"));
    await Promise.all(g.__uatAcceptPending);

    assert.equal(g.__uatAcceptWrites.length, 1);
    assert.equal(g.__uatAcceptWrites[0]?.path, `/auth/invitations/${TOKEN}/accept`);
    assert.equal(g.__uatAcceptWrites[0]?.options?.method, "POST");
    assert.deepEqual(JSON.parse(g.__uatAcceptWrites[0]?.options?.body ?? ""), {
      firstName: "Ada",
      lastName: "Lovelace",
      password,
      acceptedTerms: true,
      acceptedPrivacyPolicy: true,
    });
    assert.equal(g.__uatAcceptCompleteSignIn, 1);
    assert.deepEqual(g.__uatAcceptNavigations, ["/"]);
    assert.match(textContent(render()), /Your account is ready/);
  });

  test("does not post until the passwords match and both consents are checked", async () => {
    resetInteraction();
    let tree = fillPasswords(render(), "a-long-enough-password", "different-password");
    assert.match(textContent(tree), /Passwords don't match/);
    assert.equal(button(tree, "Create account")?.props?.disabled, true);
    click(button(tree, "Create account"));
    assert.deepEqual(g.__uatAcceptWrites, []);

    tree = fillPasswords(render(), "a-long-enough-password", "a-long-enough-password");
    const terms = inputs(tree).filter((element) => element.props?.type === "checkbox")[0];
    changeChecked(terms, true);
    tree = render();
    assert.equal(button(tree, "Create account")?.props?.disabled, true);
    click(button(tree, "Create account"));
    assert.deepEqual(g.__uatAcceptWrites, []);
    changeChecked(inputs(tree).filter((element) => element.props?.type === "checkbox")[1], true);
    tree = render();
    assert.equal(button(tree, "Create account")?.props?.disabled, true, "blank names keep submit disabled");
    click(button(tree, "Create account"));
    assert.deepEqual(g.__uatAcceptWrites, []);
    tree = fillNames(tree, "Ada", "Lovelace");
    assert.equal(button(tree, "Create account")?.props?.disabled, false);
    assert.deepEqual(g.__uatAcceptNavigations, []);
    assert.equal(g.__uatAcceptCompleteSignIn, 0);
  });

  test("an invalid or expired invitation does not post", () => {
    resetInteraction();
    g.__uatAcceptQueries = {
      [`["invitation-status","${TOKEN}"]`]: {
        isLoading: false,
        isError: false,
        data: { status: "invalid_or_expired" },
        error: null,
      },
    };
    const tree = render();
    assert.match(textContent(tree), /This invitation link is invalid or has expired/);
    assert.equal(button(tree, "Create account"), undefined);
    assert.deepEqual(g.__uatAcceptWrites, []);
  });

  test("a rejected accept shows the error and stays on the page", async () => {
    resetInteraction();
    const ApiError = g.__uatAcceptApiError;
    g.__uatAcceptApiFetch = () => Promise.reject(new ApiError(400, "This invitation link is invalid or has expired."));

    let tree = fillNames(render(), "Ada", "Lovelace");
    tree = fillPasswords(tree, "a-long-enough-password", "a-long-enough-password");
    const boxes = inputs(tree).filter((element) => element.props?.type === "checkbox");
    changeChecked(boxes[0], true);
    tree = render();
    changeChecked(inputs(tree).filter((element) => element.props?.type === "checkbox")[1], true);
    tree = render();
    click(button(tree, "Create account"));
    await Promise.all(g.__uatAcceptPending);

    tree = render();
    assert.match(textContent(tree), /This invitation link is invalid or has expired\./);
    assert.equal(textContent(tree).includes("Couldn't create your account. Try again."), false);
    assert.equal(g.__uatAcceptWrites.length, 1);
    assert.equal(g.__uatAcceptWrites[0]?.path, `/auth/invitations/${TOKEN}/accept`);
    assert.equal(g.__uatAcceptCompleteSignIn, 0);
    assert.deepEqual(g.__uatAcceptNavigations, []);
  });
});
