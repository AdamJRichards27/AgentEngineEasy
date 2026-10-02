// UAT-T1 — Login behaviour.
//
// The page posts email and password to POST /auth/login. Success calls
// useCompleteSignIn(), which refreshes the session; it does not navigate.
// The /login route in App.tsx then redirects with resolveLandingRoute.
// This harness builds element descriptors without calling child components,
// so a signed-in App render records that redirect without mounting the
// authenticated shell.

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { resolveLandingRoute } from "../productNav";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
}

interface SessionShape {
  user?: { role?: string; firstName?: string; lastName?: string; brokerageName?: string | null };
  entitlements: string[];
  isSignedIn: boolean;
  isLoading: boolean;
  probe: string;
  retryProbe: () => void;
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

function labeledInput(tree: unknown, label: string): ElementNode | undefined {
  const labels = findAll(tree, (element) => element.type === "label" && textContent(element).includes(label));
  return findAll(labels[0], (element) => element.type === "input")[0];
}

function change(element: ElementNode | undefined, value: string): void {
  const onChange = element?.props?.onChange;
  if (typeof onChange !== "function") throw new Error("missing change handler");
  onChange({ target: { value } });
}

function click(element: ElementNode | undefined): void {
  const onClick = element?.props?.onClick;
  if (typeof onClick !== "function") throw new Error(`missing click handler for ${textContent(element)}`);
  onClick();
}

function kind(element: ElementNode | undefined): string | undefined {
  const type = element?.type as { uatKind?: string; name?: string } | undefined;
  return type?.uatKind ?? type?.name;
}

const signedOut = (): SessionShape => ({
  entitlements: [],
  isSignedIn: false,
  isLoading: false,
  probe: "signed-out",
  retryProbe: () => {},
});

const virtualMocks: Plugin = {
  name: "uat-login-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:uat-login-react") return "\0uat-login-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:uat-login-jsx") return "\0uat-login-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:uat-login-query") return "\0uat-login-query";
    if (source === "wouter" || source === "virtual:uat-login-wouter") return "\0uat-login-wouter";
    if (source === "../lib/api" || source === "../../lib/api") return "\0uat-login-api";
    if (source === "../lib/session" || source === "./lib/session") return "\0uat-login-session";
    return null;
  },
  load(id) {
    if (id === "\0uat-login-react") {
      return `
        export class Component {
          constructor(props) { this.props = props; }
          setState() {}
        }
        export const useState = (...args) => globalThis.__uatLoginHooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
        export const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();
        export const lazy = () => function LazyPage() { return null; };
        export const Suspense = (props) => props.children;
        export const Fragment = Symbol.for("uat-login-fragment");
      `;
    }
    if (id === "\0uat-login-jsx") {
      return `
        export const Fragment = Symbol.for("uat-login-fragment");
        export const jsx = (type, props, key) => ({ type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0uat-login-query") {
      return `
        export const useQuery = (options) => {
          const key = JSON.stringify(options.queryKey);
          const table = globalThis.__uatLoginQueries || {};
          if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
          return { isLoading: false, isError: false, data: undefined, error: null };
        };
        export const useMutation = (options) => {
          const slot = globalThis.__uatLoginHooks.useMutation(options);
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
              globalThis.__uatLoginPending.push(pending);
            },
          };
        };
      `;
    }
    if (id === "\0uat-login-wouter") {
      return `
        export function Link(props) { return props.children; }
        export function Redirect(props) { return props.children; }
        Redirect.uatKind = "redirect";
        export function Route(props) { return props.children; }
        Route.uatKind = "route";
        export function Switch(props) { return props.children; }
        Switch.uatKind = "switch";
        export const useLocation = () => ["/", () => {}];
      `;
    }
    if (id === "\0uat-login-api") {
      return `
        export class ApiError extends Error {
          constructor(status, friendly) {
            super(friendly);
            this.name = "ApiError";
            this.status = status;
            this.friendly = friendly;
          }
        }
        globalThis.__uatLoginApiError = ApiError;
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
        export const SESSION_ENDED_MESSAGE = "Your session has ended — please sign in again.";
        export const apiFetch = (path, options) => {
          globalThis.__uatLoginWrites.push({ path, options });
          return globalThis.__uatLoginApiFetch(path, options);
        };
      `;
    }
    if (id === "\0uat-login-session") {
      return `
        export const useSession = () => globalThis.__uatLoginSession;
        export const useEntitlements = () => ({
          entitlements: globalThis.__uatLoginSession.entitlements ?? [],
          isLoading: false,
          hasEntitlement: (key) => (globalThis.__uatLoginSession.entitlements ?? []).includes(key),
        });
        export const useLogout = () => async () => {};
        export const useCompleteSignIn = () => async () => {
          globalThis.__uatLoginCompleteSignIn += 1;
          if (globalThis.__uatLoginNextSession) globalThis.__uatLoginSession = globalThis.__uatLoginNextSession;
        };
        export const useSessionEndedNotice = () => false;
      `;
    }
    return null;
  },
};

interface LoginHooks {
  beginRender: () => void;
  reset: () => void;
  useState: (initial: unknown) => [unknown, (next: unknown) => void];
  useMutation: (options: MutationSlot["options"]) => MutationSlot;
}

let vite: ViteDevServer;
let Login: () => unknown;
let App: () => unknown;

const g = globalThis as typeof globalThis & {
  __uatLoginHooks: LoginHooks;
  __uatLoginQueries: Record<string, unknown>;
  __uatLoginWrites: Write[];
  __uatLoginPending: Promise<unknown>[];
  __uatLoginSession: SessionShape;
  __uatLoginNextSession: SessionShape | null;
  __uatLoginCompleteSignIn: number;
  __uatLoginApiFetch: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>;
  __uatLoginApiError: new (status: number, friendly: string) => Error & { friendly: string; status: number };
};

function installHooks(): void {
  const state: unknown[] = [];
  let stateCursor = 0;
  const mutations: MutationSlot[] = [];
  let mutationCursor = 0;
  g.__uatLoginHooks = {
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

function resetInteraction(): void {
  g.__uatLoginHooks.reset();
  g.__uatLoginWrites = [];
  g.__uatLoginPending = [];
  g.__uatLoginCompleteSignIn = 0;
  g.__uatLoginSession = signedOut();
  g.__uatLoginNextSession = null;
  g.__uatLoginApiFetch = () => Promise.resolve({ user: { id: 1, role: "Agent" } });
}

function renderLogin(): unknown {
  g.__uatLoginHooks.beginRender();
  return Login();
}

function loginRouteChild(tree: unknown): unknown {
  const route = findAll(tree, (element) => kind(element) === "route" && element.props?.path === "/login")[0];
  assert.ok(route, "App did not render the /login route");
  return route.props?.children;
}

function sessionFor(role: string, entitlements: string[]): SessionShape {
  return {
    user: { role, firstName: "Ada", lastName: "Agent", brokerageName: "Harbour" },
    entitlements,
    isSignedIn: true,
    isLoading: false,
    probe: "signed-in",
    retryProbe: () => {},
  };
}

before(async () => {
  installHooks();
  g.__uatLoginQueries = {
    '["known-users"]': { isLoading: false, isError: true, data: undefined, error: { status: 404 } },
  };
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
        { find: /^react$/, replacement: "virtual:uat-login-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:uat-login-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:uat-login-query" },
        { find: /^wouter$/, replacement: "virtual:uat-login-wouter" },
      ],
    },
    plugins: [virtualMocks],
  });
  Login = ((await vite.ssrLoadModule("/src/pages/Login.tsx")) as { default: () => unknown }).default;
  App = ((await vite.ssrLoadModule("/src/App.tsx")) as { default: () => unknown }).default;
});

after(async () => {
  await vite?.close();
  for (const key of [
    "__uatLoginHooks",
    "__uatLoginQueries",
    "__uatLoginWrites",
    "__uatLoginPending",
    "__uatLoginSession",
    "__uatLoginNextSession",
    "__uatLoginCompleteSignIn",
    "__uatLoginApiFetch",
    "__uatLoginApiError",
  ]) {
    delete (g as Record<string, unknown>)[key];
  }
});

describe("UAT-T1 Login", { concurrency: 1 }, () => {
  test("posts email and password, and a successful sign-in lands via resolveLandingRoute", async () => {
    resetInteraction();
    const email = "ada@harbour.test";
    const password = "correct-horse-battery";
    g.__uatLoginNextSession = sessionFor("Agent", ["grow.access"]);

    let tree = renderLogin();
    const page = textContent(tree);
    assert.match(page, /Sign in to get started/);
    assert.equal(page.includes("Continue as"), false);
    assert.equal(page.includes("quick sign-in"), false);

    const signIn = button(tree, "Sign in");
    assert.equal(signIn?.props?.disabled, true);
    click(signIn);
    assert.deepEqual(g.__uatLoginWrites, []);

    change(labeledInput(tree, "Email"), email);
    tree = renderLogin();
    change(labeledInput(tree, "Password"), password);
    tree = renderLogin();
    assert.equal(button(tree, "Sign in")?.props?.disabled, false);
    click(button(tree, "Sign in"));
    await Promise.all(g.__uatLoginPending);

    assert.equal(g.__uatLoginWrites.length, 1);
    assert.equal(g.__uatLoginWrites[0]?.path, "/auth/login");
    assert.equal(g.__uatLoginWrites[0]?.options?.method, "POST");
    assert.deepEqual(JSON.parse(g.__uatLoginWrites[0]?.options?.body ?? ""), { email, password });
    assert.equal(g.__uatLoginCompleteSignIn, 1);
    assert.equal(textContent(renderLogin()).includes("Couldn't sign you in"), false);

    const cases: Array<{ role: string; entitlements: string[]; landing: "/grow" | "/" }> = [
      { role: "Agent", entitlements: ["grow.access"], landing: "/grow" },
      { role: "Agent", entitlements: ["run.access"], landing: "/" },
      { role: "Pit Crew", entitlements: ["grow.access", "run.access"], landing: "/" },
    ];
    for (const item of cases) {
      g.__uatLoginSession = sessionFor(item.role, item.entitlements);
      const child = loginRouteChild(App()) as ElementNode;
      assert.equal(kind(child), "redirect");
      assert.equal(child.props?.to, resolveLandingRoute({ role: item.role, entitlements: item.entitlements }));
      assert.equal(child.props?.to, item.landing);
    }
  });

  test("a failed login shows the error and does not land", async () => {
    resetInteraction();
    const ApiError = g.__uatLoginApiError;
    g.__uatLoginApiFetch = () => Promise.reject(new ApiError(401, "Invalid email or password."));

    let tree = renderLogin();
    change(labeledInput(tree, "Email"), "ada@harbour.test");
    tree = renderLogin();
    change(labeledInput(tree, "Password"), "wrong-password");
    tree = renderLogin();
    click(button(tree, "Sign in"));
    await Promise.all(g.__uatLoginPending);

    tree = renderLogin();
    assert.match(textContent(tree), /Invalid email or password\./);
    assert.equal(textContent(tree).includes("Couldn't sign you in. Try again."), false);
    assert.equal(g.__uatLoginWrites.length, 1);
    assert.equal(g.__uatLoginWrites[0]?.path, "/auth/login");
    assert.equal(g.__uatLoginWrites[0]?.options?.method, "POST");
    assert.equal(g.__uatLoginCompleteSignIn, 0);
    assert.equal(g.__uatLoginSession.isSignedIn, false);

    const child = loginRouteChild(App()) as ElementNode;
    assert.equal(kind(child), "Login");
  });

  test("a 428 shows the legal acceptance screen and accepting records consent then signs in", async () => {
    resetInteraction();
    const email = "ada@harbour.test";
    const password = "correct-horse-battery";
    const stored: string[] = [];
    const storage = {
      setItem: (key: string) => {
        stored.push(key);
      },
      getItem: () => null,
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    };
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
    g.__uatLoginNextSession = sessionFor("Brokerage Administrator", ["run.access"]);
    g.__uatLoginQueries['["legal-versions"]'] = {
      isLoading: false,
      isError: false,
      data: { termsVersion: "terms-2026-01", privacyVersion: "privacy-2026-01" },
      error: null,
    };
    g.__uatLoginQueries['["legal-terms"]'] = {
      isLoading: false,
      isError: false,
      data: { version: "terms-2026-01", content: "Terms body for the pilot." },
      error: null,
    };
    g.__uatLoginQueries['["legal-privacy"]'] = {
      isLoading: false,
      isError: false,
      data: { version: "privacy-2026-01", content: "Privacy body for the pilot." },
      error: null,
    };
    let loginAttempts = 0;
    g.__uatLoginApiFetch = (path, options) => {
      if (path === "/auth/login") {
        loginAttempts += 1;
        if (loginAttempts === 1) return Promise.reject(new g.__uatLoginApiError(428, "You must accept the current Terms of Use and Privacy Policy before signing in."));
        return Promise.resolve({ user: { id: 1, role: "Brokerage Administrator" } });
      }
      if (path === "/legal/acceptance") return Promise.resolve(undefined);
      return Promise.resolve({});
    };

    let tree = renderLogin();
    change(labeledInput(tree, "Email"), email);
    tree = renderLogin();
    change(labeledInput(tree, "Password"), password);
    tree = renderLogin();
    click(button(tree, "Sign in"));
    await Promise.all(g.__uatLoginPending);

    tree = renderLogin();
    const page = textContent(tree);
    assert.match(page, /Terms of Use/);
    assert.match(page, /Privacy Policy/);
    assert.match(page, /terms-2026-01/);
    assert.match(page, /privacy-2026-01/);
    assert.match(page, /Terms body for the pilot/);
    assert.match(page, /Privacy body for the pilot/);
    assert.equal(button(tree, "Accept and sign in")?.props?.disabled, true);
    assert.equal(g.__uatLoginCompleteSignIn, 0);

    const boxes = findAll(tree, (element) => element.type === "input" && element.props?.type === "checkbox");
    assert.equal(boxes.length, 2);
    const toggle = boxes[0]?.props?.onChange;
    if (typeof toggle !== "function") throw new Error("missing terms checkbox");
    toggle({ target: { checked: true } });
    tree = renderLogin();
    const togglePrivacy = findAll(tree, (element) => element.type === "input" && element.props?.type === "checkbox")[1]?.props?.onChange;
    if (typeof togglePrivacy !== "function") throw new Error("missing privacy checkbox");
    togglePrivacy({ target: { checked: true } });
    tree = renderLogin();
    assert.equal(button(tree, "Accept and sign in")?.props?.disabled, false);
    click(button(tree, "Accept and sign in"));
    await Promise.all(g.__uatLoginPending);

    assert.deepEqual(
      g.__uatLoginWrites.map((write) => write.path),
      ["/auth/login", "/legal/acceptance", "/auth/login"],
    );
    assert.equal(g.__uatLoginWrites[1]?.options?.method, "POST");
    assert.deepEqual(JSON.parse(g.__uatLoginWrites[1]?.options?.body ?? ""), {
      email,
      password,
      acceptedTerms: true,
      acceptedPrivacyPolicy: true,
    });
    assert.equal(g.__uatLoginWrites[2]?.options?.method, "POST");
    assert.deepEqual(JSON.parse(g.__uatLoginWrites[2]?.options?.body ?? ""), { email, password });
    assert.equal(g.__uatLoginCompleteSignIn, 1);
    assert.deepEqual(stored, []);
    assert.equal(textContent(renderLogin()).includes("You stayed signed out"), false);
  });

  test("declining legal acceptance stays signed out and does not record consent", async () => {
    resetInteraction();
    g.__uatLoginApiFetch = (path) => {
      if (path === "/auth/login") return Promise.reject(new g.__uatLoginApiError(428, "You must accept the current Terms of Use and Privacy Policy before signing in."));
      return Promise.resolve(undefined);
    };
    let tree = renderLogin();
    change(labeledInput(tree, "Email"), "ada@harbour.test");
    tree = renderLogin();
    change(labeledInput(tree, "Password"), "correct-horse-battery");
    tree = renderLogin();
    click(button(tree, "Sign in"));
    await Promise.all(g.__uatLoginPending);

    tree = renderLogin();
    click(button(tree, "Decline"));
    tree = renderLogin();
    assert.match(textContent(tree), /You stayed signed out/);
    assert.equal(button(tree, "Accept and sign in"), undefined);
    assert.equal(labeledInput(tree, "Password")?.props?.value, "");
    assert.deepEqual(
      g.__uatLoginWrites.map((write) => write.path),
      ["/auth/login"],
    );
    assert.equal(g.__uatLoginCompleteSignIn, 0);
    assert.equal(g.__uatLoginSession.isSignedIn, false);
  });

  test("a failed legal acceptance keeps the user signed out", async () => {
    resetInteraction();
    g.__uatLoginQueries['["legal-versions"]'] = {
      isLoading: false,
      isError: false,
      data: { termsVersion: "terms-2026-01", privacyVersion: "privacy-2026-01" },
      error: null,
    };
    g.__uatLoginQueries['["legal-terms"]'] = {
      isLoading: false,
      isError: false,
      data: { version: "terms-2026-01", content: "Terms body for the pilot." },
      error: null,
    };
    g.__uatLoginQueries['["legal-privacy"]'] = {
      isLoading: false,
      isError: false,
      data: { version: "privacy-2026-01", content: "Privacy body for the pilot." },
      error: null,
    };
    g.__uatLoginApiFetch = (path) => {
      if (path === "/legal/acceptance") return Promise.reject(new g.__uatLoginApiError(503, "Approved legal documents are not configured."));
      if (path === "/auth/login") return Promise.reject(new g.__uatLoginApiError(428, "You must accept the current Terms of Use and Privacy Policy before signing in."));
      return Promise.resolve(undefined);
    };

    let tree = renderLogin();
    change(labeledInput(tree, "Email"), "ada@harbour.test");
    tree = renderLogin();
    change(labeledInput(tree, "Password"), "correct-horse-battery");
    tree = renderLogin();
    click(button(tree, "Sign in"));
    await Promise.all(g.__uatLoginPending);
    tree = renderLogin();
    const boxes = findAll(tree, (element) => element.type === "input" && element.props?.type === "checkbox");
    (boxes[0]?.props?.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    tree = renderLogin();
    const privacy = findAll(tree, (element) => element.type === "input" && element.props?.type === "checkbox")[1];
    (privacy?.props?.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    tree = renderLogin();
    click(button(tree, "Accept and sign in"));
    await Promise.all(g.__uatLoginPending);
    tree = renderLogin();

    assert.match(textContent(tree), /Approved legal documents are not configured\./);
    assert.deepEqual(
      g.__uatLoginWrites.map((write) => write.path),
      ["/auth/login", "/legal/acceptance"],
    );
    assert.equal(g.__uatLoginCompleteSignIn, 0);
    assert.equal(g.__uatLoginSession.isSignedIn, false);
    assert.equal(button(tree, "Accept and sign in") === undefined, false);
  });
});
