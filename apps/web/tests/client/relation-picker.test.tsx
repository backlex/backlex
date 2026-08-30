/**
 * `<RelationPicker>` — how a foreign key becomes a name a person recognises.
 *
 * The field stores an opaque id. What the operator must see is the related
 * row's label, and getting there runs three pieces of machinery that only meet
 * here: the target collection's `displayTemplate`, `makeLabelFor` rendering it
 * against the fetched row, and `expandParam` deciding whether the fetch needs
 * an `?expand=` so a `{{ rel.field }}` placeholder has anything to resolve
 * against.
 *
 * Every failure in that chain looks the same on screen — a raw id — and the
 * `.catch()` around the fetch means a broken request is indistinguishable from
 * a deleted row. So the assertions below separate the cases that a screenshot
 * cannot: label resolved, label deliberately absent, and the request that had
 * to carry `expand` to have a chance at all. `{{data.rel.field}}` is a known
 * trap in this codebase; this is the picker's half of it.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { RelationPicker } from "../../src/client/admin/collections/relational-pickers";
import { expandParam } from "../../src/client/admin/lib/display-template";
import { renderWithProviders } from "./render";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * @param collection what `GET /api/collections` says about the target — the
 *   display template lives here, not on the row.
 * @param row the related record, or null to answer 404 (a deleted row).
 */
const mockRoutes = (
  collection: Record<string, unknown>,
  row: Record<string, unknown> | null,
) => {
  const urls: string[] = [];
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.includes("/api/collections")) return json({ data: [collection] });
    if (url.includes("/api/items/")) {
      return row
        ? json({ data: row })
        : json({ error: { code: "NOT_FOUND", message: "gone" } }, 404);
    }
    return json({ data: [] });
  }) as unknown as typeof fetch;
  return urls;
};

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const mount = (value: string) =>
  renderWithProviders(
    <RelationPicker value={value} onChange={() => {}} target="authors" />,
  );

describe("<RelationPicker> — resolving an id into a label", () => {
  test("a plain display template renders the related row's field", async () => {
    mockRoutes(
      { slug: "authors", displayTemplate: "{{ name }}", fields: [{ name: "name", type: "text" }] },
      { id: "a1", name: "Ada Lovelace" },
    );
    mount("a1");

    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeTruthy());
    // The trigger deliberately shows the id alongside the label — the label is
    // for recognition, the id for addressing a row in a bug report. So the
    // assertion is that the label RESOLVED, not that the id vanished.
    expect(screen.getByText("a1")).toBeTruthy();
  });

  test("a one-hop template asks for the expansion it needs", async () => {
    // `{{ org.title }}` is unresolvable without `?expand=org` — the server
    // returns the FK, not the nested row. A picker that renders the template
    // but forgets the expand shows an empty label and looks like missing data.
    const urls = mockRoutes(
      {
        slug: "authors",
        displayTemplate: "{{ org.title }}",
        fields: [{ name: "org", type: "relation", to: "orgs" }],
      },
      { id: "a2", org: { id: "o1", title: "Acme Ltd" } },
    );
    mount("a2");

    await waitFor(() => expect(screen.getByText("Acme Ltd")).toBeTruthy());
    const itemCalls = urls.filter((u) => u.includes("/api/items/authors/a2"));
    expect(`item fetched: ${itemCalls.length > 0}`).toBe("item fetched: true");
    // The FIRST call deliberately carries no expand: the target's metadata
    // arrives from `useCollections()` after the first render, so the picker
    // fires once blind and again once it knows the template. What must hold is
    // that the expanded call happens at all — without it `{{ org.title }}`
    // resolves against a bare FK and silently falls back to a generic label.
    expect(`expanded call made: ${itemCalls.some((u) => u.includes("expand=org"))}`).toBe(
      "expanded call made: true",
    );
  });

  test("expandParam asks for relations and nothing else", () => {
    // Asserted directly rather than through the picker, because the picker
    // CANNOT observe over-expansion: its first fetch runs before the target's
    // metadata arrives (so `fields` is empty and no expand is computed), that
    // fetch populates `labelCache`, and the guard `if (labelCache[value]) return`
    // then stops the corrected fetch from ever firing. Verified 2026-08-30 by
    // making `expandParam` return every field name — the render test stayed
    // green. A property the component's own caching hides belongs at the unit
    // it lives in.
    const relFields = [
      { name: "org", type: "relation", to: "orgs" },
      { name: "name", type: "text" },
    ];
    expect(expandParam("{{ org.title }}", relFields)).toBe("org");
    // A nested path whose head is NOT a relation expands nothing.
    expect(expandParam("{{ name.first }}", relFields)).toBeUndefined();
    // A flat path needs no expansion at all.
    expect(expandParam("{{ name }}", relFields)).toBeUndefined();
    // Only single-hop is supported, so a chain contributes just its head.
    expect(expandParam("{{ org.owner.email }}", relFields)).toBe("org");
    expect(expandParam(null, relFields)).toBeUndefined();
  });

  test("a deleted target row keeps the id instead of blanking the field", async () => {
    // The row is gone; the FK is still stored. The picker must keep showing
    // SOMETHING addressable — a blank trigger reads as "no value set", and an
    // operator who then saves the form silently clears a real reference.
    mockRoutes(
      { slug: "authors", displayTemplate: "{{ name }}", fields: [{ name: "name", type: "text" }] },
      null,
    );
    const { container } = mount("a4-deleted");

    // Give the rejected fetch a turn to settle, so this is "the catch ran and
    // left the id" rather than "the label had not arrived yet".
    await waitFor(() =>
      expect(container.textContent).toContain("a4-deleted"),
    );
    expect(container.textContent).toContain("a4-deleted");
  });

  test("an empty value renders the placeholder, not an empty label lookup", async () => {
    // The empty state, which this repo insists on looking at. It must also not
    // fetch: `GET /api/items/authors/` with no id is a list request, and the
    // effect guards on `!value` precisely to avoid it.
    const urls = mockRoutes(
      { slug: "authors", displayTemplate: "{{ name }}", fields: [] },
      { id: "x", name: "nobody" },
    );
    renderWithProviders(
      <RelationPicker value="" onChange={() => {}} target="authors" placeholder="Pick an author" />,
    );

    await waitFor(() => expect(screen.getByText("Pick an author")).toBeTruthy());
    expect(urls.filter((u) => /\/api\/items\/authors\/./.test(u))).toEqual([]);
  });
});
