import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import {
  RolesPanel,
  desiredPermissions,
  matrixFromPermissions,
  noticeKeyFor,
  stateFromCondition,
} from "../../src/client/admin/pages/access/roles-panel";
import { renderWithProviders } from "./render";

/**
 * The roles tab used to describe a workspace it never wrote to and had never
 * read. `save()` built `{name, description, mcpTools, mcpReadOnly,
 * orgAssignable}` — the matrix an operator had just ticked was not in the body
 * at all, under a caption promising it was saved to `role_permissions`. The
 * load half hardcoded every role's matrix to `{read:"all", create:"all",
 * update:"all", delete:"all"}` and put the role row's DESCRIPTION where its rule
 * belonged. Both halves failed quietly: creating a role produced one with zero
 * permission rows, under which every request is denied, and opening any existing
 * role showed a preset that saving then made real.
 *
 * So these specs assert the two things a screenshot cannot: what is in the
 * request BODY, and what the screen read to draw itself. "A request happened" is
 * exactly the assertion the old code would have passed.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ME = {
  id: "u-owner",
  email: "owner@example.test",
  name: null,
  image: null,
  roles: ["admin"],
  isAdmin: true,
  tenantId: "t1",
};

const OWNER_CONDITION = { owner_id: { _eq: "$user.id" } };

type ApiRole = {
  id: string;
  name: string;
  description: string | null;
  admin: boolean;
  mcpTools: string[] | null;
  mcpReadOnly: boolean;
  orgAssignable: boolean;
};

const role = (over: Partial<ApiRole> & { id: string; name: string }): ApiRole => ({
  description: null,
  admin: false,
  mcpTools: null,
  mcpReadOnly: false,
  orgAssignable: false,
  ...over,
});

type Stored = {
  id: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
};

const stored = (over: Partial<Stored> & { id: string; action: string }): Stored => ({
  collection: "*",
  fields: null,
  condition: null,
  ...over,
});

interface Harness {
  /** Every mutating request the panel made, in order. */
  sent: { method: string; url: string; body: any }[];
  /** Answer the request currently held open. */
  finish: (res: Response) => void;
  /** Is a request still in flight? */
  pending: () => boolean;
}

const mockRoutes = (opts: {
  roles?: ApiRole[];
  perms?: Record<string, Stored[]>;
  users?: { id: string; roles: { id: string; name: string }[] }[];
  /** Hold every request of this method open until `finish` is called. */
  hold?: "POST" | "PATCH" | "PUT" | "DELETE";
}): Harness => {
  const roles = opts.roles ?? [];
  const perms = opts.perms ?? {};
  const users = opts.users ?? [];
  const sent: { method: string; url: string; body: any }[] = [];
  let settle: ((res: Response) => void) | null = null;

  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      if (url.endsWith("/api/me")) return json({ data: ME });
      if (url.endsWith("/api/roles")) return json({ data: roles });
      if (url.endsWith("/api/users")) return json({ data: users });
      // The RLS card sits under the list and reads its status unconditionally.
      // It dereferences the result, so an envelope-shaped stub crashes the tree
      // and every assertion below it becomes a lie about the roles panel.
      if (url.includes("/api/admin/rls/status")) {
        return json({
          supported: false,
          appliesTo: "",
          installed: [],
          expected: [],
          stale: [],
          missing: [],
          omissions: [],
          notOwned: [],
        });
      }
      const m = /\/api\/roles\/([^/]+)\/permissions$/.exec(url);
      if (m) return json({ data: perms[m[1] ?? ""] ?? [] });
      return json({ data: [] });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ method, url, body });
    if (opts.hold === method) {
      // Held on purpose: "the row already reads the new value" is only worth
      // asserting while the request that would confirm it has not answered.
      return new Promise<Response>((res) => {
        settle = res;
      });
    }
    if (method === "POST" && url.endsWith("/api/roles")) {
      return json({ data: { id: "r-created" } }, 201);
    }
    if (method === "PUT") {
      return json({
        data: (body.permissions ?? []).map((p: any, i: number) => ({
          id: p.id ?? `p-new-${i}`,
          roleId: "r",
          fields: p.fields ?? null,
          condition: p.condition ?? null,
          collection: p.collection,
          action: p.action,
        })),
      });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;

  return {
    sent,
    finish: (res) => settle?.(res),
    pending: () => settle !== null,
  };
};

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment — nothing to reset
  }
});

const render = (toasts: string[] = []) => {
  renderWithProviders(<RolesPanel pushToast={(m: string) => toasts.push(m)} />);
  return toasts;
};

/**
 * The list row for a role.
 *
 * Rows are found by the Edit control they carry rather than by index, because
 * the permission matrix further down the page renders the same role names in
 * `font-mono` spans of its own — an index or a bare name lookup would happily
 * return one of those instead.
 */
