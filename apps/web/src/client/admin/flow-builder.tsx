// Flow builder — detailed editor opened from Flows page
import { useEffect, useRef, useState } from "react";
import { I, type IconComponent, type IconKey } from "./icons";
import { Badge, Button, IconButton, Switch } from "./ui";
import { Select } from "./select";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { emailTemplatesApi, functionsApi, collectionsApi, type ApiEmailTemplate, type ApiFunction, type ApiCollection } from "./api";

// `pending` marks steps the runtime doesn't execute yet. The compiler will
// drop them with a warning, so the palette disables the entries entirely
// until the matching backend phase lands (see flow-graph.ts PHASE_PENDING).
type TriggerDef = { id: string; label: string; desc: string; icon: string; tag: string; pending?: string };
const TRIGGERS: TriggerDef[] = [
  { id: "item.created", label: "Item created", desc: "Fires when a row is inserted in a collection", icon: "Plus", tag: "event" },
  { id: "item.updated", label: "Item updated", desc: "Fires when a row is updated", icon: "Pencil", tag: "event" },
  { id: "item.deleted", label: "Item deleted", desc: "Fires when a row is deleted", icon: "Trash", tag: "event" },
  { id: "cron", label: "Schedule (cron)", desc: "Run on a recurring schedule", icon: "Clock", tag: "cron" },
  { id: "webhook", label: "Incoming webhook", desc: "POST /api/webhook/:flowId fires this flow", icon: "Webhook", tag: "http" },
  { id: "auth.signup", label: "User signed up", desc: "Fires after sign-up succeeds", icon: "Users", tag: "auth" },
];
const ACTIONS = [
  { id: "email", label: "Send email", desc: "Templated mail via Resend / console", icon: "Mail" },
  { id: "webhook", label: "Webhook (POST)", desc: "Forward the event to a URL", icon: "Webhook" },
  { id: "request", label: "HTTP request", desc: "GET/POST/PUT — read response into $last", icon: "Globe" },
  { id: "log", label: "Log", desc: "Write a line to the server log", icon: "Function" },
  { id: "notification", label: "In-app notification", desc: "Drop a row in the notifications table", icon: "Bell" },
  { id: "transform", label: "Transform", desc: "Compute a value and pipe it into $last", icon: "Function" },
  { id: "run-script", label: "Run script", desc: "Sandboxed JS — full ctx, `data`, `last`", icon: "Code" },
  { id: "fn", label: "Run function", desc: "Invoke a saved workeros function", icon: "Function" },
  { id: "item.create", label: "Create item", desc: "Insert into a collection", icon: "Plus" },
  { id: "item.update", label: "Update item", desc: "Patch an existing row", icon: "Pencil" },
  { id: "slack", label: "Slack message", desc: "Post to a channel", icon: "Webhook", pending: "phase 2" },
  { id: "delay", label: "Delay", desc: "Wait inline (≤ 30s) or persist to scheduler", icon: "Clock" },
];
const CONTROLS = [
  { id: "if", label: "If / else", desc: "Branch on a filter DSL", icon: "Filter" },
  { id: "foreach", label: "For each", desc: "Iterate over an array", icon: "Braces", pending: "future" },
  { id: "try", label: "Try / catch", desc: "Recover from failures", icon: "Shield", pending: "future" },
];

// New-flow seed: just a trigger node. The user adds steps via the +
// affordance on the trigger's outgoing port. Avoid mock action nodes —
// they confuse the save validator and the compile path.
const STARTER_NODES = [
  { id: "n1", kind: "trigger", type: "item.updated", x: 60, y: 160, config: { collection: "posts", when: "" } },
];
const STARTER_EDGES: any[] = [];

function nodeMeta(n: any) {
  if (n.kind === "trigger") return TRIGGERS.find((t) => t.id === n.type);
  if (n.kind === "action") return ACTIONS.find((a) => a.id === n.type);
  if (n.kind === "control") return CONTROLS.find((c) => c.id === n.type);
  return null;
}

export interface FlowBuilderProps {
  initial?: any;
  onClose: () => void;
  onSave: (data: any) => void;
  pushToast: (msg: string) => void;
}

