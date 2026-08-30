/**
 * Settings → Workspace.
 *
 * `tenants.name` had no writer anywhere in the server, so this card is the
 * first surface that can correct a workspace's name at all. Three properties of
 * it are worth pinning, and each one is a defect the admin has shipped before:
 *
 *  1. **The rename paints before the request resolves.** The house rule is
 *     explicit — a mutation updates the UI immediately and reconciles after —
 *     and the shape it forbids (`await mutate(); await list(); setState(…)`)
 *     looks identical in a test that only asserts the end state. So the
 *     assertion here happens while the PATCH promise is deliberately held
 *     pending; a card rewritten into await-then-refetch fails it.
 *  2. **A refused write rolls back.** An optimistic update that cannot be taken
 *     back is worse than no optimistic update: the operator is left looking at
 *     a name the server never accepted.
 *  3. **The address is not editable, and says why.** A read-only field with no
 *     explanation reads as a bug, and the reason here is load-bearing — the
 *     slug keys the physical table namespace.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { WorkspaceCard } from "../../src/client/admin/pages/settings/workspace-card";
import { renderWithProviders } from "./render";

// RTL's automatic cleanup is order-dependent under bun:test, so every spec file
// that renders has to say so itself; without this a later render finds the
// previous one still mounted and `getByText` throws on the duplicate.
afterEach(() => cleanup());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TENANT = {
  id: "t1",
  slug: "acme-prod",
  name: "Acme",
  project: "acme",
  branch: "main",
  env: "production",
  mark: "A",
  color: "var(--chart-2)",
  role: "owner",
  createdAt: "2026-01-04T10:00:00.000Z",
  createdBy: "founder@acme.test",
};

/** A promise whose settlement this file controls, so the DOM can be inspected
 *  at the one moment an optimistic update is distinguishable from a pessimistic
 *  one: after the click, before the server answers. */
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

interface Routes {
  /** Rows `GET /api/tenants` answers with; re-read on every call so a test can
   *  make the reconcile see what the server would now hold. */
  rows: Record<string, unknown>[];
  /** When set, `PATCH /api/tenants/:id` waits on this instead of answering. */
  patchGate?: Promise<unknown>;
  patchStatus?: number;
}

let calls: { method: string; url: string; body: unknown }[] = [];

const mockRoutes = (routes: Routes) => {
  calls = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET" && url.endsWith("/api/tenants")) {
      return json({ data: routes.rows, active: "t1" });
    }
    if (method === "PATCH" && url.includes("/api/tenants/")) {
      if (routes.patchGate) await routes.patchGate;
      if (routes.patchStatus && routes.patchStatus >= 400) {
        return json({ error: { code: "VALIDATION", message: "Name already taken" } }, routes.patchStatus);
      }
      return json({ ok: true });
    }
    if (method === "DELETE" && url.includes("/api/tenants/")) return json({ ok: true });
    return json({ error: { code: "NOT_FOUND", message: `unmocked ${method} ${url}` } }, 404);
  }) as unknown as typeof fetch;
};

