// Webhooks page — outgoing HTTP on collection events + delivery log + editor
import { useEffect, useState } from "react";
import { I } from "../icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import { api } from "@/lib/api";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { fetchSafely } from "./_shared";

const WH_EVENTS = [
  "items.*.created", "items.*.updated", "items.*.deleted",
  "items.posts.created", "items.posts.updated", "items.posts.deleted",
  "items.comments.created", "items.comments.updated", "items.comments.deleted",
  "auth.login", "auth.logout", "auth.signup",
  "files.uploaded", "files.deleted",
];

/** `Header: value` lines ⇄ a `{ [name]: value }` map. Headers are optional —
 * an empty textarea means "no custom headers", so we send `null` rather than
 * an empty object the API would have to special-case. */
function parseHeaderLines(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (key) out[key] = line.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}
function formatHeaderLines(headers: Record<string, string> | null | undefined): string {
  return headers ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
}

export function WebhooksPage({ pushToast }: { pushToast: (m: string) => void }) {
  type HookRow = { id: string; name: string; url: string; events: string[]; method: string; secret: string; headers: Record<string, string> | null; active: boolean; deliveries: number; ok: boolean; successRate: number; lastDelivery: string };
  const [hooks, setHooks] = useState<HookRow[]>([]);
  const reloadHooks = async () => {
    const [r, m] = await Promise.all([
      fetchSafely<{ data: any[] }>("/api/webhooks"),
      fetchSafely<{ data: { webhooks: Record<string, { deliveries: number; lastDelivery: number | null }> } }>(`/api/admin/metrics/entities`),
    ]);
    const stats = m?.data?.webhooks ?? {};
    const fmtAgo = (ms: number | null): string => {
      if (!ms) return "—";
      const diff = Date.now() - ms;
      if (diff < 60_000) return "just now";
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      return `${Math.floor(diff / 86_400_000)}d ago`;
    };
    if (Array.isArray(r?.data)) {
      setHooks(
        r.data.map((h) => ({
          id: h.id,
          name: h.name,
          url: h.url,
          events: Array.isArray(h.events) ? h.events : [],
          method: "POST",
          secret: h.secret ?? "",
          headers: h.headers ?? null,
          active: !!h.active,
          deliveries: stats[h.id]?.deliveries ?? 0,
          ok: true,
          successRate: 100,
          lastDelivery: fmtAgo(stats[h.id]?.lastDelivery ?? null),
        })),
      );
    }
  };
  useEffect(() => { void reloadHooks(); }, []);
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; hook: any } | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  type DeliveryRow = { id: string; t: string; hook: string; ev: string; code: number; ms: number };
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const reloadDeliveries = async () => {
    try {
      const r = await api<{ data: any[] }>("/api/webhooks/_deliveries");
      if (Array.isArray(r.data)) {
        setDeliveries(
          r.data.map((d) => ({
            id: d.id,
            t: new Date(d.deliveredAt).toISOString().slice(11, 19),
            hook: d.webhookId,
            ev: d.event,
            code: d.status,
            ms: d.ms,
          })),
        );
      }
    } catch {
      // keep seed
    }
  };
  useEffect(() => { void reloadDeliveries(); }, []);

  const saveHook = async (data: any) => {
    try {
      const headers = parseHeaderLines(data.headers);
      if (editor!.mode === "create") {
        await api("/api/webhooks", {
          method: "POST",
          body: JSON.stringify({ name: data.name, url: data.url, events: data.events, secret: data.secret, active: data.active, headers }),
        });
        pushToast(`Webhook "${data.name}" created.`);
      } else {
        await api(`/api/webhooks/${editor!.hook.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: data.name, url: data.url, events: data.events, active: data.active, headers }),
        });
        pushToast(`Webhook "${data.name}" updated.`);
      }
      await reloadHooks();
    } catch (e) {
      pushToast((e as Error).message);
    }
    setEditor(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Webhooks"
        description="Outgoing HTTP on collection events. Failed deliveries retry with exponential backoff."
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setEditor({ mode: "create", hook: null })}>New webhook</Button>}
      />
      <div className="card">
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Events</th>
              <th style={{ textAlign: "right", width: 110 }}>Deliveries</th>
              <th style={{ width: 110 }}>Success</th>
              <th style={{ width: 100 }}>Status</th>
              <th className="col-actions" style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => {
              const isOpen = menuOpen === h.id;
              return (
                <tr key={h.id} className="users-row" onClick={() => setEditor({ mode: "edit", hook: h })}>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{h.name}</span>
                      <span className="muted font-mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>{h.method} · {h.url}</span>
                    </div>
                  </td>
                  <td><div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{h.events.map((e) => <Badge key={e} variant="outline" mono>{e}</Badge>)}</div></td>
                  <td className="tabular-nums" style={{ textAlign: "right" }}>{h.deliveries.toLocaleString()}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 48, height: 4, borderRadius: 999, background: "var(--muted)", overflow: "hidden" }}>
                        <div style={{ width: `${h.successRate}%`, height: "100%", background: h.successRate > 95 ? "oklch(0.78 0.15 145)" : h.successRate > 50 ? "oklch(0.78 0.15 80)" : "var(--destructive)" }} />
                      </div>
                      <span className="font-mono" style={{ fontSize: 11.5 }}>{h.successRate}%</span>
                    </div>
                  </td>
                  <td>
                    {!h.active ? <Badge variant="secondary">paused</Badge>
                      : h.ok ? <Badge variant="default">healthy</Badge>
                        : <Badge variant="destructive">failing</Badge>}
                  </td>
                  <td className="col-actions" style={{ textAlign: "right", position: "relative" }} onClick={(e) => e.stopPropagation()}>
                    <IconButton icon={I.More} onClick={(e: any) => { e.stopPropagation(); setMenuOpen(isOpen ? null : h.id); }} />
                    {isOpen && (
                      <div className="users-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setEditor({ mode: "edit", hook: h }); setMenuOpen(null); }}><I.Pencil size={12} />Edit</button>
                        <button onClick={async () => {
                          try {
                            await api(`/api/webhooks/${h.id}/test`, { method: "POST" });
                            pushToast(`Test event sent to ${h.name}.`);
                            await reloadDeliveries();
                          } catch (e) {
                            pushToast((e as Error).message);
                          }
                          setMenuOpen(null);
                        }}><I.Bolt size={12} />Send test</button>
                        <button onClick={async () => {
                          const next = !h.active;
                          try {
                            await api(`/api/webhooks/${h.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ active: next }),
                            });
                          } catch (e) {
                            pushToast((e as Error).message);
                          }
                          setHooks((arr) => arr.map((x) => x.id === h.id ? { ...x, active: next } : x));
                          setMenuOpen(null);
                          pushToast(`${h.name} ${next ? "resumed" : "paused"}.`);
                        }}>
                          {h.active ? <><I.Lock size={12} />Pause</> : <><I.Play size={12} />Resume</>}
                        </button>
                        <div className="users-menu-sep" />
                        <button className="danger" onClick={async () => {
                          try { await api(`/api/webhooks/${h.id}`, { method: "DELETE" }); } catch (e) { pushToast((e as Error).message); }
                          setHooks((arr) => arr.filter((x) => x.id !== h.id));
                          setMenuOpen(null);
                          pushToast(`${h.name} deleted.`);
                        }}><I.Trash size={12} />Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {hooks.length === 0 && (
              <tr><td colSpan={6}>
                <div className="empty" style={{ padding: "32px 0" }}>
                  <I.Webhook size={20} />
                  <h4>No webhooks yet</h4>
                  <p>Pipe collection events to Slack, your API, or any HTTPS endpoint.</p>
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Activity size={14} /><span style={{ fontSize: 13, fontWeight: 500 }}>Recent deliveries</span>
          <div className="spacer" />
          <Button variant="ghost" size="sm" icon={I.Refresh} onClick={() => pushToast("Refreshed.")}>Refresh</Button>
        </div>
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th style={{ width: 100 }}>Time</th><th style={{ width: 80 }}>Hook</th><th>Event</th><th style={{ width: 90, textAlign: "right" }}>Status</th><th style={{ width: 80, textAlign: "right" }}>ms</th><th className="col-actions" style={{ width: 60 }}></th></tr></thead>
          <tbody>
            {deliveries.map((d, i) => (
              <tr key={i}>
                <td className="font-mono muted tabular-nums" style={{ fontSize: 11.5 }}>{d.t}</td>
                <td className="font-mono" style={{ fontSize: 12 }}>{d.hook}</td>
                <td className="font-mono" style={{ fontSize: 12 }}>{d.ev}</td>
                <td className="tabular-nums" style={{ textAlign: "right" }}><Badge variant={d.code < 300 ? "default" : "destructive"}>{d.code}</Badge></td>
                <td className="tabular-nums muted" style={{ textAlign: "right" }}>{d.ms}</td>
                <td className="col-actions" style={{ textAlign: "right" }}>
                  <Button variant="ghost" size="sm" onClick={async () => {
                    try {
                      await api(`/api/webhooks/_deliveries/${d.id}/retry`, { method: "POST" });
                      pushToast("Redelivered.");
                      await reloadDeliveries();
                    } catch (e) {
                      pushToast((e as Error).message);
                    }
                  }}>Retry</Button>
                </td>
              </tr>
            ))}
            {deliveries.length === 0 && (
              <tr><td colSpan={6}>
                <div className="empty" style={{ padding: "32px 0" }}>
                  <I.Activity size={20} />
                  <h4>No deliveries yet</h4>
                  <p>Outgoing webhook deliveries will show up here once a collection event fires.</p>
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {editor && <WebhookEditorDialog mode={editor.mode} hook={editor.hook} onClose={() => setEditor(null)} onSave={saveHook} pushToast={pushToast} />}
    </div>
  );
}

function WebhookEditorDialog({ mode, hook, onClose, onSave, pushToast }: { mode: "create" | "edit"; hook: any; onClose: () => void; onSave: (data: any) => void; pushToast: (m: string) => void }) {
  const blank = { name: "", url: "", method: "POST", events: [], secret: "whsec_" + Math.random().toString(16).slice(2, 14), active: true, headers: "" };
  const [draft, setDraft] = useState<any>(hook ? { ...hook, headers: formatHeaderLines(hook.headers) } : blank);
  const [revealSecret, setRevealSecret] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const update = (k: string, v: unknown) => { setDraft((d: any) => ({ ...d, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };

  const toggleEvent = (ev: string) => {
    setDraft((d: any) => ({ ...d, events: d.events.includes(ev) ? d.events.filter((x: string) => x !== ev) : [...d.events, ev] }));
  };

  const submit = () => {
    const e: Record<string, string> = {};
    if (!String(draft.name || "").trim()) e.name = "name is required";
    if (!String(draft.url || "").trim()) e.url = "url is required";
    else if (!/^https?:\/\//.test(draft.url)) e.url = "must start with http:// or https://";
    if (!draft.events.length) e.events = "pick at least one event";
    setErrors(e);
    if (Object.keys(e).length) return;
    onSave(draft);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-lg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: "92vw" }}>
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10 }}>
            <I.Webhook size={16} />
            <div>
              <h2>{mode === "create" ? "New webhook" : "Edit webhook"}</h2>
              <p>{mode === "create" ? "POST to any HTTPS endpoint when collection events fire." : <>id <span className="font-mono">{hook?.id}</span></>}</p>
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="dialog-body">
          <div className="field">
            <label className="field-label">Name <span style={{ color: "var(--destructive)" }}>*</span></label>
            <Input aria-invalid={!!errors.name} autoFocus value={draft.name} onChange={(e) => update("name", e.target.value)} placeholder="Slack #content" />
            {errors.name && <div className="field-error"><I.AlertTriangle size={11} />{errors.name}</div>}
          </div>

          <div className="field">
            <label className="field-label">Endpoint URL <span style={{ color: "var(--destructive)" }}>*</span></label>
            <div style={{ display: "flex", gap: 8 }}>
              <Select size="sm" value={draft.method} onChange={(v) => update("method", v)} style={{ width: 100, height: 36 }} options={["POST", "PUT", "PATCH"]} />
              <Input className="font-mono" aria-invalid={!!errors.url} style={{ flex: 1, fontSize: 12.5 }} value={draft.url} onChange={(e) => update("url", e.target.value)} placeholder="https://api.example.com/webhooks/workeros" />
            </div>
            {errors.url ? <div className="field-error"><I.AlertTriangle size={11} />{errors.url}</div> : <span className="field-hint">Must accept the chosen HTTP method and respond with 2xx within 10s.</span>}
          </div>

          <div className="field">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label className="field-label">Events <span style={{ color: "var(--destructive)" }}>*</span></label>
              <span className="muted" style={{ fontSize: 11.5 }}>{draft.events.length} selected</span>
            </div>
            <div className="wh-events">
              {WH_EVENTS.map((ev) => {
                const on = draft.events.includes(ev);
                return (
                  <button key={ev} type="button" className={`wh-event ${on ? "on" : ""}`} onClick={() => toggleEvent(ev)}>
                    {on ? <I.Check size={11} /> : <I.Plus size={11} />}
                    <span className="font-mono" style={{ fontSize: 11.5 }}>{ev}</span>
                  </button>
                );
              })}
            </div>
            {errors.events && <div className="field-error"><I.AlertTriangle size={11} />{errors.events}</div>}
          </div>

          <div className="field">
            <label className="field-label">Signing secret</label>
            <div style={{ display: "flex", gap: 8 }}>
              <Input className="font-mono" style={{ flex: 1, fontSize: 12.5 }} type={revealSecret ? "text" : "password"} value={draft.secret} readOnly />
              <Button variant="outline" size="sm" icon={revealSecret ? I.X : I.Eye} onClick={() => setRevealSecret(!revealSecret)}>{revealSecret ? "Hide" : "Show"}</Button>
              <Button variant="outline" size="sm" icon={I.Refresh} onClick={() => { update("secret", "whsec_" + Math.random().toString(16).slice(2, 14)); pushToast("Secret rotated."); }}>Rotate</Button>
            </div>
            <span className="field-hint">Sent as <span className="font-mono">X-Workeros-Signature: sha256=…</span>. Verify on the receiver.</span>
          </div>

          <div className="field">
            <label className="field-label">Custom headers</label>
            <Textarea className="font-mono" style={{ minHeight: 70, fontSize: 12 }} value={draft.headers} onChange={(e) => update("headers", e.target.value)} placeholder={"Authorization: Bearer …\nX-Tenant: workeros"} />
            <span className="field-hint">One per line. <span className="font-mono">Content-Type</span> and <span className="font-mono">X-Workeros-*</span> are reserved.</span>
          </div>

          <div className="field-row">
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>Active</div>
              <div className="muted" style={{ fontSize: 11.5 }}>Deliveries pause immediately when off; queued events are dropped after 24h.</div>
            </div>
            <Switch checked={draft.active} onChange={(v) => update("active", v)} />
          </div>
        </div>

        <div className="sheet-footer">
          {mode === "edit" && <Button variant="ghost" icon={I.Bolt} onClick={async () => {
            try {
              await api(`/api/webhooks/${draft.id}/test`, { method: "POST" });
              pushToast(`Test event sent to ${draft.name}.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
          }}>Send test</Button>}
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>{mode === "create" ? "Create webhook" : "Save changes"}</Button>
        </div>
      </div>
    </div>
  );
}
