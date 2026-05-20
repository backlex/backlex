// Admin OpenAPI export — fetches /api/openapi.json on mount, summarizes the
// document (info, counts, tag-chips), and lists every path grouped by tag
// with method badges + a per-path curl-snippet preview. Two header buttons
// stream the full doc to disk as JSON or YAML.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@workeros/ui/components/button";
import { Badge } from "@workeros/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Separator } from "@workeros/ui/components/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { toast } from "@workeros/ui/components/sonner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workeros/ui/components/collapsible";
import { cn } from "@workeros/ui/lib/utils";
import { PageHeader } from "@/components/page-header";
import { I } from "@/admin/icons";
import { api } from "@/lib/api";
import { notifyError } from "@/lib/error";

// --- Types ---------------------------------------------------------------

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface OperationObject {
  tags?: string[];
  summary?: string;
  operationId?: string;
}
type PathItemObject = Partial<Record<HttpMethod, OperationObject>>;

interface OpenApiDoc {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, PathItemObject>;
  components?: { schemas?: Record<string, unknown> };
}

interface PathRow {
  path: string;
  methods: HttpMethod[];
  tag: string;
}

const UNTAGGED = "untagged";

// --- Method badge palette (semantic; shadcn Badge variants extended via cn) -

const METHOD_CLASSES: Record<HttpMethod, string> = {
  get: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  post: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  patch: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  delete: "bg-red-500/15 text-red-700 dark:text-red-300",
  put: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  options: "bg-muted text-muted-foreground",
  head: "bg-muted text-muted-foreground",
  trace: "bg-muted text-muted-foreground",
};

const MethodBadge = ({ method }: { method: HttpMethod }) => (
  <Badge
    variant="outline"
    className={cn(
      "border-transparent font-mono text-[10px] uppercase tracking-wide",
      METHOD_CLASSES[method],
    )}
  >
    {method}
  </Badge>
);

// --- Helpers -------------------------------------------------------------

const triggerDownload = (filename: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke shortly after to let the browser kick off the download first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Build a flat list of (path, methods[], tag) rows from the OpenAPI doc.
 *  Each path is bucketed under the first tag of its first operation; falls
 *  back to UNTAGGED when no tag is set. */
const collectPathRows = (doc: OpenApiDoc): PathRow[] => {
  const paths = doc.paths ?? {};
  const rows: PathRow[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    const methods: HttpMethod[] = [];
    let tag = UNTAGGED;
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!op) continue;
      methods.push(m);
      if (tag === UNTAGGED && op.tags?.[0]) tag = op.tags[0];
    }
    if (methods.length === 0) continue;
    rows.push({ path, methods, tag });
  }
  rows.sort((a, b) => (a.tag !== b.tag ? a.tag.localeCompare(b.tag) : a.path.localeCompare(b.path)));
  return rows;
};

/** Count operations per tag across the whole doc (an op tagged `[a,b]`
 *  counts for both — different from the path-row bucketing above). */
const countOpsByTag = (doc: OpenApiDoc): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of Object.values(doc.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!op) continue;
      const tags = op.tags && op.tags.length > 0 ? op.tags : [UNTAGGED];
      for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return counts;
};

const countOperations = (doc: OpenApiDoc): number => {
  let n = 0;
  for (const item of Object.values(doc.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const m of HTTP_METHODS) if (item[m]) n++;
  }
  return n;
};

/** Build a `curl` snippet for one (method, path) tuple. Uses the same
 *  origin the admin is served from + an `Authorization` placeholder so the
 *  user can drop in a `pak_...` key. */
