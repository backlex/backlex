/**
 * The schema graph's auto layout, measured on the schema that made it needed.
 *
 * The page used to deal cards onto a grid in the order the API returned them.
 * With the e-commerce template applied — 69 tables in 9 admin groups, 130
 * relations between different tables — that grid put every group everywhere
 * and drew a canvas nobody could read. "Chaos" was the report; these are the
 * three properties that make it not chaos, each measured against that grid:
 *
 *  - no card covers another, at either density;
 *  - a group's tables form one block, so "where is Catalog?" has one answer;
 *  - related tables sit closer and their relations cross far less.
 *
 * The grid lives on below, verbatim, as the baseline. Swapping it in for the
 * layout must fail the second and third properties — that is what shows the
 * checks can fail at all.
 */
import { describe, expect, test } from "bun:test";
import type { SchemaTemplate } from "../../src/server/templates/types";
import { BASE_TEMPLATES } from "../../src/server/templates/defs";
import { ecommerce } from "../../src/server/templates/defs/ecommerce";
import {
  estimateNodeHeight,
  groupOf,
  layoutSchemaGraph,
  NODE_W,
  relationAnchorY,
  relationEdges,
  settleOverlaps,
  TARGET_ANCHOR_Y,
  type ErdLayout,
  type GraphCollection,
} from "../../src/client/admin/pages/data/schema-graph-layout";

const toGraph = (t: SchemaTemplate): GraphCollection[] =>
  t.collections.map((c) => ({
    slug: c.slug,
    group: c.group ?? null,
    fields: c.fields.map((f) => ({ name: f.name, type: f.type, to: (f as { to?: string }).to })),
  }));

const shop = toGraph(ecommerce);

/** The auto-arrange the page shipped before this layout, kept as the baseline. */
function shippedGrid(collections: readonly GraphCollection[]): ErdLayout {
  const estimate = (c: GraphCollection) => 38 + Math.max(c.fields.length, 1) * 29;
  const n = collections.length;
  const cellW = 248 + 130;
  const avgH = collections.reduce((sum, c) => sum + estimate(c) + 90, 0) / n;
  const cols = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * 2.6 * avgH) / cellW))));
  const colY: number[] = Array.from({ length: cols }, () => 40);
  const out: ErdLayout = {};
  collections.forEach((c, i) => {
    const col = i % cols;
    out[c.slug] = { x: 40 + col * cellW, y: colY[col] ?? 40 };
    colY[col] = (colY[col] ?? 40) + estimate(c) + 90;
  });
  return out;
}

type Rect = { x: number; y: number; w: number; h: number };
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function cardRect(layout: ErdLayout, c: GraphCollection, compact: boolean): Rect {
  const p = layout[c.slug];
  if (!p) throw new Error(`no position for ${c.slug}`);
  return { x: p.x, y: p.y, w: NODE_W, h: estimateNodeHeight(c, compact) };
}

function overlappingCards(collections: readonly GraphCollection[], layout: ErdLayout, compact: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < collections.length; i++) {
    for (let j = i + 1; j < collections.length; j++) {
      const a = collections[i]!;
      const b = collections[j]!;
      if (intersects(cardRect(layout, a, compact), cardRect(layout, b, compact))) out.push(`${a.slug} × ${b.slug}`);
    }
  }
  return out;
}

/** Pairs of groups whose bounding boxes overlap — tables of one group drawn among another's. */
function interleavedGroups(collections: readonly GraphCollection[], layout: ErdLayout, compact: boolean): string[] {
  const boxes = new Map<string, Rect>();
  for (const c of collections) {
    const r = cardRect(layout, c, compact);
    const g = groupOf(c) || "(ungrouped)";
    const box = boxes.get(g);
    if (!box) {
      boxes.set(g, r);
      continue;
    }
    const x = Math.min(box.x, r.x);
    const y = Math.min(box.y, r.y);
    boxes.set(g, {
      x,
      y,
      w: Math.max(box.x + box.w, r.x + r.w) - x,
      h: Math.max(box.y + box.h, r.y + r.h) - y,
    });
  }
  const entries = [...boxes];
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (intersects(entries[i]![1], entries[j]![1])) out.push(`${entries[i]![0]} × ${entries[j]![0]}`);
    }
  }
  return out;
}

/**
 * How far related tables are from each other (centre to centre, averaged),
 * and how often their relations cross — each relation drawn as the straight
 * line from its field row on the source's right edge to the target's header.
 */
