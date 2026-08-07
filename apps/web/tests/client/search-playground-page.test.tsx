import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { SearchPlaygroundPage } from "../../src/client/admin/pages/data/search-playground";
import { renderWithProviders } from "./render";

// Page-level render coverage for the search playground (Data → Search). The
// server specs pin the /:slug/search behavior; what only a render test can
// catch is the client wiring — collection preselection, the query → button →
// results round-trip binding the API's camelCase rows, and the inline
// surfacing of server VALIDATION messages (the class of bug where a fetch
// shape mismatch renders as silent-empty instead of an error).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const mockFetchRoutes = (
  onSearch: () => Response = () =>
    json({
      data: [{ id: "11111111-2222-3333-4444-555555555555", title: "Hello world" }],
      mode: "fts",
      limit: 20,
    }),
) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/collections"))
      return json({
        data: [
          { slug: "notes", fts: false, displayTemplate: null, fields: [] },
          {
            // fts toggled on but nothing marked searchable — the /search
            // endpoint 422s this, so the page must not preselect or badge it.
            slug: "drafts",
            fts: true,
            displayTemplate: null,
            fields: [{ name: "title", type: "text" }],
          },
          {
            slug: "posts",
            fts: true,
            displayTemplate: null,
            fields: [{ name: "title", type: "text", searchable: true }],
          },
        ],
      });
    if (url.includes("/search")) return onSearch();
    return json({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
  }) as unknown as typeof fetch;
};

describe("<SearchPlaygroundPage>", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  const runSearch = async (q: string) => {
    renderWithProviders(<SearchPlaygroundPage pushToast={() => {}} />);
    // Collections loaded → the first FTS-enabled collection is preselected.
    await waitFor(() => expect(screen.getByText("posts")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("What are you looking for?"), {
      target: { value: q },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
  };

  test("query → results round-trip renders ranked rows + the mode badge", async () => {
    mockFetchRoutes();
    await runSearch("hello");
    await waitFor(() => expect(screen.getByText("Hello world")).toBeTruthy());
    // Count line + effective-mode badge from the response envelope.
    expect(screen.getByText("1 result(s)")).toBeTruthy();
    expect(screen.getByText("fts")).toBeTruthy();
    // The search POST went to the preselected collection.
    const calls = (global.fetch as ReturnType<typeof mock>).mock.calls as unknown as [
      RequestInfo | URL,
      RequestInit?,
    ][];
    const searchCall = calls.find(([u]) => String(u).includes("/search"));
    expect(String(searchCall?.[0])).toContain("/api/items/posts/search");
  });

  test("an empty ranking renders the no-matches empty state, not a blank page", async () => {
    mockFetchRoutes(() => json({ data: [], mode: "fts", limit: 20 }));
    await runSearch("zeppelin");
    await waitFor(() => expect(screen.getByText("No matches")).toBeTruthy());
  });

  test("preselection + FTS badge require a searchable field, not just the toggle", async () => {
    mockFetchRoutes();
    renderWithProviders(<SearchPlaygroundPage pushToast={() => {}} />);
    // "drafts" comes first and has fts: true, but no searchable field — the
    // old `c.fts`-only rule would preselect it and the search would 422.
    // "posts" (effectively searchable) must win, and its trigger renders the
    // FTS badge (Radix SelectValue mirrors the selected item's content).
    await waitFor(() => expect(screen.getByText("posts")).toBeTruthy());
    expect(screen.queryByText("drafts")).toBeNull();
    const trigger = screen.getByText("posts").closest("button");
    expect(trigger?.textContent).toContain("FTS");
  });

  test("server VALIDATION messages surface inline instead of vanishing", async () => {
    mockFetchRoutes(() =>
      json(
        {
          error: {
            code: "VALIDATION",
            message: 'Collection "posts" does not have vector search configured.',
          },
        },
        422,
      ),
    );
    await runSearch("anything");
    await waitFor(() =>
      expect(
        screen.getByText('Collection "posts" does not have vector search configured.'),
      ).toBeTruthy(),
    );
  });
});
