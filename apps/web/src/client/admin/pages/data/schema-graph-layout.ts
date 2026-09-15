/**
 * Auto-arrangement for the schema graph (ERD) — a pure function of the
 * collection list, so it is testable without React Flow, a DOM or a browser.
 *
 * What it replaced dealt cards onto a grid in API order: row-major, round-robin
 * across the columns, with no idea which table references which. On the
 * 69-table e-commerce template that scattered every group across the canvas —
 * 28 of its 36 pairs of groups had overlapping bounding boxes — and its 130
 * relations, counted as straight lines, crossed each other 1,350 times. This
 * layout does three things instead.
 *
 * 1. **A group is one block.** Tables that share an admin `group` are placed
 *    together and a block is never split, so the Catalog tables are always
 *    found in one place. Ungrouped tables form a block of their own.
 * 2. **Inside a block, a table sits LEFT of the tables it references.** That is
 *    the direction the card's handles already draw in — a relation leaves its
 *    field row on the card's right edge and enters the target's header on its
 *    left edge — so a layered block draws most relations as short left-to-right
 *    strokes instead of loops around a card. Each column is ordered by where
 *    its neighbours sit, which is what keeps those strokes from crossing.
 * 3. **A block is placed beside the blocks it shares relations with**, in
 *    whichever of its possible shapes keeps those relations shortest without
 *    growing the whole layout past the canvas's proportions.
 *
 * Heights come from the constants the card renders with (the node component
 * sizes its header and rows from `NODE_HEADER_H` / `NODE_ROW_H`), so a layout
 * computed here cannot overlap on screen, in either density.
 */

export interface GraphField {
  name: string;
  type: string;
  to?: string;
}

export interface GraphCollection {
  slug: string;
  group?: string | null;
  fields: readonly GraphField[];
}

export type Pos = { x: number; y: number };
export type ErdLayout = Record<string, Pos>;

export interface RelationEdge {
  from: string;
  to: string;
  field: string;
  many: boolean;
}

/** Card width. */
export const NODE_W = 248;
/** Card header: title, field count and the two header buttons. */
export const NODE_HEADER_H = 38;
/** One field row. */
export const NODE_ROW_H = 30;
/** The card's own top + bottom border. */
const NODE_BORDERS_H = 2;
/** Where every incoming relation enters a card: the middle of its header. */
export const TARGET_ANCHOR_Y = 1 + NODE_HEADER_H / 2;

/**
 * Width / height the layout aims for. The canvas spans the page column —
 * `.page` caps it at 1180px, so ~1120px of canvas — and is at most 640px tall
 * (70vh on shorter screens): about 1.75 on a desktop, 1.9 on a 1280×720 laptop.
 */
export const DEFAULT_ASPECT = 1.8;

interface Spacing {
  /** Between columns inside a block: room for a relation's curve and arrowhead. */
  col: number;
  /** Between cards stacked in one column. */
  stack: number;
  /** Between blocks — clearly wider than `col`, so a group reads as a group. */
  blockX: number;
  blockY: number;
}
// Compact cards are a fraction of the height; gaps sized for full cards would
// leave them islands in whitespace that fitView then has to zoom out to show.
const FULL_SPACING: Spacing = { col: 96, stack: 26, blockX: 180, blockY: 140 };
const COMPACT_SPACING: Spacing = { col: 84, stack: 20, blockX: 160, blockY: 110 };
const ORIGIN = 40;

export const isRelationType = (type: string): boolean =>
  type === "relation" || type === "relation_many";

/** The admin group a collection is filed under, or "" when it has none. */
export const groupOf = (c: { group?: string | null }): string => c.group?.trim() ?? "";

/** The rows a card draws: every field, or in compact mode only the relations. */
export const visibleFields = <F extends GraphField>(fields: readonly F[], compact: boolean): readonly F[] =>
  compact ? fields.filter((f) => isRelationType(f.type)) : fields;

export function estimateNodeHeight(c: GraphCollection, compact = false): number {
  const rows = visibleFields(c.fields, compact).length;
  // A full card always draws at least its "No user fields yet." row; a compact
  // card with no relations is just its header.
  return NODE_BORDERS_H + NODE_HEADER_H + (compact ? rows : Math.max(rows, 1)) * NODE_ROW_H;
}