function relationMetrics(collections: readonly GraphCollection[], layout: ErdLayout, compact: boolean) {
  const bySlug = new Map(collections.map((c) => [c.slug, c]));
  const lines = relationEdges(collections)
    .filter((e) => e.from !== e.to)
    .map((e) => {
      const a = cardRect(layout, bySlug.get(e.from)!, compact);
      const b = cardRect(layout, bySlug.get(e.to)!, compact);
      return {
        e,
        distance: Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2)),
        p: [a.x + NODE_W, a.y + relationAnchorY(bySlug.get(e.from)!, e.field, compact)] as const,
        q: [b.x, b.y + TARGET_ANCHOR_Y] as const,
      };
    });
  const side = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
    Math.sign((b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!));
  let crossings = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const s = lines[i]!;
      const t = lines[j]!;
      // Relations sharing a table meet at that table; that is not a crossing.
      if (new Set([s.e.from, s.e.to, t.e.from, t.e.to]).size < 4) continue;
      if (side(t.p, t.q, s.p) * side(t.p, t.q, s.q) < 0 && side(s.p, s.q, t.p) * side(s.p, s.q, t.q) < 0) crossings++;
    }
  }
  return {
    relations: lines.length,
    meanDistance: lines.reduce((sum, l) => sum + l.distance, 0) / lines.length,
    crossings,
  };
}

describe("schema graph layout — the e-commerce template", () => {
  test("the fixture is the schema the report was about", () => {
    // If the template shrinks, the numbers below stop meaning what they say.
    expect(shop.length).toBe(69);
    expect(new Set(shop.map(groupOf)).size).toBe(9);
    expect(relationEdges(shop).filter((e) => e.from !== e.to).length).toBeGreaterThanOrEqual(100);
  });

  for (const compact of [false, true]) {
    const density = compact ? "relations only" : "all fields";
    const layout = layoutSchemaGraph(shop, { compact, groupOrder: ecommerce.groups });

    test(`${density}: no card covers another`, () => {
      expect(overlappingCards(shop, layout, compact)).toEqual([]);
    });

    test(`${density}: each group's tables form one block`, () => {
      expect(interleavedGroups(shop, layout, compact)).toEqual([]);
      // …which the grid never managed: the check is not vacuous.
      expect(interleavedGroups(shop, shippedGrid(shop), compact).length).toBeGreaterThan(20);
    });

    // Measured when this landed — all fields: 1869 → 1188 px apart on average,
    // 1350 → 359 crossings; relations only: 1883 → 745 px, 1238 → 373
    // crossings. The bounds leave room to tune, not to regress to anything
    // like the grid.
    test(`${density}: related tables sit closer than on the old grid`, () => {
      const now = relationMetrics(shop, layout, compact);
      const before = relationMetrics(shop, shippedGrid(shop), compact);
      expect(now.meanDistance).toBeLessThan(before.meanDistance * 0.8);
    });

    test(`${density}: relations cross less than half as often as on the old grid`, () => {
      const now = relationMetrics(shop, layout, compact);
      const before = relationMetrics(shop, shippedGrid(shop), compact);
      expect(now.crossings).toBeLessThan(before.crossings / 2);
    });
  }

  test("inside a group, a table sits left of every table it references", () => {
    // The card's handles draw relations out of its right edge into the
    // target's left edge; a target on the left means a loop around a card.
    const layout = layoutSchemaGraph(shop, { groupOrder: ecommerce.groups });
    const groupOfSlug = new Map(shop.map((c) => [c.slug, groupOf(c)]));
    const inner = relationEdges(shop).filter((e) => e.from !== e.to && groupOfSlug.get(e.from) === groupOfSlug.get(e.to));
    expect(inner.length).toBeGreaterThan(50);
    expect(inner.filter((e) => layout[e.to]!.x <= layout[e.from]!.x).map((e) => `${e.from}.${e.field}`)).toEqual([]);
  });

  test("relations only is planned for the shorter cards, not squeezed out of the tall ones", () => {
    const extent = (layout: ErdLayout, compact: boolean) => {
      const rects = shop.map((c) => cardRect(layout, c, compact));
      return (
        (Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x))) *
        (Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y)))
      );
    };
    const full = extent(layoutSchemaGraph(shop, { groupOrder: ecommerce.groups }), false);
    const compact = extent(layoutSchemaGraph(shop, { compact: true, groupOrder: ecommerce.groups }), true);
    // Laid out for its own heights, the compact canvas takes well under half
    // the area; reusing the full layout's positions would take the same.
    expect(compact).toBeLessThan(full * 0.5);
  });
});

