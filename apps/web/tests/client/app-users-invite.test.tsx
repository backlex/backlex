import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { AppUsersPage } from "../../src/client/admin/pages/access/app-users";
import { renderWithProviders } from "./render";

/**
 * The end-user pool is where an operator seats the customers of the application
 * built on a workspace, and until now it was the one surface that could not.
 * `POST /api/app-users/invite` had shipped on the SDK, GraphQL, MCP and the CLI;
 * the page itself had six methods and no `invite`, and its description told the
 * operator that end-users "sign up via this workspace's own auth endpoint" — one
 * of the two ways in, presented as the only one.
 *
 * Three things are pinned here, each because it is the part that would rot
 * silently:
 *
 *   - the dialog posts what was typed and ticked, not a default. A create form
 *     that drops the roles looks identical on screen and is only discovered
 *     later, when the invitee signs in with nothing granted.
 *   - a duplicate address is answered with the move the operator wants — send it
 *     again — rather than a raw 409 message in a toast that disappears. The
 *     server distinguishes a pending invitation from a real account on the
 *     error's `details`; both branches are asserted, since a UI that offered
 *     "re-send" for a signed-up customer would be worse than the toast.
 *   - the role list offers only what the server would actually accept. The
 *     absence of `admin` is asserted BESIDE the presence of a custom role, so it
 *     cannot pass by rendering no roles at all.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The workspace roles `GET /api/roles` returns: the three built-ins plus two
 *  custom ones. `admin` and the implicit pair must never reach the dialog;
 *  `dealer` and `installer` must. */
const ROLES = [
  { id: "r-admin", name: "admin", description: "Full access", admin: true },
  { id: "r-auth", name: "authenticated", description: null, admin: false },
  { id: "r-public", name: "public", description: null, admin: false },
  { id: "r-dealer", name: "dealer", description: "Sees their own orders", admin: false },
  { id: "r-installer", name: "installer", description: null, admin: false },
];

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

interface Harness {
  /** Every non-GET request the page made, in order. */
  sent: Sent[];
  /** The rows `GET /api/app-users` answers with. */
  rows: Record<string, unknown>[];
}

/**
 * @param refuse what the invite endpoint answers instead of 201, if anything.
 *   `null` on a subsequent call means "answer normally from then on", which is
 *   what a re-send needs: refused once, accepted after the withdrawal.
 */
const mockRoutes = (
  seed: Record<string, unknown>[] = [],
  refuse: { status: number; body: unknown } | null = null,
): Harness => {
  const rows = seed.map((r) => ({ ...r }));
  const sent: Sent[] = [];
  let refusals = refuse ? 1 : 0;

  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      if (url.includes("/api/roles")) return json({ data: ROLES });
      if (url.includes("/api/app-users")) return json({ data: rows });
      return json({ data: [] });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ method, url, body });
    if (url.endsWith("/api/app-users/invite")) {
      if (refusals > 0 && refuse) {
        refusals -= 1;
        return json(refuse.body, refuse.status);
      }
      return json(
        { data: { id: "au-new", email: body.email, token: "tok-not-shown", expiresAt: Date.now() + 1 } },
        201,
      );
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;

  return { sent, rows };
};

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const type = async (el: Element, value: string) => {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};

const openInviteDialog = async () => {
  const toasts: string[] = [];
  renderWithProviders(<AppUsersPage pushToast={(m) => toasts.push(m)} />);
  // The page renders a skeleton until both fetches land.
  await waitFor(() => expect(screen.getByText("Invite end-user")).toBeDefined());
  await click(screen.getByText("Invite end-user"));
  await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeTruthy());
  return { dialog: document.querySelector("[role=dialog]") as HTMLElement, toasts };
};

/** The dialog's inputs, in DOM order: email, then name. */
const inputsIn = (dialog: HTMLElement): HTMLInputElement[] =>
  [...dialog.querySelectorAll("input")] as HTMLInputElement[];

/** The role row labelled `name`, or undefined when the dialog does not offer it.
 *  Addressed by the role's own name rather than by position, so adding a role to
 *  the fixture cannot silently retarget an assertion at a different checkbox. */
const roleRow = (dialog: HTMLElement, name: string): Element | undefined =>
  [...dialog.querySelectorAll("label")].find(
    (l) => l.firstElementChild?.firstElementChild?.textContent?.trim() === name,
  );

const footerButton = (dialog: HTMLElement, label: string): HTMLButtonElement => {
  const btn = [...dialog.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!btn) throw new Error(`no button "${label}" in the dialog`);
  return btn as HTMLButtonElement;
};

