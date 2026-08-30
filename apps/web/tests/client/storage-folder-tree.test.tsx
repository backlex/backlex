/**
 * `<StoragePage>` — the folder tree's counts, which are derived on the CLIENT
 * and cannot be checked anywhere else.
 *
 * `GET /api/storage/folder-counts` groups by folder ID. The tree the operator
 * actually sees is built from folder NAMES containing slashes, so `marketing`
 * is often a virtual node with no row of its own — nothing on the server knows
 * it exists. Rolling `marketing/q1` and `marketing/q2` up into it is client
 * arithmetic, and a wrong roll-up produces a plausible number rather than an
 * error: an operator reads "3 files" under a folder holding eight and concludes
 * five are missing.
 *
 * The server side of this endpoint is covered by
 * `tests/storage-folder-counts.test.ts` (including that the count is filtered
 * by permission). This is the half that spec cannot see.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { StoragePage } from "../../src/client/admin/pages/data/storage";
import { renderWithProviders } from "./render";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Two sibling sub-folders under a parent that has no row of its own. */
const FOLDERS = [
  { id: "f1", name: "marketing/q1" },
  { id: "f2", name: "marketing/q2" },
  { id: "f3", name: "legal" },
];

const mockRoutes = (counts: {
  root: number;
  byFolderId: Record<string, number>;
  total: number;
}) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/storage/folder-counts")) return json(counts);
    if (url.includes("/api/folders")) return json({ data: FOLDERS });
    if (url.includes("/api/storage")) return json({ data: [], total: 0 });
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

/** The count rendered next to a folder row, read off the row's own text. */
const countBesideFolder = (container: HTMLElement, name: string): string | null => {
  const label = [...container.querySelectorAll("*")].find(
    (el) => el.children.length === 0 && el.textContent?.trim() === name,
  );
  const row = label?.closest("div,li,button");
  if (!row) return null;
  return (row.textContent ?? "").replace(name, "").trim();
};

describe("<StoragePage> — folder counts", () => {
  test("the server's total binds to the header badge", async () => {
    mockRoutes({ root: 2, byFolderId: { f1: 5, f2: 3, f3: 1 }, total: 11 });
    renderWithProviders(<StoragePage pushToast={() => {}} />);

    // `{root, byFolderId, total}` is read straight off the response with no
    // envelope — an API that started wrapping it in `{data:…}` would leave
    // every number at its `useState` zero, which reads as an empty workspace.
    await waitFor(() => expect(screen.getAllByText("11").length).toBeGreaterThan(0));
  });

  test("a virtual parent reports the sum of its children", async () => {
    // `marketing` has no folder row — only `marketing/q1` and `marketing/q2`
    // do. 5 + 3 = 8, and nothing on the server ever computes that.
    mockRoutes({ root: 2, byFolderId: { f1: 5, f2: 3, f3: 1 }, total: 11 });
    const { container } = renderWithProviders(<StoragePage pushToast={() => {}} />);

    await waitFor(() => expect(screen.getAllByText("11").length).toBeGreaterThan(0));
    await waitFor(() => expect(countBesideFolder(container, "marketing")).toBe("8"));
    // The leaf keeps its own number rather than inheriting the parent's.
    expect(countBesideFolder(container, "legal")).toBe("1");
  });

  test("a folder the server reported nothing for is not rendered as NaN", async () => {
    // `byFolderId` only carries folders that HAVE files — the GROUP BY omits
    // empties. `?? 0` is what keeps a missing key from becoming `undefined`
    // and rendering as "NaN" once it is summed into an ancestor.
    mockRoutes({ root: 0, byFolderId: {}, total: 0 });
    const { container } = renderWithProviders(<StoragePage pushToast={() => {}} />);

    await waitFor(() => expect(container.textContent).toContain("legal"));
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).not.toContain("undefined");
  });
});
