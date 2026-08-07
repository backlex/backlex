// Ask-AI → Runs tab (assistant run history from the activity log).
// Ask AI — admin page.
//
// Ports the design's four-tab AI/MCP page (/tmp/design-bundle/backlex/project/ai-mcp.jsx)
// onto the canonical backlex UI primitives:
//   - Ask     — natural-language → MCP tool dispatcher (Phase 1)
//   - Tools   — searchable catalog + per-key guard editor (Phase 2)
//   - Runs    — filtered activity table with CSV export    (Phase 2)
//   - Connect — Claude Desktop / Cursor / curl snippets    (Phase 2)
//
// Backend hops the Ask tab still drives:
//   POST /api/admin/ai/plan  →  {rationale, tool, args, model, usage}
//   POST /api/admin/ai/run   →  executes one MCP tool + writes to `activity`
//
// Recent runs fetch /api/activity?action=mcp.&limit=10 — same wire we log
// into from the /run handler.
import type { PushToast } from "../../types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { activityApi, } from "../../api";
import { I } from "../../icons";
import { Badge, Button, EmptyState } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@backlex/ui/components/tabs";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { exportToCsv } from "@/lib/csv-export";

import {
  RunRow,
  RunStatusIcon,
  mapActivityToRun,
} from "./shared";

type RunFilter = "all" | "ok" | "review" | "denied";

export function RunsTab({
  pushToast,
}: {
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<RunFilter>("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await activityApi.list({ action: "mcp.", limit: 200 });
      setRows(r.data.map(mapActivityToRun));
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      ok: rows.filter((r) => r.status === "ok").length,
      review: rows.filter((r) => r.status === "review").length,
      denied: rows.filter((r) => r.status === "denied" || r.status === "blocked").length,
    }),
    [rows],
  );

  const visible = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "denied")
      return rows.filter((r) => r.status === "denied" || r.status === "blocked");
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const exportCsv = () => {
    if (visible.length === 0) {
      pushToast(t`Nothing to export — the current view is empty.`, "error");
      return;
    }
    try {
      const out = visible.map((r) => ({
        when: r.ts,
        tool: r.tool,
        query: r.query,
        status: r.status,
        rows: r.rows ?? "",
        durationMs: r.durationMs ?? "",
        error: r.error ?? "",
      }));
      exportToCsv(out, "mcp-runs.csv", [
        "when",
        "tool",
        "query",
        "status",
        "rows",
        "durationMs",
        "error",
      ]);
      pushToast(t`Exported ${visible.length} rows as mcp-runs.csv.`);
    } catch {
      pushToast(t`Could not export runs.`, "error");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="-mx-1 px-1">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as RunFilter)}>
            <TabsList className="whitespace-nowrap">
              <TabsTrigger value="all">
                <Trans>All</Trans>
                <Badge variant="secondary" mono>
                  {counts.all}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="ok">
                <Trans>Success</Trans>
                <Badge variant="secondary" mono>
                  {counts.ok}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="review">
                <Trans>Review</Trans>
                <Badge variant="secondary" mono>
                  {counts.review}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="denied">
                <Trans>Denied</Trans>
                <Badge variant="secondary" mono>
                  {counts.denied}
                </Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <Button
            variant="ghost"
            size="sm"
            icon={I.Refresh}
            onClick={() => {
              void refresh();
            }}
            title={t`Refresh`}
          >
            <span className="sr-only">
              <Trans>Refresh</Trans>
            </span>
          </Button>
          <Button variant="outline" size="sm" icon={I.Download} onClick={exportCsv}>
            <Trans>Export CSV</Trans>
          </Button>
        </div>
      </div>
      <Card className="py-0 gap-0">
        {loading ? (
          <div className="flex flex-col">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="ml-auto h-4 w-20" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            bare
            size="md"
            icon={I.History}
            title={
              filter === "all" ? (
                <Trans>No runs yet</Trans>
              ) : (
                <Trans>No runs in this bucket</Trans>
              )
            }
            description={
              <Trans>
                MCP tool calls from the Ask tab and connected clients land here.
              </Trans>
            }
          />
        ) : (
          <ScrollArea viewportClassName="max-h-[640px]">
            <table className="w-full min-w-[680px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-border">
                    {[
                      t`When`,
                      t`Tool`,
                      t`Query`,
                      t`Result`,
                      t`Latency`,
                    ].map((h) => (
                      <th
                        key={h}
                        className="h-9 px-3 text-left text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground md:px-4"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border/60 last:border-b-0 hover:bg-accent/40"
                    >
                      <td className="h-12 px-3 align-middle font-mono text-[11.5px] text-muted-foreground md:px-4">
                        {r.when}
                      </td>
                      <td className="px-3 align-middle md:px-4">
                        <span className="font-mono text-[12px]">{r.tool}</span>
                      </td>
                      <td
                        className="max-w-md truncate px-3 align-middle text-foreground/85 md:px-4"
                        title={r.query}
                      >
                        {r.query}
                      </td>
                      <td className="px-3 align-middle md:px-4">
                        <span className="inline-flex items-center gap-1.5 text-[12px]">
                          <RunStatusIcon status={r.status} />
                          {r.status === "ok" && r.rows != null ? (
                            <span className="font-mono tabular-nums">
                              {r.rows} <Trans>rows</Trans>
                            </span>
                          ) : r.status === "ok" ? (
                            <Trans>ok</Trans>
                          ) : r.status === "blocked" ? (
                            <span className="text-muted-foreground">
                              <Trans>blocked</Trans>
                              {r.error ? (
                                <>
                                  {" · "}
                                  <span className="font-mono">{r.error}</span>
                                </>
                              ) : null}
                            </span>
                          ) : r.status === "review" ? (
                            <Trans>pending review</Trans>
                          ) : (
                            <span className="text-destructive">
                              {r.error ?? <Trans>denied</Trans>}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 align-middle font-mono tabular-nums text-muted-foreground md:px-4">
                        {r.durationMs != null ? `${r.durationMs}ms` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
          </ScrollArea>
        )}
      </Card>
    </div>
  );
}

// ─── Connect tab ──────────────────────────────────────────────────────────
