// @ts-nocheck
import { useEffect, useState } from "react";
import { I } from "../icons";
import { Badge, Button, JsonBlock, PageHeader } from "../ui";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workeros/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { activityApi, type ApiActivity } from "../api";
import { ActivitySkeleton } from "../page-skeletons";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

export function ActivityPage({ pushToast }: { pushToast: (m: string) => void }) {
  type Evt = { t: string; actor: string; action: string; resource: string; diff: string; ip: string; durationMs: number | null; raw: ApiActivity };
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
    durationMs: a.durationMs,
    raw: a,
  });

  const formatDuration = (ms: number | null): string => {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

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

  // First whole-page fetch — show the page-shaped skeleton until the initial
  // batch of rows lands.
  if (loading && events.length === 0) return <ActivitySkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title="Activity log" description="Append-only audit trail. Every mutation through the API or UI is logged with actor, IP, and diff." actions={<Button variant="outline" icon={I.Download} onClick={() => {
        const header = "time,actor,action,resource,diff,ip";
        const csvQuote = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
        const body = events
          .map((e) => [e.t, e.actor, e.action, e.resource, e.diff, e.ip].map(csvQuote).join(","))
          .join("\n");
        const blob = new Blob([header + "\n" + body], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "activity.csv"; a.click();
        URL.revokeObjectURL(url);
        pushToast("Exported as activity.csv.");
      }}>Export</Button>} />
      <Tabs value={filter} onValueChange={(v) => setFilter(v)}>
        <TabsList className="flex-wrap">
          {["all", "item", "auth", "schema", "role", "storage", "flow", "function", "webhook", "backup"].map((k) => (
            <TabsTrigger key={k} value={k}>{k} <span className="tabular-nums text-muted-foreground">{k === "all" ? events.length : events.filter((e) => e.action.startsWith(k)).length}</span></TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <Table className={ADMIN_TABLE_CLS}>
          <TableHeader><TableRow><TableHead className="w-[160px] whitespace-nowrap">Time</TableHead><TableHead className="w-[90px] text-right">Duration</TableHead><TableHead className="w-[140px]">Action</TableHead><TableHead>Resource</TableHead><TableHead>Diff</TableHead><TableHead className="w-[130px]">IP</TableHead></TableRow></TableHeader>
          <TableBody>
            {visible.map((e, i) => (
              <TableRow
                key={i}
                onClick={() => setOpenEvt(e)}
                className="cursor-pointer"
                title="Click for full payload"
              >
                <TableCell className="whitespace-nowrap font-mono text-[11.5px] tabular-nums text-muted-foreground">{e.t}</TableCell>
                <TableCell className="whitespace-nowrap text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">{formatDuration(e.durationMs)}</TableCell>
                <TableCell><Badge variant={actionColor(e.action)} mono>{e.action}</Badge></TableCell>
                <TableCell className="font-mono text-xs">{e.resource}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{e.diff}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{e.ip}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between border-t border-border px-3.5 py-2.5">
          <span className="text-xs tabular-nums text-muted-foreground">
            {filter === "all"
              ? `${events.length} loaded${hasMore ? "" : " · end"}`
              : `${visible.length} of ${events.length} loaded${hasMore ? "" : " · end"}`}
          </span>
          <Button
            variant="outline"
            disabled={!hasMore || loading}
            onClick={() => void fetchPage(events.length, true)}
          >
            {loading ? (
              <Skeleton className="h-3.5 w-16" />
            ) : hasMore ? (
              "Load more"
            ) : (
              "No more rows"
            )}
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
  const fullTs = (() => {
    const d = new Date(evt.raw.createdAt);
    return Number.isNaN(d.getTime()) ? evt.t : d.toISOString().replace("T", " ").replace("Z", " UTC");
  })();
  const collection = evt.raw.collection;
  const itemId = evt.raw.itemId;
  const userAgent = evt.raw.userAgent;
  const durationMs = evt.raw.durationMs;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <DialogTitle className="sr-only">{`${evt.action} activity detail`}</DialogTitle>
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant={actionColor(evt.action)} mono>{evt.action}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{collection}{itemId ? "/" + itemId : ""}</span>
          </div>
          <h3 className="m-0 text-sm font-medium">
            {evt.actor}
          </h3>
        </DialogHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
          <div className="grid grid-cols-[140px_1fr] gap-x-3.5 gap-y-2 text-[12.5px]">
            <span className="text-muted-foreground">Time</span>
            <span className="font-mono">{fullTs}</span>
            <span className="text-muted-foreground">Actor</span>
            <span className="font-mono [word-break:break-all]">{evt.actor}</span>
            <span className="text-muted-foreground">Action</span>
            <span className="font-mono">{evt.action}</span>
            <span className="text-muted-foreground">Collection</span>
            <span className="font-mono">{collection}</span>
            {itemId && (
              <>
                <span className="text-muted-foreground">Item ID</span>
                <span className="font-mono [word-break:break-all]">{itemId}</span>
              </>
            )}
            <span className="text-muted-foreground">IP</span>
            <span className="font-mono">{evt.ip}</span>
            {userAgent && (
              <>
                <span className="text-muted-foreground">User-Agent</span>
                <span className="font-mono text-[11.5px] [word-break:break-all]">{userAgent}</span>
              </>
            )}
            {durationMs != null && (
              <>
                <span className="text-muted-foreground">Duration</span>
                <span className="font-mono tabular-nums">{durationMs} ms</span>
              </>
            )}
            <span className="text-muted-foreground">Activity ID</span>
            <span className="font-mono text-[11.5px] [word-break:break-all]">{evt.raw.id}</span>
          </div>
          <JsonBlock label="Payload" value={evt.raw.payload} />
          {evt.raw.response != null && (
            <JsonBlock label="Response" value={evt.raw.response} />
          )}
        </div>
        <DialogFooter className="border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
