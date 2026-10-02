// UAT-OB1 — own-name edit.
//
// PATCH /auth/profile carries only the trimmed first and last name. The
// form has no user id to send. Settings and the signed-in shell are the
// surfaces that offer it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const virtualMocks: Plugin = {
  name: "uat-profile-name-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:uat-profile-react") return "\0uat-profile-react";
    if (source === "react/jsx-dev-runtime" || source === "react/jsx-runtime" || source === "virtual:uat-profile-jsx") return "\0uat-profile-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:uat-profile-query") return "\0uat-profile-query";
    if (source === "../lib/api") return "\0uat-profile-api";
    return null;
  },
  load(id) {
    if (id === "\0uat-profile-react") {
      return `
        export const useState = (...args) => globalThis.__uatProfileHooks.useState(...args);
      `;
    }
    if (id === "\0uat-profile-jsx") {
      return `
        export const Fragment = Symbol.for("uat-profile-fragment");
        export const jsx = (type, props, key) => ({ type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0uat-profile-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filters) => {
            globalThis.__uatProfileInvalidations.push(filters);
          },
        });
        export const useMutation = (options) => {
          const slot = globalThis.__uatProfileHooks.useMutation(options);
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
              globalThis.__uatProfilePending.push(pending);
            },
          };
        };
      `;
    }
    if (id === "\0uat-profile-api") {
      return `
        export class ApiError extends Error {
          constructor(status, friendly) {
            super(friendly);
            this.name = "ApiError";
            this.status = status;
            this.friendly = friendly;
          }
        }
        globalThis.__uatProfileApiError = ApiError;
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
        export const apiFetch = (path, options) => {
          globalThis.__uatProfileWrites.push({ path, options });
          return globalThis.__uatProfileApiFetch(path, options);
        };
      `;
    }
    return null;
  },
};

interface ProfileHooks {
  beginRender: () => void;
  reset: () => void;
  useState: (initial: unknown) => [unknown, (next: unknown) => void];
  useMutation: (options: MutationSlot["options"]) => MutationSlot;
}

let vite: ViteDevServer;
let Form: (props: { initialFirstName: string; initialLastName: string }) => unknown;

const g = globalThis as typeof globalThis & {
  __uatProfileHooks: ProfileHooks;
  __uatProfileWrites: Write[];
  __uatProfilePending: Promise<unknown>[];
  __uatProfileInvalidations: unknown[];
  __uatProfileApiFetch: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>;
  __uatProfileApiError: new (status: number, friendly: string) => Error & { friendly: string };
};

function installHooks(): void {
  const state: unknown[] = [];
  let stateCursor = 0;
  const mutations: MutationSlot[] = [];
  let mutationCursor = 0;
  g.__uatProfileHooks = {
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
  g.__uatProfileHooks.reset();
  g.__uatProfileWrites = [];
  g.__uatProfilePending = [];
  g.__uatProfileInvalidations = [];
  g.__uatProfileApiFetch = () => Promise.resolve({ user: { firstName: "Ada", lastName: "Lovelace" } });
}

function render(first = "", last = ""): unknown {
  g.__uatProfileHooks.beginRender();
  return Form({ initialFirstName: first, initialLastName: last });
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
        { find: /^react$/, replacement: "virtual:uat-profile-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:uat-profile-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:uat-profile-query" },
      ],
    },
    plugins: [virtualMocks],
  });
  Form = ((await vite.ssrLoadModule("/src/components/OwnNameForm.tsx")) as {
    default: (props: { initialFirstName: string; initialLastName: string }) => unknown;
  }).default;
});

after(async () => {
  await vite?.close();
  for (const key of ["__uatProfileHooks", "__uatProfileWrites", "__uatProfilePending", "__uatProfileInvalidations", "__uatProfileApiFetch", "__uatProfileApiError"]) {
    delete (g as Record<string, unknown>)[key];
  }
});

describe("UAT-OB1 profile name", { concurrency: 1 }, () => {
  test("settings and the signed-in shell offer name capture", () => {
    const settings = readFileSync(new URL("../../pages/Settings.tsx", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    assert.match(settings, /OwnNameForm/);
    assert.match(settings, /Complete your profile/);
    assert.match(app, /Complete your profile/);
    assert.match(app, /Add your name/);
  });

  test("saves the trimmed own name and does not send another user's id", async () => {
    resetInteraction();
    let tree = render();
    assert.equal(button(tree, "Save name")?.props?.disabled, true);
    click(button(tree, "Save name"));
    assert.deepEqual(g.__uatProfileWrites, []);

    change(labeledInput(tree, "First name"), "  Ada  ");
    tree = render();
    assert.equal(button(tree, "Save name")?.props?.disabled, true);
    change(labeledInput(tree, "Last name"), "  Lovelace  ");
    tree = render();
    assert.equal(button(tree, "Save name")?.props?.disabled, false);
    click(button(tree, "Save name"));
    await Promise.all(g.__uatProfilePending);

    assert.equal(g.__uatProfileWrites.length, 1);
    assert.equal(g.__uatProfileWrites[0]?.path, "/auth/profile");
    assert.equal(g.__uatProfileWrites[0]?.options?.method, "PATCH");
    const body = JSON.parse(g.__uatProfileWrites[0]?.options?.body ?? "") as Record<string, unknown>;
    assert.deepEqual(body, { firstName: "Ada", lastName: "Lovelace" });
    assert.equal("userId" in body, false);
    assert.equal("id" in body, false);
    assert.equal(g.__uatProfileInvalidations.length, 1);
    assert.match(textContent(render("Ada", "Lovelace")), /Name saved\./);
  });

  test("a rejected save shows the error and does not claim success", async () => {
    resetInteraction();
    const ApiError = g.__uatProfileApiError;
    g.__uatProfileApiFetch = () => Promise.reject(new ApiError(400, "First name is required."));
    let tree = render("Ada", "Lovelace");
    change(labeledInput(tree, "First name"), "Ada");
    tree = render("Ada", "Lovelace");
    click(button(tree, "Save name"));
    await Promise.all(g.__uatProfilePending);
    tree = render("Ada", "Lovelace");
    assert.match(textContent(tree), /First name is required\./);
    assert.equal(textContent(tree).includes("Name saved."), false);
    assert.equal(g.__uatProfileInvalidations.length, 0);
  });
});
