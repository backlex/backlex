// Shared rollup editor — the Rollup tab of the Add / Edit field dialogs, shown
// for the `rollup` interface. A rollup column is an aggregate over ANOTHER
// collection's rows, so every part of it names something that must actually
// exist. Rather than validate free text after the fact, each control is a
// dropdown built from the schema already in memory: the source list holds only
// collections that relate back here, the relation list only that collection's
// relations that point at us, the value list only its numeric columns. An
// invalid rollup is unreachable rather than rejected.
import { useMemo } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Select } from "../select";
import {
  type GroupNode,
  newGroup,
  objToTree,
  RuleBuilder,
  ruleTreeToObj,
  treeHasRule,
} from "../rule-builder";

export interface RollupDraft {
  fn: string;
  from: string;
  via: string;
  field: string;
  filter: GroupNode;
}

export const emptyRollupDraft = (): RollupDraft => ({
  fn: "sum",
  from: "",
  via: "",
  field: "",
  filter: newGroup(),
});

/** Hydrate a draft from a stored `rollup` object. */
export const rollupToDraft = (v: unknown): RollupDraft => {
  if (!v || typeof v !== "object") return emptyRollupDraft();
  const o = v as Record<string, unknown>;
  return {
    fn: typeof o.fn === "string" ? o.fn : "sum",
    from: typeof o.from === "string" ? o.from : "",
    via: typeof o.via === "string" ? o.via : "",
    field: typeof o.field === "string" ? o.field : "",
    filter: o.filter ? objToTree(o.filter) : newGroup(),
  };
};

/** Compile a draft into the `rollup` object, or undefined when incomplete.
 *  `count` deliberately drops `field` — the server rejects a count that
 *  carries one, because counting rows takes no column. */
export const cleanRollup = (d: RollupDraft): Record<string, unknown> | undefined => {
  if (!d.from || !d.via || !d.fn) return undefined;
  if (d.fn !== "count" && !d.field) return undefined;
  return {
    from: d.from,
    via: d.via,
    fn: d.fn,
    ...(d.fn === "count" ? {} : { field: d.field }),
    ...(treeHasRule(d.filter) ? { filter: ruleTreeToObj(d.filter) } : {}),
  };
};

/** Storage type a rollup must land in for a given aggregate. `avg` needs a
 *  decimal column or the average truncates; the rest are happy either way, and
 *  `count` is whole by definition. Mirrors the server-side rule. */
export const rollupStorageType = (fn: string): "integer" | "number" =>
  fn === "count" ? "integer" : "number";

interface CollectionLike {
  slug: string;
  fieldDefs?: Array<{ name: string; type: string; to?: string; rollup?: unknown }>;
}

export function FieldRollupEditor({
  /** Slug of the collection this field belongs to — the rollup's parent. */
  ownerSlug,
  collections,
  value,
  onChange,
}: {
  ownerSlug: string;
  collections: CollectionLike[];
  value: RollupDraft;
  onChange: (d: RollupDraft) => void;
}) {
  const { t } = useLingui();
  const set = (patch: Partial<RollupDraft>) => onChange({ ...value, ...patch });

  // Only collections carrying a `relation` field aimed at THIS collection can
  // be rolled up — anything else has no way to say which parent a row belongs
  // to. relation_many is excluded: it holds a list, not one parent.
  const sources = useMemo(
    () =>
      (collections ?? [])
        .filter(
          (c) =>
            c.slug !== ownerSlug &&
            (c.fieldDefs ?? []).some((f) => f.type === "relation" && f.to === ownerSlug),
        )
        .map((c) => ({ value: c.slug, label: c.slug })),
    [collections, ownerSlug],
  );

  const source = useMemo(
    () => (collections ?? []).find((c) => c.slug === value.from),
    [collections, value.from],
  );
  const sourceFields = source?.fieldDefs ?? [];

  const viaOptions = useMemo(
    () =>
      sourceFields
        .filter((f) => f.type === "relation" && f.to === ownerSlug)
        .map((f) => ({ value: f.name, label: f.name })),
    [sourceFields, ownerSlug],
  );

  // A rollup over a rollup would lag a write behind, so the inner ones are not
  // offered (the server refuses them too).
  const valueOptions = useMemo(
    () =>
      sourceFields
        .filter((f) => (f.type === "integer" || f.type === "number") && !f.rollup)
        .map((f) => ({ value: f.name, label: f.name, hint: f.type })),
    [sourceFields],
  );

  const filterFields = useMemo(() => sourceFields.map((f) => f.name), [sourceFields]);

  /** Picking a source auto-selects the only relation back when there is one —
   *  which is the overwhelmingly common shape (`invoice_lines.invoice`). */
  const pickSource = (slug: string) => {
    const c = (collections ?? []).find((x) => x.slug === slug);
    const backs = (c?.fieldDefs ?? []).filter((f) => f.type === "relation" && f.to === ownerSlug);
    set({ from: slug, via: backs.length === 1 ? (backs[0]?.name ?? "") : "", field: "", filter: newGroup() });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        <Trans>
          This column is kept up to date by backlex from another collection's rows — it is
          read-only through the API, and every write to those rows restates it.
        </Trans>
      </p>

      {sources.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          <Trans>
            No collection points at this one yet. Add a relation field on the collection you want
            to summarise (for example an "invoice" field on invoice lines), then come back.
          </Trans>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium"><Trans>Aggregate</Trans></span>
              <Select
                value={value.fn}
                onChange={(v) => set({ fn: v, ...(v === "count" ? { field: "" } : {}) })}
                className="min-w-0"
                options={[
                  { value: "sum", label: t`Sum`, hint: t`add the values up` },
                  { value: "count", label: t`Count`, hint: t`how many rows` },
                  { value: "avg", label: t`Average`, hint: t`mean value` },
                  { value: "min", label: t`Minimum`, hint: t`smallest value` },
                  { value: "max", label: t`Maximum`, hint: t`largest value` },
                ]}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium"><Trans>Of collection</Trans></span>
              <Select
                value={value.from}
                onChange={pickSource}
                options={sources}
                className="min-w-0"
                placeholder={t`Pick a collection…`}
              />
            </label>
          </div>

          {value.from && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium"><Trans>Related through</Trans></span>
                <Select
                  value={value.via}
                  onChange={(v) => set({ via: v })}
                  options={viaOptions}
                  className="min-w-0"
                  placeholder={t`Pick the relation…`}
                />
                <span className="text-muted-foreground text-[11px]">
                  <Trans>The field on {value.from} that points back at this row.</Trans>
                </span>
              </label>
              {value.fn !== "count" && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium"><Trans>Value</Trans></span>
                  <Select
                    value={value.field}
                    onChange={(v) => set({ field: v })}
                    options={valueOptions}
                    className="min-w-0"
                    placeholder={t`Pick a number column…`}
                  />
                  {valueOptions.length === 0 && (
                    <span className="text-muted-foreground text-[11px]">
                      <Trans>{value.from} has no number column to aggregate.</Trans>
                    </span>
                  )}
                </label>
              )}
            </div>
          )}

          {value.from && value.via && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium"><Trans>Only count rows matching</Trans></span>
              <span className="text-muted-foreground text-[11px]">
                <Trans>
                  Optional. Filters which {value.from} rows are included. Deleted rows are always
                  excluded. The rule can only read that collection's own columns — a total is one
                  stored number shared by every reader, so it cannot depend on who is looking.
                </Trans>
              </span>
              <RuleBuilder
                tree={value.filter}
                onChange={(tree) => set({ filter: tree })}
                fields={filterFields}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