const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const setValue = async (id: string, value: string) => {
  const el = document.getElementById(id) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const button = (label: string | RegExp): HTMLButtonElement =>
  screen.getByText(label).closest("button") as HTMLButtonElement;

const renderCard = async (
  routes: Routes,
  extra: { pushToast?: (m: string, kind?: string) => void; onArchived?: () => void } = {},
) => {
  mockRoutes(routes);
  renderWithProviders(
    <WorkspaceCard
      pushToast={(extra.pushToast ?? (() => {})) as never}
      onArchived={extra.onArchived ?? (() => {})}
    />,
  );
  await waitFor(() => expect(screen.getByText("Acme")).toBeDefined());
};

describe("the workspace card", () => {
  test("shows the workspace and its immutable address, with the reason", async () => {
    await renderCard({ rows: [TENANT] });

    expect(screen.getByText("acme-prod")).toBeDefined();
    // The reason is the point: without it a disabled field reads as an
    // oversight rather than as a fact about how tables are named.
    expect(screen.getByText(/physical table namespace/)).toBeDefined();
    // The copy button is an icon, so it is identified by its accessible title.
    expect(document.querySelector('button[title="Copy address"]')).not.toBeNull();
  });

  test("the address is text, never an input", async () => {
    await renderCard({ rows: [TENANT] });

    // Rendering it into a disabled `<input>` would still put it one attribute
    // removed from editable, and would invite a future "just enable it".
    const inputs = [...document.querySelectorAll("input")];
    expect(inputs.map((i) => i.value)).not.toContain("acme-prod");
    expect(screen.getByText("acme-prod").tagName).not.toBe("INPUT");
    // …and the name beside it IS one, so the assertion above is not vacuous:
    // this card really does render editable fields.
    expect(inputs.map((i) => i.value)).toContain("Acme");
  });

  test("provenance is shown when the server sends it", async () => {
    await renderCard({ rows: [TENANT] });
    expect(screen.getByText("founder@acme.test")).toBeDefined();
    expect(screen.getByText("Created by")).toBeDefined();
  });

  test("a server that sends no provenance renders no empty rows", async () => {
    const { createdAt: _a, createdBy: _b, ...bare } = TENANT;
    await renderCard({ rows: [bare] });
    // "Created by —" would be a claim about a person nobody recorded.
    expect(screen.queryByText("Created by")).toBeNull();
  });
});

describe("renaming", () => {
  test("paints before the request resolves, then reconciles", async () => {
    const gate = deferred<void>();
    const routes: Routes = { rows: [TENANT], patchGate: gate.promise };
    await renderCard(routes);

    await setValue("ws-name", "Acme Europe");
    await click(button("Save"));

    // The PATCH has not answered — nothing has been resolved. If the card were
    // written as await-then-refetch, the heading would still read "Acme" here,
    // which is exactly the stale-row shape the house rule forbids.
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
    expect(screen.getByText("Acme Europe")).toBeDefined();
    expect(screen.queryByText("Acme")).toBeNull();

    // Let the server answer, and let it answer with the renamed row so the
    // reconcile that follows agrees with what is already on screen.
    routes.rows = [{ ...TENANT, name: "Acme Europe" }];
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBe(2));
    expect(screen.getByText("Acme Europe")).toBeDefined();
  });

  test("sends the name the operator typed", async () => {
    await renderCard({ rows: [TENANT] });
    await setValue("ws-name", "  Acme Europe  ");
    await click(button("Save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));

    const patch = calls.find((c) => c.method === "PATCH")!;
    expect((patch.body as { name: string }).name).toBe("Acme Europe");
    // The slug is not offered by the form and must not be smuggled into the
    // body either — the server refuses it, and a refused key would fail the
    // whole write.
    expect(patch.body).not.toHaveProperty("slug");
  });

  test("rolls back and says why when the server refuses", async () => {
    const gate = deferred<void>();
    const toasts: string[] = [];
    await renderCard(
      { rows: [TENANT], patchGate: gate.promise, patchStatus: 422 },
      { pushToast: (m) => toasts.push(m) },
    );

    await setValue("ws-name", "Acme Europe");
    await click(button("Save"));
    expect(screen.getByText("Acme Europe")).toBeDefined();

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(screen.getByText("Acme")).toBeDefined());
    // Both halves matter. Reverting silently would leave the operator thinking
    // the rename landed and then unlanded on its own.
    expect(screen.queryByText("Acme Europe")).toBeNull();
    expect(toasts).toContain("Name already taken");
    // The input follows the rollback too — a field still holding the refused
    // value with the heading showing the old one is two answers to one question.
    expect((document.getElementById("ws-name") as HTMLInputElement).value).toBe("Acme");
  });

  test("Save is inert until something actually changed", async () => {
    await renderCard({ rows: [TENANT] });
    expect(button("Save").disabled).toBe(true);
    await setValue("ws-name", "Acme Europe");
    expect(button("Save").disabled).toBe(false);
  });
});

describe("archiving", () => {
  test("asks first, and the question states the consequence", async () => {
    await renderCard({ rows: [TENANT] });

    await click(button("Archive…"));
    await waitFor(() => expect(screen.getByText("Archive this workspace?")).toBeDefined());

    // The consequence is that it leaves EVERYONE's list, not just the actor's.
    // A confirmation that does not say so is not informed consent.
    expect(screen.getByText(/disappears from the workspace list of every member/)).toBeDefined();
    expect(screen.getByText(/Nothing is deleted/)).toBeDefined();
    // Nothing has been sent yet — the dialog is the gate, not a progress note.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("confirming sends the DELETE and hands off", async () => {
    let handedOff = 0;
    await renderCard({ rows: [TENANT] }, { onArchived: () => { handedOff++; } });

    await click(button("Archive…"));
    await waitFor(() => expect(screen.getByText("Archive this workspace?")).toBeDefined());
    await click(button("Archive workspace"));

    await waitFor(() => expect(handedOff).toBe(1));
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toContain("/api/tenants/t1");
  });

  test("cancelling sends nothing", async () => {
    await renderCard({ rows: [TENANT] });
    await click(button("Archive…"));
    await waitFor(() => expect(screen.getByText("Archive this workspace?")).toBeDefined());
    await click(button("Cancel"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("the root workspace cannot be archived, and says so", async () => {
    await renderCard({ rows: [{ ...TENANT, slug: "default" }] });
    // The server refuses `default`; offering the button would be a trap that
    // only reveals itself after the confirmation.
    expect(button("Archive…").disabled).toBe(true);
    expect(screen.getByText(/root workspace/)).toBeDefined();
  });

  test("a non-owner cannot archive, and says so", async () => {
    await renderCard({ rows: [{ ...TENANT, role: "admin" }] });
    expect(button("Archive…").disabled).toBe(true);
    expect(screen.getByText(/Only a workspace owner/)).toBeDefined();
  });
});