describe("schema graph layout — any schema", () => {
  test("every catalog template: no overlaps, one block per group", () => {
    for (const template of BASE_TEMPLATES) {
      const graph = toGraph(template);
      if (graph.length === 0) continue;
      for (const compact of [false, true]) {
        const layout = layoutSchemaGraph(graph, { compact, groupOrder: template.groups });
        expect(`${template.id}: ${overlappingCards(graph, layout, compact).join(", ")}`).toBe(`${template.id}: `);
        expect(`${template.id}: ${interleavedGroups(graph, layout, compact).join(", ")}`).toBe(`${template.id}: `);
      }
    }
  });

  test("ungrouped tables form a block of their own", () => {
    const mixed = shop.map((c, i) => (i % 4 === 0 ? { ...c, group: null } : c));
    const layout = layoutSchemaGraph(mixed);
    expect(overlappingCards(mixed, layout, false)).toEqual([]);
    expect(interleavedGroups(mixed, layout, false)).toEqual([]);
  });

  test("the result does not depend on the order the API returns rows in", () => {
    // Only positions somebody dragged are saved; every other table must land
    // in the same place on the next load, whatever order storage yields.
    const reference = layoutSchemaGraph(shop, { groupOrder: ecommerce.groups });
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const shuffled = [...shop].map((c) => [random(), c] as const).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    expect(layoutSchemaGraph(shuffled, { groupOrder: ecommerce.groups })).toEqual(reference);
    expect(layoutSchemaGraph([...shop].reverse(), { groupOrder: ecommerce.groups })).toEqual(reference);
  });

  test("empty, single, self-referencing, dangling and cyclic schemas", () => {
    expect(layoutSchemaGraph([])).toEqual({});
    expect(layoutSchemaGraph([{ slug: "a", fields: [] }])).toEqual({ a: { x: 40, y: 40 } });
    // A category's parent, and a relation to a table that is gone.
    const odd = layoutSchemaGraph([
      { slug: "categories", fields: [{ name: "parent", type: "relation", to: "categories" }, { name: "gone", type: "relation", to: "nope" }] },
    ]);
    expect(Object.keys(odd)).toEqual(["categories"]);
    // A cart and the order it became point at each other.
    const cyclic: GraphCollection[] = [
      { slug: "carts", fields: [{ name: "order", type: "relation", to: "orders" }] },
      { slug: "orders", fields: [{ name: "cart", type: "relation", to: "carts" }] },
    ];
    expect(overlappingCards(cyclic, layoutSchemaGraph(cyclic), false)).toEqual([]);
  });
});

describe("card geometry", () => {
  const products: GraphCollection = {
    slug: "products",
    fields: [
      { name: "title", type: "text" },
      { name: "brand", type: "relation", to: "brands" },
      { name: "price", type: "money" },
      { name: "tags", type: "relation_many", to: "tags" },
    ],
  };

  test("a compact card is its header and its relation rows", () => {
    expect(estimateNodeHeight(products, true)).toBe(estimateNodeHeight({ slug: "x", fields: [] }, true) + 2 * 30);
    expect(estimateNodeHeight(products, false)).toBe(estimateNodeHeight(products, true) + 2 * 30);
    // A full card with no fields still draws its "No user fields yet." row.
    expect(estimateNodeHeight({ slug: "x", fields: [] }, false)).toBe(estimateNodeHeight({ slug: "x", fields: [] }, true) + 30);
  });

  test("a relation leaves its card from its own row, in either density", () => {
    // Full: `tags` is the fourth row. Compact: the second, after `brand`.
    expect(relationAnchorY(products, "tags", false) - relationAnchorY(products, "brand", false)).toBe(2 * 30);
    expect(relationAnchorY(products, "tags", true) - relationAnchorY(products, "brand", true)).toBe(30);
  });
});

describe("settleOverlaps", () => {
  test("a card that grew pushes down what it now covers, and nothing else", () => {
    const positions: ErdLayout = { a: { x: 0, y: 0 }, b: { x: 0, y: 130 }, c: { x: 0, y: 260 }, side: { x: 400, y: 130 } };
    // `a` was planned 100px tall and gained two rows.
    const heights = { a: 160, b: 100, c: 100, side: 100 };
    const settled = settleOverlaps(positions, heights);
    expect(settled.a).toEqual({ x: 0, y: 0 });
    expect(settled.b!.y).toBeGreaterThanOrEqual(160);
    expect(settled.c!.y).toBeGreaterThanOrEqual(settled.b!.y + 100);
    // Another column is not in the way and does not move.
    expect(settled.side).toEqual({ x: 400, y: 130 });
  });

  test("a position somebody chose never moves; the arranged card makes way", () => {
    const positions: ErdLayout = { dragged: { x: 10, y: 50 }, arranged: { x: 0, y: 0 } };
    const settled = settleOverlaps(positions, { dragged: 100, arranged: 100 }, new Set(["dragged"]));
    expect(settled.dragged).toEqual({ x: 10, y: 50 });
    expect(settled.arranged!.y).toBeGreaterThanOrEqual(150);
  });
});
