import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { MembersPanel } from "../../src/client/admin/pages/access/members-panel";
import { renderWithProviders } from "./render";

/**
 * The members panel is where a workspace's membership is actually governed, and
 * for a long time it governed nothing: the role dropdown was hard-`disabled`
 * with a comment naming the PATCH route that did not exist, there was no way to
 * hand a workspace over, and the trash icon deleted a row without revoking
 * anything behind it.
 *
 * These specs pin the two halves of that repair that a screenshot cannot show.
 * First, the mutation is OPTIMISTIC in the strict sense the house rule means —
 * the row reads the new role while the request is still in flight, and reads the
 * old one again if the server refuses. An `await api.mutate(); refetch()` would
 * pass a naive "does it end up right" assertion and still leave the row visibly
 * stale for a round trip, so the pending state is asserted directly, against a
 * promise the test holds open. Second, the transfer dialog says the part the
 * button does not: the caller stops being the owner.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ME = { id: "u-owner", email: "owner@example.test", name: null, image: null, roles: ["admin"], isAdmin: true, tenantId: "t1" };

const TENANTS = {
  data: [{ id: "t1", slug: "acme", name: "Acme", project: "acme", branch: "main", env: "production", mark: null, color: null, role: "owner" }],
  active: "t1",
};

/** A member row as `GET /api/tenants/:id/members` returns it. The index
 *  signature is what lets a spec add a field the client does not model yet. */
type Row = { id: string; [k: string]: unknown };

const member = (over: Partial<Row> = {}): Row => ({
  id: "m2",
  tenantId: "t1",
  userId: "u-2",
  email: "colleague@example.test",
  role: "member",
  status: "active",
  invitedAt: null,
  joinedAt: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const OWNER_ROW = member({ id: "m1", userId: "u-owner", email: "owner@example.test", role: "owner" });
const INVITED_ROW = member({ id: "m3", userId: null, email: "pending@example.test", role: "member", status: "invited" });

interface Harness {
  /** Every mutating request the panel made, in order. */
  sent: { method: string; url: string; body: Record<string, unknown> }[];
  /** Answers the request still in flight. */
  finish: (res: Response) => void;
  started: () => boolean;
  settled: () => boolean;
}

const mockRoutes = (seed: Row[]): Harness => {
  // The list the server would hand back on a refetch. A successful mutation is
  // applied to it, so the reconcile that follows agrees with the optimistic
  // paint instead of undoing it.
  const rows = seed.map((r) => ({ ...r }));
  const sent: { method: string; url: string; body: Record<string, unknown> }[] = [];
  let started = false;
  let settled = false;
  let settle: ((res: Response) => void) | null = null;

  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/me")) return json({ data: ME });
    if (url.endsWith("/api/tenants")) return json(TENANTS);
    if (url.endsWith("/members") && method === "GET") return json({ data: rows });
    if (method !== "GET") {
      // Every write is held open on purpose: "the row already changed" is only
      // a claim worth testing while the request has not answered yet.
      started = true;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const id = url.split("/").pop();
      sent.push({ method, url, body });
      return new Promise<Response>((res) => {
        settle = (r) => {
          settled = true;
          const at = rows.findIndex((x) => x.id === id);
          if (r.ok && at !== -1) {
            if (method === "PATCH") Object.assign(rows[at] as Row, body);
            if (method === "DELETE") rows.splice(at, 1);
          }
          res(r);
        };
      });
    }
    return json({ data: [] });
  }) as unknown as typeof fetch;

  return {
    sent,
    finish: (res) => settle?.(res),
    started: () => started,
    settled: () => settled,
  };
};

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

/** The row whose member address is `email`. Rows are addressed by content
 *  rather than by index so adding a fixture row cannot silently retarget an
 *  assertion at somebody else's controls. */
const rowFor = (email: string): HTMLElement => {
  const cell = [...document.querySelectorAll("span[title]")].find(
    (s) => s.getAttribute("title") === email,
  );
  if (!cell) throw new Error(`no row for ${email}`);
  return cell.closest("div.grid") as HTMLElement;
};

const roleTriggerFor = (email: string): HTMLElement =>
  rowFor(email).querySelector("[role=combobox]") as HTMLElement;

/** Radix opens on pointerdown and commits on pointerup, neither of which
 *  `.click()` alone produces in happy-dom. */
const openSelect = async (trigger: HTMLElement) => {
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
};

const pickOption = async (label: string) => {
  const opt = [...document.querySelectorAll("[role=option]")].find(
    (o) => o.textContent?.trim() === label,
  ) as HTMLElement | undefined;
  if (!opt) throw new Error(`no option "${label}" — saw ${[...document.querySelectorAll("[role=option]")].map((o) => o.textContent).join(", ")}`);
  await act(async () => {
    opt.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    opt.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0 }));
    opt.click();
  });
};

const clickTitled = async (scope: HTMLElement, title: string) => {
  const el = scope.querySelector(`[title="${title}"]`) as HTMLButtonElement | null;
  if (!el) throw new Error(`no control titled "${title}"`);
  if (el.disabled) throw new Error(`control "${title}" is disabled`);
  await act(async () => {
    el.click();
  });
};

const clickText = async (label: string) => {
  const el = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`no button labelled "${label}"`);
  await act(async () => {
    el.click();
  });
};

const renderPanel = (toasts: string[] = []) => {
  renderWithProviders(<MembersPanel roles={[]} pushToast={(m: string) => toasts.push(m)} />);
  return toasts;
};

