/**
 * Every control the Users page offers must actually do something.
 *
 * The page shipped with three controls that did not. Two of them — the row
 * menu's "Send reset link" and the bulk bar's "Reset password" — called
 * `pushToast` and nothing else, so the operator read "Reset link sent to
 * ada@example.test." for a request that was never made. The third, "Copy invite
 * link", read a field the list stopped returning, so it was present for a row
 * created in the same session and gone after a reload.
 *
 * The centrepiece here is therefore a SWEEP rather than a test per control: it
 * enumerates whatever the row menus and the bulk bar currently render and
 * demands that clicking each one produces an outbound request. A new silent
 * control fails it without anybody remembering to add a case — which is the
 * point, this being the third instance of the bug class on this branch.
 *
 * One wiring note. `@/lib/auth` builds its better-auth client at module
 * evaluation time and better-auth captures `globalThis.fetch` BY VALUE right
 * there, so a stub installed afterwards would never see the password-reset
 * call. The module is mocked instead, and the stub records into the same call
 * log as the fetch stub — what the sweep asserts is "this control reached the
 * network layer", and for a reset that layer is the auth client.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./render";

interface Call {
  method: string;
  url: string;
  body: string | null;
}

const calls: Call[] = [];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * What non-GET requests should answer with, if anything. `when` narrows the
 * refusal to some of them, which is how a PARTIAL bulk outcome is staged.
 * Reset per test.
 */
let refuse: { status: number; message: string; when?: (c: Call) => boolean } | null = null;

const realFetch = globalThis.fetch;

const USERS = [
  {
    id: "u-ada",
    email: "ada@example.test",
    name: "Ada",
    status: "active",
    provider: "password",
    twoFactorEnabled: true,
    createdAt: "2026-01-01",
    lastSeenAt: Date.now() - 60_000,
    roles: [{ id: "r-admin", name: "admin" }],
  },
  {
    id: "u-grace",
    email: "grace@example.test",
    name: "Grace",
    status: "suspended",
    provider: "password",
    twoFactorEnabled: false,
    createdAt: "2026-01-02",
    lastSeenAt: null,
    roles: [{ id: "r-auth", name: "authenticated" }],
  },
  {
    id: "u-sso",
    email: "sso@example.test",
    name: "Fed",
    status: "active",
    provider: "saml",
    twoFactorEnabled: false,
    createdAt: "2026-01-03",
    lastSeenAt: null,
    roles: [{ id: "r-auth", name: "authenticated" }],
  },
  {
    // A pending invite: the id IS the tenant_members row id, and the list
    // deliberately carries no `inviteUrl` — that is the Phase 5 shape.
    id: "m-pending",
    email: "pending@example.test",
    name: null,
    status: "invited",
    provider: "invite",
    twoFactorEnabled: false,
    createdAt: "2026-01-04",
    lastSeenAt: null,
    memberId: "m-pending",
    roles: [{ id: "r-auth", name: "authenticated" }],
  },
];

const answer = (call: Call): Response => {
  const { url, method } = call;
  if (method === "GET" && url.endsWith("/api/users")) return json({ data: USERS });
  if (method === "GET" && url.endsWith("/api/roles"))
    return json({
      data: [
        { id: "r-admin", name: "admin", admin: true },
        { id: "r-auth", name: "authenticated", admin: false },
        { id: "r-public", name: "public", admin: false },
      ],
    });
  if (method === "GET" && url.endsWith("/api/tenants"))
    return json({
      data: [{ id: "t1", slug: "acme", name: "Acme", project: "acme", branch: "main", env: "production", color: null }],
      active: "t1",
    });
  if (url.includes("/sessions") && method === "GET")
    return json({ data: [{ id: "s1", userAgent: "Firefox", ipAddress: "10.0.0.1", createdAt: null, updatedAt: Date.now() }] });
  if (url.includes("/api/activity")) return json({ data: [] });
  if (refuse && (!refuse.when || refuse.when(call)))
    return json({ error: { code: "FORBIDDEN", message: refuse.message } }, refuse.status);
  if (url.includes("/resend-invite"))
    return json({ data: { id: "m-pending", token: "tok", url: "https://app.test/invite?token=tok", sent: true } });
  return json({ ok: true, data: {} });
};

const stubFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const call: Call = {
    method: (init?.method ?? "GET").toUpperCase(),
    url,
    body: init?.body ? String(init.body) : null,
  };
  calls.push(call);
  return Promise.resolve(answer(call));
}) as unknown as typeof fetch;

/**
 * The auth client, with only `forgetPassword` replaced.
 *
 * A mocked module stays in the worker's registry for the whole run — every spec
 * file's module graph is evaluated before any test executes, so an `afterAll`
 * that puts the real module back is already too late for a file that imported
 * it during that pass (`grid-edit` renders a table whose collab hook calls
 * `auth.useSession()`, and a hand-written replacement object left that
 * undefined). So this is a PASSTHROUGH: everything but the one method under
 * test resolves to the real client, and nothing else in the suite can notice.
 */
const realAuth = await import("../../src/client/lib/auth");
mock.module("../../src/client/lib/auth", () => ({
  ...realAuth,
  auth: new Proxy(realAuth.auth as object, {
    get: (target, prop) =>
      prop === "forgetPassword"
        ? async (o: { email: string }) => {
            const call: Call = {
              method: "POST",
              url: "/api/auth/forget-password",
              body: JSON.stringify(o),
            };
            calls.push(call);
            return refuse && (!refuse.when || refuse.when(call))
              ? { error: { message: refuse.message } }
              : { error: null };
          }
        : Reflect.get(target, prop),
  }),
}));

const { UsersPage } = await import("../../src/client/admin/pages/access/users");

// Installed for the duration of this file's tests only. Assigning it at module
// scope would put it in place while the rest of the suite's files are being
// evaluated, and anything that captures `globalThis.fetch` by value at import
// time (the better-auth client does exactly that) would keep it afterwards.
beforeAll(() => {
  globalThis.fetch = stubFetch;
});

