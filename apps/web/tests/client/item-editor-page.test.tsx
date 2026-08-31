/**
 * `<ItemEditorPage>` — the screen an operator spends most of their day in, and
 * the least-covered file in the admin (1,253 lines at 2.0% before this).
 *
 * Two seams get the attention, because both fail SILENTLY and both have
 * already shipped broken here:
 *
 * 1. **camelCase in, snake_case out.** The items API serializes `createdAt` /
 *    `updatedAt` / `publishedAt`; the hand-written `Post` type in
 *    `admin/config.ts` declares `updated_at` / `published_at`. Field access goes
 *    through `Record<string, unknown>`, so reading the wrong key is `undefined`
 *    rather than a type error — which is how System fields rendered blank and
 *    the Calendar view came up empty, both found by a person and neither by a
 *    test. The editor now reads `rec.updatedAt ?? rec.updated_at`, and this
 *    file is what stops that fallback being "simplified" away.
 * 2. **The 409 precondition.** Every save sends `x-if-unmodified-since` with the
 *    `updatedAt` it loaded, so a concurrent save 409s instead of silently
 *    overwriting. "Save anyway" must then retry WITHOUT the header — a force
 *    that keeps the precondition 409s forever, and the UI looks identical
 *    either way: the banner just stays up.
 *
 * Every fixture row below carries ONLY the camelCase keys, which is what the
 * server actually sends. A fixture with both spellings would pass no matter
 * which one the component read, and that is the whole bug.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ItemEditorPage } from "../../src/client/admin/collections/item-editor";
import type { CollectionSchema } from "../../src/client/admin/config";
import { renderWithProviders } from "./render";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const HOUR = 3_600_000;

const SCHEMA: CollectionSchema = {
  slug: "posts",
  ownerScoped: false,
  fields: [{ name: "title", type: "text" } as CollectionSchema["fields"][number]],
};

/** Every request the editor makes, with the row under test as the item. */
const mockRoutes = (
  row: Record<string, unknown>,
  opts: { patch?: () => Response } = {},
) => {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ]),
      ),
    });
    if (method === "PATCH" && url.includes("/api/items/posts/")) {
      return opts.patch ? opts.patch() : json({ data: { ...row, updatedAt: Date.now() } });
    }
    if (url.includes("/api/revisions")) return json({ data: [] });
    if (url.includes("/api/comments")) return json({ data: [] });
    if (url.includes("/api/extensions")) return json({ data: [] });
    if (url.includes("/api/admin/kpis")) return json({ data: [] });
    if (url.includes("/api/items/posts/")) return json({ data: row });
    // Anything else the editor's side panels reach for: an empty list is a
    // truthful "nothing here", and the assertions below never depend on it.
    return json({ data: [] });
  }) as unknown as typeof fetch;
  return calls;
};

const noop = () => {};

const mount = (
  row: Record<string, unknown> | null,
  over: Partial<Parameters<typeof ItemEditorPage>[0]> = {},
) =>
  renderWithProviders(
    <ItemEditorPage
      slug="posts"
      itemId={row ? String(row.id) : "new"}
      schema={SCHEMA}
      pushToast={noop}
      onSaved={noop}
      onCreated={noop}
      onDeleted={noop}
      onBack={noop}
      navigateToItem={noop}
      {...over}
    />,
  );

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

describe("<ItemEditorPage> — camelCase timestamps reach the System fields panel", () => {
  test("created_at and updated_at render from a camelCase-only row", async () => {
    // Exactly what `GET /api/items/:slug/:id` returns. No snake_case anywhere.
    mockRoutes({
      id: "p1",
      title: "Hello",
      createdAt: Date.now() - 3 * HOUR,
      updatedAt: Date.now() - 1 * HOUR,
    });
    mount({ id: "p1" });

    await waitFor(() => expect(screen.getByText("System fields")).toBeTruthy());

    // `relativeTime` renders "3h ago" / "1h ago"; reading the snake_case key
    // would hand it `undefined`, which returns "" and the row falls back to
    // the em dash. So the assertion is on the VALUE, not on the row existing.
    expect(screen.getByText("3h ago")).toBeTruthy();
    expect(screen.getByText("1h ago")).toBeTruthy();
  });

  test("a row with neither spelling shows the em dash rather than an empty cell", async () => {
    // The negative control. Without it, "3h ago" above could be satisfied by a
    // component that renders a relative time from something else entirely.
    mockRoutes({ id: "p2", title: "No timestamps" });
    mount({ id: "p2" });

    await waitFor(() => expect(screen.getByText("System fields")).toBeTruthy());
    // `created_at` is omitted entirely when absent; `updated_at` always renders.
    expect(screen.queryByText("created_at")).toBeNull();
    // Scoped to this row rather than to the page: several panels render an em
    // dash, so a bare `getByText("—")` finds one of theirs and proves nothing
    // about the timestamp binding.
    const row = screen.getByText("updated_at").parentElement;
    expect(row?.textContent).toBe("updated_at—");
  });
});

