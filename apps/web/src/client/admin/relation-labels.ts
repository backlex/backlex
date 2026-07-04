// Batch-resolves relation FK ids to human labels for the items table: collect
// the visible page's ids per relation column, fetch the target rows in one
// `_in` query, and render each through the target collection's display
// template (falling back to the title-ish field scan, then the raw id). This
// is the list-view counterpart of the RelationPicker's per-value label fetch.
import { useQueries } from "@tanstack/react-query";
import { itemsApi } from "./api";
import { useCollections } from "./queries";
import { makeLabelFor } from "./relational-pickers";

export interface RelationColumn {
  name: string;
  /** Target collection slug (the field's `to`). */
  to?: string;
}

/** Returns `fieldName → (fk id → label)` for every relation column on the
 *  current page. Missing entries mean "not loaded yet / row deleted" — render
 *  the id as the fallback. */
export function useRelationLabels(
  fields: RelationColumn[],
  rows: Array<Record<string, unknown>>,
): Record<string, Record<string, string>> {
  const { data } = useCollections();
  const cols = data?.data;
  const queries = fields.map((f) => {
    const target = f.to ?? "";
    const ids = [
      ...new Set(
        rows
          .map((r) => r[f.name])
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    ].sort();
    const tmpl =
      (cols?.find((c) => c.slug === target) as { displayTemplate?: string | null } | undefined)
        ?.displayTemplate ?? null;
    return {
      queryKey: ["relation-labels", target, tmpl, ids] as const,
      enabled: !!target && ids.length > 0,
      staleTime: 30_000,
      queryFn: async () => {
        const res = await itemsApi.list(target, {
          filter: JSON.stringify({ id: { _in: ids } }),
          limit: ids.length,
        });
        const labelFor = makeLabelFor(tmpl);
        const map: Record<string, string> = {};
        for (const row of (Array.isArray(res.data) ? res.data : []) as Array<
          Record<string, unknown>
        >) {
          const id = String(row.id ?? "");
          if (id) map[id] = labelFor(row) ?? id;
        }
        return map;
      },
    };
  });
  const results = useQueries({ queries });
  const out: Record<string, Record<string, string>> = {};
  fields.forEach((f, i) => {
    out[f.name] = (results[i]?.data as Record<string, string> | undefined) ?? {};
  });
  return out;
}