afterEach(() => {
  cleanup();
  calls.length = 0;
  refuse = null;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Requests that are not the page's own first-load reads. */
const writes = (): Call[] =>
  calls.filter(
    (c) =>
      !(c.method === "GET" && /\/api\/(users|roles|tenants)$/.test(c.url)),
  );

const renderPage = async (toasts: string[] = []): Promise<string[]> => {
  renderWithProviders(<UsersPage pushToast={(m: string) => toasts.push(m)} />);
  // The page holds a skeleton until `/api/users` lands.
  await waitFor(() => expect(rowFor("ada@example.test")).toBeDefined());
  return toasts;
};

const rowFor = (email: string): HTMLElement => {
  const cell = [...document.querySelectorAll("span")].find(
    (s) => s.textContent?.trim() === email,
  );
  if (!cell) throw new Error(`no row for ${email}`);
  return cell.closest("tr") as HTMLElement;
};

/** Radix opens a menu on pointerdown, not on a bare `.click()`. */
const openMenu = async (email: string) => {
  const trigger = rowFor(email).querySelector('[aria-haspopup="menu"]') as HTMLElement;
  if (!trigger) throw new Error(`no row menu for ${email}`);
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
};

const menuItems = (): HTMLElement[] =>
  [...document.querySelectorAll("[role=menuitem]")] as HTMLElement[];

const menuLabels = (): string[] =>
  menuItems().map((m) => m.textContent?.trim() ?? "");

const clickMenuItem = async (label: string) => {
  const item = menuItems().find((m) => m.textContent?.trim() === label);
  if (!item) throw new Error(`no menu item "${label}" — saw ${menuLabels().join(", ")}`);
  await act(async () => {
    item.click();
  });
};

/**
 * The controls that legitimately talk to nobody: they drop a selection or shut
 * a panel. Named one by one rather than skipped by shape (icon-only, say), so
 * that a new silent control cannot inherit an exemption it was never granted.
 */
const LOCAL_ONLY = ["Clear selection", "Close"];

const labelOf = (b: HTMLButtonElement): string =>
  b.textContent?.trim() || b.getAttribute("title") || "";

/** The buttons in the bulk-action bar, which only exists with a selection. */
const bulkButtons = (): HTMLButtonElement[] => {
  const badge = [...document.querySelectorAll("*")].find((el) =>
    /^\d+ selected$/.test(el.textContent?.trim() ?? ""),
  );
  const bar = badge?.closest("div.flex.flex-wrap");
  if (!bar) throw new Error("no bulk-action bar on screen");
  return [...bar.querySelectorAll("button")].filter(
    (b) => !LOCAL_ONLY.includes(labelOf(b)),
  ) as HTMLButtonElement[];
};

/**
 * The drawer's action buttons — everything that is meant to reach the server.
 * "Save changes" is excluded by being disabled: it stays inert until a field is
 * edited, which is a different guarantee from "makes no request".
 */
const drawerActions = (): HTMLButtonElement[] => {
  const drawer = document.querySelector("[role=dialog]");
  if (!drawer) return [];
  return [...drawer.querySelectorAll("button")].filter(
    (b) => labelOf(b) !== "" && !LOCAL_ONLY.includes(labelOf(b)) && !b.disabled,
  ) as HTMLButtonElement[];
};

const selectRow = async (email: string) => {
  const box = rowFor(email).querySelector('[role=checkbox]') as HTMLElement;
  await act(async () => {
    box.click();
  });
};

describe("the sweep: no control without a request behind it", () => {
  test("every row-menu item on every row issues one", async () => {
    // Discovered, not enumerated: a new item added to any of these menus is
    // swept the moment it exists.
    const found: Record<string, string[]> = {};
    for (const email of ["ada@example.test", "grace@example.test", "sso@example.test", "pending@example.test"]) {
      // One menu per render: `menuLabels()` reads the whole document, and
      // reading four menus off one page would depend on Radix closing the
      // previous one — a claim about Radix, not about this page.
      await renderPage();
      await openMenu(email);
      found[email] = menuLabels();
      expect(found[email]!.length).toBeGreaterThan(0);
      cleanup();
    }

    for (const [email, labels] of Object.entries(found)) {
      for (const label of labels) {
        // A fresh page per item: several of them remove the row they act on.
        calls.length = 0;
        await renderPage();
        await openMenu(email);
        await clickMenuItem(label);
        await waitFor(() =>
          expect(
            writes().length,
            `"${label}" on ${email} made no request`,
          ).toBeGreaterThan(0),
        );
        cleanup();
      }
    }
  });

  test("every bulk-bar button issues one", async () => {
    await renderPage();
    await selectRow("ada@example.test");
    await waitFor(() => expect(bulkButtons().length).toBeGreaterThan(0));
    const labels = bulkButtons().map(labelOf);
    expect(labels).toContain("Reset password");
    cleanup();

    for (const label of labels) {
      calls.length = 0;
      await renderPage();
      await selectRow("ada@example.test");
      const btn = bulkButtons().find((b) => labelOf(b) === label);
      if (!btn) throw new Error(`no bulk button "${label}"`);
      await act(async () => {
        btn.click();
      });
      await waitFor(() =>
        expect(writes().length, `bulk "${label}" made no request`).toBeGreaterThan(0),
      );
      cleanup();
    }
  });

  test("every drawer action button issues one", async () => {
    const openDrawer = async () => {
      await renderPage();
      await openMenu("ada@example.test");
      await clickMenuItem("View profile");
      await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeTruthy());
      // The session list arrives after its own fetch; the row it draws carries
      // one of the buttons under sweep.
      await waitFor(() => expect(drawerActions().length).toBe(4));
      return document.querySelector("[role=dialog]") as HTMLElement;
    };

    await openDrawer();
    // Addressed by position, not by label: "Revoke" names two different
    // buttons (one session, then every session), and the positive assertion
    // here is that all four are present in that order.
    expect(drawerActions().map((b) => b.textContent?.trim())).toEqual([
      "Revoke",
      "Send",
      "Revoke",
      "Delete",
    ]);
    const count = drawerActions().length;
    cleanup();

    for (let i = 0; i < count; i++) {
      calls.length = 0;
      await openDrawer();
      const btn = drawerActions()[i]!;
      const label = btn.textContent?.trim();
      const before = writes().length;
      await act(async () => {
        btn.click();
      });
      await waitFor(() =>
        expect(writes().length, `drawer "${label}" (#${i}) made no request`).toBeGreaterThan(before),
      );
      cleanup();
    }
  });
});

describe("the reset link", () => {
  test("the row menu reaches the auth client and reports what it answered", async () => {
    const toasts = await renderPage();
    await openMenu("ada@example.test");
    await clickMenuItem("Send reset link");
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/forget-password"))).toBe(true),
    );
    expect(toasts.join(" ")).toContain("Reset link sent to ada@example.test");
  });

  test("a refused reset says so instead of claiming success", async () => {
    refuse = { status: 429, message: "Too many requests" };
    const toasts = await renderPage();
    await openMenu("ada@example.test");
    await clickMenuItem("Send reset link");
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(toasts.join(" ")).toContain("Too many requests");
    expect(toasts.join(" ")).not.toContain("Reset link sent");
  });

  test("a federated account is not offered one", async () => {
    await renderPage();
    await openMenu("sso@example.test");
    // The positive state first: this menu is open and populated, so the
    // absence below is a real absence and not an unopened menu.
    expect(menuLabels()).toContain("View profile");
    expect(menuLabels()).not.toContain("Send reset link");
  });

  test("the bulk button counts what the server accepted", async () => {
    const toasts = await renderPage();
    await selectRow("ada@example.test");
    await selectRow("grace@example.test");
    const btn = bulkButtons().find((b) => b.textContent?.trim() === "Reset password");
    await act(async () => {
      (btn as HTMLButtonElement).click();
    });
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(calls.filter((c) => c.url.includes("/forget-password")).length).toBe(2);
    expect(toasts.join(" ")).toContain("Reset link sent to 2 users");
  });
});

