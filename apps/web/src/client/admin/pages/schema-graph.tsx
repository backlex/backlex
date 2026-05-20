// Schema graph (ERD) page — live view of dynamic collections + their relations.
//
// Nodes come from /api/collections (collectionsApi.list). FK relations are
// derived from any field whose type === "relation" — the field's `to` value
// (when present) is the target collection slug. Anything without a relation
// renders as an isolated node. Layout is a simple deterministic grid.
import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { Badge, Button, PageHeader } from "../ui";
import { collectionsApi, type ApiCollection } from "../api";

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
      pushToast("Schema exported · schema.json");
    } catch {
      pushToast("Export failed.", "error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Schema graph"
        description="Live ERD of dynamic collections. Foreign keys derive from field type · relations panel below shows the join shape used by REST + GraphQL."
        actions={
          <>
            <Button variant="outline" icon={I.Download} onClick={onExport}>
              Export
            </Button>
            <Button
              variant="outline"
              icon={I.Refresh}
              onClick={() => {
                setReloadKey((k) => k + 1);
                pushToast("Graph refreshed from collections metadata.");
              }}
            >
              Refresh
            </Button>
          </>
        }
      />

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="card-section" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>
            {nodes.length} collections · {edges.length} relations
          </span>
          <div className="spacer" />
          <div style={{ display: "flex", gap: 10, fontSize: 11.5, color: "var(--muted-foreground)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 16, height: 2, background: "var(--foreground)" }} /> fk
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 16, height: 0, borderTop: "2px dashed var(--foreground)" }} /> m2m
            </span>
          </div>
        </div>
        <div className="graph-canvas">
          {nodes.length === 0 ? (
            <div className="muted" style={{ padding: 40, fontSize: 13, textAlign: "center" }}>
              {loaded ? "No collections to graph — create one to populate the ERD." : "Loading collections…"}
            </div>
          ) : (
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
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
                  <g key={`${e.from}->${e.to}:${i}`} className={`edge ${highlighted ? "on" : ""}`}>
                    <path
                      d={d}
                      fill="none"
                      stroke="var(--foreground)"
                      strokeWidth="1.5"
                      strokeDasharray={e.kind === "m2m" ? "6 5" : ""}
                      markerEnd="url(#arr)"
                      opacity={inactive ? 0.18 : 0.55}
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
        </div>
      </div>

      {/* Relations table */}
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Network size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>relations</span>
          <span className="font-mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
            {edges.length}
          </span>
        </div>
        {edges.length === 0 ? (
          <div className="muted" style={{ padding: "14px 16px", fontSize: 12 }}>
            No relation-typed fields detected. Add a field with type{" "}
            <span className="font-mono">relation</span> to draw an edge.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 200 }}>from</th>
                <th style={{ width: 40 }} />
                <th style={{ width: 200 }}>to</th>
                <th style={{ width: 80 }}>kind</th>
                <th>field</th>
                <th style={{ width: 110 }}>expansion</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((e, i) => (
                <tr key={`${e.from}->${e.to}:${i}`}>
                  <td className="font-mono">c_{e.from}</td>
                  <td><I.ChevronRight size={12} className="muted" /></td>
                  <td className="font-mono">c_{e.to}</td>
                  <td>
                    <Badge variant={e.kind === "m2m" ? "secondary" : "outline"}>{e.kind}</Badge>
                  </td>
                  <td className="font-mono" style={{ color: "var(--muted-foreground)" }}>
                    {e.label}
                  </td>
                  <td className="font-mono" style={{ color: "var(--muted-foreground)", fontSize: 11.5 }}>
                    fields=*,{e.to.replace(/s$/, "")}.*
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
