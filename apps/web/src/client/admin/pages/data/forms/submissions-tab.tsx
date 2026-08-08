import type { PushToast } from "../../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../../icons";
import {
  Button,
  EmptyState,
} from "../../../ui";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@backlex/ui/components/sheet";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ConfirmDialog } from "../../../sheet";
import {
  itemsApi,
  type ApiForm,
  type ApiFormBlock,
  type ApiFormEligibleField,
} from "../../../api";
import { relTime } from "./shared";

const MONO_TYPES = new Set(["integer", "number", "timestamp", "uuid"]);

function SubmissionDrawer({
  form,
  fieldBlocks,
  efByName,
  row,
  onClose,
  onDeleted,
  onOpenCollection,
  pushToast,
}: {
  form: ApiForm;
  fieldBlocks: ApiFormBlock[];
  efByName: Map<string, ApiFormEligibleField>;
  row: Record<string, unknown> | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onOpenCollection: () => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!row) return null;

  const id = String(row.id ?? "");
  // Headline: first text-ish answer; subline: first email-format answer.
  const nameField = fieldBlocks.find((b) => {
    const ef = efByName.get(b.name ?? "");
    return ef && (ef.type === "text" || ef.type === "longtext") && ef.format !== "email" && row[b.name!];
  });
  const emailField = fieldBlocks.find(
    (b) => efByName.get(b.name ?? "")?.format === "email" && row[b.name!],
  );
  const headline = String((nameField && row[nameField.name!]) ?? id);
  const initials = headline
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await itemsApi.remove(form.collection, id);
      onDeleted(id);
      onClose();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        className="flex flex-col gap-0 border-l border-primary/30 p-0"
        style={{ width: 434, maxWidth: "92vw" }}
      >
        {/* header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4.5 py-4">
          <div
            className="grid size-9 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white"
            style={{ background: "linear-gradient(135deg,#8B6CFF,#ff9d83)" }}
          >
            {initials || "•"}
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-[14.5px] font-bold">{headline}</SheetTitle>
            {emailField && (
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {String(row[emailField.name!])}
              </div>
            )}
          </div>
        </div>
        {/* meta grid */}
        <div className="grid shrink-0 grid-cols-2 gap-x-3.5 gap-y-2 border-b border-border px-4.5 py-3 text-[11px]">
          <div>
            <span className="text-muted-foreground/70"><Trans>Submitted</Trans></span>
            <div className="mt-0.5 font-mono text-[11.5px]">{relTime(row.createdAt ?? row.created_at)}</div>
          </div>
          <div>
            <span className="text-muted-foreground/70"><Trans>Row</Trans></span>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-primary">{id}</div>
          </div>
          <div>
            <span className="text-muted-foreground/70"><Trans>Checks</Trans></span>
            <div className="mt-0.5 font-mono text-[11.5px] text-emerald-400">
              honeypot ✓{form.settings?.turnstile ? " turnstile ✓" : ""}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground/70"><Trans>Collection</Trans></span>
            <div className="mt-0.5 truncate font-mono text-[11.5px]">{form.collection}</div>
          </div>
        </div>
        {/* answers */}
        <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
          <div className="flex flex-col px-4.5 pb-3.5 pt-1.5">
            {fieldBlocks
              .filter((b) => b.name)
              .map((b) => {
                const ef = efByName.get(b.name!);
                const v = row[b.name!];
                const mono = ef ? MONO_TYPES.has(ef.type) || Boolean(ef.format) : false;
                return (
                  <div key={b.name} className="border-b border-border/60 py-2.5 last:border-b-0">
                    <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground/70">
                      {b.name}
                    </div>
                    {v === null || v === undefined || v === "" ? (
                      <div className="text-[13px] text-muted-foreground/50">—</div>
                    ) : mono ? (
                      <div className="break-all font-mono text-[12.5px] text-muted-foreground">{String(v)}</div>
                    ) : (
                      <div className="text-[13px] leading-relaxed">{String(v)}</div>
                    )}
                  </div>
                );
              })}
          </div>
        </ScrollArea>
        {/* footer */}
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-background/60 px-4.5 py-3.5">
          <Button variant="ghost" icon={I.ExternalLink} onClick={onOpenCollection}>
            <Trans>Open in {form.collection}</Trans>
          </Button>
          <div className="flex-1" />
          <button
            type="button"
            title={t`Delete submission`}
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            className="grid size-8 place-items-center rounded-control border border-orange-300/40 bg-orange-300/5 text-orange-300 hover:bg-orange-300/10"
          >
            <I.Trash size={14} />
          </button>
        </div>
        <ConfirmDialog
          open={confirmDelete}
          title={t`Delete this submission?`}
          description={t`The row is removed from the collection. This can't be undone.`}
          actionLabel={t`Delete`}
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      </SheetContent>
    </Sheet>
  );
}