export function FlowBuilder({ initial, onClose, onSave, pushToast }: FlowBuilderProps) {
  const [name, setName] = useState(initial?.name || "New flow");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [nodes, setNodes] = useState<any[]>(initial?.nodes || STARTER_NODES);
  const [edges, setEdges] = useState<any[]>(initial?.edges || STARTER_EDGES);
  const [selectedId, setSelectedId] = useState<string | null>("n1");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteFor, setPaletteFor] = useState<{ from: string; branch: string | null } | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  // Live email-template catalog. The inspector picks templateKey from this so
  // the same key the flow runtime resolves at execution is what the admin saw.
  const [emailTemplates, setEmailTemplates] = useState<ApiEmailTemplate[]>([]);
  const [fns, setFns] = useState<ApiFunction[]>([]);
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [tpls, funcs, cols] = await Promise.all([
          emailTemplatesApi.list().catch(() => ({ data: [] as ApiEmailTemplate[] })),
          functionsApi.list().catch(() => ({ data: [] as ApiFunction[] })),
          collectionsApi.list().catch(() => ({ data: [] as ApiCollection[] })),
        ]);
        if (cancelled) return;
        if (Array.isArray(tpls.data)) setEmailTemplates(tpls.data);
        if (Array.isArray(funcs.data)) setFns(funcs.data);
        if (Array.isArray(cols.data)) setCollections(cols.data);
      } catch {
        // keep empty — UI falls back to "no items" hints
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Make the browser back button close the builder. We push a sentinel
  // history entry on mount so a `popstate` event always fires for back —
  // the SPA URL stays where it was. On programmatic close (Save / Cancel)
  // we pop the sentinel ourselves so the back stack stays clean and the
  // address bar's back button doesn't end up needing two presses.
  useEffect(() => {
    const sentinel = { __workerosFlowBuilder: true };
    history.pushState(sentinel, "", location.pathname + location.search);
    let popped = false;
    const onPop = () => { popped = true; onClose(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!popped) {
        // Programmatic close — drop the sentinel we pushed.
        history.back();
      }
    };
  }, [onClose]);

  const selected = nodes.find((n) => n.id === selectedId);

  const selectNode = (id: string) => setSelectedId(id);

  const addNodeFromPalette = (cat: any) => {
    if (!paletteFor) return;
    const fromNode = nodes.find((n) => n.id === paletteFor.from);
    const newId = "n" + Math.random().toString(36).slice(2, 7);
    const newNode = {
      id: newId,
      kind: cat.kind,
      type: cat.id,
      x: (fromNode?.x ?? 200) + 260,
      y: (fromNode?.y ?? 200) + (paletteFor.branch === "false" ? 80 : 0),
      config: defaultConfigFor(cat.kind, cat.id),
    };
    setNodes((arr) => [...arr, newNode]);
    setEdges((arr) => [...arr, { from: paletteFor.from, to: newId, branch: paletteFor.branch }]);
    setSelectedId(newId);
    setPaletteOpen(false);
    setPaletteFor(null);
  };

  const removeNode = (id: string) => {
    if (nodes.find((n) => n.id === id)?.kind === "trigger") { pushToast("Cannot delete the trigger."); return; }
    setNodes((arr) => arr.filter((n) => n.id !== id));
    setEdges((arr) => arr.filter((e) => e.from !== id && e.to !== id));
    if (selectedId === id) setSelectedId("n1");
  };

  const updateNode = (id: string, patch: any) => {
    setNodes((arr) => arr.map((n) => n.id === id ? { ...n, ...patch, config: { ...n.config, ...(patch.config || {}) } } : n));
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (e.clientX - rect.left - pan.x) / zoom - drag.dx;
      const y = (e.clientY - rect.top - pan.y) / zoom - drag.dy;
      updateNode(drag.id, { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 });
    };
    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [drag, zoom, pan]);

  const onNodeMouseDown = (e: any, n: any) => {
    if (e.target.closest(".fb-port") || e.target.closest(".fb-node-actions")) return;
    e.stopPropagation();
    selectNode(n.id);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = (e.clientX - rect.left - pan.x) / zoom;
    const py = (e.clientY - rect.top - pan.y) / zoom;
    setDrag({ id: n.id, dx: px - n.x, dy: py - n.y });
  };

  return (
    <div className="fb-overlay">
      <div className="fb-shell">
        <div className="fb-header">
          <IconButton icon={I.ChevronLeft} onClick={onClose} title="Back" />
          <div className="fb-title">
            <input className="fb-name" value={name} onChange={(e) => setName(e.target.value)} />
            <span className="font-mono muted" style={{ fontSize: 11.5 }}>flow_{(initial?.id || "draft").slice(-6)}</span>
          </div>
          <Badge variant={enabled ? "default" : "secondary"}>{enabled ? "enabled" : "draft"}</Badge>
          <div className="spacer" />
          <Button variant="outline" size="sm" icon={I.Code}>JSON</Button>
          <Button variant="outline" size="sm" icon={I.Zap} onClick={() => setTestOpen(true)}>Test run</Button>
          <Switch checked={enabled} onChange={setEnabled} />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          {(() => {
            // Don't disable the native button — leave it clickable so the
            // user gets a toast explaining *why* it's a no-op. (A disabled
            // button with no feedback was the original UX bug.)
            const isEmpty = nodes.filter((n) => n.kind !== "trigger").length === 0;
            return (
              <Button
                variant="primary"
                size="sm"
                icon={I.Check}
                style={isEmpty ? { opacity: 0.5 } : undefined}
                title={isEmpty ? "Add at least one step before saving" : undefined}
                onClick={() => {
                  if (isEmpty) {
                    pushToast("Add at least one step before saving");
                    return;
                  }
                  onSave({ id: initial?.id, name, enabled, nodes, edges });
                }}
              >Save flow</Button>
            );
          })()}
        </div>

        <div className="fb-body">
          <div className="fb-rail">
            <div className="fb-rail-section">
              <div className="fb-rail-h">Steps</div>
              <div className="fb-rail-list">
                {nodes.map((n, i) => {
                  const m = nodeMeta(n);
                  const Icon = (I as Record<string, IconComponent>)[m?.icon as IconKey] || I.Function;
                  return (
                    <div key={n.id} className="fb-rail-item" data-active={selectedId === n.id} onClick={() => selectNode(n.id)}>
                      <span className={`fb-kind fb-kind-${n.kind}`}><Icon size={11} /></span>
                      <span className="fb-rail-num tabular-nums">{i + 1}</span>
                      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 500 }}>{m?.label || n.type}</span>
                        <span className="font-mono muted" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {n.kind === "trigger" ? n.config?.collection : n.kind === "control" ? n.config?.test : n.config?.fn || n.config?.to || n.config?.url || "—"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="fb-rail-section">
              <div className="fb-rail-h">Variables</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 6px" }}>
                {[
                  ["{{ event.type }}", "string"],
                  ["{{ event.data }}", "json"],
                  ["{{ item }}", "object"],
                  ["{{ item.author.email }}", "string"],
                  ["{{ $user.id }}", "uuid"],
                  ["{{ $now }}", "iso8601"],
                  ["{{ steps.if.result }}", "boolean"],
                ].map(([k, t]) => (
                  <div key={k} className="fb-var">
                    <span className="font-mono" style={{ fontSize: 11.5 }}>{k}</span>
                    <span className="muted font-mono" style={{ fontSize: 10.5 }}>{t}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="fb-canvas-wrap">
            <div className="fb-canvas-toolbar">
              <Button variant="ghost" size="sm" icon={I.Plus} onClick={() => { setPaletteFor({ from: nodes[nodes.length - 1].id, branch: null }); setPaletteOpen(true); }}>Add step</Button>
              <span className="muted" style={{ fontSize: 12 }}>·</span>
              <span className="muted tabular-nums" style={{ fontSize: 12 }}>{nodes.length} steps · {edges.length} edges</span>
              <div className="spacer" />
              <button className="fb-zoom-btn" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}><I.Minus size={12} /></button>
              <span className="font-mono tabular-nums" style={{ fontSize: 11.5, minWidth: 36, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
              <button className="fb-zoom-btn" onClick={() => setZoom((z) => Math.min(2, z + 0.1))}><I.Plus size={12} /></button>
              <button className="fb-zoom-btn" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="Reset view"><I.Refresh size={12} /></button>
            </div>
            <div className="fb-canvas" ref={canvasRef} onClick={() => setSelectedId(null)}>
              <div className="fb-grid" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
                <svg className="fb-edges" width="2400" height="1600" style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}>
                  {edges.map((e, i) => {
                    const a = nodes.find((n) => n.id === e.from);
                    const b = nodes.find((n) => n.id === e.to);
                    if (!a || !b) return null;
                    const x1 = a.x + 200, y1 = a.y + 38;
                    const x2 = b.x, y2 = b.y + 38;
                    const cx = (x1 + x2) / 2;
                    const color = e.branch === "true" ? "oklch(0.65 0.18 145)" : e.branch === "false" ? "oklch(0.7 0.18 22)" : "var(--muted-foreground)";
                    return (
                      <g key={i}>
                        <path d={`M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`} fill="none" stroke={color} strokeWidth="1.6" strokeOpacity="0.9" />
                        <circle cx={x2} cy={y2} r="3" fill={color} />
                        {e.branch && <text x={cx} y={(y1 + y2) / 2 - 4} fill={color} fontSize="10" fontFamily="Geist Mono" textAnchor="middle">{e.branch}</text>}
                      </g>
                    );
                  })}
                </svg>
                {nodes.map((n) => {
                  const m = nodeMeta(n);
                  const Icon = (I as Record<string, IconComponent>)[m?.icon as IconKey] || I.Function;
                  const sel = selectedId === n.id;
                  return (
                    <div key={n.id}
                         className={`fb-node fb-node-${n.kind}`}
                         data-selected={sel}
                         style={{ left: n.x, top: n.y }}
                         onMouseDown={(e) => onNodeMouseDown(e, n)}
                         onClick={(e) => { e.stopPropagation(); selectNode(n.id); }}>
                      <div className="fb-node-head">
                        <span className={`fb-kind fb-kind-${n.kind}`}><Icon size={11} /></span>
                        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, color: "var(--muted-foreground)" }}>{n.kind}</span>
                        <span style={{ fontSize: 12.5, fontWeight: 500, marginLeft: "auto" }}>{m?.label}</span>
                      </div>
                      <div className="fb-node-body">
                        {n.kind === "trigger" && (
                          <>
                            <span className="muted">on</span> <span className="font-mono">{n.config.collection || "posts"}</span>
                            {n.config.when && <div className="fb-mono-dim">{n.config.when}</div>}
                          </>
                        )}
                        {n.kind === "control" && n.type === "if" && (
                          <span className="font-mono">{n.config.test}</span>
                        )}
                        {n.kind === "action" && n.type === "fn" && (
                          <><span className="muted">fn:</span> <span className="font-mono">{n.config.fn}</span>{n.config.async && <span className="muted"> · async</span>}</>
                        )}
                        {n.kind === "action" && n.type === "email" && (
                          <>
                            <span className="muted">to</span> <span className="font-mono">{n.config.to}</span>
                            {n.config.templateKey && <span className="muted"> · tpl <span className="font-mono">{n.config.templateKey}</span></span>}
                          </>
                        )}
                        {n.kind === "action" && n.type === "webhook" && (
                          <><span className="muted">POST</span> <span className="font-mono">{n.config.url || "https://…"}</span></>
                        )}
                        {n.kind === "action" && n.type === "delay" && (
                          <span className="font-mono">{n.config.duration || "5m"}</span>
                        )}
                      </div>
                      {n.kind === "control" && n.type === "if" ? (
                        <>
                          <button className="fb-port fb-port-true" title="Add to true branch" onClick={(e) => { e.stopPropagation(); setPaletteFor({ from: n.id, branch: "true" }); setPaletteOpen(true); }}>+</button>
                          <button className="fb-port fb-port-false" title="Add to false branch" onClick={(e) => { e.stopPropagation(); setPaletteFor({ from: n.id, branch: "false" }); setPaletteOpen(true); }}>+</button>
                        </>
                      ) : (
                        <button className="fb-port fb-port-out" title="Add next step" onClick={(e) => { e.stopPropagation(); setPaletteFor({ from: n.id, branch: null }); setPaletteOpen(true); }}>+</button>
                      )}
                      {sel && n.kind !== "trigger" && (
                        <div className="fb-node-actions">
                          <button onClick={(e) => { e.stopPropagation(); removeNode(n.id); }} title="Delete"><I.Trash size={11} /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <FlowInspector
            node={selected}
            onChange={(patch: any) => selected && updateNode(selected.id, patch)}
            emailTemplates={emailTemplates}
            fns={fns}
            collections={collections}
          />
        </div>
      </div>

      {paletteOpen && <NodePalette onSelect={addNodeFromPalette} onClose={() => { setPaletteOpen(false); setPaletteFor(null); }} branch={paletteFor?.branch} />}
      {testOpen && <TestRunPanel name={name} nodes={nodes} edges={edges} onClose={() => setTestOpen(false)} />}
    </div>
  );
}

function defaultConfigFor(kind: string, type: string) {
  if (kind === "trigger") return { collection: "posts", when: "" };
  if (kind === "control" && type === "if") return { test: 'status _eq "published"' };
  if (kind === "action" && type === "email") return { to: "{{ data.author.email }}", templateKey: "", subject: "", text: "" };
  if (kind === "action" && type === "webhook") return { url: "https://api.example.com/hook", method: "POST", body: "" };
  if (kind === "action" && type === "request") return { url: "https://api.example.com/data", method: "GET", body: "" };
  if (kind === "action" && type === "log") return { message: "{{ data }}" };
  if (kind === "action" && type === "notification") return { title: "New event", body: "", url: "", userId: null };
  if (kind === "action" && type === "transform") return { value: "" };
  if (kind === "action" && type === "run-script") return { code: "// data, last, ctx, auth available\nreturn data;", timeoutMs: 5000 };
  if (kind === "action" && type === "fn") return { fn: "", async: true, retries: 3 };
  if (kind === "action" && type === "delay") return { duration: "5m" };
  if (kind === "action" && type === "item.create") return { collection: "", data: "{{ data }}" };
  if (kind === "action" && type === "item.update") return { collection: "", id: "{{ data.id }}", data: "{{ data }}" };
  if (kind === "action" && type === "slack") return { channel: "#general", text: "New event" };
  return {};
}

function FlowInspector({ node, onChange, emailTemplates = [], fns = [], collections = [] }: { node?: any; onChange: (patch: any) => void; emailTemplates?: ApiEmailTemplate[]; fns?: ApiFunction[]; collections?: ApiCollection[] }) {
  if (!node) return (
    <div className="fb-inspector">
      <div className="fb-inspector-empty">
        <I.Bolt size={20} />
        <div style={{ fontSize: 13, fontWeight: 500, marginTop: 8 }}>Nothing selected</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4, textAlign: "center", maxWidth: 220 }}>Click any step to edit its configuration. Drag to rearrange. Click <span className="font-mono">+</span> on a step to add the next.</div>
      </div>
    </div>
  );
  const m = nodeMeta(node);
  const Icon = (I as Record<string, IconComponent>)[m?.icon as IconKey] || I.Function;
  return (
    <div className="fb-inspector">
      <div className="fb-inspector-head">
        <span className={`fb-kind fb-kind-${node.kind}`}><Icon size={11} /></span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{m?.label}</span>
          <span className="font-mono muted" style={{ fontSize: 11 }}>{node.kind} · {node.id}</span>
        </div>
      </div>
      <div className="fb-inspector-body">
        {node.kind === "trigger" && (
          <>
            <div className="field">
              <label className="field-label">Event</label>
              <Select value={node.type} onChange={(v) => onChange({ type: v })} options={TRIGGERS.map((t) => ({ value: t.id, label: t.pending ? `${t.label} (${t.pending})` : t.label }))} />
            </div>
            {node.type.startsWith("item.") && (
              <div className="field">
                <label className="field-label">Collection</label>
                <Select value={node.config.collection} onChange={(v) => onChange({ config: { collection: v } })} options={["posts", "comments", "authors", "tags", { value: "*", label: "* (all collections)" }]} />
              </div>
            )}
            {node.type === "cron" && (
              <div className="field">
                <label className="field-label">Schedule</label>
                <Input value={node.config.cron || "0 9 * * *"} onChange={(e) => onChange({ config: { cron: e.target.value } })} placeholder="0 9 * * *" />
                <span className="field-hint font-mono">runs daily at 09:00 UTC</span>
              </div>
            )}
            {node.type.startsWith("item.") && (
              <div className="field">
                <label className="field-label">When (filter DSL)</label>
                <Textarea rows={3} value={node.config.when} onChange={(e) => onChange({ config: { when: e.target.value } })} placeholder='{ "status": { "_eq": "published" } }' />
                <span className="field-hint">Trigger only fires when the row matches this filter (after the change).</span>
              </div>
            )}
          </>
        )}
        {node.kind === "control" && node.type === "if" && (
          <>
            <div className="field">
              <label className="field-label">Test</label>
              <Textarea rows={3} value={node.config.test} onChange={(e) => onChange({ config: { test: e.target.value } })} />
              <span className="field-hint">Evaluates against current step context. Use <span className="font-mono">{"{{ var }}"}</span> for interpolation.</span>
            </div>
            <div className="alter-preview" style={{ fontSize: 11 }}>
              <span className="kw">if</span> ({node.config.test}) {"{ → true }"} <br /> <span className="kw">else</span> {"{ → false }"}
            </div>
          </>
        )}
        {node.kind === "action" && node.type === "email" && (
          <>
            <div className="field"><label className="field-label">To</label><Input value={node.config.to} onChange={(e) => onChange({ config: { to: e.target.value } })} placeholder="{{ data.author.email }}" /></div>
            <div className="field">
              <label className="field-label">Template</label>
              <Select
                value={node.config.templateKey || ""}
                onChange={(v) => onChange({ config: { templateKey: v } })}
                options={[
                  { value: "", label: emailTemplates.length === 0 ? "(none — no templates yet)" : "(none — use literal subject/body)" },
                  ...emailTemplates.map((t) => ({ value: t.key, label: `${t.name} · ${t.key}` })),
                ]}
              />
              <span className="field-hint">When set, body is rendered from the stored template at run time. Otherwise the literal Subject + Body fields below are used.</span>
            </div>
            {!node.config.templateKey && (
              <>
                <div className="field"><label className="field-label">Subject</label><Input value={node.config.subject || ""} onChange={(e) => onChange({ config: { subject: e.target.value } })} /></div>
                <div className="field"><label className="field-label">Body (text)</label><Textarea rows={4} value={node.config.text || ""} onChange={(e) => onChange({ config: { text: e.target.value } })} placeholder="Hi {{ data.author.name }}, …" /></div>
              </>
            )}
          </>
        )}
        {node.kind === "action" && node.type === "fn" && (
          <>
            <div className="field">
              <label className="field-label">Function</label>
              <Select
                value={node.config.fn || ""}
                onChange={(v) => onChange({ config: { fn: v } })}
                options={[
                  { value: "", label: fns.length === 0 ? "(none — no functions yet)" : "Select a function…" },
                  ...fns.map((f) => ({ value: f.name, label: `${f.name}${f.active ? "" : " (inactive)"}` })),
                ]}
              />
              <span className="field-hint">Tenant-scoped lookup at run time. Inactive functions throw at execution.</span>
            </div>
            <div className="field">
              <label className="field-label">Input</label>
              <Textarea className="font-mono" rows={3} value={node.config.input || ""} onChange={(e) => onChange({ config: { input: e.target.value } })} placeholder="leave empty to pass the trigger payload" />
              <span className="field-hint">JSON or template string. Becomes <span className="font-mono">data</span> inside the function.</span>
            </div>
          </>
        )}
        {node.kind === "action" && (node.type === "webhook" || node.type === "request") && (
          <>
            <div className="field">
              <label className="field-label">Method</label>
              <Select
                value={node.config.method || (node.type === "request" ? "GET" : "POST")}
                onChange={(v) => onChange({ config: { method: v } })}
                options={["GET", "POST", "PUT", "PATCH", "DELETE"]}
              />
            </div>
            <div className="field"><label className="field-label">URL</label><Input value={node.config.url} onChange={(e) => onChange({ config: { url: e.target.value } })} /></div>
            <div className="field"><label className="field-label">Body</label><Textarea className="font-mono" rows={3} value={node.config.body || ""} onChange={(e) => onChange({ config: { body: e.target.value } })} placeholder='{ "key": "{{ data.title }}" }' /><span className="field-hint">JSON or template string. Webhook defaults to the event payload when empty.</span></div>
          </>
        )}
        {node.kind === "action" && node.type === "log" && (
          <div className="field"><label className="field-label">Message</label><Input value={node.config.message || ""} onChange={(e) => onChange({ config: { message: e.target.value } })} /><span className="field-hint">Server log line. Use <span className="font-mono">{"{{ data.* }}"}</span> for interpolation.</span></div>
        )}
        {node.kind === "action" && node.type === "notification" && (
          <>
            <div className="field"><label className="field-label">Title</label><Input value={node.config.title || ""} onChange={(e) => onChange({ config: { title: e.target.value } })} /></div>
            <div className="field"><label className="field-label">Body</label><Textarea rows={2} value={node.config.body || ""} onChange={(e) => onChange({ config: { body: e.target.value } })} /></div>
            <div className="field"><label className="field-label">URL</label><Input value={node.config.url || ""} onChange={(e) => onChange({ config: { url: e.target.value } })} placeholder="/posts/{{ data.id }}" /></div>
            <div className="field"><label className="field-label">Recipient (userId)</label><Input value={node.config.userId ?? ""} onChange={(e) => onChange({ config: { userId: e.target.value || null } })} placeholder="leave empty for admins" /></div>
          </>
        )}
        {node.kind === "action" && node.type === "transform" && (
          <div className="field"><label className="field-label">Value</label><Textarea className="font-mono" rows={3} value={node.config.value || ""} onChange={(e) => onChange({ config: { value: e.target.value } })} placeholder="{{ data.title }}" /><span className="field-hint">Result is piped into <span className="font-mono">$last</span> for the next step.</span></div>
        )}
        {node.kind === "action" && node.type === "run-script" && (
          <>
            <div className="field"><label className="field-label">Code</label><Textarea className="font-mono" rows={6} value={node.config.code || ""} onChange={(e) => onChange({ config: { code: e.target.value } })} /><span className="field-hint">Sandboxed JS. Returns into <span className="font-mono">$last</span>.</span></div>
            <div className="field"><label className="field-label">Timeout (ms)</label><Input type="number" value={node.config.timeoutMs ?? 5000} onChange={(e) => onChange({ config: { timeoutMs: Number(e.target.value) || 5000 } })} /></div>
          </>
        )}
        {node.kind === "action" && (node.type === "item.create" || node.type === "item.update") && (
          <>
            <div className="field">
              <label className="field-label">Collection</label>
              <Select
                value={node.config.collection || ""}
                onChange={(v) => onChange({ config: { collection: v } })}
                options={[
                  { value: "", label: collections.length === 0 ? "(none — no collections)" : "Select a collection…" },
                  ...collections.map((c) => ({ value: c.slug, label: c.slug })),
                ]}
              />
            </div>
            {node.type === "item.update" && (
              <div className="field"><label className="field-label">Row id</label><Input value={node.config.id || ""} onChange={(e) => onChange({ config: { id: e.target.value } })} placeholder="{{ data.id }}" /></div>
            )}
            <div className="field">
              <label className="field-label">Data</label>
              <Textarea className="font-mono" rows={5} value={node.config.data || ""} onChange={(e) => onChange({ config: { data: e.target.value } })} placeholder='{ "title": "{{ data.title }}" }' />
              <span className="field-hint">JSON object — template strings are interpolated before insert/update.</span>
            </div>
          </>
        )}
        {node.kind === "action" && node.type === "delay" && (
          <div className="field">
            <label className="field-label">Duration</label>
            <Input value={node.config.duration || ""} onChange={(e) => onChange({ config: { duration: e.target.value } })} placeholder="5m" />
            <span className="field-hint">e.g. 30s, 5m, 1h, 2d. ≤ 30s sleeps inline; longer waits persist to the scheduler.</span>
          </div>
        )}

        <div className="fb-section-divider"><span>Error handling</span></div>
        <div className="field-row">
          <div><div className="field-label">On error</div></div>
          <Select value={node.config.onError || "retry"} onChange={(v) => onChange({ config: { onError: v } })} options={[{ value: "retry", label: "Retry" }, { value: "continue", label: "Continue" }, { value: "fail", label: "Fail flow" }]} style={{ maxWidth: 130 }} />
        </div>
      </div>
    </div>
  );
}

function NodePalette({ onSelect, onClose, branch }: { onSelect: (cat: any) => void; onClose: () => void; branch?: string | null }) {
  const [q, setQ] = useState("");
  const list = [
    ...ACTIONS.map((a) => ({ ...a, kind: "action" })),
    ...CONTROLS.map((c) => ({ ...c, kind: "control" })),
  ].filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="fb-palette-overlay" onClick={onClose}>
      <div className="fb-palette" onClick={(e) => e.stopPropagation()}>
        <div className="fb-palette-head">
          <I.Search size={13} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search steps…" />
          {branch && <Badge variant="outline">{branch} branch</Badge>}
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>
        <div className="fb-palette-grid">
          {list.map((x) => {
            const Icon = (I as Record<string, IconComponent>)[x.icon as IconKey] || I.Function;
            const pending = (x as any).pending as string | undefined;
            return (
              <button
                key={x.id + x.kind}
                className="fb-palette-item"
                disabled={!!pending}
                onClick={() => { if (!pending) onSelect(x); }}
                style={pending ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                title={pending ? `Lands in ${pending}` : undefined}
              >
                <span className={`fb-kind fb-kind-${x.kind}`}><Icon size={13} /></span>
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{x.label}</span>
                  <span className="muted" style={{ fontSize: 11.5 }}>{x.desc}</span>
                </div>
                {pending ? <Badge variant="outline">{pending}</Badge> : <span className="muted font-mono" style={{ fontSize: 10.5 }}>{x.kind}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TestRunPanel({ name, nodes, edges: _edges, onClose }: { name: string; nodes: any[]; edges: any[]; onClose: () => void }) {
  const [payload, setPayload] = useState(`{
  "type": "items.posts.updated",
  "data": {
    "id": "01HZ7K8Q6XYZ",
    "title": "Drizzle 1.0 in production",
    "status": "published",
    "tags": ["release", "drizzle"],
    "author": { "email": "rana@workeros.dev" }
  }
}`);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<any[]>([]);

  const run = () => {
    setRunning(true);
    setSteps([]);
    const order = nodes;
    let acc: any[] = [];
    order.forEach((n, i) => {
      const m = nodeMeta(n);
      const status = i === 2 && n.kind === "control" ? "true" : "ok";
      const ms = 12 + Math.floor(Math.random() * 90);
      setTimeout(() => {
        acc = [...acc, { id: n.id, label: m?.label || n.type, status, ms, t: "T+" + (i * 80) + "ms" }];
        setSteps([...acc]);
        if (i === order.length - 1) setRunning(false);
      }, 350 * (i + 1));
    });
  };

  return (
    <div className="fb-test-overlay" onClick={onClose}>
      <div className="fb-test" onClick={(e) => e.stopPropagation()}>
        <div className="fb-test-head">
          <I.Zap size={14} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Test run · {name}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>Dry run — no real side-effects</div>
          </div>
          <div className="spacer" />
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>
        <div className="fb-test-body">
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Sample event payload</div>
            <Textarea className="font-mono" rows={14} value={payload} onChange={(e) => setPayload(e.target.value)} style={{ fontSize: 11.5, lineHeight: 1.5 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <Button variant="primary" icon={I.Zap} onClick={run} disabled={running}>{running ? "Running…" : "Run"}</Button>
              <Button variant="ghost" onClick={() => setSteps([])}>Clear</Button>
            </div>
          </div>
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Step log</div>
            <div className="fb-test-steps">
              {steps.length === 0 && <div className="muted" style={{ padding: 16, fontSize: 12.5 }}>Click Run to simulate.</div>}
              {steps.map((s, i) => (
                <div key={i} className="fb-test-step" data-status={s.status}>
                  <span className="fb-test-num tabular-nums">{i + 1}</span>
                  <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>{s.label}</span>
                    <span className="font-mono muted" style={{ fontSize: 11 }}>{s.t} · {s.ms}ms</span>
                  </div>
                  <Badge variant={s.status === "ok" ? "default" : s.status === "true" ? "default" : "secondary"}>{s.status}</Badge>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