describe("the pending invite row", () => {
  test("offers a resend, not a link copied from the list", async () => {
    await renderPage();
    await openMenu("pending@example.test");
    expect(menuLabels()).toContain("Resend invite");
    // The list no longer carries a token, so an item that reads one off the row
    // can only be right until the next reload.
    expect(menuLabels()).not.toContain("Copy invite link");
  });

  test("the resend hits the route that rotates the token, and shows the new link", async () => {
    await renderPage();
    await openMenu("pending@example.test");
    await clickMenuItem("Resend invite");
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "POST" && c.url.endsWith("/api/tenants/t1/members/m-pending/resend-invite"),
        ),
      ).toBe(true),
    );
    // The link lives in a readonly input, which is the only place it exists —
    // it came off the resend response, not off the row.
    await waitFor(() => {
      const shown = [...document.querySelectorAll("input")].map((i) => i.value);
      expect(shown).toContain("https://app.test/invite?token=tok");
    });
  });
});

describe("a bulk action", () => {
  test("reports what the server accepted, not the size of the selection", async () => {
    // `Promise.allSettled` never rejects, so the old code's catch was dead and
    // the toast always named the full count. One of these two is refused.
    refuse = {
      status: 403,
      message: "That account is protected",
      when: (c) => c.url.includes("u-sso"),
    };
    const toasts = await renderPage();
    await selectRow("ada@example.test");
    await selectRow("sso@example.test");
    const btn = bulkButtons().find((b) => b.textContent?.trim() === "Suspend");
    await act(async () => {
      (btn as HTMLButtonElement).click();
    });

    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(toasts.join(" ")).toContain("Suspended 1 of 2");
    expect(toasts.join(" ")).toContain("That account is protected");
    // A mixed outcome is reconciled against the server rather than guessed at.
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/users")).length).toBeGreaterThan(1),
    );
  });
});

describe("a refused write", () => {
  test("puts the row back instead of leaving it changed", async () => {
    refuse = { status: 403, message: "You cannot suspend the last owner" };
    const toasts = await renderPage();
    await openMenu("ada@example.test");
    await clickMenuItem("Suspend");

    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(toasts.join(" ")).toContain("cannot suspend the last owner");
    // The old shape reported the error AND applied the change AND toasted
    // "suspended." — so both the badge and the absence of that sentence matter.
    expect(toasts.join(" ")).not.toContain("suspended.");
    const row = rowFor("ada@example.test").textContent ?? "";
    expect(row).toContain("active");
    expect(row).not.toContain("suspended");
  });
});
