/**
 * The category picker has two shapes, and which one it draws is the
 * marketplace's answer rather than a preference.
 *
 * Seven of the eight hand their whole taxonomy over, so the picker is one
 * search box over every leaf. Allegro will not — it answers with the children
 * of one node and has ~23,000 categories — so its picker walks down a level at
 * a time.
 *
 * This is verified here rather than in a browser for one reason: driving the
 * walked mode on a real screen needs Allegro credentials, which a test machine
 * does not have. The SEARCH mode was verified on the real screen at 390 and
 * 1440 against Trendyol's live public catalog, because that is the path the
 * other seven providers take and the one an edit here could regress.
 *
 * What must hold, and what would otherwise be silent:
 *   - a walked provider is never asked for the whole tree (an empty picker
 *     reads as "this marketplace has no categories")
 *   - stepping into a branch asks for THAT level, and only once
 *   - a leaf is the answer; a branch is a step
 *   - levels accumulate, so the breadcrumb can still name where you are
 */
import { useState } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./render";
import { CategoryMapDialog } from "../../src/client/admin/pages/automation/integration-listing-dialog";

const INFO = {
  settingFields: [],
  browse: "levels" as const,
  columns: [{ value: "title", label: "Title" }],
  variantColumns: [{ value: "sku", label: "SKU" }],
  outputs: [],
  lookups: [],
};

/** Allegro's shape: the children of one node, with the parent from the walk. */
const LEVELS: Record<string, { id: string; name: string; parentId: string | null; leaf: boolean }[]> = {
  "": [
    { id: "1", name: "Dom i Ogród", parentId: null, leaf: false },
    { id: "2", name: "Elektronika", parentId: null, leaf: false },
  ],
  "1": [
    { id: "11", name: "Meble", parentId: "1", leaf: false },
    { id: "12", name: "Dywany", parentId: "1", leaf: true },
  ],
  "11": [{ id: "111", name: "Krzesła", parentId: "11", leaf: true }],
};

type Cat = { id: string; name: string; parentId: string | null; leaf: boolean };

const BASE = {
  integrationId: "i1",
  providerName: "Allegro",
  info: INFO,
  productFields: [{ value: "category", label: "category" }],
  existing: null,
  onClose: () => {},
  onSave: () => {},
};

/**
 * Drives the picker the way the real panel does: the levels it has fetched live
 * in React state, and a fetch MERGES into them rather than replacing.
 */
const Walked = ({ asked }: { asked: (string | null)[] }) => {
  const [categories, setCategories] = useState<Cat[]>([]);
  const onLoadLevel = async (parentId: string | null) => {
    if (asked.includes(parentId)) return;
    asked.push(parentId);
    const next = LEVELS[parentId ?? ""] ?? [];
    setCategories((prev) => {
      const seen = new Set(prev.map((c) => c.id));
      return [...prev, ...next.filter((c) => !seen.has(c.id))];
    });
  };
  return <CategoryMapDialog {...BASE} categories={categories} browse="levels" onLoadLevel={onLoadLevel} />;
};

afterEach(() => cleanup());

describe("a marketplace that hands its categories over one level at a time", () => {
  test("it is walked, not searched — and each level is asked for once", async () => {
    const asked: (string | null)[] = [];
    renderWithProviders(<Walked asked={asked} />);

    // The roots, asked for as `null` — never "the whole tree".
    expect(await screen.findByText("Dom i Ogród")).toBeTruthy();
    expect(asked).toEqual([null]);
    expect(screen.getByText("All categories")).toBeTruthy();
    // The search box belongs to the other mode.
    expect(screen.queryByPlaceholderText("Search the categories")).toBeNull();

    // A branch is a step, not an answer.
    fireEvent.click(screen.getByText("Dom i Ogród"));
    expect(await screen.findByText("Meble")).toBeTruthy();
    expect(asked).toEqual([null, "1"]);

    // Going back is free — the level above was kept, so nothing is re-asked.
    fireEvent.click(screen.getByLabelText("Go up one level"));
    expect(await screen.findByText("Elektronika")).toBeTruthy();
    expect(asked).toEqual([null, "1"]);

    // …and so is going back down.
    fireEvent.click(screen.getByText("Dom i Ogród"));
    expect(await screen.findByText("Dywany")).toBeTruthy();
    expect(asked).toEqual([null, "1"]);
  });

  test("a leaf is the answer, and choosing it stops the walk", async () => {
    const asked: (string | null)[] = [];
    renderWithProviders(<Walked asked={asked} />);

    fireEvent.click(await screen.findByText("Dom i Ogród"));
    // `Dywany` is a leaf: clicking it picks the category rather than descending.
    fireEvent.click(await screen.findByText("Dywany"));
    await waitFor(() => expect(screen.queryByText("All categories")).toBeNull());
    // The breadcrumb of the CHOSEN category, which is only nameable because the
    // walk kept every level it passed through.
    expect(document.body.textContent).toContain("Dom i Ogród › Dywany");
  });
});

describe("a marketplace that hands the whole tree over", () => {
  test("it is searched, and no level is ever requested", async () => {
    const asked: (string | null)[] = [];
    renderWithProviders(
      <CategoryMapDialog
        {...BASE}
        info={{ ...INFO, browse: "all" }}
        categories={[
          { id: "1", name: "Dom", parentId: null, leaf: false },
          { id: "12", name: "Dywany", parentId: "1", leaf: true },
        ]}
        browse="all"
        onLoadLevel={async (p) => {
          asked.push(p);
        }}
      />,
    );

    // The search box, not the breadcrumb.
    expect(await screen.findByPlaceholderText("Search the categories")).toBeTruthy();
    expect(screen.queryByText("All categories")).toBeNull();
    // Asking a provider that already gave everything for one level would be a
    // wasted request at best and an error at worst.
    expect(asked).toEqual([]);
  });
});
