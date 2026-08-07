// Shared lifecycle editor — the Lifecycle tab of the Add / Edit field dialogs,
// shown for selection interfaces that store one value (`dropdown`, `radio`).
//
// What it edits is a graph, and a graph is the one thing a stack of text inputs
// renders badly. So the control is a MATRIX: one row per value the row is in,
// one checkbox per value it may move to. That shape makes the two mistakes this
// feature exists to prevent visible without reading anything — a row of all
// unchecked boxes IS a final state, and a column nobody checks IS unreachable.
//
// The per-move extras (who may make it, what the row must carry, what the
// button says) hang off the selected cell rather than living in the grid, since
// most moves need none of them and a grid of six controls per cell is unusable
// on a phone.
//
// The verdict logic is NOT reimplemented here: `allowedMoves` from
// @backlex/db/transitions is the same function the server enforces with, so the
// preview at the bottom cannot promise something a save would refuse.
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { Button } from "@backlex/ui/components/button";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { allowedMoves, isTerminal } from "@backlex/db/transitions";
import { Switch } from "../ui";
import { useRoles } from "../queries";

/** A transition spec while it is being edited. Kept edge-keyed rather than
 *  rule-keyed: the matrix writes one cell at a time, and collapsing adjacent
 *  cells back into `from: [a, b]` rules is a save-time concern. */
export interface TransitionsDraft {
  enabled: boolean;
  /** `"from>to"` → the extras for that edge. Presence = the edge is allowed. */
  edges: Record<string, { roles: string[]; requires: string[]; label: string }>;
  /** Values a new row may start in. Empty = any. */
  initial: string[];
}

export const emptyTransitionsDraft = (): TransitionsDraft => ({
  enabled: false,
  edges: {},
  initial: [],
});

const edgeKey = (from: string, to: string) => `${from}>${to}`;

/** Recover the matrix from a stored `transitions` object.
 *
 *  A wildcard rule is EXPANDED against the choice list rather than preserved.
 *  The matrix cannot draw `*`, and drawing an approximation of it while saving
 *  the original would mean the editor showed one graph and enforced another —
 *  so the expansion is real, and re-saving writes the expanded form. Specs
 *  authored by hand keep working; they just come back explicit. */
export const transitionsToDraft = (v: unknown, choices: string[]): TransitionsDraft => {
  const base = emptyTransitionsDraft();
  if (!v || typeof v !== "object") return base;
  const spec = v as { allow?: any[]; initial?: string[] };
  if (!Array.isArray(spec.allow) || spec.allow.length === 0) return base;
  const sides = (side: unknown): string[] => {
    const list = Array.isArray(side) ? side : [side];
    return list.includes("*") ? choices : (list as string[]).filter((x) => choices.includes(x));
  };
  const edges: TransitionsDraft["edges"] = {};
  for (const rule of spec.allow) {
    for (const from of sides(rule?.from)) {
      for (const to of sides(rule?.to)) {
        if (from === to) continue;
        edges[edgeKey(from, to)] = {
          roles: Array.isArray(rule?.roles) ? rule.roles : [],
          requires: Array.isArray(rule?.requires) ? rule.requires : [],
          label: typeof rule?.label === "string" ? rule.label : "",
        };
      }
    }
  }
  return {
    enabled: true,
    edges,
    initial: Array.isArray(spec.initial) ? spec.initial.filter((x) => choices.includes(x)) : [],
  };
};

/** Compile a draft into the stored `transitions` object, or undefined when the
 *  tab is off / empty (which is what the dialog treats as "no lifecycle").
 *
 *  Edges that share their extras AND their target are merged into one rule with
 *  a `from` list. Purely cosmetic — the server reads either form identically —
 *  but it keeps a ten-state lifecycle from storing ninety near-identical rules
 *  in the collection metadata. */
export const cleanTransitions = (d: TransitionsDraft): Record<string, unknown> | undefined => {
  if (!d.enabled) return undefined;
  const keys = Object.keys(d.edges);
  if (keys.length === 0) return undefined;
  const buckets = new Map<string, { from: string[]; to: string; extras: TransitionsDraft["edges"][string] }>();
  for (const key of keys) {
    // Keys are built as `${from}>${to}`, so both halves are always present —
    // the defaults exist only to give the compiler the `string` it can't infer
    // from `split`.
    const [from = "", to = ""] = key.split(">");
    const extras = d.edges[key]!;
    const sig = JSON.stringify([to, [...extras.roles].sort(), [...extras.requires].sort(), extras.label]);
    const bucket = buckets.get(sig);
    if (bucket) bucket.from.push(from);
    else buckets.set(sig, { from: [from], to, extras });
  }
  const allow = [...buckets.values()].map((b) => ({
    from: b.from.length === 1 ? b.from[0] : b.from,
    to: b.to,
    ...(b.extras.roles.length ? { roles: b.extras.roles } : {}),
    ...(b.extras.requires.length ? { requires: b.extras.requires } : {}),
    ...(b.extras.label.trim() ? { label: b.extras.label.trim() } : {}),
  }));
  return { allow, ...(d.initial.length ? { initial: d.initial } : {}) };
};

