import { readFileSync } from "node:fs";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { matchesCondition } from "@backlex/db";
import type { AuthSubject } from "@backlex/core";
import { PermissionsMatrix } from "../../src/client/admin/pages/access/permissions-matrix";
import { CE_DYNAMIC_VARS } from "../../src/client/admin/rule-builder";
import { renderWithProviders } from "./render";

/**
 * The permission matrix is the screen an operator reaches for when a role is
 * denied something it should be allowed, so what it shows has to be what the
 * server holds.
 *
 * Two ways it was not. The read-back seeded each row from a hand-written CRUD
 * literal and then skipped any action the seed did not already carry
 * (`if (!(p.action in row)) continue`) — while the header rendered a Publish
 * column. A stored `publish` grant was therefore drawn as "no access", and the
 * cell that claimed to deny it had nothing behind it. And the value-side
 * variable palette offered `$user.role` and `$now.year`, neither of which the
 * DSL compiler resolves: typed into a rule they are compared as literal
 * strings, so the rule silently matches nothing.
 *
 * The palette spec below reads the compiler's own source rather than a copy of
 * its variable list, because a copy is exactly what produced the fiction.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ROLES = [
  { id: "r-admin", name: "admin", system: true },
  // `roles[1]` is what the matrix opens on, so the role under test goes here.
  { id: "r-editor", name: "editor" },
];

const COLLECTIONS = {
  data: [
    {
      slug: "posts",
      fields: [{ name: "id" }, { name: "owner_id" }, { name: "status" }],
    },
  ],
};

/** A stored `role_permissions` row as `GET /api/roles/:id/permissions` returns
 *  one. Unrestricted by default; a spec narrows it with a condition. */
const perm = (over: Record<string, unknown> = {}) => ({
  id: "p-1",
  collection: "posts",
  action: "publish",
  fields: null,
  condition: null,
  ...over,
});

interface Harness {
  /** Every mutating request the matrix made, in order. */
  sent: { method: string; url: string; body: Record<string, unknown> | null }[];
}

const mockRoutes = (stored: ReturnType<typeof perm>[]): Harness => {
  const sent: Harness["sent"] = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      sent.push({
        method,
        url,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      return json({ ok: true });
    }
    if (url.endsWith("/api/collections")) return json(COLLECTIONS);
    if (url.endsWith("/api/roles")) return json({ data: ROLES });
    if (url.endsWith("/permissions")) return json({ data: stored });
    return json({ data: [] });
  }) as unknown as typeof fetch;
  return { sent };
};

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const renderMatrix = () => {
  renderWithProviders(<PermissionsMatrix roles={ROLES} pushToast={() => {}} />);
};

/**
 * The cell for one (action, collection), addressed by the accessible label the
 * grid gives it — `editor · Publish · posts: all`. Addressing by content rather
 * than by index means adding a column cannot silently retarget an assertion at
 * a different action.
 */
const cell = (actionTitle: string, collection: string): HTMLElement => {
  const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
    b.getAttribute("aria-label")?.includes(`· ${actionTitle} · ${collection}:`),
  );
  if (!btn) {
    throw new Error(
      `no cell for ${actionTitle}/${collection} — saw ${[...document.querySelectorAll("button[aria-label]")]
        .map((b) => b.getAttribute("aria-label"))
        .join(" | ")}`,
    );
  }
  return btn as HTMLElement;
};

/** The state the cell is drawn in: the tail of its label, `all|none|custom`. */
const cellState = (actionTitle: string, collection: string): string =>
  cell(actionTitle, collection).getAttribute("aria-label")!.split(": ").pop()!;

/** Radix opens a dropdown on pointerdown, which `.click()` alone does not
 *  produce in happy-dom. */
const openCellMenu = async (actionTitle: string, collection: string) => {
  const trigger = cell(actionTitle, collection);
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
};

const pickMenuItem = async (label: string) => {
  const item = [...document.querySelectorAll("[role=menuitem]")].find((o) =>
    o.textContent?.includes(label),
  ) as HTMLElement | undefined;
  if (!item) {
    throw new Error(
      `no menu item "${label}" — saw ${[...document.querySelectorAll("[role=menuitem]")]
        .map((o) => o.textContent)
        .join(" | ")}`,
    );
  }
  await act(async () => {
    item.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    item.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0 }));
    item.click();
  });
};

describe("a stored publish grant", () => {
  test("is drawn on the Publish column instead of vanishing", async () => {
    mockRoutes([perm()]);
    renderMatrix();

    // The positive half first: an action with NO stored row reads denied. That
    // is what makes the publish assertion meaningful — before the fix every
    // column including Publish read "none", so a bare "publish is none" check
    // would have passed against the defect.
    await waitFor(() => expect(cellState("Read", "posts")).toBe("none"));
    expect(cellState("Publish", "posts")).toBe("all");
    // And the header counts it, rather than reporting five denials.
    expect(document.body.textContent).toContain("1 all");
  });

  test("with a condition reads as conditional, not as denied", async () => {
    mockRoutes([perm({ condition: { owner_id: { _eq: "$user.id" } } })]);
    renderMatrix();

    await waitFor(() => expect(cellState("Publish", "posts")).toBe("custom"));
    expect(cellState("Delete", "posts")).toBe("none");
  });

  test("a field allow-list narrows the grant, so the cell is not drawn full", async () => {
    mockRoutes([perm({ fields: ["title"] })]);
    renderMatrix();

    // `condition == null` alone used to mean "full access", which called a row
    // that only exposes one column unrestricted.
    await waitFor(() => expect(cellState("Read", "posts")).toBe("none"));
    expect(cellState("Publish", "posts")).toBe("custom");
  });
});