describe("<ItemEditorPage> — the edited-since-publish badge", () => {
  const publishedRow = (updatedAt: number) => ({
    id: "p3",
    title: "Live post",
    _status: "published",
    _published_at: Date.now() - 2 * HOUR,
    updatedAt,
  });

  test("appears when the live row was edited after it was published", async () => {
    mockRoutes(publishedRow(Date.now() - 1 * HOUR));
    // `versioned` is what mounts the publish rail at all — without it the
    // status badges never render and both tests below would pass vacuously.
    mount({ id: "p3" }, { versioned: true });

    await waitFor(() => expect(screen.getByText("Published")).toBeTruthy());
    expect(screen.getByText("Edited since publish")).toBeTruthy();
  });

  test("stays away when the row has not been touched since publish", async () => {
    // Run in the state where the badge COULD appear — a published row with both
    // timestamps present — so the absence means the comparison ran and said no,
    // rather than the branch never being reached.
    mockRoutes(publishedRow(Date.now() - 3 * HOUR));
    mount({ id: "p3" }, { versioned: true });

    await waitFor(() => expect(screen.getByText("Published")).toBeTruthy());
    expect(screen.queryByText("Edited since publish")).toBeNull();
  });
});

describe("<ItemEditorPage> — the save-conflict precondition", () => {
  let calls: ReturnType<typeof mockRoutes>;

  beforeEach(() => {
    let patched = 0;
    calls = mockRoutes(
      { id: "p4", title: "Contested", updatedAt: 1_700_000_000_000 },
      {
        patch: () => {
          patched += 1;
          // First save loses the race; the forced retry is allowed through, so
          // the test can tell a working "Save anyway" from one that re-sends
          // the precondition and 409s forever.
          return patched === 1
            ? json(
                { error: { code: "CONFLICT", message: "Row changed since you loaded it" } },
                409,
              )
            : json({ data: { id: "p4", title: "Contested", updatedAt: Date.now() } });
        },
      },
    );
  });

  const patches = () => calls.filter((c) => c.method === "PATCH");

  test("a 409 raises the banner instead of a toast, and offers both ways out", async () => {
    mount({ id: "p4" });
    await waitFor(() => expect(screen.getByText("System fields")).toBeTruthy());

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(screen.getByText(/changed by someone else after you opened it/)).toBeTruthy(),
    );
    expect(screen.getByText("Reload")).toBeTruthy();
    expect(screen.getByText("Save anyway")).toBeTruthy();

    // The precondition is what made the server answer 409 at all. A save that
    // forgot the header would overwrite silently and this banner would never
    // exist to be asserted on.
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.headers["x-if-unmodified-since"]).toBe("1700000000000");
  });

  test("`Save anyway` drops the precondition — otherwise it 409s forever", async () => {
    mount({ id: "p4" });
    await waitFor(() => expect(screen.getByText("System fields")).toBeTruthy());
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText("Save anyway")).toBeTruthy());

    fireEvent.click(screen.getByText("Save anyway"));

    await waitFor(() => expect(patches()).toHaveLength(2));
    // The whole point of the force path. Both requests look identical in the
    // UI — the difference is one header, and only the second one can win.
    expect(patches()[1]!.headers["x-if-unmodified-since"]).toBeUndefined();
    await waitFor(() =>
      expect(screen.queryByText(/changed by someone else after you opened it/)).toBeNull(),
    );
  });
});

describe("<ItemEditorPage> — the create form", () => {
  test("renders with no row at all, and asks for no record by id", async () => {
    // The empty state this repo insists on looking at: `itemId="new"` has
    // nothing to fetch, no System fields panel, and no revision history.
    const calls = mockRoutes({});
    mount(null);

    await waitFor(() => expect(screen.getByText("Fields")).toBeTruthy());
    expect(screen.queryByText("System fields")).toBeNull();
    expect(calls.some((c) => c.url.includes("/api/items/posts/new"))).toBe(false);
    // A bare spinner or a "Loading…" string is a convention violation here —
    // the create form has nothing to wait for.
    expect(screen.queryByText(/^Loading/)).toBeNull();
  });
});
