/**
 * Extension `widgets` — iframes mounted inside an existing admin screen and
 * handed that screen's context.
 *
 * Two halves worth pinning: the manifest half (an unknown mount is refused,
 * and a widget's entry file is required to exist like every other entry — the
 * install must not half-succeed with a widget pointing at nothing), and the
 * selection half (`widgetsFor`, which decides what appears where). The
 * selection rule is the one with a real failure mode: a widget scoped to
 * `orders` turning up on the blog, or a workspace-wide widget disappearing
 * because it declared no collections.
 */
import { describe, expect, test } from "bun:test";
import { ManifestSchema, validatePackage } from "../src/server/services/extensions";
import { widgetsFor } from "../src/client/admin/extension-widgets";
import type { ApiExtension } from "../src/client/admin/api/automation";

const manifest = (widgets: unknown[]) => ({
  name: "w-ext",
  version: "1.0.0",
  title: "Widget Extension",
  contributes: { widgets },
});

describe("widget manifest validation", () => {
  test("the three mounts are accepted", () => {
    for (const mount of ["item-detail", "item-list", "home"]) {
      const r = ManifestSchema.safeParse(
        manifest([{ id: "w", title: "W", mount, entry: "w.html" }]),
      );
      expect(r.success).toBe(true);
    }
  });

  test("an unknown mount is refused rather than silently never rendering", () => {
    const r = ManifestSchema.safeParse(
      manifest([{ id: "w", title: "W", mount: "product-details-sidebar", entry: "w.html" }]),
    );
    expect(r.success).toBe(false);
  });

  test("mount is required — a widget with nowhere to go is not a widget", () => {
    expect(ManifestSchema.safeParse(manifest([{ id: "w", title: "W", entry: "w.html" }])).success)
      .toBe(false);
  });

  test("collections must be slugs, and the list is optional", () => {
    expect(
      ManifestSchema.safeParse(
        manifest([{ id: "w", title: "W", mount: "item-detail", entry: "w.html" }]),
      ).success,
    ).toBe(true);
    expect(
      ManifestSchema.safeParse(
        manifest([
          { id: "w", title: "W", mount: "item-detail", collections: ["orders"], entry: "w.html" },
        ]),
      ).success,
    ).toBe(true);
    expect(
      ManifestSchema.safeParse(
        manifest([
          { id: "w", title: "W", mount: "item-detail", collections: ["Not A Slug"], entry: "w.html" },
        ]),
      ).success,
    ).toBe(false);
  });

  test("an entry escaping the package is refused, same as every other entry", () => {
    expect(
      ManifestSchema.safeParse(
        manifest([{ id: "w", title: "W", mount: "home", entry: "../../etc/hosts" }]),
      ).success,
    ).toBe(false);
  });

  test("a widget's entry must exist, and is stored — an install must not half-succeed", () => {
    const pkg = (files: Record<string, string>) => ({
      "backlex-extension.json": JSON.stringify(
        manifest([{ id: "w", title: "W", mount: "home", entry: "widget.html" }]),
      ),
      ...files,
    });
    expect(() => validatePackage(pkg({}))).toThrow(/missing file: widget\.html/);
    const { assets } = validatePackage(pkg({ "widget.html": "<!doctype html>ok" }));
    expect(assets["widget.html"]).toBe("<!doctype html>ok");
  });
});

describe("widgetsFor — what renders where", () => {
  const ext = (name: string, widgets: unknown[]): ApiExtension =>
    ({
      id: name,
      name,
      version: "1.0.0",
      source: "upload",
      npmPackage: null,
      enabled: true,
      manifest: {
        name,
        version: "1.0.0",
        title: name,
        contributes: { widgets },
      },
    }) as unknown as ApiExtension;

  const scoped = ext("shipping", [
    { id: "s", title: "Shipping", mount: "item-detail", collections: ["orders"], entry: "s.html" },
  ]);
  const global = ext("notes", [{ id: "n", title: "Notes", mount: "item-detail", entry: "n.html" }]);
  const listOnly = ext("export", [{ id: "e", title: "Export", mount: "item-list", entry: "e.html" }]);
  const homeOnly = ext("kpi", [{ id: "k", title: "KPI", mount: "home", entry: "k.html" }]);
  const all = [scoped, global, listOnly, homeOnly];

  test("a scoped widget appears only on its collection", () => {
    expect(widgetsFor(all, "item-detail", "orders").map((w) => w.id).sort()).toEqual(["n", "s"]);
    expect(widgetsFor(all, "item-detail", "posts").map((w) => w.id)).toEqual(["n"]);
  });

  test("a widget with no collections list is workspace-wide", () => {
    expect(widgetsFor([global], "item-detail", "anything").length).toBe(1);
  });

  test("mounts do not bleed into each other", () => {
    expect(widgetsFor(all, "item-list", "orders").map((w) => w.id)).toEqual(["e"]);
    expect(widgetsFor(all, "home").map((w) => w.id)).toEqual(["k"]);
  });

  test("home ignores the collection filter — it has no collection to match", () => {
    const homeScoped = ext("h", [
      { id: "h", title: "H", mount: "home", collections: ["orders"], entry: "h.html" },
    ]);
    expect(widgetsFor([homeScoped], "home").length).toBe(1);
  });

  test("a scoped widget is hidden when no collection is open, not shown to everything", () => {
    expect(widgetsFor([scoped], "item-list", undefined).length).toBe(0);
    expect(widgetsFor([scoped], "item-detail", undefined).length).toBe(0);
  });

  test("an extension contributing no widgets contributes nothing", () => {
    expect(widgetsFor([ext("plain", [])], "item-detail", "orders").length).toBe(0);
    expect(widgetsFor([{ ...ext("x", []), manifest: {} } as ApiExtension], "home").length).toBe(0);
  });
});