describe("the role dropdown", () => {
  test("is no longer inert — every member row offers a live choice", async () => {
    mockRoutes([OWNER_ROW, member()]);
    renderPanel();
    await waitFor(() => expect(rowFor("colleague@example.test")).toBeDefined());
    const trigger = roleTriggerFor("colleague@example.test") as HTMLButtonElement;
    // The defect this replaces was a permanently `disabled` trigger. An owner
    // acting on a member outranks them, so nothing here may be greyed out.
    expect(trigger.disabled).toBe(false);
    expect(trigger.textContent).toContain("member");
  });

  test("the new role is on screen BEFORE the request resolves", async () => {
    const h = mockRoutes([OWNER_ROW, member()]);
    renderPanel();
    await waitFor(() => expect(rowFor("colleague@example.test")).toBeDefined());

    await openSelect(roleTriggerFor("colleague@example.test"));
    await pickOption("admin");

    // The request is out and deliberately unanswered. If the panel were
    // await-then-refetch, the row would still read "member" right here.
    await waitFor(() => expect(h.started()).toBe(true));
    expect(h.settled()).toBe(false);
    expect(roleTriggerFor("colleague@example.test").textContent).toContain("admin");
    expect(h.sent[0]?.body).toEqual({ role: "admin" });

    h.finish(json({ ok: true }));
    await act(async () => {
      await Promise.resolve();
    });
  });

  test("a refused change puts the old role back and says why", async () => {
    const h = mockRoutes([OWNER_ROW, member()]);
    const toasts = renderPanel();
    await waitFor(() => expect(rowFor("colleague@example.test")).toBeDefined());

    await openSelect(roleTriggerFor("colleague@example.test"));
    await pickOption("owner");
    await waitFor(() => expect(h.started()).toBe(true));
    expect(roleTriggerFor("colleague@example.test").textContent).toContain("owner");

    await act(async () => {
      h.finish(json({ error: { code: "FORBIDDEN", message: 'A "admin" can\'t grant "owner"' } }, 403));
      await Promise.resolve();
    });

    // Rolled back to what the server still holds, with the server's own
    // sentence rather than a generic failure.
    await waitFor(() =>
      expect(roleTriggerFor("colleague@example.test").textContent).toContain("member"),
    );
    expect(toasts.join(" ")).toContain("can't grant");
  });
});

describe("ownership transfer", () => {
  test("the dialog says the caller stops being the owner", async () => {
    mockRoutes([OWNER_ROW, member()]);
    renderPanel();
    await waitFor(() => expect(rowFor("colleague@example.test")).toBeDefined());

    await clickTitled(rowFor("colleague@example.test"), "Transfer ownership");
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeTruthy());

    const copy = (document.querySelector("[role=dialog]") as HTMLElement).textContent ?? "";
    // "Make X the owner" is the half a reader takes in. The other half is the
    // whole reason this needs a confirmation at all.
    expect(copy).toContain("You stop being the owner");
    expect(copy).toContain("drops to admin");
    expect(copy).toContain("colleague@example.test");
  });

  test("the last owner cannot be removed from their own row", async () => {
    mockRoutes([OWNER_ROW, member()]);
    renderPanel();
    await waitFor(() => expect(rowFor("owner@example.test")).toBeDefined());
    const trash = rowFor("owner@example.test").querySelector(
      '[title="The last owner cannot be removed"]',
    ) as HTMLButtonElement;
    // A workspace with nobody in charge is only recoverable through OWNER_EMAIL
    // or SQL, so the control that would produce one is not offered.
    expect(trash).toBeTruthy();
    expect(trash.disabled).toBe(true);
  });
});

describe("removing a colleague", () => {
  test("the dialog names what removal actually revokes", async () => {
    mockRoutes([OWNER_ROW, member()]);
    renderPanel();
    await waitFor(() => expect(rowFor("colleague@example.test")).toBeDefined());

    await clickTitled(rowFor("colleague@example.test"), "Remove");
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeTruthy());

    const copy = (document.querySelector("[role=dialog]") as HTMLElement).textContent ?? "";
    // The old single-statement delete left the workspace roles and the API keys
    // behind, so "removed" meant one row and nothing else. The copy states the
    // whole set, because that is now what happens.
    expect(copy).toContain("workspace roles and API keys are revoked");
    expect(copy).toContain("colleague@example.test");
  });

  test("the row goes before the request answers, and comes back if it is refused", async () => {
    const h = mockRoutes([OWNER_ROW, member()]);
    const toasts = renderPanel();
    await waitFor(() => expect(rowFor("colleague@example.test")).toBeDefined());

    await clickTitled(rowFor("colleague@example.test"), "Remove");
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeTruthy());
    await clickText("Remove member");

    await waitFor(() => expect(h.started()).toBe(true));
    expect(h.settled()).toBe(false);
    expect(h.sent[0]?.method).toBe("DELETE");
    expect(() => rowFor("colleague@example.test")).toThrow();

    await act(async () => {
      h.finish(json({ error: { code: "VALIDATION", message: "This is the workspace's last owner — promote someone else first" } }, 422));
      await Promise.resolve();
    });

    await waitFor(() => expect(rowFor("colleague@example.test")).toBeDefined());
    expect(toasts.join(" ")).toContain("last owner");
  });
});

describe("pending invitations", () => {
  test("a pending row offers resend and withdraw, and no live link", async () => {
    mockRoutes([OWNER_ROW, INVITED_ROW]);
    renderPanel();
    await waitFor(() => expect(rowFor("pending@example.test")).toBeDefined());

    const row = rowFor("pending@example.test");
    expect(row.querySelector('[title="Resend invitation"]')).toBeTruthy();
    expect(row.querySelector('[title="Withdraw invitation"]')).toBeTruthy();
    // The list response carries no token, and the panel must not invent a link
    // from one: an accept URL on screen is a live credential.
    expect(document.body.textContent).not.toContain("/invite/");
    expect(document.querySelector('input[readonly]')).toBeNull();
  });
});
