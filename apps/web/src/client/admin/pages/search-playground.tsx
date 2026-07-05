// Search playground — run the ranked `/:slug/search` endpoint (full-text /
// vector / hybrid) against any collection without leaving the admin. The
// server resolves the effective mode from the collection's capabilities and
// returns whole rows best-first with every read filter enforced.
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { I } from "../icons";
import { Badge, Button, EmptyState, PageHeader } from "../ui";
import { Select } from "../select";
import { rowLabel, shortId, type LabelSchemaField } from "../row-label";
import { SearchPlaygroundSkeleton } from "../page-skeletons";

interface SearchCollection {
  slug: string;
  fts?: boolean;
  displayTemplate?: string | null;
  fields?: LabelSchemaField[];
}

type SearchMode = "auto" | "fts" | "vector" | "hybrid";

export function SearchPlaygroundPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [cols, setCols] = useState<SearchCollection[] | null>(null);
  const [slug, setSlug] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>("auto");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null);
  const [usedMode, setUsedMode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/collections", { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: SearchCollection[] };
        const list = j.data ?? [];
        if (!cancelled) {
          setCols(list);
          // Preselect the first searchable collection so the page is one
          // keystroke away from a result.
          setSlug((list.find((c) => c.fts) ?? list[0])?.slug);
        }
      } catch {
        if (!cancelled) setCols([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async () => {
    if (!slug || !q.trim() || searching) return;
    setSearching(true);
    setError(null);
    try {
      const r = await fetch(`/api/items/${encodeURIComponent(slug)}/search`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          q: q.trim(),
          ...(mode !== "auto" ? { mode } : {}),
          limit: 20,
        }),
      });
      const j = (await r.json().catch(() => null)) as
        | { data?: Record<string, unknown>[]; mode?: string; error?: { message?: string } }
        | null;
      if (!r.ok) {
        setResults(null);
        setUsedMode(null);
        setError(j?.error?.message ?? t`Search failed.`);
        return;
      }
      setResults(j?.data ?? []);
      setUsedMode(j?.mode ?? null);
    } catch {
      setError(t`Search failed.`);
      pushToast(t`Search failed.`);
    } finally {
      setSearching(false);
    }
  };

  if (cols === null) return <SearchPlaygroundSkeleton />;

  const active = cols.find((c) => c.slug === slug);
  const modeOptions = [
    { value: "auto", label: t`Auto`, hint: t`whatever the collection has enabled` },
    { value: "fts", label: t`Full-text`, hint: t`keyword index` },
    { value: "vector", label: t`Vector`, hint: t`semantic embeddings` },
    { value: "hybrid", label: t`Hybrid`, hint: t`RRF fusion of both` },
  ];

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Search playground`}
        description={t`Run ranked full-text, vector, or hybrid search against a collection — same permissions and visibility as the API.`}
      />

      <Card className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-[220px_minmax(0,1fr)_170px_auto] items-end gap-2.5 max-[820px]:grid-cols-1 [&>*]:min-w-0">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              <Trans>Collection</Trans>
            </span>
            <Select
              value={slug}
              onChange={(v) => {
                setSlug(v);
                setResults(null);
                setUsedMode(null);
                setError(null);
              }}
              options={cols.map((c) => ({
                value: c.slug,
                label: c.slug,
                badge: c.fts ? (
                  <Badge variant="outline" mono>
                    FTS
                  </Badge>
                ) : undefined,
              }))}
              placeholder={t`Pick a collection`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              <Trans>Query</Trans>
            </span>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
              placeholder={t`What are you looking for?`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              <Trans>Mode</Trans>
            </span>
            <Select value={mode} onChange={(v) => setMode(v as SearchMode)} options={modeOptions} />
          </div>
          <div className="flex justify-end">
            <Button icon={I.Search} onClick={() => void run()} disabled={!slug || !q.trim() || searching}>
              {searching ? <Trans>Searching…</Trans> : <Trans>Search</Trans>}
            </Button>
          </div>
        </div>
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive [overflow-wrap:anywhere]">
            {error}
          </div>
        )}
      </Card>

      {searching ? (
        <Card className="flex flex-col gap-0 py-0">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
              <Skeleton className="size-6 rounded-md" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/5" />
              </div>
            </div>
          ))}
        </Card>
      ) : results === null ? (
        <EmptyState
          icon={I.Search}
          title={t`Search a collection`}
          description={t`Pick a collection, type a query, and run it. Full-text needs the collection's FTS switch on; vector needs an embedding model configured.`}
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon={I.Search}
          title={t`No matches`}
          description={t`Nothing ranked for that query — try different words or another mode.`}
        />
      ) : (
        <Card className="flex flex-col gap-0 py-0">
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
            <span className="text-xs tabular-nums text-muted-foreground">
              <Trans>{results.length} result(s)</Trans>
            </span>
            {usedMode && (
              <Badge variant="outline" mono>
                {usedMode}
              </Badge>
            )}
          </div>
          {results.map((row, i) => (
            <div
              key={String(row.id ?? i)}
              className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0"
            >
              <span className="text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate">
                  {rowLabel(row, {
                    displayTemplate: active?.displayTemplate ?? null,
                    fields: active?.fields,
                  })}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {shortId(row.id)}
                </span>
              </div>
              <span />
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
