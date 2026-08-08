
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../../icons";
import {
  IconButton,
  Switch,
} from "../../../ui";
import { Select } from "../../../select";
import { cn } from "@backlex/ui/lib/utils";
import { Input } from "@backlex/ui/components/input";
import {
  type ApiFormBlock,
  type ApiFormBlockMatrixRow,
  type ApiFormBlockScale,
  type ApiFormEligibleField,
} from "../../../api";
import { PanelCard, PanelLabel, Segmented } from "./panels";
import { blockIcon, blockScale, choiceSignature, humanize } from "./shared";

/** The fields a matrix may still take as rows: eligible, unused, and able to
 *  share the columns the rows it already has are answered on. */
const matrixRowCandidates = (
  block: ApiFormBlock,
  eligible: ApiFormEligibleField[],
  used: Set<string | undefined>,
  efByName: Map<string, ApiFormEligibleField>,
): ApiFormEligibleField[] => {
  const first = (block.rows ?? []).map((r) => efByName.get(r.name)).find(Boolean);
  const free = eligible.filter((f) => !used.has(f.name));
  if (!first) return free.filter((f) => f.type === "integer" || f.choices);
  if (block.scale) return free.filter((f) => f.type === "integer");
  const sig = choiceSignature(first);
  return sig ? free.filter((f) => choiceSignature(f) === sig) : [];
};

/** Accepted-type presets for file blocks — each chip toggles its MIME
 *  patterns in `block.accept`. No selection ⇒ any type. */
const FILE_ACCEPT_PRESETS: Array<{ key: string; patterns: string[] }> = [
  { key: "images", patterns: ["image/*"] },
  { key: "pdf", patterns: ["application/pdf"] },
  {
    key: "documents",
    patterns: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ],
  },
  {
    key: "spreadsheets",
    patterns: [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  { key: "video", patterns: ["video/*"] },
  { key: "audio", patterns: ["audio/*"] },
  { key: "archives", patterns: ["application/zip", "application/gzip", "application/x-7z-compressed"] },
];

/** Size choices for the file-block cap. The env ceiling
 *  (`FORM_UPLOAD_MAX_BYTES`, default 5 MB) still clamps at upload time. */
const FILE_SIZE_OPTIONS = [1, 2, 5, 10, 25, 50] as const;

/** Widest a hand-set scale may be — mirrors `SCALE_MAX_POINTS` on the server,
 *  which refuses anything wider. */
const SCALE_MAX_POINTS = 11;

/**
 * How an integer question is answered.
 *
 * The four styles are the whole finite set, so they are a dropdown rather than
 * a switch per style: a plain number input, a star row, a numbered row, and
 * NPS — which is a numbered row with its ends nailed to 0 and 10 because that
 * is what makes the score comparable to anyone else's.
 */
function ScaleEditor({
  block,
  ef,
  onPatch,
  allowPlain = true,
}: {
  block: ApiFormBlock;
  ef: ApiFormEligibleField;
  onPatch: (id: string, patch: Partial<ApiFormBlock>) => void;
  /** False on a matrix, where the shared scale IS the columns: dropping it
   *  would leave rows with nothing to be answered on. */
  allowPlain?: boolean;
}) {
  const { t } = useLingui();
  const scale = blockScale(block, ef);
  const style = scale?.style ?? "input";
  const set = (next: ApiFormBlockScale | undefined) =>
    // The legacy `rating` flag is cleared alongside: leaving it set would
    // resurrect the 1–5 star row on any reader that still prefers it.
    onPatch(block.id!, { scale: next, rating: undefined });

  const bounds = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      value: String(from + i),
      label: String(from + i),
    }));

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <span className="flex items-center gap-1.5">
          <I.Gauge size={12} />
          <Trans>Answer style</Trans>
        </span>
        <Select
          value={style}
          onChange={(v) => {
            if (v === "input") return set(undefined);
            if (v === "nps") return set({ min: 0, max: 10, style: "nps" });
            if (v === "stars") return set({ min: 1, max: 5, style: "stars" });
            return set({ min: scale?.min ?? 1, max: scale?.max ?? 5, style: "number" });
          }}
          options={[
            ...(allowPlain ? [{ value: "input", label: t`Number input` }] : []),
            { value: "stars", label: t`Star rating` },
            { value: "number", label: t`Numbered scale` },
            { value: "nps", label: t`NPS — how likely to recommend (0–10)` },
          ]}
        />
      </label>

      {scale && style !== "nps" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
            <Trans>From</Trans>
            <Select
              value={String(scale.min)}
              onChange={(v) => {
                const min = Number(v);
                set({ ...scale, min, max: Math.min(Math.max(scale.max, min + 1), min + SCALE_MAX_POINTS - 1) });
              }}
              options={bounds(0, 1)}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
            <Trans>To</Trans>
            <Select
              value={String(scale.max)}
              onChange={(v) => set({ ...scale, max: Number(v) })}
              options={bounds(scale.min + 1, scale.min + SCALE_MAX_POINTS - 1)}
            />
          </label>
        </div>
      )}

      {scale && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
            <Trans>Low label</Trans>
            <Input
              value={scale.minLabel ?? ""}
              placeholder={t`Not at all`}
              onChange={(e) => set({ ...scale, minLabel: e.target.value || undefined })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
            <Trans>High label</Trans>
            <Input
              value={scale.maxLabel ?? ""}
              placeholder={t`Extremely`}
              onChange={(e) => set({ ...scale, maxLabel: e.target.value || undefined })}
            />
          </label>
        </div>
      )}

      {style === "nps" && (
        <span className="text-[11px] text-muted-foreground">
          <Trans>
            Results score this as promoters (9–10) minus detractors (0–6).
          </Trans>
        </span>
      )}
    </div>
  );
}

