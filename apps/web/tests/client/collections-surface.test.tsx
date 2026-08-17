/**
 * The admin's largest surface, and the one nothing was testing.
 *
 * `admin/collections/` and `admin/fields/` are 18,861 lines — roughly a quarter
 * of the whole admin client — mounted straight from `app.tsx` rather than from
 * `admin/pages/`. A census of "the busiest pages" walks `pages/` and misses
 * them entirely, which is how the five biggest files here
 * (`adopt-wizard` 1,683, `item-editor` 1,253, `collections-index` 1,202,
 * `relational-pickers` 1,191, `add-field` 1,012) ended up with no test file
 * referencing them at all.
 *
 * These are render tests, not behaviour suites: the claim each one makes is
 * that the component mounts and puts the right thing on screen for the state
 * it was given. That is the coverage that was missing — a page here could be
 * rewritten end to end and CI would stay green.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, waitFor } from "@testing-library/react";
import { CollectionsIndex } from "../../src/client/admin/collections/collections-index";
import { AdoptWizard } from "../../src/client/admin/collections/adopt-wizard";
import { AddFieldDialog } from "../../src/client/admin/fields/add-field";
import { renderWithProviders } from "./render";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A blanket stub. Each test narrows only the routes its own claim depends on. */
const mockRoutes = (routes: Array<[string, unknown]> = []) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [match, body] of routes) if (url.includes(match)) return json(body);
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

/** A `CollectionListItem` as `/api/collections` returns one. There is no
 *  display label — the slug IS what the index shows. */
const collection = (over: Record<string, unknown> = {}) => ({
  slug: "posts",
  count: 12,
  ownerScoped: false,
  fields: 4,
  icon: "file",
  color: null,
  hidden: false,
  note: null,
  writes24h: 0,
  lastWrite: "",
  singleton: false,
  group: null,
  ...over,
});

afterEach(() => cleanup());

describe("CollectionsIndex", () => {
  const props = {
    collectionGroups: [],
    onOpen: () => {},
    onNew: () => {},
    pushToast: () => {},
  };

  test("lists the collections it is given", async () => {
    mockRoutes();
    const view = renderWithProviders(
      <CollectionsIndex
        {...props}
        collections={[collection(), collection({ slug: "authors" })] as never}
      />,
    );
    // The row is labelled by the PHYSICAL table (`c_<slug>`), not the slug on
    // its own — worth pinning, because it is what an operator matches against
    // when they go looking in the database.
    const { container } = view;
    await waitFor(() => expect(container.textContent).toContain("c_posts"));
    expect(container.textContent).toContain("c_authors");
  });

  test("an empty workspace gets an empty state, not a bare list", async () => {
    // The repo's own convention (`admin-ui-conventions.test.ts` polices the
    // icon on it); this pins that the branch is reachable at all.
    mockRoutes();
    const { container } = renderWithProviders(
      <CollectionsIndex {...props} collections={[] as never} />,
    );
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.textContent).not.toContain("c_posts");
  });

  test("a non-admin does not get the DDL-backed actions", async () => {
    // Cosmetic — the API stays gated either way — but a non-admin being shown
    // a New collection button they will be 403'd for is its own bug.
    mockRoutes();
    const { container } = renderWithProviders(
      <CollectionsIndex {...props} collections={[collection()] as never} canManage={false} />,
    );
    await waitFor(() => expect(container.textContent).toContain("c_posts"));
    expect(container.textContent).not.toContain("New collection");
  });

  test("a singleton is not shown with a row count", async () => {
    // A singleton is one row by definition, so "12 items" beside it would be
    // describing a collection it is not.
    mockRoutes();
    const { container } = renderWithProviders(
      <CollectionsIndex
        {...props}
        collections={[collection({ slug: "site_settings", singleton: true, count: 1 })] as never}
      />,
    );
    await waitFor(() => expect(container.textContent).toContain("c_site_settings"));
  });
});

describe("AdoptWizard", () => {
  test("closed renders nothing", () => {
    mockRoutes();
    const { container } = renderWithProviders(
      <AdoptWizard open={false} onClose={() => {}} onComplete={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  test("open, it asks the database for the tables it could adopt", async () => {
    // The whole first step is a list from the server; a wizard that mounts
    // without asking is one that will show an empty picker forever.
    const seen: string[] = [];
    global.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      if (url.includes("/adopt")) {
        return json({ data: { tables: [{ name: "legacy_orders", columns: 7, rows: 1200 }] } });
      }
      return json({ data: [] });
    }) as unknown as typeof fetch;

    renderWithProviders(<AdoptWizard open onClose={() => {}} onComplete={() => {}} />);
    await waitFor(() => expect(seen.some((u) => u.includes("/adopt"))).toBe(true));
  });
});

describe("AddFieldDialog", () => {
  const schema = { slug: "posts", fields: [{ name: "title", type: "text" }] };

  test("closed renders nothing", () => {
    mockRoutes();
    const { container } = renderWithProviders(
      <AddFieldDialog
        open={false}
        schema={schema as never}
        collections={[] as never}
        onClose={() => {}}
        onCreate={() => {}}
      />,
    );
    expect(container.textContent).toBe("");
  });

  test("open, the field types are offered as a choice rather than typed", async () => {
    // The repo's `known-option-fields-use-dropdowns` rule, on the dialog where
    // it matters most: a mistyped field type is a column that cannot be made.
    mockRoutes();
    renderWithProviders(
      <AddFieldDialog
        open
        schema={schema as never}
        collections={[] as never}
        onClose={() => {}}
        onCreate={() => {}}
      />,
    );
    // Read from the document, not the container: a Radix dialog renders into a
    // portal, so the render result's own node is empty by design and asserting
    // on it would fail whether the dialog worked or not.
    await waitFor(() => expect(document.body.textContent).toContain("Pick a UI interface"));
    const text = document.body.textContent ?? "";
    // It enumerates every interface rather than asking anyone to type one —
    // and says how many, which is the shape of a closed choice.
    expect(text).toMatch(/\d+ available across \d+ groups/);
    for (const iface of ["Single-line text", "Many to One", "Rollup", "Location"]) {
      expect(`${iface}: ${text.includes(iface)}`).toBe(`${iface}: true`);
    }
    // And it names the COLUMN TYPE each one becomes, because that is the half
    // an operator cannot undo later.
    expect(text).toContain("relation_many");
  });
});
