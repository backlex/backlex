// Webhooks page — outgoing HTTP on collection events + delivery log + editor
import { useEffect, useState } from "react";
import { I } from "../icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import { api } from "@/lib/api";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workeros/ui/components/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { fetchSafely } from "./_shared";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";
const USERS_MENU_CLS =
  "absolute right-2 top-[calc(100%-4px)] z-30 flex min-w-[180px] flex-col rounded-xl border border-border bg-popover p-1 text-left shadow-[0_8px_24px_oklch(0_0_0/0.16)] [&>button]:flex [&>button]:cursor-pointer [&>button]:items-center [&>button]:gap-2 [&>button]:rounded-md [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-2.5 [&>button]:py-[7px] [&>button]:text-left [&>button]:text-[12.5px] [&>button]:text-foreground [&>button:hover]:bg-accent";

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
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title="Webhooks"
        description="Outgoing HTTP on collection events. Failed deliveries retry with exponential backoff."
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setEditor({ mode: "create", hook: null })}>New webhook</Button>}
      />
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <Table className={ADMIN_TABLE_CLS}>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead>Events</TableHead>
              <TableHead className="w-[110px] text-right">Deliveries</TableHead>
              <TableHead className="w-[110px]">Success</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead className="sticky right-0 w-11 bg-card" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {hooks.map((h) => {
              const isOpen = menuOpen === h.id;
              return (
                <TableRow key={h.id} className="cursor-pointer" onClick={() => setEditor({ mode: "edit", hook: h })}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] font-medium">{h.name}</span>
                      <span className="max-w-[360px] truncate font-mono text-[11.5px] text-muted-foreground">{h.method} · {h.url}</span>
                    </div>
                  </TableCell>
                  <TableCell><div className="flex flex-wrap gap-1">{h.events.map((e) => <Badge key={e} variant="outline" mono>{e}</Badge>)}</div></TableCell>
                  <TableCell className="text-right tabular-nums">{h.deliveries.toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <div className="h-1 w-12 overflow-hidden rounded-full bg-muted">
                        <div className="h-full" style={{ width: `${h.successRate}%`, background: h.successRate > 95 ? "oklch(0.78 0.15 145)" : h.successRate > 50 ? "oklch(0.78 0.15 80)" : "var(--destructive)" }} />
                      </div>
                      <span className="font-mono text-[11.5px]">{h.successRate}%</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {!h.active ? <Badge variant="secondary">paused</Badge>
                      : h.ok ? <Badge variant="default">healthy</Badge>
                        : <Badge variant="destructive">failing</Badge>}
                  </TableCell>
                  <TableCell className="sticky right-0 bg-card text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="relative">
                      <IconButton icon={I.More} onClick={(e: any) => { e.stopPropagation(); setMenuOpen(isOpen ? null : h.id); }} />
                      {isOpen && (
                        <div className={USERS_MENU_CLS} onClick={(e) => e.stopPropagation()}>
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
                          <div className="mx-1.5 my-1 h-px bg-border" />
                          <button className="!text-destructive" onClick={async () => {
                            try { await api(`/api/webhooks/${h.id}`, { method: "DELETE" }); } catch (e) { pushToast((e as Error).message); }
                            setHooks((arr) => arr.filter((x) => x.id !== h.id));
                            setMenuOpen(null);
                            pushToast(`${h.name} deleted.`);
                          }}><I.Trash size={12} />Delete</button>
                        </div>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {hooks.length === 0 && (
              <TableRow><TableCell colSpan={6}>
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <I.Webhook size={20} />
                  <h4 className="m-0 text-[15px] font-semibold">No webhooks yet</h4>
                  <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">Pipe collection events to Slack, your API, or any HTTPS endpoint.</p>
                </div>
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Activity size={14} /><span className="text-[13px] font-medium">Recent deliveries</span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" icon={I.Refresh} onClick={() => pushToast("Refreshed.")}>Refresh</Button>
        </div>
        <Table className={ADMIN_TABLE_CLS}>
          <TableHeader><TableRow><TableHead className="w-[100px]">Time</TableHead><TableHead className="w-[80px]">Hook</TableHead><TableHead>Event</TableHead><TableHead className="w-[90px] text-right">Status</TableHead><TableHead className="w-[80px] text-right">ms</TableHead><TableHead className="sticky right-0 w-[60px] bg-card" /></TableRow></TableHeader>
          <TableBody>
            {deliveries.map((d, i) => (
              <TableRow key={i}>
                <TableCell className="font-mono text-[11.5px] tabular-nums text-muted-foreground">{d.t}</TableCell>
                <TableCell className="font-mono text-xs">{d.hook}</TableCell>
                <TableCell className="font-mono text-xs">{d.ev}</TableCell>
                <TableCell className="text-right tabular-nums"><Badge variant={d.code < 300 ? "default" : "destructive"}>{d.code}</Badge></TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{d.ms}</TableCell>
                <TableCell className="sticky right-0 bg-card text-right">
                  <Button variant="ghost" size="sm" onClick={async () => {
                    try {
                      await api(`/api/webhooks/_deliveries/${d.id}/retry`, { method: "POST" });
                      pushToast("Redelivered.");
                      await reloadDeliveries();
                    } catch (e) {
                      pushToast((e as Error).message);
                    }
                  }}>Retry</Button>
                </TableCell>
              </TableRow>
            ))}
            {deliveries.length === 0 && (
              <TableRow><TableCell colSpan={6}>
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <I.Activity size={20} />
                  <h4 className="m-0 text-[15px] font-semibold">No deliveries yet</h4>
                  <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">Outgoing webhook deliveries will show up here once a collection event fires.</p>
                </div>
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] w-[640px] max-w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="flex-row items-start gap-2.5 space-y-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <I.Webhook size={16} className="mt-0.5" />
          <div>
            <DialogTitle className="text-base font-semibold tracking-[-0.01em]">{mode === "create" ? "New webhook" : "Edit webhook"}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[12.5px]">{mode === "create" ? "POST to any HTTPS endpoint when collection events fire." : <>id <span className="font-mono">{hook?.id}</span></>}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Name <span className="text-destructive">*</span></label>
            <Input aria-invalid={!!errors.name} autoFocus value={draft.name} onChange={(e) => update("name", e.target.value)} placeholder="Slack #content" />
            {errors.name && <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{errors.name}</div>}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Endpoint URL <span className="text-destructive">*</span></label>
            <div className="flex gap-2">
              <Select size="sm" value={draft.method} onChange={(v) => update("method", v)} className="h-9 w-[100px]" options={["POST", "PUT", "PATCH"]} />
              <Input className="font-mono flex-1 text-[12.5px]" aria-invalid={!!errors.url} value={draft.url} onChange={(e) => update("url", e.target.value)} placeholder="https://api.example.com/webhooks/workeros" />
            </div>
            {errors.url ? <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{errors.url}</div> : <span className="text-[11.5px] text-muted-foreground">Must accept the chosen HTTP method and respond with 2xx within 10s.</span>}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Events <span className="text-destructive">*</span></label>
              <span className="text-[11.5px] text-muted-foreground">{draft.events.length} selected</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5 rounded-xl border border-border bg-muted p-2.5">
              {WH_EVENTS.map((ev) => {
                const on = draft.events.includes(ev);
                return (
                  <button key={ev} type="button" className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 ${on ? "border-[color-mix(in_oklch,var(--primary)_50%,var(--border))] bg-muted text-foreground" : "border-border bg-card text-muted-foreground hover:border-[color-mix(in_oklch,var(--foreground)_25%,var(--border))] hover:text-foreground"}`} onClick={() => toggleEvent(ev)}>
                    {on ? <I.Check size={11} /> : <I.Plus size={11} />}
                    <span className="font-mono text-[11.5px]">{ev}</span>
                  </button>
                );
              })}
            </div>
            {errors.events && <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{errors.events}</div>}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Signing secret</label>
            <div className="flex gap-2">
              <Input className="font-mono flex-1 text-[12.5px]" type={revealSecret ? "text" : "password"} value={draft.secret} readOnly />
              <Button variant="outline" size="sm" icon={revealSecret ? I.X : I.Eye} onClick={() => setRevealSecret(!revealSecret)}>{revealSecret ? "Hide" : "Show"}</Button>
              <Button variant="outline" size="sm" icon={I.Refresh} onClick={() => { update("secret", "whsec_" + Math.random().toString(16).slice(2, 14)); pushToast("Secret rotated."); }}>Rotate</Button>
            </div>
            <span className="text-[11.5px] text-muted-foreground">Sent as <span className="font-mono">X-Workeros-Signature: sha256=…</span>. Verify on the receiver.</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Custom headers</label>
            <Textarea className="font-mono min-h-[70px] text-xs" value={draft.headers} onChange={(e) => update("headers", e.target.value)} placeholder={"Authorization: Bearer …\nX-Tenant: workeros"} />
            <span className="text-[11.5px] text-muted-foreground">One per line. <span className="font-mono">Content-Type</span> and <span className="font-mono">X-Workeros-*</span> are reserved.</span>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[12.5px] font-medium">Active</div>
              <div className="text-[11.5px] text-muted-foreground">Deliveries pause immediately when off; queued events are dropped after 24h.</div>
            </div>
            <Switch checked={draft.active} onChange={(v) => update("active", v)} />
          </div>
        </div>

        <DialogFooter className="border-t border-border bg-card px-5 py-3 sm:justify-end">
          {mode === "edit" && <Button variant="ghost" icon={I.Bolt} onClick={async () => {
            try {
              await api(`/api/webhooks/${draft.id}/test`, { method: "POST" });
              pushToast(`Test event sent to ${draft.name}.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
          }}>Send test</Button>}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>{mode === "create" ? "Create webhook" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
