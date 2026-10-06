// G-UAT-2 — New contact form on the Contacts tab.
// Submit, a failed create, a 409 that links to the existing contact, and the
// form hidden without grow.contacts.manage. Same in-memory React harness the
// other Grow behaviour tests use.

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Plugin, type ViteDevServer } from "vite";

interface ElementNode {
  type?: unknown;
  props?: Record<string, unknown> & {
    children?: unknown;
    onClick?: () => void;
    onSubmit?: (event: { preventDefault: () => void }) => void;
    onChange?: (event: { target: { value: string } }) => void;
    id?: string;
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

function linkTo(tree: unknown, label: string): ElementNode | undefined {
  return findAll(tree, (element) => element.type === "a" && textContent(element).includes(label))[0];
}

function field(tree: unknown, id: string): ElementNode | undefined {
  return findAll(tree, (element) => element.props?.id === id)[0];
}

class FakeApiError extends Error {
  status: number;
  friendly: string;
  contactId?: number;
  constructor(status: number, friendly: string, contactId?: number) {
    super(friendly);
    this.status = status;
    this.friendly = friendly;
    this.contactId = contactId;
  }
}

type Call = { path: string; options?: { method?: string; body?: string } };

function createHarness() {
  const state: unknown[] = [];
  let stateCursor = 0;
  return {
    beginRender() {
      stateCursor = 0;
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
  };
}

const mocks: Plugin = {
  name: "guat2-new-contact-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:guat2-react") return "\0guat2-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:guat2-jsx") return "\0guat2-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:guat2-query") return "\0guat2-query";
    if (source === "wouter" || source === "virtual:guat2-wouter") return "\0guat2-wouter";
    if (source === "../lib/api") return "\0guat2-api";
    if (source === "../lib/session") return "\0guat2-session";
    if (
      source === "../components/AskAgentEngine" ||
      source === "../components/CommunicationsSection" ||
      source === "../components/PropertyIntelligencePanel" ||
      source === "../components/GrowContactTranscriptPanel" ||
      source === "../components/GrowContactConsentPanel" ||
      source === "../components/GrowPendingCommitmentProposals" ||
      source === "../components/ErrorBoundary"
    ) {
      return "\0guat2-components";
    }
    return null;
  },
  load(id) {
    if (id === "\0guat2-react") {
      return `
        export const useState = (...args) => globalThis.__guat2Hooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0guat2-jsx") {
      return `
        export const Fragment = Symbol.for("guat2-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0guat2-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filter) => globalThis.__guat2Invalidated.push(filter && filter.queryKey),
        });
        export const useQuery = (options) => {
          const key = options && options.queryKey && options.queryKey[0];
          if (key === "grow-contacts" && globalThis.__guat2Contacts) {
            return { isLoading: false, isError: false, data: { contacts: globalThis.__guat2Contacts }, refetch() {} };
          }
          if (key === "grow-relationships") return { isLoading: false, isError: false, data: { relationships: [] }, refetch() {} };
          if (key === "grow-activities") return { isLoading: false, isError: false, data: { activities: [] }, refetch() {} };
          return { isLoading: false, isError: false, data: undefined, refetch() {} };
        };
        export const useMutation = (options) => {
          const index = globalThis.__guat2MutationCursor++;
          globalThis.__guat2Mutations[index] = options;
          return {
            isPending: false,
            isError: false,
            error: null,
            mutate(input) {
              globalThis.__guat2Pending.push(
                Promise.resolve()
                  .then(() => options.mutationFn(input))
                  .then(
                    (result) => { options.onSuccess?.(result, input); },
                    (failure) => { options.onError?.(failure, input); },
                  ),
              );
            },
          };
        };
      `;
    }
    if (id === "\0guat2-wouter") {
      return `export const Link = (props) => ({ type: "a", props }); export const useSearch = () => "";`;
    }
    if (id === "\0guat2-api") {
      return `
        export const ApiError = globalThis.__guat2ApiError;
        export const apiFetch = (path, options) => globalThis.__guat2ApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
      `;
    }
    if (id === "\0guat2-session") {
      return `
        export const useSession = () => ({ user: { id: 1, firstName: "Sam", role: "Agent" } });
        export const useEntitlements = () => ({
          isLoading: false,
          hasEntitlement: (key) => globalThis.__guat2Entitlements.includes(key),
        });
      `;
    }
    if (id === "\0guat2-components") {
      return `
        export const AskAgentEngine = () => null;
        export const ContactCommunicationsSection = () => null;
        export const PropertyIntelligencePanel = () => null;
        export const GrowContactTranscriptPanel = () => null;
        export const GrowContactConsentPanel = () => null;
        export const GrowPendingCommitmentProposals = () => null;
        export const ErrorBoundary = (props) => props.children;
      `;
    }
    return null;
  },
};

async function withVite<T>(run: (vite: ViteDevServer) => Promise<T>): Promise<T> {
  const vite = await createServer({
    root: new URL("../../..", import.meta.url).pathname,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^react$/, replacement: "virtual:guat2-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:guat2-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:guat2-query" },
        { find: /^wouter$/, replacement: "virtual:guat2-wouter" },
      ],
    },
    plugins: [mocks],
  });
  try {
    return await run(vite);
  } finally {
    await vite.close();
  }
}

function install(entitlements: string[], fetchImpl: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const opened: number[] = [];
  Object.assign(globalThis, {
    __guat2Hooks: hooks,
    __guat2ApiError: FakeApiError,
    __guat2Entitlements: entitlements,
    __guat2Invalidated: invalidated,
    __guat2Pending: pending,
    __guat2Mutations: [],
    __guat2MutationCursor: 0,
    __guat2ApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return fetchImpl(path, options);
    },
  });
  return { hooks, calls, invalidated, pending, opened };
}

function clearGlobals() {
  for (const key of [
    "__guat2Hooks",
    "__guat2ApiError",
    "__guat2Entitlements",
    "__guat2Invalidated",
    "__guat2Pending",
    "__guat2Mutations",
    "__guat2MutationCursor",
    "__guat2ApiFetch",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

type FormComponent = () => unknown;

function render(hooks: ReturnType<typeof createHarness>, Form: FormComponent) {
  (globalThis as { __guat2MutationCursor: number }).__guat2MutationCursor = 0;
  hooks.beginRender();
  return Form();
}

function openAndFill(hooks: ReturnType<typeof createHarness>, Form: FormComponent) {
  const closed = render(hooks, Form);
  const openButton = button(closed, "New contact");
  assert.ok(openButton, "an entitled user sees New contact");
  openButton.props!.onClick!();
  const formTree = render(hooks, Form);
  field(formTree, "new-contact-name")!.props!.onChange!({ target: { value: "Ada Lovelace" } });
  field(formTree, "new-contact-email")!.props!.onChange!({ target: { value: "ada@example.com" } });
  field(formTree, "new-contact-phone")!.props!.onChange!({ target: { value: "0400111222" } });
  const filled = render(hooks, Form);
  assert.equal(field(filled, "new-contact-property"), undefined, "the form does not link a property");
  assert.equal(button(filled, "Link property"), undefined);
  return filled;
}

test("submitting New contact posts name, email and phone, then offers Contact 360", async () => {
  const { hooks, calls, invalidated, pending } = install(["grow.contacts.manage"], async () => ({ contact: { id: 17 } }));
  try {
    await withVite(async (vite) => {
      const { GrowNewContactForm } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowNewContactForm: FormComponent };
      const filled = openAndFill(hooks, GrowNewContactForm);
      const form = findAll(filled, (element) => element.type === "form")[0];
      form.props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/grow/contacts");
      assert.equal(calls[0].options?.method, "POST");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), {
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "0400111222",
      });
      assert.ok(
        invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-contacts"),
        "contact search is invalidated",
      );
      assert.ok(
        invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-today"),
        "Getting started (grow-today) is invalidated after creating a contact",
      );

      const done = render(hooks, GrowNewContactForm);
      assert.match(textContent(done), /Contact created/);
      const view = linkTo(done, "View Contact 360");
      assert.ok(view, "success offers Contact 360");
      assert.equal(view.props!.href, "/grow/contacts/17");
    });
  } finally {
    clearGlobals();
  }
});

test("a failed create shows the error and does not offer Contact 360", async () => {
  const { hooks, calls, invalidated, pending } = install(["grow.contacts.read", "grow.contacts.manage"], async () => {
    throw new FakeApiError(400, "A contact needs a name, email, or phone.");
  });
  try {
    await withVite(async (vite) => {
      const { GrowNewContactForm } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowNewContactForm: FormComponent };
      const filled = openAndFill(hooks, GrowNewContactForm);
      findAll(filled, (element) => element.type === "form")[0].props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      const done = render(hooks, GrowNewContactForm);
      assert.match(textContent(done), /A contact needs a name, email, or phone/);
      assert.equal(button(done, "View Contact 360"), undefined);
      assert.equal(linkTo(done, "View Contact 360"), undefined);
      assert.equal(calls.length, 1);
      assert.equal(invalidated.length, 0);
    });
  } finally {
    clearGlobals();
  }
});

test("a 409 says the contact already exists and links to it", async () => {
  const { hooks, pending } = install(["grow.contacts.manage"], async () => {
    throw new FakeApiError(409, "A contact with this phone number already exists.", 42);
  });
  try {
    await withVite(async (vite) => {
      const { GrowNewContactForm } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowNewContactForm: FormComponent };
      const filled = openAndFill(hooks, GrowNewContactForm);
      findAll(filled, (element) => element.type === "form")[0].props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      const done = render(hooks, GrowNewContactForm);
      assert.match(textContent(done), /already exists/);
      const view = linkTo(done, "View Contact 360");
      assert.ok(view, "the duplicate links to the existing contact");
      assert.equal(view.props!.href, "/grow/contacts/42");
    });
  } finally {
    clearGlobals();
  }
});

test("the contact list's View Contact 360 link goes to that contact's address", async () => {
  const { hooks } = install(["grow.contacts.manage"], async () => ({ contact: { id: 1 } }));
  (globalThis as { __guat2Contacts?: unknown }).__guat2Contacts = [
    {
      id: 18207,
      displayName: "UAT1-Sam Seller",
      partyType: "Person",
      email: "sam@example.test",
      mobile: "+61400000103",
      roles: [],
      relatedPropertyCount: 1,
    },
  ];
  try {
    await withVite(async (vite) => {
      const { GrowContactList } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowContactList: () => unknown };
      hooks.beginRender();
      const tree = GrowContactList();
      const view = linkTo(tree, "View Contact 360");
      assert.ok(view, "the row offers Contact 360");
      assert.equal(view.props!.href, "/grow/contacts/18207");
      assert.match(textContent(tree), /UAT1-Sam Seller/);
    });
  } finally {
    delete (globalThis as { __guat2Contacts?: unknown }).__guat2Contacts;
    clearGlobals();
  }
});

test("New contact is hidden without grow.contacts.manage", async () => {
  const { hooks, calls } = install(["grow.contacts.read", "grow.activities.manage"], async () => ({ contact: { id: 1 } }));
  try {
    await withVite(async (vite) => {
      const { GrowNewContactForm } = (await vite.ssrLoadModule("/src/pages/Grow.tsx")) as { GrowNewContactForm: FormComponent };
      const tree = render(hooks, GrowNewContactForm);
      assert.equal(tree, null);
      assert.equal(button(tree, "New contact"), undefined);
      assert.equal(field(tree, "new-contact-name"), undefined);
      assert.equal(calls.length, 0);
    });
  } finally {
    clearGlobals();
  }
});