/**
 * The rows of a matrix, and the columns they are all answered on.
 *
 * The columns are not chosen here — they follow from the fields the rows name,
 * which is why the row picker only offers fields that can be answered on the
 * columns the matrix already has. An operator cannot assemble a grid the server
 * would refuse, because the ingredients for one are never on the menu.
 */
function MatrixEditor({
  block,
  firstRowEf,
  efByName,
  eligible,
  usedNames,
  locale,
  base,
  collection,
  onPatch,
}: {
  block: ApiFormBlock;
  firstRowEf: ApiFormEligibleField | null;
  efByName: Map<string, ApiFormEligibleField>;
  eligible: ApiFormEligibleField[];
  usedNames: Set<string | undefined>;
  locale: string;
  base: string;
  collection: string;
  onPatch: (id: string, patch: Partial<ApiFormBlock>) => void;
}) {
  const { t } = useLingui();
  const rows = block.rows ?? [];
  const onScale = Boolean(block.scale) || (firstRowEf?.type === "integer" && !firstRowEf.choices);
  const candidates = matrixRowCandidates(block, eligible, usedNames, efByName);
  const setRows = (next: ApiFormBlockMatrixRow[]) => onPatch(block.id!, { rows: next });

  const patchRow = (index: number, patch: Partial<ApiFormBlockMatrixRow>) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const moveRow = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved!);
    setRows(next);
  };

  /** A row's caption in the locale being edited; empty falls back down the
   *  same chain the public page uses. */
  const rowLabel = (row: ApiFormBlockMatrixRow) =>
    locale === base ? row.label ?? "" : row.i18n?.[locale]?.label ?? "";
  const setRowLabel = (index: number, value: string) =>
    locale === base
      ? patchRow(index, { label: value || undefined })
      : patchRow(index, {
          i18n: {
            ...rows[index]?.i18n,
            [locale]: { ...rows[index]?.i18n?.[locale], label: value || undefined },
          },
        });

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex flex-col gap-1.5">
        <PanelLabel>
          <span className="flex items-center gap-1">
            <I.Grid3 size={11} />
            <Trans>rows · {rows.length}</Trans>
          </span>
        </PanelLabel>
        {rows.map((row, i) => {
          const rowEf = efByName.get(row.name);
          return (
            <div key={row.name} className="flex items-center gap-1.5">
              <div className="flex shrink-0 flex-col">
                <button
                  type="button"
                  title={t`Move up`}
                  onClick={() => moveRow(i, -1)}
                  className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground"
                >
                  <I.ChevronUp size={10} />
                </button>
                <button
                  type="button"
                  title={t`Move down`}
                  onClick={() => moveRow(i, 1)}
                  className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground"
                >
                  <I.ChevronDown size={10} />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <Input
                  value={rowLabel(row)}
                  placeholder={
                    locale === base
                      ? rowEf?.label ?? humanize(row.name)
                      : row.label || rowEf?.label || humanize(row.name)
                  }
                  onChange={(e) => setRowLabel(i, e.target.value)}
                />
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                  {row.name}
                  {!rowEf && <span className="text-destructive"> · <Trans>not on this collection</Trans></span>}
                </span>
              </div>
              {rows.length > 1 && !rowEf?.required && (
                <IconButton
                  icon={I.X}
                  title={t`Remove row`}
                  onClick={() => setRows(rows.filter((_, x) => x !== i))}
                />
              )}
            </div>
          );
        })}
        {candidates.length > 0 ? (
          <Select
            value=""
            onChange={(v) => v && setRows([...rows, { name: v }])}
            options={[
              { value: "", label: t`Add a row…` },
              ...candidates.map((f) => ({
                value: f.name,
                label: f.label ?? humanize(f.name),
              })),
            ]}
          />
        ) : (
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            {onScale ? (
              <Trans>Every free number field on <span className="font-mono">{collection}</span> is already on the form.</Trans>
            ) : (
              <Trans>No other field on <span className="font-mono">{collection}</span> offers these same choices.</Trans>
            )}
          </span>
        )}
      </div>

      {onScale && firstRowEf ? (
        <ScaleEditor block={block} ef={firstRowEf} onPatch={onPatch} allowPlain={false} />
      ) : (
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <PanelLabel><Trans>columns · from schema enum</Trans></PanelLabel>
          <div className="flex flex-wrap gap-1">
            {(firstRowEf?.choices ?? []).map((c) => (
              <span key={c} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {c}
              </span>
            ))}
          </div>
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            <Trans>Every row is answered on these — edit them on the field in <span className="font-mono">{collection}</span>.</Trans>
          </span>
        </div>
      )}
    </div>
  );
}