/* ── submissions tab ───────────────────────────────────────────────── */

export function SubmissionsTab({
  form,
  fieldBlocks,
  efByName,
  pushToast,
  onOpenCollection,
}: {
  form: ApiForm;
  fieldBlocks: ApiFormBlock[];
  efByName: Map<string, ApiFormEligibleField>;
  pushToast: PushToast;
  onOpenCollection: () => void;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selRow, setSelRow] = useState<Record<string, unknown> | null>(null);

  // Row lifecycle (draft/published) is the COLLECTION's concern, not the
  // form's — moderate it in the collection view. This tab only shows what
  // arrived. The form's own status (live/paused) lives on the list cards.
  const cols = fieldBlocks.slice(0, 4).map((b) => b.name!).filter(Boolean);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    const query: Record<string, string | number> = { limit: 50, sort: "-created_at", meta: "filter_count" };
    itemsApi
      .list(form.collection, query)
      .then((r) => {
        if (cancelled) return;
        setRows(r.data);
        setTotal(r.meta?.filter_count ?? r.meta?.total_count ?? r.data.length);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [form.collection]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-3 max-[860px]:grid-cols-2">
        {[
          { label: t`Total`, value: String(form.submissionCount), sub: t`accepted, all time` },
          { label: t`Blocked`, value: String(form.blockedCount), sub: t`turnstile + honeypot + rate limit` },
          { label: t`Last submission`, value: relTime(form.lastSubmissionAt), sub: t`ago` },
          {
            label: t`Rows in collection`,
            value: total === null ? "…" : String(total),
            sub: form.collection,
          },
        ].map((s, i) => (
          <Card key={i} className="gap-1 p-4">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">{s.label}</span>
            <span className="text-[22px] font-semibold tabular-nums">{s.value}</span>
            <span className="truncate text-[11px] text-muted-foreground">{s.sub}</span>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => window.open(`/api/items/${form.collection}/export?format=csv`, "_blank")}
          className="ml-auto flex items-center gap-2 rounded-[12px] border border-white/10 bg-white/[0.03] px-4 py-2 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/15 hover:text-foreground"
        >
          <I.Download size={14} />
          <Trans>Export CSV</Trans>
        </button>
      </div>

      <Card className="gap-0 py-0">
        {rows === null ? (
          <div className="flex flex-col">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            bare
            size="md"
            icon={I.Form}
            title={<Trans>No submissions yet</Trans>}
            description={<Trans>Share the public link — rows land here (and in the collection) as they arrive.</Trans>}
          />
        ) : (
          <ScrollArea viewportClassName="max-h-[calc(100vh-24rem)]" className="w-full">
            <div className="min-w-[720px]">
              <div
                className="grid items-center gap-3 border-b border-border px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                style={{ gridTemplateColumns: `110px repeat(${cols.length}, 1fr)` }}
              >
                <span><Trans>When</Trans></span>
                {cols.map((c) => (
                  <span key={c} className="truncate">{c}</span>
                ))}
              </div>
              {rows.map((r, i) => (
                <div
                  key={String(r.id ?? i)}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelRow(r)}
                  onKeyDown={(e) => e.key === "Enter" && setSelRow(r)}
                  className="grid cursor-pointer items-center gap-3 border-b border-border px-3.5 py-[10px] text-[12.5px] transition-colors last:border-b-0 hover:bg-accent/40"
                  style={{ gridTemplateColumns: `110px repeat(${cols.length}, 1fr)` }}
                >
                  {/* serialized rows expose camelCase system keys (createdAt) */}
                  <span className="font-mono text-[11px] text-muted-foreground">{relTime(r.createdAt ?? r.created_at)}</span>
                  {cols.map((c) => (
                    <span key={c} className="truncate">{r[c] === null || r[c] === undefined ? "—" : String(r[c])}</span>
                  ))}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
        {rows !== null && rows.length > 0 && (
          <div className="flex items-center justify-between border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
            <span><Trans>Showing {rows.length} of {total ?? rows.length} rows</Trans></span>
            <span>
              <Trans>rows live in <span className="font-mono">{form.collection}</span></Trans>
            </span>
          </div>
        )}
      </Card>

      <SubmissionDrawer
        form={form}
        fieldBlocks={fieldBlocks}
        efByName={efByName}
        row={selRow}
        onClose={() => setSelRow(null)}
        onDeleted={(id) => {
          setRows((prev) => (prev ? prev.filter((r) => String(r.id) !== id) : prev));
          setTotal((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
        }}
        onOpenCollection={onOpenCollection}
        pushToast={pushToast}
      />
    </div>
  );
}

/* ── insert palette ────────────────────────────────────────────────── */