describe("what the matrix sends back", () => {
  test("changing another action leaves the stored publish row untouched", async () => {
    const h = mockRoutes([perm()]);
    renderMatrix();
    await waitFor(() => expect(cellState("Publish", "posts")).toBe("all"));

    await openCellMenu("Read", "posts");
    await pickMenuItem("Full access");

    // The positive state first: the read grant really was written, so the
    // absence below is not the absence of any request at all.
    await waitFor(() => expect(h.sent.length).toBeGreaterThan(0));
    const posts = h.sent.filter((s) => s.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      collection: "posts",
      action: "read",
      fields: null,
      condition: null,
    });
    // Nothing addressed the publish row — it survives the save unchanged.
    expect(h.sent.some((s) => s.url.includes("/api/permissions/p-1"))).toBe(false);
    expect(h.sent.some((s) => s.body?.action === "publish")).toBe(false);
  });

  test("the Publish cell writes the publish action, not a CRUD one", async () => {
    const h = mockRoutes([]);
    renderMatrix();
    await waitFor(() => expect(cellState("Publish", "posts")).toBe("none"));

    await openCellMenu("Publish", "posts");
    await pickMenuItem("Full access");

    await waitFor(() => expect(h.sent.length).toBeGreaterThan(0));
    expect(h.sent[0]).toMatchObject({
      method: "POST",
      body: { collection: "posts", action: "publish", fields: null, condition: null },
    });
  });

  test("re-picking a state a row already holds writes nothing", async () => {
    const h = mockRoutes([perm({ condition: { owner_id: { _eq: "$user.id" } } })]);
    renderMatrix();
    await waitFor(() => expect(cellState("Publish", "posts")).toBe("custom"));

    await openCellMenu("Publish", "posts");
    await pickMenuItem("Use custom rule");

    // Opening the rule builder must not first replace the stored rule with the
    // starter one. The dialog opening is the proof the click landed — without
    // it this would assert nothing.
    await waitFor(() => expect(document.body.textContent).toContain("Edit rule"));
    expect(h.sent).toEqual([]);
  });
});

/**
 * The variables `resolveVar` in `packages/db/src/permission.ts` actually
 * answers, read out of that function's source. Parsing beats importing a
 * constant because there is no constant — the list only exists as a chain of
 * `v === "$…"` comparisons, and a copy of it in the admin is what drifted.
 */
const compilerVars = (): string[] => {
  const src = readFileSync(
    new URL("../../../../packages/db/src/permission.ts", import.meta.url),
    "utf8",
  );
  const start = src.indexOf("const resolveVar = (");
  if (start === -1) throw new Error("resolveVar not found in permission.ts");
  // The function ends at the first line that closes it at column zero.
  const end = src.indexOf("\n};", start);
  if (end === -1) throw new Error("could not find the end of resolveVar");
  const body = src.slice(start, end);
  return [...body.matchAll(/v === "(\$[^"]+)"/g)].map((m) => m[1] as string);
};

describe("the value-side variable palette", () => {
  const paletteVars = CE_DYNAMIC_VARS.map((v) => v.v).filter((v) => v.startsWith("$"));

  test("the compiler's list is actually readable", () => {
    // Verify the extraction before trusting it: a regex that matched nothing
    // would make every assertion below vacuously true.
    const real = compilerVars();
    expect(real.length).toBeGreaterThan(5);
    expect(real).toContain("$user.id");
    expect(real).toContain("$org.id");
    expect(real).not.toContain("$user.role");
  });

  test("offers nothing the DSL cannot resolve", () => {
    const real = compilerVars();
    expect(paletteVars.length).toBeGreaterThan(0);
    const fiction = paletteVars.filter((v) => !real.includes(v));
    expect(fiction).toEqual([]);
  });

  test("offers the org variables the canonical B2B rule needs", () => {
    // These are what Phase 3 made enforceable on writes; a palette that hides
    // them leaves the one rule an operator most needs undiscoverable.
    expect(paletteVars).toContain("$org.id");
    expect(paletteVars).toContain("$org.role");
    expect(paletteVars).toContain("$user.orgs");
  });

  test("every entry it offers resolves against a real subject", () => {
    const subject: AuthSubject = {
      userId: "u-1",
      email: "editor@example.test",
      roles: ["editor"],
      tenantId: "t-1",
      orgId: "o-1",
      orgRole: "admin",
      orgIds: ["o-1", "o-2"],
    };
    // What each variable is worth for this subject, compared against a column
    // holding the same value. An unresolved variable compares as the literal
    // string and fails — which is exactly what the control below proves.
    const expected: Record<string, unknown> = {
      "$user.id": "u-1",
      "$user.email": "editor@example.test",
      "$tenant.id": "t-1",
      "$org.id": "o-1",
      "$org.role": "admin",
    };
    for (const v of paletteVars) {
      if (v === "$now") continue; // resolves to an instant, not a fixed value
      if (v === "$user.roles" || v === "$user.orgs") {
        // List-valued: the column has to be one OF the resolved array.
        const row = { col: v === "$user.roles" ? "editor" : "o-2" };
        expect(matchesCondition(row, { col: { _in: v } } as never, subject)).toBe(true);
        continue;
      }
      const want = expected[v];
      expect(want).toBeDefined();
      expect(matchesCondition({ col: want }, { col: { _eq: v } } as never, subject)).toBe(true);
    }
    // The control: a variable the compiler does not know stays a literal, so
    // the same comparison fails. Without this the loop above could be passing
    // for the wrong reason.
    expect(
      matchesCondition({ col: "admin" }, { col: { _eq: "$user.role" } } as never, subject),
    ).toBe(false);
  });
});