export function BlockPanel({
  block,
  ef,
  fieldBlocks,
  efByName,
  eligible,
  usedNames,
  locale,
  base,
  collection,
  onText,
  onPatch,
  onRemove,
  onClose,
}: {
  block: ApiFormBlock;
  ef: ApiFormEligibleField | null;
  fieldBlocks: ApiFormBlock[];
  efByName: Map<string, ApiFormEligibleField>;
  eligible: ApiFormEligibleField[];
  usedNames: Set<string | undefined>;
  locale: string;
  base: string;
  collection: string;
  onText: (id: string, key: "label" | "placeholder" | "help", value: string) => void;
  onPatch: (id: string, patch: Partial<ApiFormBlock>) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const isStep = (block.kind ?? "field") === "step";
  const isMatrix = block.kind === "matrix";
  // The first row decides what the rest can be — it is the field whose type
  // (or choices) the columns are drawn from.
  const firstRowEf = isMatrix
    ? (block.rows ?? []).map((r) => efByName.get(r.name)).find(Boolean) ?? null
    : null;
  // A matrix holding a schema-required field can't be removed for the same
  // reason a required field block can't: the form would stop validating.
  const holdsRequired = isMatrix
    ? (block.rows ?? []).some((r) => efByName.get(r.name)?.required)
    : Boolean(ef?.required);
  const loc = locale !== base ? block.i18n?.[locale] : undefined;
  const val = (key: "label" | "placeholder" | "help") =>
    locale === base ? (block[key] ?? "") : (loc?.[key] ?? "");
  const basePh = (key: "label" | "placeholder" | "help") =>
    locale === base
      ? key === "label" && ef
        ? ef.label ?? humanize(ef.name)
        : ""
      : block[key] || (key === "label" && ef ? ef.label ?? humanize(ef.name) : "");

  // Condition sources: other dropdown field-blocks (design: choice fields).
  const condSources = fieldBlocks.filter(
    (b) => b.name !== block.name && efByName.get(b.name ?? "")?.choices,
  );
  const condChoices = block.cond
    ? efByName.get(block.cond.field)?.choices ?? []
    : [];

  return (
    <PanelCard
      icon={blockIcon(ef, block)}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[12px]">
            {isStep ? t`Step break` : isMatrix ? t`Matrix` : block.name}
          </span>
          {ef && <span className="text-[10px] font-normal text-muted-foreground">{ef.type}</span>}
        </span>
      }
      onClose={onClose}
    >
      {locale !== base && (
        <div className="rounded-control border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary">
          <Trans>editing {locale.toUpperCase()} — empty falls back to {base.toUpperCase()}</Trans>
        </div>
      )}
      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Label</Trans>
        <Input
          value={val("label")}
          placeholder={basePh("label")}
          onChange={(e) => onText(block.id!, "label", e.target.value)}
        />
      </label>
      {!isStep && ef && !ef.choices && ef.type !== "boolean" && ef.type !== "file" && !blockScale(block, ef) && (
        <label className="flex flex-col gap-1 text-[12px] font-medium">
          <Trans>Placeholder</Trans>
          <Input
            value={val("placeholder")}
            placeholder={basePh("placeholder")}
            onChange={(e) => onText(block.id!, "placeholder", e.target.value)}
          />
        </label>
      )}
      {!isStep && (
        <label className="flex flex-col gap-1 text-[12px] font-medium">
          <Trans>Help text</Trans>
          <Input
            value={val("help")}
            placeholder={basePh("help")}
            onChange={(e) => onText(block.id!, "help", e.target.value)}
          />
        </label>
      )}

      {!isStep && ef && (
        <div className="flex items-center justify-between gap-2 text-[12px] font-medium">
          <div className="min-w-0">
            <Trans>Required</Trans>
            {block.consent && ef.type === "boolean" ? (
              <div className="mt-0.5 flex items-center gap-1 text-[10.5px] font-normal text-muted-foreground">
                <I.Shield size={10} />
                <Trans>consent must be accepted — always required</Trans>
              </div>
            ) : ef.required ? (
              <div className="mt-0.5 flex items-center gap-1 text-[10.5px] font-normal text-muted-foreground">
                <I.Lock size={10} />
                <Trans>required by the collection schema</Trans>
              </div>
            ) : (
              <div className="mt-0.5 text-[10.5px] font-normal text-muted-foreground"><Trans>optional</Trans></div>
            )}
          </div>
          {(block.consent && ef.type === "boolean") || ef.required ? (
            <span className="pointer-events-none opacity-55">
              <Switch checked onChange={() => {}} />
            </span>
          ) : null}
        </div>
      )}

      {!isStep && !isMatrix && ef?.type === "integer" && (
        <ScaleEditor block={block} ef={ef} onPatch={onPatch} />
      )}

      {isMatrix && (
        <MatrixEditor
          block={block}
          firstRowEf={firstRowEf}
          efByName={efByName}
          eligible={eligible}
          usedNames={usedNames}
          locale={locale}
          base={base}
          collection={collection}
          onPatch={onPatch}
        />
      )}

      {!isStep && ef?.type === "file" && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <label className="flex flex-col gap-1 text-[12px] font-medium">
            <span className="flex items-center gap-1.5"><I.Upload size={12} /><Trans>Max file size</Trans></span>
            <Select
              value={block.maxBytes ? String(block.maxBytes) : "default"}
              onChange={(v) =>
                onPatch(block.id!, { maxBytes: v === "default" ? undefined : Number(v) })
              }
              options={[
                { value: "default", label: t`Server default (5 MB)` },
                ...FILE_SIZE_OPTIONS.map((mb) => ({
                  value: String(mb * 1024 * 1024),
                  label: `${mb} MB`,
                })),
              ]}
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              <Trans>The server-wide upload ceiling still applies on top.</Trans>
            </span>
          </label>
          <div className="flex flex-col gap-1.5">
            <PanelLabel><Trans>Accepted types</Trans></PanelLabel>
            <div className="flex flex-wrap gap-1">
              {FILE_ACCEPT_PRESETS.map((preset) => {
                const cur = block.accept ?? [];
                const active = preset.patterns.every((pt) => cur.includes(pt));
                const labels: Record<string, string> = {
                  images: t`Images`,
                  pdf: t`PDF`,
                  documents: t`Documents`,
                  spreadsheets: t`Spreadsheets`,
                  video: t`Video`,
                  audio: t`Audio`,
                  archives: t`Archives`,
                };
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => {
                      const next = active
                        ? cur.filter((x) => !preset.patterns.includes(x))
                        : [...cur, ...preset.patterns.filter((x) => !cur.includes(x))];
                      onPatch(block.id!, { accept: next.length ? next : undefined });
                    }}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11.5px] transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50",
                    )}
                  >
                    {labels[preset.key]}
                  </button>
                );
              })}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {block.accept?.length ? (
                <Trans>Only the selected types are accepted — enforced server-side.</Trans>
              ) : (
                <Trans>No selection — any file type is accepted.</Trans>
              )}
            </span>
          </div>
        </div>
      )}

      {!isStep && ef?.type === "boolean" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[12px] font-medium">
            <span className="flex items-center gap-1.5"><I.Shield size={12} /><Trans>Consent checkbox</Trans></span>
            <Switch checked={Boolean(block.consent)} onChange={(v) => onPatch(block.id!, { consent: v })} />
          </div>
          {block.consent && (
            <>
              <span className="text-[11px] text-muted-foreground">
                <Trans>Visitors must tick it to submit — enforced server-side. Put the
                consent sentence in the Label.</Trans>
              </span>
              <label className="flex flex-col gap-1 text-[12px] font-medium">
                <Trans>Policy URL</Trans>
                <Input
                  value={block.policyUrl ?? ""}
                  placeholder="https://example.com/privacy"
                  onChange={(e) => onPatch(block.id!, { policyUrl: e.target.value || undefined })}
                />
                <span className="text-[11px] font-normal text-muted-foreground">
                  <Trans>Shown as a "read the full text" link next to the checkbox.</Trans>
                </span>
              </label>
            </>
          )}
        </div>
      )}

      {!isStep && ef?.choices && (
        <div className="flex flex-col gap-1.5">
          <PanelLabel><Trans>choices · from schema enum</Trans></PanelLabel>
          <div className="flex flex-wrap gap-1">
            {ef.choices.map((c) => (
              <span key={c} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {c}
              </span>
            ))}
          </div>
          <span className="text-[10.5px] text-muted-foreground">
            <Trans>edit choices on the field in <span className="font-mono">{collection}</span></Trans>
          </span>
        </div>
      )}

      {!isStep && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <PanelLabel>
            <span className="flex items-center gap-1"><I.Network size={11} /><Trans>Logic</Trans></span>
          </PanelLabel>
          {block.cond ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11.5px] text-muted-foreground"><Trans>Show this block only when</Trans></span>
              <Select
                value={block.cond.field}
                onChange={(v) =>
                  onPatch(block.id!, { cond: { ...block.cond!, field: v, value: efByName.get(v)?.choices?.[0] ?? "" } })
                }
                options={condSources.map((b) => ({ value: b.name!, label: b.name! }))}
              />
              <Segmented
                value={block.cond.op}
                onChange={(v) => onPatch(block.id!, { cond: { ...block.cond!, op: v } })}
                options={[
                  { value: "is", label: t`is` },
                  { value: "is_not", label: t`is not` },
                ]}
              />
              <Select
                value={block.cond.value}
                onChange={(v) => onPatch(block.id!, { cond: { ...block.cond!, value: v } })}
                options={condChoices.map((c) => ({ value: c, label: c }))}
              />
              <button
                type="button"
                onClick={() => onPatch(block.id!, { cond: undefined })}
                className="self-start text-[11.5px] text-destructive hover:underline"
              >
                <Trans>Remove condition</Trans>
              </button>
            </div>
          ) : condSources.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                const src = condSources[0]!;
                onPatch(block.id!, {
                  cond: {
                    field: src.name!,
                    op: "is",
                    value: efByName.get(src.name!)?.choices?.[0] ?? "",
                  },
                });
              }}
              className="flex w-full items-center justify-center gap-2 rounded-control border border-dashed border-primary/40 px-3 py-2.5 text-[13px] font-medium text-primary transition-colors hover:border-primary hover:bg-primary/5"
            >
              <I.Plus size={13} />
              <Trans>Show conditionally</Trans>
            </button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              <Trans>Add a dropdown field to the form to build show-conditions on it.</Trans>
            </span>
          )}
        </div>
      )}

      {isStep && (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          <Trans>Step breaks split the form into pages — presentation only, nothing is
          written to the collection.</Trans>
        </p>
      )}

      {!isStep && holdsRequired ? (
        <div className="flex items-center justify-center gap-1.5 rounded-control border border-dashed border-border px-3 py-2.5 text-[11.5px] text-muted-foreground">
          <I.Lock size={11} />
          <Trans>required by the schema — can't be removed from the form</Trans>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onRemove(block.id!)}
            className="flex w-full items-center justify-center gap-2 rounded-control border border-orange-300/40 bg-orange-300/5 px-3 py-2.5 text-[13px] font-medium text-orange-300 transition-colors hover:border-orange-300/70 hover:bg-orange-300/10"
          >
            <I.Trash size={13} />
            <Trans>Remove from form</Trans>
          </button>
          {!isStep && (
            <span className="text-center text-[11px] text-muted-foreground">
              <Trans>the field stays in the collection</Trans>
            </span>
          )}
        </div>
      )}
    </PanelCard>
  );
}

/* ── right panel: ending ───────────────────────────────────────────── */