describe("inviting an end-user from the dashboard", () => {
  test("the dialog posts the address, the name and the roles that were ticked", async () => {
    const h = mockRoutes();
    const { dialog } = await openInviteDialog();

    const [email, name] = inputsIn(dialog);
    await type(email!, "  Dealer@Example.Test  ");
    await type(name!, "Ada Dealer");
    await click(roleRow(dialog, "dealer")!.querySelector("[role=checkbox]")!);

    await click(footerButton(dialog, "Send invitation"));

    await waitFor(() => expect(h.sent.length).toBeGreaterThan(0));
    const post = h.sent.find((r) => r.url.endsWith("/api/app-users/invite"));
    expect(post).toBeDefined();
    expect(post!.method).toBe("POST");
    // Normalized the way the server stores it, so a re-invite of the same human
    // in different casing is recognised as the duplicate it is.
    expect(post!.body.email).toBe("dealer@example.test");
    expect(post!.body.name).toBe("Ada Dealer");
    expect(post!.body.roleIds).toEqual(["r-dealer"]);

    // The invited row is in the table immediately — no list refetch stands
    // between the operator and the evidence that it happened.
    await waitFor(() => expect(screen.getByText("dealer@example.test")).toBeDefined());
    expect(screen.getAllByText("invited").length).toBeGreaterThan(0);
  });

  test("the roles offered are the ones the server would accept", async () => {
    mockRoutes();
    const { dialog } = await openInviteDialog();

    // Present, so the absences below are not the absence of a role list.
    expect(roleRow(dialog, "dealer")).toBeDefined();
    expect(roleRow(dialog, "installer")).toBeDefined();
    // `resolveAssignableRoles` rejects the admin role on every surface that
    // binds one; offering it here would only produce a 422.
    expect(roleRow(dialog, "admin")).toBeUndefined();
    // Implicit, so a checkbox would be a control with nothing behind it.
    expect(roleRow(dialog, "authenticated")).toBeUndefined();
    expect(roleRow(dialog, "public")).toBeUndefined();
  });

  test("with only the built-in roles the dialog says so instead of showing nothing", async () => {
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET").toUpperCase() !== "GET") return json({ ok: true });
      if (url.includes("/api/roles")) return json({ data: ROLES.filter((r) => r.id !== "r-dealer" && r.id !== "r-installer") });
      if (url.includes("/api/app-users")) return json({ data: [] });
      return json({ data: [] });
    }) as unknown as typeof fetch;

    const { dialog } = await openInviteDialog();
    expect(roleRow(dialog, "dealer")).toBeUndefined();
    expect(dialog.textContent).toContain("only the three built-in roles");
    // The way out, not just the explanation.
    expect(dialog.querySelector('a[href="/access/roles"]')).toBeTruthy();
    // And the invitation is still sendable without one.
    expect(footerButton(dialog, "Send invitation").disabled).toBe(true);
    await type(inputsIn(dialog)[0]!, "solo@example.test");
    expect(footerButton(dialog, "Send invitation").disabled).toBe(false);
  });
});

describe("inviting an address that is already in the pool", () => {
  const conflict = (reason: string, status: string) => ({
    status: 409,
    body: {
      error: {
        code: "CONFLICT",
        message: `pending@example.test ${reason}`,
        details: {
          reason,
          appUserId: "au-pending",
          email: "pending@example.test",
          status,
        },
      },
    },
  });

  test("a pending invitation offers the re-send instead of a raw error", async () => {
    const h = mockRoutes(
      [
        {
          id: "au-pending",
          email: "pending@example.test",
          name: null,
          emailVerified: false,
          status: "invited",
          createdAt: Date.now(),
          roles: [],
        },
      ],
      conflict("already_invited", "invited"),
    );
    const { dialog, toasts } = await openInviteDialog();

    await type(inputsIn(dialog)[0]!, "pending@example.test");
    await click(roleRow(dialog, "installer")!.querySelector("[role=checkbox]")!);
    await click(footerButton(dialog, "Send invitation"));

    // The failure stays on the form — a toast would take the next move away
    // with it after five seconds.
    await waitFor(() => expect(dialog.textContent).toContain("hasn't accepted yet"));
    expect(toasts).toEqual([]);
    const again = footerButton(dialog, "Send a new invitation");

    await click(again);
    await waitFor(() => expect(h.sent.length).toBe(3));
    // A re-send is a withdrawal plus a fresh invitation, in that order: there is
    // no resend route, and the pending row IS the invitation.
    expect(h.sent[0]).toMatchObject({ method: "POST", url: expect.stringContaining("/api/app-users/invite") });
    expect(h.sent[1]).toMatchObject({ method: "DELETE", url: expect.stringContaining("/api/app-users/au-pending") });
    expect(h.sent[2]!.method).toBe("POST");
    // The roles ticked on the form are carried into the new invitation rather
    // than quietly dropped by the round trip.
    expect(h.sent[2]!.body.roleIds).toEqual(["r-installer"]);
    expect(toasts.join(" ")).toContain("A new invitation is on its way");
  });

  test("an address that already has an account is not offered a re-send", async () => {
    mockRoutes([], conflict("already_a_user", "active"));
    const { dialog } = await openInviteDialog();

    await type(inputsIn(dialog)[0]!, "pending@example.test");
    await click(footerButton(dialog, "Send invitation"));

    await waitFor(() => expect(dialog.textContent).toContain("already has an account"));
    // Re-sending would withdraw a real account's row. The affordance is absent
    // here and present in the test above, so neither assertion is vacuous.
    expect(
      [...dialog.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Send a new invitation",
      ),
    ).toBe(false);
  });
});
