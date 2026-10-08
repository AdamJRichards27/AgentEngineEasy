// GP-2 — Edit contact on Contact 360. Prefill, inline validation, a 409
// conflict, the consent note, and a save that refreshes Contact 360 and the
// contact list. Same in-memory React harness as the new-contact behaviour test.

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
    onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
    id?: string;
    htmlFor?: string;
    type?: string;
    value?: string;
    href?: string;
    role?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    "aria-invalid"?: boolean;
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

const contact = {
  firstName: "Ada",
  middleName: null,
  lastName: "Lovelace",
  organisationName: null,
  email: "ada@example.com",
  mobile: "0400111222",
  residentialAddress: "12 Analytical Street",
};

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
  name: "gp2-edit-contact-mocks",
  enforce: "pre",
  resolveId(source) {
    if (source === "react" || source === "virtual:gp2-react") return "\0gp2-react";
    if (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime" || source === "virtual:gp2-jsx") return "\0gp2-jsx";
    if (source === "@tanstack/react-query" || source === "virtual:gp2-query") return "\0gp2-query";
    if (source === "wouter" || source === "virtual:gp2-wouter") return "\0gp2-wouter";
    if (source === "../lib/api") return "\0gp2-api";
    return null;
  },
  load(id) {
    if (id === "\0gp2-react") {
      return `
        export const useState = (...args) => globalThis.__gp2Hooks.useState(...args);
        export const useEffect = () => {};
        export const useRef = (initial) => ({ current: initial });
      `;
    }
    if (id === "\0gp2-jsx") {
      return `
        export const Fragment = Symbol.for("gp2-fragment");
        export const jsx = (type, props, key) => (typeof type === "function" ? type(props) : { type, props, key });
        export const jsxs = jsx;
        export const jsxDEV = jsx;
      `;
    }
    if (id === "\0gp2-query") {
      return `
        export const useQueryClient = () => ({
          invalidateQueries: (filter) => globalThis.__gp2Invalidated.push(filter && filter.queryKey),
        });
        export const useMutation = (options) => {
          const index = globalThis.__gp2MutationCursor++;
          globalThis.__gp2Mutations[index] = options;
          return {
            isPending: false,
            isError: false,
            error: null,
            mutate(input) {
              globalThis.__gp2Pending.push(
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
    if (id === "\0gp2-wouter") {
      return `export const Link = (props) => ({ type: "a", props });`;
    }
    if (id === "\0gp2-api") {
      return `
        export const ApiError = globalThis.__gp2ApiError;
        export const apiFetch = (path, options) => globalThis.__gp2ApiFetch(path, options);
        export function apiErrorMessage(error, fallback) {
          if (error instanceof ApiError && typeof error.friendly === "string" && error.friendly.trim()) return error.friendly;
          return fallback;
        }
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
        { find: /^react$/, replacement: "virtual:gp2-react" },
        { find: /^react\/jsx-(dev-)?runtime$/, replacement: "virtual:gp2-jsx" },
        { find: /^@tanstack\/react-query$/, replacement: "virtual:gp2-query" },
        { find: /^wouter$/, replacement: "virtual:gp2-wouter" },
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

function install(fetchImpl: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>) {
  const hooks = createHarness();
  const calls: Call[] = [];
  const invalidated: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  Object.assign(globalThis, {
    __gp2Hooks: hooks,
    __gp2ApiError: FakeApiError,
    __gp2Invalidated: invalidated,
    __gp2Pending: pending,
    __gp2Mutations: [],
    __gp2MutationCursor: 0,
    __gp2ApiFetch: (path: string, options?: { method?: string; body?: string }) => {
      calls.push({ path, options });
      return fetchImpl(path, options);
    },
  });
  return { hooks, calls, invalidated, pending };
}

function clearGlobals() {
  for (const key of ["__gp2Hooks", "__gp2ApiError", "__gp2Invalidated", "__gp2Pending", "__gp2Mutations", "__gp2MutationCursor", "__gp2ApiFetch"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

type FormComponent = (props: { partyId: number; contact: typeof contact; canEdit: boolean }) => unknown;

function render(hooks: ReturnType<typeof createHarness>, Form: FormComponent, canEdit = true) {
  (globalThis as { __gp2MutationCursor: number }).__gp2MutationCursor = 0;
  hooks.beginRender();
  return Form({ partyId: 17, contact, canEdit });
}

function openForm(hooks: ReturnType<typeof createHarness>, Form: FormComponent) {
  const closed = render(hooks, Form);
  const edit = button(closed, "Edit contact");
  assert.ok(edit, "an entitled user sees Edit contact");
  assert.equal(edit.props!.type, "button");
  edit.props!.onClick!();
  return render(hooks, Form);
}

function setField(tree: unknown, id: string, value: string) {
  const input = field(tree, id);
  assert.ok(input, id);
  input!.props!.onChange!({ target: { value } });
}

test("Edit contact opens a labelled form prefilled from Contact 360", async () => {
  const { hooks, calls } = install(async () => ({ contact: { id: 17 } }));
  try {
    await withVite(async (vite) => {
      const { GrowContactEditForm } = (await vite.ssrLoadModule("/src/components/GrowContactEditForm.tsx")) as {
        GrowContactEditForm: FormComponent;
      };
      const closed = render(hooks, GrowContactEditForm);
      assert.equal(field(closed, "contact-edit-first-name"), undefined);
      const formTree = openForm(hooks, GrowContactEditForm);
      const form = findAll(formTree, (element) => element.type === "form")[0];
      assert.ok(form);
      assert.equal(form.props!.ariaLabelledBy ?? form.props!["aria-labelledby"], "contact-edit-heading");

      const pairs: Array<[string, string, string]> = [
        ["contact-edit-first-name", "First name", "Ada"],
        ["contact-edit-middle-name", "Middle name", ""],
        ["contact-edit-last-name", "Last name", "Lovelace"],
        ["contact-edit-organisation", "Organisation", ""],
        ["contact-edit-email", "Email", "ada@example.com"],
        ["contact-edit-mobile", "Mobile phone", "0400111222"],
        ["contact-edit-address", "Address", "12 Analytical Street"],
      ];
      for (const [id, label, value] of pairs) {
        const input = field(formTree, id);
        assert.ok(input, id);
        assert.equal(input!.props!.value, value);
        const labelling = findAll(formTree, (element) => element.type === "label" && element.props?.htmlFor === id)[0];
        assert.ok(labelling, `${id} has a label`);
        assert.equal(textContent(labelling).trim(), label);
      }
      assert.equal(field(formTree, "contact-edit-first-name")!.props!.autoFocus, true);
      const save = button(formTree, "Save contact");
      const cancel = button(formTree, "Cancel");
      assert.equal(save?.props!.type, "submit");
      assert.equal(cancel?.props!.type, "button");
      assert.equal(calls.length, 0);

      cancel!.props!.onClick!();
      const afterCancel = render(hooks, GrowContactEditForm);
      assert.ok(button(afterCancel, "Edit contact"));
      assert.equal(field(afterCancel, "contact-edit-first-name"), undefined);
      assert.equal(calls.length, 0);
    });
  } finally {
    clearGlobals();
  }
});

test("clearing every identifying field shows the creation error and does not save", async () => {
  const { hooks, calls, invalidated, pending } = install(async () => ({ contact: { id: 17 } }));
  try {
    await withVite(async (vite) => {
      const { GrowContactEditForm } = (await vite.ssrLoadModule("/src/components/GrowContactEditForm.tsx")) as {
        GrowContactEditForm: FormComponent;
      };
      let tree = openForm(hooks, GrowContactEditForm);
      for (const id of ["contact-edit-first-name", "contact-edit-last-name", "contact-edit-email", "contact-edit-mobile"]) {
        setField(tree, id, "   ");
        tree = render(hooks, GrowContactEditForm);
      }
      setField(tree, "contact-edit-address", "1 Remaining Street");
      tree = render(hooks, GrowContactEditForm);
      findAll(tree, (element) => element.type === "form")[0].props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      const done = render(hooks, GrowContactEditForm);
      const alert = findAll(done, (element) => element.props?.role === "alert")[0];
      assert.ok(alert);
      assert.match(textContent(alert), /A contact needs a name, email, or phone/);
      assert.equal(field(done, "contact-edit-first-name")!.props!["aria-invalid"], true);
      assert.equal(calls.length, 0);
      assert.equal(invalidated.length, 0);
      assert.ok(field(done, "contact-edit-address"), "the form stays open so the error can be corrected");
    });
  } finally {
    clearGlobals();
  }
});

test("a 409 shows the conflict inline and links only when the existing contact is visible", async () => {
  const { hooks, calls, invalidated, pending } = install(async () => {
    throw new FakeApiError(409, "A contact with this email already exists.", 42);
  });
  try {
    await withVite(async (vite) => {
      const { GrowContactEditForm } = (await vite.ssrLoadModule("/src/components/GrowContactEditForm.tsx")) as {
        GrowContactEditForm: FormComponent;
      };
      let tree = openForm(hooks, GrowContactEditForm);
      setField(tree, "contact-edit-email", "taken@example.com");
      tree = render(hooks, GrowContactEditForm);
      assert.match(textContent(tree), /Consent for the new email must be recorded separately/);
      assert.equal(field(tree, "contact-edit-email")!.props!.value, "taken@example.com");
      findAll(tree, (element) => element.type === "form")[0].props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      const done = render(hooks, GrowContactEditForm);
      const alert = findAll(done, (element) => element.props?.role === "alert")[0];
      assert.match(textContent(alert), /already exists/);
      const view = linkTo(done, "View the existing contact");
      assert.ok(view);
      assert.equal(view!.props!.href, "/grow/contacts/42");
      assert.equal(textContent(done).includes("ada@example.com") && textContent(alert).includes("ada@example.com"), false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options?.method, "PATCH");
      assert.equal(invalidated.length, 0, "a conflict does not refresh");
    });
  } finally {
    clearGlobals();
  }
});

test("a 409 without a visible contact id shows the message and no link", async () => {
  const { hooks, pending } = install(async () => {
    throw new FakeApiError(409, "A contact with this phone number already exists.");
  });
  try {
    await withVite(async (vite) => {
      const { GrowContactEditForm } = (await vite.ssrLoadModule("/src/components/GrowContactEditForm.tsx")) as {
        GrowContactEditForm: FormComponent;
      };
      let tree = openForm(hooks, GrowContactEditForm);
      setField(tree, "contact-edit-mobile", "0499888777");
      tree = render(hooks, GrowContactEditForm);
      assert.match(textContent(tree), /Consent for the new phone must be recorded separately/);
      findAll(tree, (element) => element.type === "form")[0].props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      const done = render(hooks, GrowContactEditForm);
      assert.match(textContent(done), /phone number already exists/);
      assert.equal(linkTo(done, "View the existing contact"), undefined);
      assert.equal(field(done, "contact-edit-mobile")!.props!.value, "0499888777");
    });
  } finally {
    clearGlobals();
  }
});

test("saving refreshes Contact 360 and the contact list, and notes a new email", async () => {
  const { hooks, calls, invalidated, pending } = install(async () => ({ contact: { id: 17 } }));
  try {
    await withVite(async (vite) => {
      const { GrowContactEditForm } = (await vite.ssrLoadModule("/src/components/GrowContactEditForm.tsx")) as {
        GrowContactEditForm: FormComponent;
      };
      let tree = openForm(hooks, GrowContactEditForm);
      setField(tree, "contact-edit-last-name", "King");
      setField(tree, "contact-edit-email", "ada.king@example.com");
      tree = render(hooks, GrowContactEditForm);
      assert.match(textContent(tree), /Consent for the new email must be recorded separately/);
      findAll(tree, (element) => element.type === "form")[0].props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/grow/contacts/17");
      assert.equal(calls[0].options?.method, "PATCH");
      assert.deepEqual(JSON.parse(calls[0].options!.body!), {
        firstName: "Ada",
        middleName: "",
        lastName: "King",
        organisationName: "",
        email: "ada.king@example.com",
        mobile: "0400111222",
        residentialAddress: "12 Analytical Street",
      });
      assert.ok(invalidated.some((key) => Array.isArray(key) && key[0] === "grow-contact" && key[1] === 17));
      assert.ok(invalidated.some((key) => Array.isArray(key) && key.length === 1 && key[0] === "grow-contacts"));

      const done = render(hooks, GrowContactEditForm);
      assert.ok(button(done, "Edit contact"), "the form closes after a successful save");
      assert.match(textContent(done), /Saved\. Consent for the new email must be recorded separately/);
    });
  } finally {
    clearGlobals();
  }
});

test("a server validation error stays inline and a name-only save does not warn about consent", async () => {
  const { hooks, calls, invalidated, pending } = install(async () => {
    throw new FakeApiError(400, "Contact fields must be 2000 characters or fewer.");
  });
  try {
    await withVite(async (vite) => {
      const { GrowContactEditForm } = (await vite.ssrLoadModule("/src/components/GrowContactEditForm.tsx")) as {
        GrowContactEditForm: FormComponent;
      };
      let tree = openForm(hooks, GrowContactEditForm);
      setField(tree, "contact-edit-last-name", "Byron");
      tree = render(hooks, GrowContactEditForm);
      assert.equal(textContent(tree).includes("recorded separately"), false);
      findAll(tree, (element) => element.type === "form")[0].props!.onSubmit!({ preventDefault() {} });
      await Promise.all(pending);
      const done = render(hooks, GrowContactEditForm);
      assert.match(textContent(done), /2000 characters or fewer/);
      assert.equal(linkTo(done, "View the existing contact"), undefined);
      assert.equal(calls.length, 1);
      assert.equal(invalidated.length, 0);
      assert.ok(field(done, "contact-edit-last-name"));
    });
  } finally {
    clearGlobals();
  }
});

test("Edit contact is hidden without grow.contacts.manage", async () => {
  const { hooks, calls } = install(async () => ({ contact: { id: 17 } }));
  try {
    await withVite(async (vite) => {
      const { GrowContactEditForm } = (await vite.ssrLoadModule("/src/components/GrowContactEditForm.tsx")) as {
        GrowContactEditForm: FormComponent;
      };
      const tree = render(hooks, GrowContactEditForm, false);
      assert.equal(tree, null);
      assert.equal(button(tree, "Edit contact"), undefined);
      assert.equal(calls.length, 0);
    });
  } finally {
    clearGlobals();
  }
});
