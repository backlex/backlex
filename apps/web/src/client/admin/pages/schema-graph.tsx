// Schema graph (ERD) page — live view of dynamic collections + their relations.
//
// Nodes come from /api/collections (collectionsApi.list). FK relations are
// derived from any field whose type === "relation" — the field's `to` value
// (when present) is the target collection slug. Anything without a relation
// renders as an isolated node. Layout is a simple deterministic grid.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, PageHeader } from "../ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workeros/ui/components/table";
import { ScrollArea } from "@workeros/ui/components/scroll-area";
import { collectionsApi, type ApiCollection } from "../api";
import { SchemaGraphSkeleton } from "../page-skeletons";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

interface GraphNode {
  slug: string;
  x: number;
  y: number;
  fields: number;
  color: string;
}

interface GraphEdge {
  from: string;
  to: string;
  label: string;
  kind: "fk" | "m2m";
}

// Same OKLCH palette the design uses, cycled by index.
const NODE_PALETTE = [
  "oklch(0.78 0.16 130)",
  "oklch(0.72 0.16 240)",
  "oklch(0.72 0.18 95)",
  "oklch(0.7 0.16 28)",
  "oklch(0.68 0.06 285)",
  "oklch(0.74 0.16 200)",
  "oklch(0.7 0.18 320)",
  "oklch(0.76 0.14 160)",
];

const NODE_W = 220;
const NODE_H = 96;
const COL_GAP = 140;
const ROW_GAP = 60;
const COLS = 3;
const ORIGIN_X = 80;
const ORIGIN_Y = 60;

function buildGraph(collections: ApiCollection[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const slugs = new Set(collections.map((c) => c.slug));
  const nodes: GraphNode[] = collections.map((c, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      slug: c.slug,
      x: ORIGIN_X + col * (NODE_W + COL_GAP),
      y: ORIGIN_Y + row * (NODE_H + ROW_GAP),
      fields: Array.isArray(c.fields) ? c.fields.length : 0,
      color: NODE_PALETTE[i % NODE_PALETTE.length] ?? NODE_PALETTE[0]!,
    };
  });

  const edges: GraphEdge[] = [];
  for (const c of collections) {
    for (const f of c.fields ?? []) {
      // The DB schema only labels `relation` for proper FK fields; m2m
      // tables would show up as their own collection with both ends. For
      // simplicity treat every relation as an `fk` edge — the design's m2m
      // styling stays available if a future field flag carries that.
      if (f.type !== "relation") continue;
      const target = (f as { to?: string }).to;
      if (!target || !slugs.has(target) || target === c.slug) continue;
      edges.push({
        from: c.slug,
        to: target,
        label: `${f.name} → id`,
        kind: "fk",
      });
    }
  }
  return { nodes, edges };
}