/** The spec a preview should be judged against, tolerating an empty draft. */
const previewSpec = (d: TransitionsDraft) =>
  (cleanTransitions(d) as { allow: any[]; initial?: string[] } | undefined) ?? { allow: [] };

export function FieldTransitionsEditor({
  value,
  onChange,
  choices,
  /** Sibling field names — the candidates for `requires`. */
  candidates,
}: {
  value: TransitionsDraft;
  onChange: (d: TransitionsDraft) => void;
  choices: { value: string; label?: string }[];
  candidates: { name: string }[];
}) {
  const { t } = useLingui();
  // Read straight from the roles query rather than taking a prop: both dialogs
  // would otherwise have to thread it through, and the server rejects a rule
  // naming a role that does not exist — so the picker has to show the real list.
  const rolesQuery = useRoles();
  const roles = ((rolesQuery.data?.data ?? []) as { name: string }[]).map((r) => r.name);
  const [selected, setSelected] = useState<string | null>(null);
  const values = useMemo(() => choices.map((c) => c.value).filter(Boolean), [choices]);
  const set = (patch: Partial<TransitionsDraft>) => onChange({ ...value, ...patch });

  const toggleEdge = (from: string, to: string) => {
    const key = edgeKey(from, to);
    const next = { ...value.edges };
    if (next[key]) {
      delete next[key];
      if (selected === key) setSelected(null);
    } else {
      next[key] = { roles: [], requires: [], label: "" };
      setSelected(key);
    }
    set({ edges: next });
  };

  const patchEdge = (key: string, patch: Partial<TransitionsDraft["edges"][string]>) =>
    set({ edges: { ...value.edges, [key]: { ...value.edges[key]!, ...patch } } });

  const toggleInitial = (v: string) =>
    set({
      initial: value.initial.includes(v)
        ? value.initial.filter((x) => x !== v)
        : [...value.initial, v],
    });

  const spec = previewSpec(value);
  const selectedExtras = selected ? value.edges[selected] : null;

  if (values.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-[12.5px] text-muted-foreground">
        <Trans>
          Add the choices on the Interface tab first — a lifecycle is drawn between
          this field's values, so there is nothing to connect yet.
        </Trans>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="text-[12.5px] font-medium text-foreground">
            <Trans>Enforce a lifecycle</Trans>
          </div>
          <span className="text-[11.5px] text-muted-foreground">
            <Trans>
              Only the moves you allow are accepted — on the API, in flows, everywhere.
              Leave it off and any value may follow any other.
            </Trans>
          </span>
        </div>
        <Switch checked={value.enabled} onChange={(on) => set({ enabled: on })} />
      </div>

      {value.enabled && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="text-[12.5px] font-medium text-foreground">
              <Trans>Allowed moves</Trans>
            </div>
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>
                A row with nothing ticked is a final state — nothing can move out of it.
              </Trans>
            </span>
            <ScrollArea className="w-full rounded-md border border-border" viewportClassName="max-h-[15rem]">
              <div className="min-w-max p-1">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-background px-2 py-1.5 text-left font-medium text-muted-foreground">
                        <Trans>from ↓ / to →</Trans>
                      </th>
                      {values.map((to) => (
                        <th key={to} className="px-2 py-1.5 font-medium text-muted-foreground">
                          {to}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {values.map((from) => (
                      <tr key={from} className="border-t border-border">
                        <td className="sticky left-0 z-10 bg-background px-2 py-1.5 font-medium text-foreground">
                          <span className="flex items-center gap-1.5">
                            {from}
                            {isTerminal(spec, from) && (
                              <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                                <Trans>final</Trans>
                              </span>
                            )}
                          </span>
                        </td>
                        {values.map((to) => {
                          const key = edgeKey(from, to);
                          const on = Boolean(value.edges[key]);
                          const extras = value.edges[key];
                          const marked =
                            on && (extras!.roles.length || extras!.requires.length);
                          return (
                            <td key={to} className="px-2 py-1.5 text-center">
                              {from === to ? (
                                <span className="text-muted-foreground/40">—</span>
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`${from} → ${to}`}
                                  aria-pressed={on}
                                  onClick={() => (on ? setSelected(key) : toggleEdge(from, to))}
                                  onDoubleClick={() => toggleEdge(from, to)}
                                  className={[
                                    "size-5 rounded border text-[11px] leading-none transition-colors",
                                    on
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-border hover:border-primary/60",
                                    selected === key ? "ring-2 ring-primary/40" : "",
                                  ].join(" ")}
                                >
                                  {on ? (marked ? "!" : "✓") : ""}
                                </button>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ScrollArea>
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>
                Click an empty box to allow that move; click an allowed one to give it a
                rule below. Double-click to remove it.
              </Trans>
            </span>
          </div>

          {selected && selectedExtras && (
            <div className="flex flex-col gap-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-mono text-[12px] text-foreground">
                  {selected.replace(">", " → ")}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  <Trans>Done</Trans>
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground">
                  <Trans>Button label</Trans>
                </label>
                <Input
                  value={selectedExtras.label}
                  onChange={(e) => patchEdge(selected, { label: e.target.value })}
                  placeholder={t`Mark paid`}
                />
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>What the action is called where this move is offered.</Trans>
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground">
                  <Trans>Only these roles may make this move</Trans>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {roles.length === 0 && (
                    <span className="text-[11.5px] text-muted-foreground">
                      <Trans>No roles in this workspace yet.</Trans>
                    </span>
                  )}
                  {roles.map((r) => {
                    const on = selectedExtras.roles.includes(r);
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() =>
                          patchEdge(selected, {
                            roles: on
                              ? selectedExtras.roles.filter((x) => x !== r)
                              : [...selectedExtras.roles, r],
                          })
                        }
                        className={[
                          "rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors",
                          on
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:border-primary/60",
                        ].join(" ")}
                      >
                        {r}
                      </button>
                    );
                  })}
                </div>
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>
                    Leave empty for anyone who can edit the record. Flows and other
                    server-side writes are not judged by this — only by the moves themselves.
                  </Trans>
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground">
                  <Trans>Require these fields first</Trans>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {candidates.length === 0 && (
                    <span className="text-[11.5px] text-muted-foreground">
                      <Trans>No other fields on this collection yet.</Trans>
                    </span>
                  )}
                  {candidates.map((f) => {
                    const on = selectedExtras.requires.includes(f.name);
                    return (
                      <button
                        key={f.name}
                        type="button"
                        onClick={() =>
                          patchEdge(selected, {
                            requires: on
                              ? selectedExtras.requires.filter((x) => x !== f.name)
                              : [...selectedExtras.requires, f.name],
                          })
                        }
                        className={[
                          "rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] transition-colors",
                          on
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:border-primary/60",
                        ].join(" ")}
                      >
                        {f.name}
                      </button>
                    );
                  })}
                </div>
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>
                    The move is refused until they hold a value — filling one in the same
                    save counts.
                  </Trans>
                </span>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <div className="text-[12.5px] font-medium text-foreground">
              <Trans>A new record may start as</Trans>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {values.map((v) => {
                const on = value.initial.length === 0 || value.initial.includes(v);
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => toggleInitial(v)}
                    className={[
                      "rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors",
                      on
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-primary/60",
                    ].join(" ")}
                  >
                    {v}
                  </button>
                );
              })}
            </div>
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>Untouched means any value. Existing records are never re-judged by this.</Trans>
            </span>
          </div>

          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-1.5 text-[12.5px] font-medium text-foreground">
              <Trans>What an editor will see</Trans>
            </div>
            <div className="flex flex-col gap-1">
              {values.map((v) => {
                const moves = allowedMoves(spec, {
                  from: v,
                  roles: null,
                  row: {},
                  choices: values,
                });
                return (
                  <div key={v} className="flex flex-wrap items-baseline gap-1.5 text-[11.5px]">
                    <span className="font-mono text-foreground">{v}</span>
                    <span className="text-muted-foreground">→</span>
                    {moves.length === 0 ? (
                      <span className="text-muted-foreground">
                        <Trans>nothing (final)</Trans>
                      </span>
                    ) : (
                      <span className="font-mono text-muted-foreground">
                        {moves.map((m) => m.to).join(", ")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
