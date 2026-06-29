// Traces page — distributed-tracing explorer over GET /api/admin/traces.
//
// Each row is one trace (spans grouped by `traceId`, summarized by the root
// span). The SDK stamps a W3C `traceparent` on every request, the server
// records a span per request, and functions re-emit the header — so a request
// that calls back into the API shows up as a multi-span trace. Click a row to
// open the waterfall (GET /api/admin/traces/:traceId).
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, EmptyState, PageHeader } from "../ui";
import { Input } from "@backlex/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@backlex/ui/components/table";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import type { ApiSpan, ApiTraceSummary } from "../api";
import { useTrace, useTraces } from "../queries";

const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${hh}:${mm}:${ss} · ${date}`;
};

/** Status → badge tint. 2xx neutral, 4xx warn, 5xx/none destructive. */
const statusVariant = (
  status: number | null,
): "secondary" | "destructive" | "outline" => {
  if (status == null) return "outline";
  if (status >= 500) return "destructive";
  if (status >= 400) return "destructive";
  return "secondary";
};

export function TracesPage({
  pushToast,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const [path, setPath] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [live, setLive] = useState(false);
  const [openTrace, setOpenTrace] = useState<ApiTraceSummary | null>(null);

  const filters = useMemo(
    () => ({ path: path.trim() || undefined, minStatus: errorsOnly ? 400 : undefined, limit: 100 }),
    [path, errorsOnly],
  );
  const { data, isLoading, isError, refetch, isFetching } = useTraces(filters, live);
  const traces = data?.data ?? [];

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Traces`}
        description={t`Distributed request traces. Every SDK/API call carries a W3C traceparent; a span is recorded per request and functions propagate it, so one operation stitches together across hops.`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={live ? "primary" : "outline"}
              icon={I.Zap}
              onClick={() => setLive((v) => !v)}
            >
              {live ? <Trans>Live</Trans> : <Trans>Go live</Trans>}
            </Button>
            <Button
              variant="outline"
              icon={I.Refresh}
              disabled={isFetching}
              onClick={() => {
                void refetch().then(() => pushToast(t`Traces refreshed.`));
              }}
            >
              <Trans>Refresh</Trans>
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t`Filter by path…`}
          className="max-w-xs"
        />
        <Button
          variant={errorsOnly ? "primary" : "outline"}
          icon={I.AlertTriangle}
          onClick={() => setErrorsOnly((v) => !v)}
        >
          <Trans>Errors only</Trans>
        </Button>
      </div>

      {isError ? (
        <Card className="items-center gap-3 px-6 py-12 text-center">
          <div className="grid size-10 place-items-center rounded-xl bg-muted text-primary">
            <I.AlertTriangle size={18} />
          </div>
          <h4 className="m-0 text-[15px] font-semibold">
            <Trans>Couldn't load traces</Trans>
          </h4>
          <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">
            <Trans>The traces endpoint returned an error. Refresh to try again.</Trans>
          </p>
        </Card>
      ) : !isLoading && traces.length === 0 ? (
        <EmptyState
          icon={I.Activity}
          title={t`No traces yet`}
          description={t`Traces appear as requests come in. Make a call with the SDK or admin UI, then refresh.`}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[170px] whitespace-nowrap">
                <Trans>Time</Trans>
              </TableHead>
              <TableHead>
                <Trans>Operation</Trans>
              </TableHead>
              <TableHead className="w-[90px]">
                <Trans>Status</Trans>
              </TableHead>
              <TableHead className="w-[70px] text-right">
                <Trans>Spans</Trans>
              </TableHead>
              <TableHead className="w-[90px] text-right">
                <Trans>Duration</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {traces.map((tr) => (
              <TableRow
                key={tr.traceId}
                onClick={() => setOpenTrace(tr)}
                className="cursor-pointer"
              >
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtTime(tr.startedAt)}
                </TableCell>
                <TableCell className="font-mono text-[12.5px]">{tr.name}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(tr.rootStatus)}>
                    {tr.rootStatus ?? "—"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{tr.spanCount}</TableCell>
                <TableCell className="text-right tabular-nums">{tr.durationMs}ms</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <TraceDetail trace={openTrace} onClose={() => setOpenTrace(null)} />
    </div>
  );
}

/** Waterfall dialog for one trace. */
function TraceDetail({
  trace,
  onClose,
}: {
  trace: ApiTraceSummary | null;
  onClose: () => void;
}) {
  const { data } = useTrace(trace?.traceId ?? null);
  const spans = data?.spans ?? [];

  const { min, total } = useMemo(() => {
    if (spans.length === 0) return { min: 0, total: 1 };
    const starts = spans.map((s) => s.startedAt);
    const ends = spans.map((s) => s.startedAt + (s.durationMs ?? 0));
    const lo = Math.min(...starts);
    const hi = Math.max(...ends);
    return { min: lo, total: Math.max(1, hi - lo) };
  }, [spans]);

  // The method+path lives in the title; the waterfall's root row carries only
  // the "root" badge so the endpoint isn't printed twice.
  return (
    <Dialog open={!!trace} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-[13px]">
            {trace?.name ?? <Trans>Trace</Trans>}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
          {trace && (
            <Badge variant={trace.hasError ? "destructive" : "secondary"} mono>
              {trace.rootStatus ?? "—"}
            </Badge>
          )}
          {trace && <span className="font-mono tabular-nums text-foreground">{trace.durationMs}ms</span>}
          <span className="break-all font-mono">{trace?.traceId}</span>
        </div>
        <ScrollArea className="min-h-0" viewportClassName="max-h-[calc(85vh-10rem)] max-[640px]:max-h-[calc(85vh-15rem)]">
          <div className="flex flex-col gap-1.5 py-1">
            {spans.length === 0 ? (
              <p className="m-0 px-1 py-6 text-center text-[13px] text-muted-foreground">
                <Trans>No spans recorded for this trace.</Trans>
              </p>
            ) : (
              spans.map((s) => (
                <SpanBar key={s.id} span={s} min={min} total={total} />
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function SpanBar({ span, min, total }: { span: ApiSpan; min: number; total: number }) {
  const dur = span.durationMs ?? 0;
  const left = ((span.startedAt - min) / total) * 100;
  const width = Math.max(1.5, (dur / total) * 100);
  const isError = (span.status ?? 0) >= 400;
  const isRoot = span.parentSpanId === null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2fr_auto] items-center gap-2 px-1">
      <div className="flex min-w-0 items-center gap-2">
        {isRoot ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            <Trans>root</Trans>
          </Badge>
        ) : (
          <span className="truncate font-mono text-[11.5px]">{span.name}</span>
        )}
      </div>
      <div className="relative h-5 rounded bg-muted">
        <div
          className={`absolute top-0 h-5 rounded ${isError ? "bg-destructive" : "bg-primary"}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">
        {dur}ms
      </span>
    </div>
  );
}