export function SchemaGraphPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const { t } = useLingui();
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await collectionsApi.list();
        if (cancelled) return;
        if (Array.isArray(res.data)) setCollections(res.data);
      } catch {
        // Auth/network failure — leave empty; the page renders the empty state.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const { nodes, edges } = useMemo(() => buildGraph(collections), [collections]);

  // Canvas sized to fit the laid-out grid + a margin.
  const rows = Math.max(1, Math.ceil(nodes.length / COLS));
  const W = Math.max(1100, ORIGIN_X * 2 + COLS * NODE_W + (COLS - 1) * COL_GAP);
  const H = Math.max(360, ORIGIN_Y * 2 + rows * NODE_H + (rows - 1) * ROW_GAP);

  const nodeBySlug = useMemo(() => new Map(nodes.map((n) => [n.slug, n])), [nodes]);

  const edgePath = (e: GraphEdge) => {
    const from = nodeBySlug.get(e.from);
    const to = nodeBySlug.get(e.to);
    if (!from || !to) return null;
    const a = { cx: from.x + NODE_W / 2, cy: from.y + NODE_H / 2 };
    const b = { cx: to.x + NODE_W / 2, cy: to.y + NODE_H / 2 };
    const mx = (a.cx + b.cx) / 2;
    return `M ${a.cx} ${a.cy} C ${mx} ${a.cy}, ${mx} ${b.cy}, ${b.cx} ${b.cy}`;
  };

  const onExport = () => {
    try {
      const payload = JSON.stringify({ nodes, edges }, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "schema.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      pushToast(t`Schema exported · schema.json`);
    } catch {
      pushToast(t`Export failed.`, "error");
    }
  };

  // First whole-page fetch — collections haven't landed yet.
  if (!loaded) return <SchemaGraphSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Schema graph`}
        description={t`Live ERD of dynamic collections. Foreign keys derive from field type · relations panel below shows the join shape used by REST + GraphQL.`}
        actions={
          <>
            <Button variant="outline" icon={I.Download} onClick={onExport}>
              <Trans>Export</Trans>
            </Button>
            <Button
              variant="outline"
              icon={I.Refresh}
              onClick={() => {
                setReloadKey((k) => k + 1);
                pushToast(t`Graph refreshed from collections metadata.`);
              }}
            >
              <Trans>Refresh</Trans>
            </Button>
          </>
        }
      />

      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3.5">
          <span className="text-[12.5px] font-medium">
            <Trans>{nodes.length} collections · {edges.length} relations</Trans>
          </span>
          <div className="flex-1" />
          <div className="flex gap-2.5 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-[5px]">
              <span className="h-0.5 w-4 bg-foreground" /> <Trans>fk</Trans>
            </span>
            <span className="flex items-center gap-[5px]">
              <span className="w-4 border-t-2 border-dashed border-foreground" /> <Trans>m2m</Trans>
            </span>
          </div>
        </div>
        <ScrollArea className="w-full bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))]">
          {nodes.length === 0 ? (
            <div className="p-10 text-center text-[13px] text-muted-foreground">
              <Trans>No collections to graph — create one to populate the ERD.</Trans>
            </div>
          ) : (
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block min-w-[1100px]">
              <defs>
                <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M 24 0 L 0 0 0 24" fill="none" stroke="var(--border)" strokeWidth="1" />
                </pattern>
                <marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--foreground)" />
                </marker>
              </defs>
              <rect width={W} height={H} fill="url(#grid)" />
              {edges.map((e, i) => {
                const d = edgePath(e);
                if (!d) return null;
                const inactive = selected != null && selected !== e.from && selected !== e.to;
                const highlighted = selected != null && (selected === e.from || selected === e.to);
                return (
                  <g key={`${e.from}->${e.to}:${i}`}>
                    <path
                      d={d}
                      fill="none"
                      stroke={highlighted ? "var(--primary)" : "var(--foreground)"}
                      strokeWidth="1.5"
                      strokeDasharray={e.kind === "m2m" ? "6 5" : ""}
                      markerEnd="url(#arr)"
                      opacity={highlighted ? 1 : inactive ? 0.18 : 0.55}
                    />
                  </g>
                );
              })}
              {nodes.map((n) => (
                <g
                  key={n.slug}
                  transform={`translate(${n.x},${n.y})`}
                  onClick={() => setSelected((s) => (s === n.slug ? null : n.slug))}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx="14"
                    fill="var(--card)"
                    stroke={selected === n.slug ? "var(--primary)" : "var(--border)"}
                    strokeWidth={selected === n.slug ? 2 : 1}
                  />
                  <rect width="4" height={NODE_H} rx="2" fill={n.color} />
                  <text
                    x="20"
                    y="28"
                    fontFamily="Geist Mono, monospace"
                    fontSize="13.5"
                    fontWeight="500"
                    fill="var(--foreground)"
                  >
                    c_{n.slug}
                  </text>
                  <text x="20" y="50" fontSize="11.5" fill="var(--muted-foreground)">
                    {n.fields} fields
                  </text>
                  <g transform="translate(20, 64)">
                    <rect width="68" height="18" rx="6" fill="var(--muted)" />
                    <text
                      x="34"
                      y="12"
                      fontFamily="Geist Mono, monospace"
                      fontSize="10"
                      textAnchor="middle"
                      fill="var(--muted-foreground)"
                    >
                      VIEW SCHEMA
                    </text>
                  </g>
                </g>
              ))}
            </svg>
          )}
        </ScrollArea>
      </div>

      {/* Relations table */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Network size={14} />
          <span className="text-[13px] font-medium"><Trans>relations</Trans></span>
          <span className="font-mono text-xs text-muted-foreground">
            {edges.length}
          </span>
        </div>
        {edges.length === 0 ? (
          <div className="px-4 py-3.5 text-xs text-muted-foreground">
            <Trans>No relation-typed fields detected. Add a field with type{" "}
            <span className="font-mono">relation</span> to draw an edge.</Trans>
          </div>
        ) : (
          <Table className={ADMIN_TABLE_CLS}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]"><Trans>from</Trans></TableHead>
                <TableHead className="w-10" />
                <TableHead className="w-[200px]"><Trans>to</Trans></TableHead>
                <TableHead className="w-[80px]"><Trans>kind</Trans></TableHead>
                <TableHead><Trans>field</Trans></TableHead>
                <TableHead className="w-[110px]"><Trans>expansion</Trans></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {edges.map((e, i) => (
                <TableRow key={`${e.from}->${e.to}:${i}`}>
                  <TableCell className="font-mono">c_{e.from}</TableCell>
                  <TableCell><I.ChevronRight size={12} className="text-muted-foreground" /></TableCell>
                  <TableCell className="font-mono">c_{e.to}</TableCell>
                  <TableCell>
                    <Badge variant={e.kind === "m2m" ? "secondary" : "outline"}>{e.kind}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {e.label}
                  </TableCell>
                  <TableCell className="font-mono text-[11.5px] text-muted-foreground">
                    fields=*,{e.to.replace(/s$/, "")}.*
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
