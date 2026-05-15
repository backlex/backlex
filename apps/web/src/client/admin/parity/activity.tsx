// @ts-nocheck
import { useEffect, useState } from "react";
import { I } from "../icons";
import { Badge, Button, IconButton, JsonBlock, PageHeader } from "../ui";
import { activityApi, type ApiActivity } from "../api";

export function ActivityPage({ pushToast }: { pushToast: (m: string) => void }) {
  type Evt = { t: string; actor: string; action: string; resource: string; diff: string; ip: string; raw: ApiActivity };
  const PAGE_SIZE = 50;
  const [events, setEvents] = useState<Evt[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  // hasMore stays true until a fetch returns fewer rows than requested.
  const [hasMore, setHasMore] = useState(true);
  // Selected row for the detail modal.
  const [openEvt, setOpenEvt] = useState<Evt | null>(null);

  const mapRow = (a: ApiActivity): Evt => ({
    t: new Date(a.createdAt).toISOString().replace("T", " ").slice(0, 19),
    actor: a.userId ?? "system",
    action: a.action,
    resource: `${a.collection}${a.itemId ? "/" + a.itemId : ""}`,
    diff: typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload ?? {}).slice(0, 80),
    ip: a.ip ?? "—",
    raw: a,
  });

  const fetchPage = async (offset: number, append: boolean) => {
    setLoading(true);
    try {
      const res = await activityApi.list({ limit: PAGE_SIZE, offset });
      if (Array.isArray(res.data)) {
        const mapped = res.data.map(mapRow);
        setEvents((prev) => (append ? [...prev, ...mapped] : mapped));
        setHasMore(res.data.length === PAGE_SIZE);
      }
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchPage(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = filter === "all" ? events : events.filter((e) => e.action.startsWith(filter));
  const actionColor = (a: string) => a.startsWith("item.") ? "default" as const : a.startsWith("auth.") ? "secondary" as const : a.startsWith("schema.") ? "destructive" as const : "outline" as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Activity log" description="Append-only audit trail. Every mutation through the API or UI is logged with actor, IP, and diff." actions={<Button variant="outline" icon={I.Download} onClick={() => {
        const header = "time,actor,action,resource,diff,ip";
        const escape = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
        const body = events
          .map((e) => [e.t, e.actor, e.action, e.resource, e.diff, e.ip].map(escape).join(","))
          .join("\n");
        const blob = new Blob([header + "\n" + body], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "activity.csv"; a.click();
        URL.revokeObjectURL(url);
        pushToast("Exported as activity.csv.");
      }}>Export</Button>} />
      <div className="filter-bar">
        {["all", "item", "auth", "schema", "role", "storage", "flow", "function", "webhook", "backup"].map((k) => (
          <button key={k} className={`chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>{k} <span className="muted tabular-nums">{k === "all" ? events.length : events.filter((e) => e.action.startsWith(k)).length}</span></button>
        ))}
      </div>
      <div className="card">
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th style={{ width: 160, whiteSpace: "nowrap" }}>Time</th><th style={{ width: 200 }}>Actor</th><th style={{ width: 140 }}>Action</th><th>Resource</th><th>Diff</th><th style={{ width: 130 }}>IP</th></tr></thead>
          <tbody>
            {visible.map((e, i) => (
              <tr
                key={i}
                onClick={() => setOpenEvt(e)}
                style={{ cursor: "pointer" }}
                title="Click for full payload"
              >
                <td className="font-mono muted tabular-nums" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{e.t}</td>
                <td style={{ wordBreak: "break-all" }}>{e.actor}</td>
                <td><Badge variant={actionColor(e.action)} mono>{e.action}</Badge></td>
                <td className="font-mono" style={{ fontSize: 12 }}>{e.resource}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{e.diff}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
          <span className="muted tabular-nums" style={{ fontSize: 12 }}>
            {filter === "all"
              ? `${events.length} loaded${hasMore ? "" : " · end"}`
              : `${visible.length} of ${events.length} loaded${hasMore ? "" : " · end"}`}
          </span>
          <Button
            variant="outline"
            disabled={!hasMore || loading}
            onClick={() => void fetchPage(events.length, true)}
          >
            {loading ? "Loading…" : hasMore ? "Load more" : "No more rows"}
          </Button>
        </div>
      </div>
      {openEvt && (
        <ActivityEventDialog evt={openEvt} actionColor={actionColor} onClose={() => setOpenEvt(null)} />
      )}
    </div>
  );
}

function ActivityEventDialog({
  evt,
  actionColor,
  onClose,
}: {
  evt: { t: string; actor: string; action: string; resource: string; ip: string; raw: ApiActivity };
  actionColor: (a: string) => "default" | "secondary" | "destructive" | "outline";
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const fullTs = (() => {
    const d = new Date(evt.raw.createdAt);
    return Number.isNaN(d.getTime()) ? evt.t : d.toISOString().replace("T", " ").replace("Z", " UTC");
  })();
  const collection = evt.raw.collection;
  const itemId = evt.raw.itemId;
  const userAgent = evt.raw.userAgent;
  const durationMs = evt.raw.durationMs;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${evt.action} activity detail`}
      >
        <div className="dialog-head">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <Badge variant={actionColor(evt.action)} mono>{evt.action}</Badge>
              <span className="font-mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{collection}{itemId ? "/" + itemId : ""}</span>
            </div>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>
              {evt.actor}
            </h3>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div className="dialog-body">
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px 14px", fontSize: 12.5 }}>
            <span style={{ color: "var(--muted-foreground)" }}>Time</span>
            <span className="font-mono">{fullTs}</span>
            <span style={{ color: "var(--muted-foreground)" }}>Actor</span>
            <span className="font-mono" style={{ wordBreak: "break-all" }}>{evt.actor}</span>
            <span style={{ color: "var(--muted-foreground)" }}>Action</span>
            <span className="font-mono">{evt.action}</span>
            <span style={{ color: "var(--muted-foreground)" }}>Collection</span>
            <span className="font-mono">{collection}</span>
            {itemId && (
              <>
                <span style={{ color: "var(--muted-foreground)" }}>Item ID</span>
                <span className="font-mono" style={{ wordBreak: "break-all" }}>{itemId}</span>
              </>
            )}
            <span style={{ color: "var(--muted-foreground)" }}>IP</span>
            <span className="font-mono">{evt.ip}</span>
            {userAgent && (
              <>
                <span style={{ color: "var(--muted-foreground)" }}>User-Agent</span>
                <span className="font-mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{userAgent}</span>
              </>
            )}
            {durationMs != null && (
              <>
                <span style={{ color: "var(--muted-foreground)" }}>Duration</span>
                <span className="font-mono tabular-nums">{durationMs} ms</span>
              </>
            )}
            <span style={{ color: "var(--muted-foreground)" }}>Activity ID</span>
            <span className="font-mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{evt.raw.id}</span>
          </div>
          <JsonBlock label="Payload" value={evt.raw.payload} />
          {evt.raw.response != null && (
            <JsonBlock label="Response" value={evt.raw.response} />
          )}
        </div>
        <div className="dialog-foot">
          <div className="spacer" style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
