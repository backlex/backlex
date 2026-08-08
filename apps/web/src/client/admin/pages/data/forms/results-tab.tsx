
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../../icons";
import {
  Badge,
  EmptyState,
} from "../../../ui";
import { cn } from "@backlex/ui/lib/utils";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  formsApi,
  type ApiForm,
  type ApiFormResultBlock,
  type ApiFormResults,
} from "../../../api";

/** A labelled bar. Width is the count against the biggest bucket, so the
 *  shape of the answers is readable even when every share is small; the number
 *  next to it is the share of people who answered, which is the figure being
 *  read out loud. */
function ResultBar({
  label,
  count,
  max,
  share,
}: {
  label: string;
  count: number;
  max: number;
  share: number | null;
}) {
  // A point nobody picked draws NO bar. The minimum width is there so a single
  // answer among hundreds is still visible, but applying it at zero would show
  // a sliver where the honest answer is nothing.
  const width = count > 0 && max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-[34%] max-w-[220px] shrink-0 truncate text-[12.5px]" title={label}>
        {label}
      </span>
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
      </span>
      <span className="w-[74px] shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">
        {count}
        {share !== null && <span className="ml-1.5 opacity-70">{share}%</span>}
      </span>
    </div>
  );
}

/** Results, folded back into the questions they were asked as: a run of blocks
 *  sharing a matrix id is one grid, everything else is one card. */
const groupResultBlocks = (
  blocks: ApiFormResultBlock[],
): Array<
  | { kind: "one"; block: ApiFormResultBlock }
  | { kind: "matrix"; id: string; label: string; blocks: ApiFormResultBlock[] }
> => {
  const out: Array<
    | { kind: "one"; block: ApiFormResultBlock }
    | { kind: "matrix"; id: string; label: string; blocks: ApiFormResultBlock[] }
  > = [];
  for (const block of blocks) {
    const m = block.matrix;
    if (!m) {
      out.push({ kind: "one", block });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "matrix" && last.id === m.id) {
      last.blocks.push(block);
      continue;
    }
    out.push({ kind: "matrix", id: m.id, label: m.label, blocks: [block] });
  }
  return out;
};

/**
 * What the answers add up to.
 *
 * One card per question, drawn from `/results` — which counts and never
 * quotes. Free-text questions therefore show their answered count and send you
 * to the collection, where the words are read under the collection's own
 * permissions instead of a second time here.
 */
export function ResultsTab({
  form,
  onOpenCollection,
}: {
  form: ApiForm;
  onOpenCollection: () => void;
}) {
  const { t } = useLingui();
  const [data, setData] = useState<ApiFormResults | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    formsApi
      .results(form.id)
      .then((r) => {
        if (!cancelled) setData(r.data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [form.id]);

  if (failed) {
    return (
      <EmptyState
        icon={I.Gauge}
        title={<Trans>Results can't be read</Trans>}
        description={
          <Trans>
            The collection this form writes into may have been deleted or renamed.
          </Trans>
        }
      />
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3 max-[860px]:grid-cols-1">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="gap-2 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-16" />
            </Card>
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <Card key={i} className="gap-3 p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-2/3" />
          </Card>
        ))}
      </div>
    );
  }

  if (data.rows === 0) {
    return (
      <EmptyState
        icon={I.Gauge}
        title={<Trans>No answers yet</Trans>}
        description={
          <Trans>Share the public link — every question gets a breakdown here as answers arrive.</Trans>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "grid gap-3 max-[860px]:grid-cols-1",
          data.inProgress > 0 ? "grid-cols-4" : "grid-cols-3",
        )}
      >
        {[
          { label: t`Rows`, value: String(data.rows), sub: data.collection },
          {
            label: t`Submissions`,
            value: String(data.submissionCount),
            sub: t`accepted through this form`,
          },
          // Only when there are any: a zero here on a form that saves progress
          // reads as a problem, and on one that doesn't it is noise.
          ...(data.inProgress > 0
            ? [
                {
                  label: t`In progress`,
                  value: String(data.inProgress),
                  sub: t`started, not submitted`,
                },
              ]
            : []),
          { label: t`Questions`, value: String(data.blocks.length), sub: t`summarised` },
        ].map((s, i) => (
          <Card key={i} className="gap-1 p-4">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              {s.label}
            </span>
            <span className="text-[22px] font-semibold tabular-nums">{s.value}</span>
            <span className="truncate text-[11px] text-muted-foreground">{s.sub}</span>
          </Card>
        ))}
      </div>

      {/* The counts are the collection's, not the form's — nothing stamps a row
          with the form that wrote it, so say so rather than implying otherwise. */}
      <p className="text-[11.5px] text-muted-foreground">
        <Trans>
          Counts cover every row in {data.collection}, including any written outside this form.
        </Trans>
      </p>

      {groupResultBlocks(data.blocks).map((g) =>
        g.kind === "matrix" ? (
          // A matrix was asked as one question, so its rows are read back
          // under it — the same grouping the form drew, not a scattering of
          // near-identical cards the operator has to reassemble by eye.
          <div key={g.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 px-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              <I.Grid3 size={11} />
              <span className="min-w-0 truncate">{g.label}</span>
            </div>
            <div className="flex flex-col gap-2 border-l border-border pl-3">
              {g.blocks.map((b) => resultCard(b))}
            </div>
          </div>
        ) : (
          resultCard(g.block)
        ),
      )}

      {data.truncated > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          <Trans>{data.truncated} more questions are not summarised — this form has more than the panel computes.</Trans>
        </p>
      )}
    </div>
  );

  function resultCard(b: ApiFormResultBlock) {
    const max = b.buckets?.reduce((m, k) => Math.max(m, k.count), 0) ?? 0;
    return (
          <Card key={b.name} className="gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[13.5px] font-semibold">{b.label}</span>
              <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                {b.nps && (
                  <Badge mono variant={b.nps.score >= 0 ? "default" : "destructive"}>
                    <Trans>NPS {b.nps.score}</Trans>
                  </Badge>
                )}
                {b.nps === null && b.average !== null && (
                  <Badge mono variant="secondary">
                    <Trans>avg {b.average}</Trans>
                  </Badge>
                )}
                <span>
                  {b.answered} <Trans>answered</Trans>
                </span>
              </span>
            </div>

            {b.buckets ? (
              <div className="flex flex-col gap-2">
                {b.buckets.map((k) => (
                  <ResultBar
                    key={k.value}
                    // `true`/`false` is how the column stores it, not how a
                    // person reads it — and the API stays language-neutral, so
                    // the wording belongs here.
                    label={
                      b.kind === "boolean" ? (k.value === "true" ? t`Yes` : t`No`) : k.label
                    }
                    count={k.count}
                    max={max}
                    share={b.answered > 0 ? Math.round((k.count / b.answered) * 100) : null}
                  />
                ))}
                {b.kind === "multi_choice" && (
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>Several answers allowed, so the shares can add up to more than 100%.</Trans>
                  </span>
                )}
                {b.nps && (
                  // Label first, count second — "1 passives" would need a
                  // plural rule in every locale to say nothing extra.
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>
                      promoters {b.nps.promoters} · passives {b.nps.passives} · detractors{" "}
                      {b.nps.detractors}
                    </Trans>
                  </span>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={onOpenCollection}
                className="flex items-center gap-2 self-start text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <I.ExternalLink size={13} />
                <Trans>Written answers are not shown here — read them in the collection</Trans>
              </button>
            )}
          </Card>
    );
  }
}