const roleRow = (name: string): HTMLElement => {
  const rows = [...document.querySelectorAll("div.grid")].filter((d) =>
    d.querySelector('[title="Edit role"]'),
  ) as HTMLElement[];
  const row = rows.find((d) => d.querySelector("span.font-mono")?.textContent === name);
  if (!row) throw new Error(`no role row for "${name}"`);
  return row;
};

/** The rule text the list shows for a role — the cell that used to hold the
 *  role's description. */
const ruleTextOf = (name: string): string =>
  (roleRow(name).children[2] as HTMLElement).textContent ?? "";

const click = async (el: Element | null | undefined, what: string) => {
  if (!el) throw new Error(`nothing to click: ${what}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const clickTitled = async (scope: Element | Document, title: string) =>
  click(scope.querySelector(`[title="${title}"]`), title);

const clickText = async (label: string, scope: Element | Document = document) =>
  click(
    [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label),
    `button "${label}"`,
  );

const dialog = (): HTMLElement => {
  const d = document.querySelector("[role=dialog]") as HTMLElement | null;
  if (!d) throw new Error("the role editor is not open");
  return d;
};

/** Tick one cell of the editor's per-action picker. */
const pickState = async (action: string, label: string) => {
  const d = dialog();
  const cell = [...d.querySelectorAll("span.font-mono")].find((s) => s.textContent === action);
  if (!cell) throw new Error(`no "${action}" row in the editor`);
  await clickText(label, cell.parentElement as HTMLElement);
};

/** Open the editor on an existing role and wait for it to paint. */
const openEditor = async (name: string) => {
  await clickTitled(roleRow(name), "Edit role");
  await waitFor(() => expect(dialog()).toBeDefined());
};

const putBody = (h: Harness, roleId: string): any => {
  const req = h.sent.find((s) => s.method === "PUT" && s.url.endsWith(`/api/roles/${roleId}/permissions`));
  if (!req) {
    throw new Error(
      `no PUT to /api/roles/${roleId}/permissions — saw ${h.sent.map((s) => `${s.method} ${s.url}`).join(", ") || "nothing"}`,
    );
  }
  return req.body;
};

/** One entry of a desired set, by (collection, action). */
const entry = (body: any, collection: string, action: string) =>
  (body.permissions ?? []).find((p: any) => p.collection === collection && p.action === action);

describe("what the list shows is what the server holds", () => {
  test("a role's rule is read from its permission rows, not from its description", async () => {
    mockRoutes({
      roles: [
        role({
          id: "r-auth",
          name: "authenticated",
          description: "Anyone who has signed in",
        }),
      ],
      perms: {
        "r-auth": [
          stored({ id: "p1", action: "read", condition: OWNER_CONDITION }),
          stored({ id: "p2", action: "create", condition: null }),
        ],
      },
    });
    render();
    await waitFor(() => expect(roleRow("authenticated")).toBeDefined());
    const text = ruleTextOf("authenticated");
    // The positive half first, so the negative one below cannot pass vacuously:
    // every action is reported from the rows that exist, including the three
    // that have none.
    expect(text).toContain("read: owner");
    expect(text).toContain("create: all");
    expect(text).toContain("update: none");
    expect(text).toContain("delete: none");
    expect(text).toContain("publish: none");
    // And the description, which used to be printed here as if it were a rule,
    // is not.
    expect(text).not.toContain("Anyone who has signed in");
  });

  test("a role with no permission rows reads as denied, not as full access", async () => {
    mockRoutes({
      roles: [role({ id: "r-editor", name: "editor" })],
      perms: { "r-editor": [] },
    });
    render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    // This is the shape the old editor produced and then drew as
    // `{read:"all",create:"all",update:"all",delete:"all"}`. A role with no rows
    // is denied everything, and the row has to say so.
    expect(ruleTextOf("editor")).toBe("read: none · create: none · update: none · delete: none · publish: none");
  });

  test("opening a role shows the stored rule, not a preset", async () => {
    mockRoutes({
      roles: [role({ id: "r-auth", name: "authenticated" })],
      perms: {
        "r-auth": [
          stored({ id: "p1", action: "read", condition: OWNER_CONDITION }),
          stored({ id: "p2", action: "publish", condition: { status: { _eq: "published" } } }),
        ],
      },
    });
    render();
    await waitFor(() => expect(roleRow("authenticated")).toBeDefined());
    await openEditor("authenticated");
    const compiled = dialog().querySelector("pre")?.textContent ?? "";
    expect(compiled).toContain('read: { owner_id: { _eq: "$user.id" } }');
    expect(compiled).toContain('publish: { status: { _eq: "published" } }');
    // `create` has no stored row. The preset the editor used to open on claimed
    // it did.
    expect(compiled).not.toContain("create: {}");
  });
});

describe("what an operator ticks is what gets sent", () => {
  test("the matrix is in the request body", async () => {
    const h = mockRoutes({
      roles: [role({ id: "r-editor", name: "editor" })],
      perms: { "r-editor": [] },
    });
    render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    await openEditor("editor");
    await pickState("read", "everyone");
    await pickState("delete", "owner only");
    await clickText("Save changes");
    await waitFor(() => expect(h.sent.some((s) => s.method === "PUT")).toBe(true));

    const body = putBody(h, "r-editor");
    expect(entry(body, "*", "read")).toMatchObject({ condition: null, fields: null });
    expect(entry(body, "*", "delete")).toMatchObject({ condition: OWNER_CONDITION });
    // "no access" is the ABSENCE of a row: the DSL has no deny operator, and
    // the `{_deny: true}` the compiled-rule pane prints is a comparison with no
    // recognised operator — which the compiler reduces to TRUE, i.e. full
    // access. Sending one would grant exactly what the operator refused.
    expect(entry(body, "*", "create")).toBeUndefined();
    expect(entry(body, "*", "update")).toBeUndefined();
    expect(entry(body, "*", "publish")).toBeUndefined();
    expect(body.permissions).toHaveLength(2);
  });

  test("a new role's permissions are written after it exists", async () => {
    const h = mockRoutes({ roles: [], perms: {} });
    render();
    await waitFor(() => expect(document.body.textContent).toContain("Add role"));
    await clickText("Add role");
    await waitFor(() => expect(dialog()).toBeDefined());
    const nameInput = dialog().querySelector("input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(nameInput, "support");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pickState("read", "everyone");
    await pickState("create", "no access");
    await pickState("update", "no access");
    await pickState("delete", "no access");
    await clickText("Create role");
    await waitFor(() => expect(h.sent.some((s) => s.method === "PUT")).toBe(true));

    // Addressed by URL: the MCP guard picker inside the editor posts a
    // `tools/list` of its own, and "the first POST" would be that one.
    const created = h.sent.find((s) => s.method === "POST" && s.url.endsWith("/api/roles"));
    expect(created?.body).toMatchObject({ name: "support", admin: false });
    // The PUT is addressed to the id the POST answered with — not to the name,
    // and not to an empty id.
    const body = putBody(h, "r-created");
    expect(entry(body, "*", "read")).toMatchObject({ condition: null });
    expect(body.permissions).toHaveLength(1);
  });

  test("rows this editor never showed survive a save", async () => {
    const h = mockRoutes({
      roles: [role({ id: "r-editor", name: "editor" })],
      perms: {
        "r-editor": [
          // A per-collection grant, made in the matrix card below this list.
          stored({ id: "p-posts", collection: "posts", action: "read", fields: ["title"] }),
          // A role-wide rule the five-way picker cannot express.
          stored({ id: "p-odd", action: "update", condition: { status: { _in: ["draft"] } } }),
        ],
      },
    });
    render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    await openEditor("editor");
    await pickState("read", "everyone");
    await clickText("Save changes");
    await waitFor(() => expect(h.sent.some((s) => s.method === "PUT")).toBe(true));

    const body = putBody(h, "r-editor");
    // The endpoint replaces the WHOLE set, so anything not restated is revoked.
    expect(entry(body, "posts", "read")).toMatchObject({ id: "p-posts", fields: ["title"] });
    expect(entry(body, "*", "update")).toMatchObject({
      id: "p-odd",
      condition: { status: { _in: ["draft"] } },
    });
    expect(entry(body, "*", "read")).toMatchObject({ condition: null });
  });
});

describe("the save paints before it is confirmed", () => {
  test("the row reads the new rule while the request is still in flight", async () => {
    const h = mockRoutes({
      roles: [role({ id: "r-editor", name: "editor" })],
      perms: { "r-editor": [] },
      hold: "PATCH",
    });
    render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    expect(ruleTextOf("editor")).toContain("read: none");

    await openEditor("editor");
    await pickState("read", "everyone");
    await clickText("Save changes");

    // Nothing has answered yet — and the row already says so.
    await waitFor(() => expect(h.pending()).toBe(true));
    expect(ruleTextOf("editor")).toContain("read: all");
  });

  test("a refused save puts the old rule back and says why", async () => {
    const h = mockRoutes({
      roles: [role({ id: "r-editor", name: "editor" })],
      perms: { "r-editor": [] },
      hold: "PATCH",
    });
    const toasts = render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    await openEditor("editor");
    await pickState("read", "everyone");
    await clickText("Save changes");
    await waitFor(() => expect(h.pending()).toBe(true));
    expect(ruleTextOf("editor")).toContain("read: all");

    await act(async () => {
      h.finish(json({ error: { message: "Role is managed elsewhere" } }, 409));
    });
    await waitFor(() => expect(ruleTextOf("editor")).toContain("read: none"));
    expect(toasts.join(" ")).toContain("Role is managed elsewhere");
  });
});

describe("deleting a custom role", () => {
  test("is offered for custom roles and refused for system ones", async () => {
    mockRoutes({
      roles: [role({ id: "r-auth", name: "authenticated" }), role({ id: "r-editor", name: "editor" })],
    });
    render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    // The positive half: the control exists at all, on the row that may use it.
    expect(roleRow("editor").querySelector('[title="Delete role"]')).not.toBeNull();
    // The server refuses to delete a system role, so the button is not drawn
    // for one.
    expect(roleRow("authenticated").querySelector('[title="Delete role"]')).toBeNull();
  });

  test("the confirm names how many members hold the role", async () => {
    mockRoutes({
      roles: [role({ id: "r-editor", name: "editor" })],
      users: [
        { id: "u1", roles: [{ id: "r-editor", name: "editor" }] },
        { id: "u2", roles: [{ id: "r-editor", name: "editor" }] },
        { id: "u3", roles: [{ id: "r-auth", name: "authenticated" }] },
      ],
    });
    render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    await clickTitled(roleRow("editor"), "Delete role");
    await waitFor(() =>
      expect(document.querySelector("[role=alertdialog]")?.textContent).toContain(
        "2 workspace member(s)",
      ),
    );
  });

  test("the row goes immediately and comes back if the server refuses", async () => {
    const h = mockRoutes({
      roles: [role({ id: "r-editor", name: "editor" })],
      hold: "DELETE",
    });
    const toasts = render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    await clickTitled(roleRow("editor"), "Delete role");
    await waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull());
    await clickText("Delete role", document.querySelector("[role=alertdialog]")!);

    await waitFor(() => expect(h.pending()).toBe(true));
    expect(() => roleRow("editor")).toThrow();

    await act(async () => {
      h.finish(json({ error: { message: "Role still in use" } }, 409));
    });
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    expect(toasts.join(" ")).toContain("Role still in use");
  });
});

describe("the zero-permission notice", () => {
  test("warns, dismisses, and stays dismissed for that admin", async () => {
    mockRoutes({ roles: [role({ id: "r-editor", name: "editor" })] });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Re-check every role created here before today"),
    );
    await clickText("Got it");
    expect(document.body.textContent).not.toContain(
      "Re-check every role created here before today",
    );
    // Per admin, not per browser: the key carries the signed-in user's id, so
    // one person answering it does not answer it for a colleague.
    expect(localStorage.getItem(noticeKeyFor("u-owner"))).toBe("1");
    expect(localStorage.getItem(noticeKeyFor("someone-else"))).toBeNull();

    cleanup();
    render();
    await waitFor(() => expect(roleRow("editor")).toBeDefined());
    expect(document.body.textContent).not.toContain(
      "Re-check every role created here before today",
    );
  });
});

describe("reading a stored condition", () => {
  test("recognises exactly the shapes the picker can write back", () => {
    expect(stateFromCondition(null)).toBe("all");
    expect(stateFromCondition(OWNER_CONDITION)).toBe("owner");
    expect(stateFromCondition({ status: { _eq: "published" } })).toBe("published");
    // Anything else is reported as unreadable rather than rounded to the
    // nearest preset — rounding is what would silently rewrite it on save.
    expect(stateFromCondition({ owner_id: { _eq: "$user.id" }, status: { _eq: "x" } })).toBeNull();
    expect(stateFromCondition({ owner_id: { _in: ["$user.id"] } })).toBeNull();
  });

  test("two rows on one action resolve to the more permissive, as the server does", () => {
    const { matrix } = matrixFromPermissions([
      stored({ id: "a", action: "read", condition: OWNER_CONDITION }),
      stored({ id: "b", action: "read", condition: null }),
    ]);
    // The resolver OR-combines matching rows, so an unconditional row alongside
    // an owner-scoped one means the role really does read everything.
    expect(matrix.read).toBe("all");
  });

  test("an unreadable role-wide rule blocks the picker from overwriting it", () => {
    const existing = [stored({ id: "p-odd", action: "read", condition: { status: { _in: ["a"] } } })];
    const { opaque } = matrixFromPermissions(existing);
    expect(opaque).toEqual(["read"]);
    // The matrix says "none" for `read` because the picker has no state for
    // that rule — so the save must not take that "none" at face value and drop
    // the row.
    const out = desiredPermissions(existing, {
      read: "none",
      create: "none",
      update: "none",
      delete: "none",
      publish: "none",
    });
    expect(out).toEqual([
      { id: "p-odd", collection: "*", action: "read", fields: null, condition: { status: { _in: ["a"] } } },
    ]);
  });
});