const buildCurl = (method: HttpMethod, path: string): string => {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-workspace";
  const url = `${origin}${path}`;
  const lines = [
    `curl -X ${method.toUpperCase()} '${url}' \\`,
    `  -H 'Authorization: Bearer pak_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \\`,
    `  -H 'Accept: application/json'`,
  ];
  if (method === "post" || method === "patch" || method === "put") {
    lines[lines.length - 1] += " \\";
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -d '{}'`);
  }
  return lines.join("\n");
};

// --- Page ----------------------------------------------------------------

export const OpenApiExportPage = () => {
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [downloading, setDownloading] = useState<"json" | "yaml" | null>(null);

  // Per-tag collapsed state. Default: first 2 groups open.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // Curl-preview dialog state.
  const [curlOpen, setCurlOpen] = useState(false);
  const [curlText, setCurlText] = useState("");
  const [curlSubtitle, setCurlSubtitle] = useState("");

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const json = await api<OpenApiDoc>("/api/openapi.json");
      setDoc(json);
      if (isRefresh) toast.success("OpenAPI spec refreshed.");
    } catch (err) {
      notifyError(err, "while loading OpenAPI spec");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Compute derived data once per doc change.
  const { rows, tagOrder, summary } = useMemo(() => {
    if (!doc) {
      return {
        rows: [] as PathRow[],
        tagOrder: [] as string[],
        summary: {
          title: "—",
          version: "—",
          pathCount: 0,
          operationCount: 0,
          schemaCount: 0,
          tagCounts: new Map<string, number>(),
        },
      };
    }
    const allRows = collectPathRows(doc);
    const tagsSeen: string[] = [];
    for (const r of allRows) if (!tagsSeen.includes(r.tag)) tagsSeen.push(r.tag);
    return {
      rows: allRows,
      tagOrder: tagsSeen,
      summary: {
        title: doc.info?.title ?? "Untitled API",
        version: doc.info?.version ?? "—",
        pathCount: Object.keys(doc.paths ?? {}).length,
        operationCount: countOperations(doc),
        schemaCount: Object.keys(doc.components?.schemas ?? {}).length,
        tagCounts: countOpsByTag(doc),
      },
    };
  }, [doc]);

  // Initialize open-group state when the tag list changes. Preserve any
  // explicit user toggles; only set defaults for tags we haven't decided
  // about yet (first 2 tags open).
  useEffect(() => {
    if (tagOrder.length === 0) return;
    setOpenGroups((prev) => {
      const next = { ...prev };
      tagOrder.forEach((t, i) => {
        if (!(t in next)) next[t] = i < 2;
      });
      return next;
    });
  }, [tagOrder]);

  const rowsByTag = useMemo(() => {
    const map = new Map<string, PathRow[]>();
    for (const r of rows) {
      const arr = map.get(r.tag) ?? [];
      arr.push(r);
      map.set(r.tag, arr);
    }
    return map;
  }, [rows]);

  const downloadJson = async () => {
    setDownloading("json");
    try {
      // Re-fetch on download so the file matches the server's current view
      // (collections may have been added/removed since mount).
      const fresh = await api<OpenApiDoc>("/api/openapi.json");
      const text = JSON.stringify(fresh, null, 2);
      triggerDownload("workeros-openapi.json", new Blob([text], { type: "application/json" }));
    } catch (err) {
      notifyError(err, "while downloading JSON");
    } finally {
      setDownloading(null);
    }
  };

  const downloadYaml = async () => {
    setDownloading("yaml");
    try {
      const res = await fetch("/api/openapi.yaml", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      triggerDownload("workeros-openapi.yaml", new Blob([text], { type: "application/yaml" }));
    } catch (err) {
      notifyError(err, "while downloading YAML");
    } finally {
      setDownloading(null);
    }
  };

  const openCurlFor = (row: PathRow) => {
    const method = row.methods[0];
    if (!method) return;
    setCurlText(buildCurl(method, row.path));
    setCurlSubtitle(`${method.toUpperCase()} ${row.path}`);
    setCurlOpen(true);
  };

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curlText);
      toast.success("Copied curl snippet.");
    } catch (err) {
      notifyError(err, "while copying to clipboard");
    }
  };

  const toggleGroup = (tag: string) =>
    setOpenGroups((prev) => ({ ...prev, [tag]: !prev[tag] }));

  // --- Render ------------------------------------------------------------

  return (
    <div className="openapi-export-page flex flex-col gap-6">
      {/*
        PageHeader's `actions` slot uses `flex shrink-0`, so this 3-button
        row would crush the description column to ~100px on narrow viewports
        (~826px) and force the description to wrap word-per-line. Pass the
        actions through `actions={…}` but wrap them in `openapi-actions`;
        the CSS at the end of admin.css unsets the PageHeader's `shrink-0`
        and lets the buttons wrap to a 2nd line when there isn't enough
        horizontal room.
      */}
      <PageHeader
        title="OpenAPI"
        description="Machine-readable spec for every /api endpoint in this workspace — including dynamic /api/items/{slug} entries for your collections. Import into Postman, Insomnia, Swagger UI, or any code-gen tool."
        actions={
          <div className="openapi-actions flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || loading}
              onClick={() => void load(true)}
              aria-label="Refresh spec"
            >
              <I.Refresh size={14} className={cn(refreshing && "animate-spin")} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={downloading !== null || loading}
              onClick={() => void downloadJson()}
            >
              <I.Download size={14} />
              {downloading === "json" ? "Downloading…" : "Download JSON"}
            </Button>
            <Button
              size="sm"
              disabled={downloading !== null || loading}
              onClick={() => void downloadYaml()}
            >
              <I.Download size={14} />
              {downloading === "yaml" ? "Downloading…" : "Download YAML"}
            </Button>
          </div>
        }
      />

      {/* Summary --------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <I.Info size={16} />
            Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading spec…</p>
          ) : !doc ? (
            <p className="text-sm text-muted-foreground">Spec unavailable. Try Refresh.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                <Stat label="Title" value={summary.title} />
                <Stat label="Version" value={summary.version} />
                <Stat label="Paths" value={String(summary.pathCount)} />
                <Stat label="Operations" value={String(summary.operationCount)} />
                <Stat label="Schemas" value={String(summary.schemaCount)} />
              </div>
              {summary.tagCounts.size > 0 && (
                <>
                  <Separator />
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Tags
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(summary.tagCounts.entries())
                        .sort((a, b) => b[1] - a[1])
                        .map(([tag, n]) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                            <span className="ml-1 font-mono text-[10px] opacity-70">{n}</span>
                          </Badge>
                        ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Paths ----------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <I.Code size={16} />
            Paths
            {rows.length > 0 && (
              <span className="font-mono text-xs text-muted-foreground">{rows.length}</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">No paths in the current spec.</p>
          )}
          {tagOrder.map((tag) => {
            const groupRows = rowsByTag.get(tag) ?? [];
            const isOpen = openGroups[tag] ?? false;
            return (
              <Collapsible
                key={tag}
                open={isOpen}
                onOpenChange={() => toggleGroup(tag)}
                className="overflow-hidden rounded-md border bg-background/50"
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
                    aria-expanded={isOpen}
                  >
                    <span className="flex items-center gap-2">
                      {isOpen ? <I.ChevronDown size={14} /> : <I.ChevronRight size={14} />}
                      <span className="font-medium">{tag}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {groupRows.length}
                      </span>
                    </span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex flex-col divide-y border-t">
                    {groupRows.map((row) => (
                      <div
                        key={row.path}
                        className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <div className="flex flex-wrap gap-1">
                            {row.methods.map((m) => (
                              <MethodBadge key={m} method={m} />
                            ))}
                          </div>
                          <code className="truncate font-mono text-xs text-foreground/90">
                            {row.path}
                          </code>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openCurlFor(row)}
                          aria-label={`Copy curl example for ${row.path}`}
                        >
                          <I.Code size={14} />
                          curl
                        </Button>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </CardContent>
      </Card>

      {/* Curl-preview dialog -------------------------------------------- */}
      <Dialog open={curlOpen} onOpenChange={setCurlOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <I.Code size={16} />
              curl example
            </DialogTitle>
            <DialogDescription>
              <span className="font-mono">{curlSubtitle}</span>
              <br />
              Drop in a workspace API key (<code className="font-mono">pak_…</code>) before
              running.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[40vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
            {curlText}
          </pre>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setCurlOpen(false)}>
              Close
            </Button>
            <Button size="sm" onClick={() => void copyCurl()}>
              <I.Save size={14} />
              Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
    <span className="truncate text-sm" title={value}>
      {value}
    </span>
  </div>
);