/** Where a relation's edge leaves its card, measured from the card's top. */
export function relationAnchorY(c: GraphCollection, field: string, compact = false): number {
  const row = visibleFields(c.fields, compact).findIndex((f) => f.name === field);
  return 1 + NODE_HEADER_H + Math.max(row, 0) * NODE_ROW_H + NODE_ROW_H / 2;
}

/** Every relation whose target is a collection on the canvas. */
export function relationEdges(collections: readonly GraphCollection[]): RelationEdge[] {
  const slugs = new Set(collections.map((c) => c.slug));
  const out: RelationEdge[] = [];
  for (const c of collections) {
    for (const f of c.fields) {
      if (!isRelationType(f.type) || !f.to || !slugs.has(f.to)) continue;
      out.push({ from: c.slug, to: f.to, field: f.name, many: f.type === "relation_many" });
    }
  }
  return out;
}

export interface LayoutOptions {
  /** Lay out the "relations only" cards instead of the full ones. */
  compact?: boolean;
  /** The workspace's group header order. Only breaks ties, so equal choices
   *  follow the order the sidebar lists the groups in. */
  groupOrder?: readonly string[];
  /** Target width / height of the whole layout. */
  aspect?: number;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function layoutSchemaGraph(
  collections: readonly GraphCollection[],
  opts: LayoutOptions = {},
): ErdLayout {
  if (collections.length === 0) return {};
  const compact = opts.compact ?? false;
  const gap = compact ? COMPACT_SPACING : FULL_SPACING;
  const groupOrder = opts.groupOrder ?? [];

  // Canonical input order. The API returns rows in storage order, which is
  // not the same on every database; sorting first makes the result a function
  // of the schema alone, so a table nobody dragged lands in the same place on
  // every load. That is what lets the page save only positions a person chose.
  const cols = [...collections].sort((a, b) => byText(a.slug, b.slug));
  const bySlug = new Map(cols.map((c) => [c.slug, c]));
  const height = new Map(cols.map((c) => [c.slug, estimateNodeHeight(c, compact)]));
  const groupOfSlug = new Map(cols.map((c) => [c.slug, groupOf(c)]));

  const members = new Map<string, string[]>();
  for (const c of cols) {
    const g = groupOf(c);
    const list = members.get(g);
    if (list) list.push(c.slug);
    else members.set(g, [c.slug]);
  }
  const groupRank = (g: string): number => {
    if (g === "") return Number.POSITIVE_INFINITY;
    const i = groupOrder.indexOf(g);
    return i === -1 ? groupOrder.length : i;
  };
  const groups = [...members.keys()].sort((a, b) => groupRank(a) - groupRank(b) || byText(a, b));

  // A self-reference (a category's parent) says nothing about where a table
  // belongs, so it plays no part in arranging anything.
  const inner = new Map<string, Array<[string, string]>>(groups.map((g) => [g, []]));
  const between: RelationEdge[] = [];
  for (const e of relationEdges(cols)) {
    if (e.from === e.to) continue;
    const g = groupOfSlug.get(e.from)!;
    if (g === groupOfSlug.get(e.to)) inner.get(g)!.push([e.from, e.to]);
    else between.push(e);
  }

  // Shapes. A block's column may not grow past a height cap; a taller column
  // continues in the next one. Small caps make wide, low blocks and large caps
  // tall, narrow ones, so each group is offered every distinct shape across a
  // range of caps and placement picks the one that fits beside its
  // neighbours. One cap for all groups is what made the largest group a strip
  // along the bottom, away from everything it relates to.
  const heights = [...height.values()];
  const tallest = Math.max(...heights);
  const stacked = heights.reduce((s, h) => s + h, 0) + gap.stack * (heights.length - 1);
  const caps = new Set<number>();
  for (let i = 0; i <= 10; i++) caps.add(Math.round(tallest * (stacked / tallest) ** (i / 10)));
  const shapes = new Map<string, Block[]>();
  for (const g of groups) {
    const seen = new Set<string>();
    const list: Block[] = [];
    for (const cap of caps) {
      const b = layoutBlock(members.get(g)!, inner.get(g)!, height, cap, gap);
      if (seen.has(`${b.w}x${b.h}`)) continue;
      seen.add(`${b.w}x${b.h}`);
      list.push(b);
    }
    shapes.set(g, list);
  }

  const placed = placeBlocks(greedyGroupOrder(groups, between, groupOfSlug), shapes, between, {
    groupOfSlug,
    anchorFrom: new Map(between.map((e) => [e, relationAnchorY(bySlug.get(e.from)!, e.field, compact)])),
    aspect: opts.aspect ?? DEFAULT_ASPECT,
    gap,
  });

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  const out: ErdLayout = {};
  for (const p of placed.values()) {
    for (const [slug, r] of p.b.pos) {
      out[slug] = { x: ORIGIN + p.x - minX + r.x, y: ORIGIN + p.y - minY + r.y };
    }
  }
  return out;
}

/**
 * Push cards down until none overlaps another.
 *
 * The page computes a layout once per density and then holds it still: a
 * canvas that rearranges itself whenever a field is added loses its reader.
 * But a field added inline makes its card a row taller than the layout
 * planned for, and a table somebody dragged can sit where the layout put
 * another. This moves only what actually collides — in top-to-bottom order,
 * each card goes below whatever it would overlap — and never moves a card in
 * `fixed`, which holds the positions a person chose.
 */
export function settleOverlaps(
  positions: Readonly<ErdLayout>,
  heights: Readonly<Record<string, number>>,
  fixed: ReadonlySet<string> = new Set(),
  gap = 24,
): ErdLayout {
  const out: ErdLayout = {};
  const settled: Array<Pos & { h: number }> = [];
  for (const [slug, p] of Object.entries(positions)) {
    if (!fixed.has(slug)) continue;
    out[slug] = p;
    settled.push({ ...p, h: heights[slug] ?? 0 });
  }
  const movable = Object.keys(positions)
    .filter((slug) => !fixed.has(slug))
    .sort((a, b) => positions[a]!.y - positions[b]!.y || positions[a]!.x - positions[b]!.x);
  for (const slug of movable) {
    const { x } = positions[slug]!;
    let { y } = positions[slug]!;
    const h = heights[slug] ?? 0;
    for (let moved = true; moved; ) {
      moved = false;
      for (const s of settled) {
        if (x < s.x + NODE_W && s.x < x + NODE_W && y < s.y + s.h && s.y < y + h) {
          y = s.y + s.h + gap;
          moved = true;
        }
      }
    }
    out[slug] = { x, y };
    settled.push({ x, y, h });
  }
  return out;
}

interface Block {
  /** Positions relative to the block's top-left corner. */
  pos: Map<string, Pos>;
  w: number;
  h: number;
}

interface Spot {
  x: number;
  y: number;
  b: Block;
}

/**
 * How much a relation between groups weighs against the layout growing. At 2,
 * making the whole layout 100px bigger is worth it only if it saves more than
 * 200px on each relation involved — tuned across the 26 catalog templates,
 * where it drew the fewest crossings without giving up zoom (1 drew slightly
 * more crossings, 3 longer relations).
 */
const GROWTH_WEIGHT = 2;

/**
 * Put each group's block where its relations to the groups already placed are
 * shortest, then revisit every group once all of them exist — the first ones
 * were placed with nothing to relate to.
 */
function placeBlocks(
  order: readonly string[],
  shapes: ReadonlyMap<string, readonly Block[]>,
  between: readonly RelationEdge[],
  ctx: {
    groupOfSlug: ReadonlyMap<string, string>;
    anchorFrom: ReadonlyMap<RelationEdge, number>;
    aspect: number;
    gap: Spacing;
  },
): Map<string, Spot> {
  const { groupOfSlug, anchorFrom, aspect, gap } = ctx;
  const placed = new Map<string, Spot>();
  const links = new Map<string, RelationEdge[]>(order.map((g) => [g, []]));
  for (const e of between) {
    links.get(groupOfSlug.get(e.from)!)!.push(e);
    links.get(groupOfSlug.get(e.to)!)!.push(e);
  }

  // A relation is drawn from its field row on the source's right edge into
  // the target's header on its left edge, so measuring between those two
  // points also charges a target placed behind its source for the way round.
  const length = (e: RelationEdge, g: string, spot: Spot): number => {
    const from = groupOfSlug.get(e.from) === g ? spot : placed.get(groupOfSlug.get(e.from)!)!;
    const to = groupOfSlug.get(e.to) === g ? spot : placed.get(groupOfSlug.get(e.to)!)!;
    const a = from.b.pos.get(e.from)!;
    const b = to.b.pos.get(e.to)!;
    return Math.hypot(
      to.x + b.x - (from.x + a.x + NODE_W),
      to.y + b.y + TARGET_ANCHOR_Y - (from.y + a.y + anchorFrom.get(e)!),
    );
  };
  // Fitting everything on the canvas at the largest zoom is decided by
  // whichever side runs out first.
  const extent = (spots: readonly Spot[]): number => {
    if (spots.length === 0) return 0;
    const x0 = Math.min(...spots.map((s) => s.x));
    const y0 = Math.min(...spots.map((s) => s.y));
    const x1 = Math.max(...spots.map((s) => s.x + s.b.w));
    const y1 = Math.max(...spots.map((s) => s.y + s.b.h));
    return Math.max((x1 - x0) / aspect, y1 - y0);
  };
  const apart = (s: Spot, o: Spot): boolean =>
    s.x + s.b.w + gap.blockX <= o.x ||
    o.x + o.b.w + gap.blockX <= s.x ||
    s.y + s.b.h + gap.blockY <= o.y ||
    o.y + o.b.h + gap.blockY <= s.y;

  const cost = (g: string, spot: Spot, others: readonly Spot[], before: number): number => {
    let total = 0;
    let count = 0;
    for (const e of links.get(g)!) {
      const other = groupOfSlug.get(e.from) === g ? groupOfSlug.get(e.to)! : groupOfSlug.get(e.from)!;
      if (!placed.has(other)) continue;
      total += length(e, g, spot);
      count++;
    }
    return total + GROWTH_WEIGHT * Math.max(1, count) * (extent([...others, spot]) - before);
  };

  const bestSpot = (g: string, others: readonly Spot[]): { spot: Spot; cost: number } => {
    const before = extent(others);
    let best: { spot: Spot; cost: number } | null = null;
    for (const b of shapes.get(g)!) {
      // Beside, above or below each placed block, flush with either of its
      // edges or centred on it.
      const candidates: Pos[] = others.length === 0 ? [{ x: 0, y: 0 }] : [];
      for (const o of others) {
        for (const y of [o.y, o.y + o.b.h - b.h, o.y + Math.round((o.b.h - b.h) / 2)]) {
          candidates.push({ x: o.x + o.b.w + gap.blockX, y }, { x: o.x - gap.blockX - b.w, y });
        }
        for (const x of [o.x, o.x + o.b.w - b.w, o.x + Math.round((o.b.w - b.w) / 2)]) {
          candidates.push({ x, y: o.y + o.b.h + gap.blockY }, { x, y: o.y - gap.blockY - b.h });
        }
      }
      for (const c of candidates) {
        const spot = { ...c, b };
        if (!others.every((o) => apart(spot, o))) continue;
        const value = cost(g, spot, others, before);
        if (!best || value < best.cost - 1e-6) best = { spot, cost: value };
      }
    }
    // Never null: the spot beside whichever block reaches furthest right is
    // always free, and it is always a candidate.
    return best!;
  };

  const othersThan = (g: string): Spot[] => [...placed].filter(([h]) => h !== g).map(([, s]) => s);
  for (const g of order) placed.set(g, bestSpot(g, othersThan(g)).spot);
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (const g of order) {
      const others = othersThan(g);
      const stay = cost(g, placed.get(g)!, others, extent(others));
      const next = bestSpot(g, others);
      if (next.cost < stay - 1e-6) {
        placed.set(g, next.spot);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return placed;
}

/**
 * Lay one group out as columns: referencing tables left of referenced ones,
 * each column ordered by its neighbours, continued sideways past `cap`.
 */
function layoutBlock(
  slugs: readonly string[],
  links: ReadonlyArray<readonly [string, string]>,
  height: ReadonlyMap<string, number>,
  cap: number,
  gap: Spacing,
): Block {
  const out = new Map<string, Set<string>>(slugs.map((s) => [s, new Set()]));
  const inc = new Map<string, Set<string>>(slugs.map((s) => [s, new Set()]));
  for (const [a, b] of links) {
    out.get(a)!.add(b);
    inc.get(b)!.add(a);
  }
  const linked = slugs.filter((s) => out.get(s)!.size + inc.get(s)!.size > 0);
  const loose = slugs.filter((s) => out.get(s)!.size + inc.get(s)!.size === 0);

  // 1. Layering needs an acyclic graph, and schemas have cycles (a cart and
  //    the order it became point at each other). A depth-first walk from the
  //    least-referenced tables keeps every edge except the ones closing a
  //    loop; those are still drawn, they just do not decide columns.
  const dagOut = new Map<string, string[]>(slugs.map((s) => [s, []]));
  const dagIn = new Map<string, string[]>(slugs.map((s) => [s, []]));
  const state = new Map<string, "open" | "done">();
  const visit = (u: string): void => {
    state.set(u, "open");
    for (const v of out.get(u)!) {
      const st = state.get(v);
      if (st === "open") continue;
      dagOut.get(u)!.push(v);
      dagIn.get(v)!.push(u);
      if (st === undefined) visit(v);
    }
    state.set(u, "done");
  };
  for (const s of [...linked].sort((a, b) => inc.get(a)!.size - inc.get(b)!.size)) {
    if (!state.has(s)) visit(s);
  }

  // 2. Columns. The longest chain of references below a table decides how far
  //    left it goes, which puts it one column left of the left-most table it
  //    references…
  const depth = new Map<string, number>();
  const depthOf = (u: string): number => {
    const known = depth.get(u);
    if (known !== undefined) return known;
    let d = 0;
    for (const v of dagOut.get(u)!) d = Math.max(d, depthOf(v) + 1);
    depth.set(u, d);
    return d;
  };
  const maxDepth = Math.max(0, ...linked.map(depthOf));
  const col = new Map(linked.map((s) => [s, maxDepth - depthOf(s)]));
  //    …but strands a table that references nothing in the last column even
  //    when the one table pointing at it sits far to the left. Pull each table
  //    toward the column its neighbours want it in (the median), never past a
  //    column the reference direction forbids.
  for (let pass = 0; pass < 4; pass++) {
    for (const u of linked) {
      const lo = Math.max(0, ...dagIn.get(u)!.map((p) => col.get(p)! + 1));
      const hi = Math.min(maxDepth, ...dagOut.get(u)!.map((v) => col.get(v)! - 1));
      const wants = [
        ...dagIn.get(u)!.map((p) => col.get(p)! + 1),
        ...dagOut.get(u)!.map((v) => col.get(v)! - 1),
      ].sort((a, b) => a - b);
      const median = wants[(wants.length - 1) >> 1];
      if (median !== undefined) col.set(u, Math.min(hi, Math.max(lo, median)));
    }
  }
  const used = [...new Set(col.values())].sort((a, b) => a - b);
  const columns: string[][] = used.map(() => []);
  for (const s of linked) columns[used.indexOf(col.get(s)!)]!.push(s);

  // 3. Order each column by the mean position of its neighbours in the other
  //    columns, sweeping right and back a few times so the orders settle.
  const place = new Map<string, number>();
  const settle = (column: readonly string[]) =>
    column.forEach((s, i) => place.set(s, (i + 0.5) / column.length));
  columns.forEach(settle);
  const columnOf = new Map<string, number>();
  columns.forEach((column, i) => column.forEach((s) => columnOf.set(s, i)));
  for (let sweep = 0; sweep < 8; sweep++) {
    for (const column of sweep % 2 === 0 ? columns : [...columns].reverse()) {
      const key = new Map<string, number>();
      for (const s of column) {
        const around = [...out.get(s)!, ...inc.get(s)!].filter((n) => columnOf.get(n) !== columnOf.get(s));
        key.set(
          s,
          around.length > 0 ? around.reduce((sum, n) => sum + place.get(n)!, 0) / around.length : place.get(s)!,
        );
      }
      column.sort((a, b) => key.get(a)! - key.get(b)!);
      settle(column);
    }
  }

  // 4. Stack each column, continuing in a new one beside it past the cap.
  const stacks: string[][] = [];
  const stackH: number[] = [];
  for (const column of columns) {
    let stack: string[] = [];
    let h = 0;
    for (const s of column) {
      const sh = height.get(s)!;
      if (stack.length > 0 && h + gap.stack + sh > cap) {
        stacks.push(stack);
        stackH.push(h);
        stack = [];
        h = 0;
      }
      h += (stack.length > 0 ? gap.stack : 0) + sh;
      stack.push(s);
    }
    if (stack.length > 0) {
      stacks.push(stack);
      stackH.push(h);
    }
  }

  // 5. Tables with no relation inside their group go wherever there is room,
  //    tallest first, and open a new column on the right when there is none.
  for (const s of [...loose].sort((a, b) => height.get(b)! - height.get(a)!)) {
    const sh = height.get(s)!;
    let target = -1;
    for (let i = 0; i < stacks.length; i++) {
      if (stackH[i]! + gap.stack + sh > cap) continue;
      if (target === -1 || stackH[i]! < stackH[target]!) target = i;
    }
    if (target === -1) {
      stacks.push([s]);
      stackH.push(sh);
    } else {
      stacks[target]!.push(s);
      stackH[target] = stackH[target]! + gap.stack + sh;
    }
  }

  // 6. Centre the shorter stacks on the tallest, so relations into a short
  //    column arrive near its middle rather than at the top of the block.
  const h = Math.max(...stackH);
  const pos = new Map<string, Pos>();
  stacks.forEach((stack, i) => {
    let y = Math.floor((h - stackH[i]!) / 2);
    const x = i * (NODE_W + gap.col);
    for (const s of stack) {
      pos.set(s, { x, y });
      y += height.get(s)! + gap.stack;
    }
  });
  return { pos, w: stacks.length * NODE_W + (stacks.length - 1) * gap.col, h };
}

/**
 * The order groups are placed in: the one with the most relations to the rest
 * first, then repeatedly whichever is most tied to those already placed — the
 * latest counting double, since it is the block the next one tends to sit
 * beside. Ungrouped tables go last: nobody filed them, so they are the least
 * likely to anchor anything.
 */
function greedyGroupOrder(
  groups: readonly string[],
  between: readonly RelationEdge[],
  groupOfSlug: ReadonlyMap<string, string>,
): string[] {
  const weight = new Map<string, number>();
  const key = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
  for (const e of between) {
    const k = key(groupOfSlug.get(e.from)!, groupOfSlug.get(e.to)!);
    weight.set(k, (weight.get(k) ?? 0) + 1);
  }
  const w = (a: string, b: string) => weight.get(key(a, b)) ?? 0;
  const remaining = groups.filter((g) => g !== "");
  const order: string[] = [];
  // Strictly greater, so a tie keeps the group listed first in `groups`.
  const pick = (score: (g: string) => number) => {
    let bestIndex = 0;
    remaining.forEach((g, i) => {
      if (score(g) > score(remaining[bestIndex]!)) bestIndex = i;
    });
    order.push(remaining.splice(bestIndex, 1)[0]!);
  };
  if (remaining.length > 0) pick((g) => groups.reduce((s, o) => s + (o === g ? 0 : w(g, o)), 0));
  while (remaining.length > 0) {
    const last = order[order.length - 1]!;
    pick((g) => 2 * w(g, last) + order.reduce((s, o) => s + w(g, o), 0));
  }
  if (groups.includes("")) order.push("");
  return order;
}
