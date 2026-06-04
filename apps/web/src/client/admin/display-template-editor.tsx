// @ts-nocheck
// Token/chip editor for a collection's "display template" — the mustache string
// (`{{ title }} — {{ status }}`) used for row labels in relation pickers and
// references. Field placeholders render as removable shadcn Badges; literal text
// stays editable inline. An "Insert field" popover (shadcn Command) lists this
// collection's fields with Directus-style drill-down into relation targets, so
// you can build `{{ author.name }}` without typing braces. A raw-mode toggle
// drops to a plain input for power users / mid-string surgery.
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { renderTemplate } from "@backlex/core";
import { Badge } from "@backlex/ui/components/badge";
import { Input } from "@backlex/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@backlex/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@backlex/ui/components/command";
import { I } from "./icons";
import { Button, IconButton } from "./ui";
import {
  type Segment,
  tokenizeTemplate,
  serializeSegments,
  isNestedPath,
  headOf,
} from "./display-template";

interface FieldLike {
  name: string;
  type?: string;
  to?: string;
}

interface CollectionLike {
  slug: string;
  fields?: FieldLike[];
}

export interface DisplayTemplateEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Fields of the collection this template belongs to. */
  fields: FieldLike[];
  /** All workspace collections, for relation drill-down (slug → fields). */
  collections: CollectionLike[];
  placeholder?: string;
}

// System columns that are always present on a row and worth offering even
// though they don't appear in the user-defined `fields` list.
const SYSTEM_FIELDS: FieldLike[] = [
  { name: "id", type: "id" },
  { name: "created_at", type: "datetime" },
  { name: "updated_at", type: "datetime" },
];

/** Coalesce adjacent text and force a strictly alternating text/field/text…
 *  shape (text at both ends, a text slot between every pair of chips) so every
 *  even index is an editable input. Empty text segments serialize to "". */
function normalize(segs: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (seg.kind === "text" && last && last.kind === "text") {
      last.value += seg.value;
    } else {
      merged.push(seg.kind === "text" ? { ...seg } : seg);
    }
  }
  const out: Segment[] = [];
  if (merged.length === 0 || merged[0].kind !== "text") {
    out.push({ kind: "text", value: "" });
  }
  for (const seg of merged) {
    if (seg.kind === "field" && out[out.length - 1]?.kind !== "text") {
      out.push({ kind: "text", value: "" });
    }
    out.push(seg);
  }
  if (out[out.length - 1]?.kind !== "text") out.push({ kind: "text", value: "" });
  return out;
}

const seed = (value: string): Segment[] => normalize(tokenizeTemplate(value));

export function DisplayTemplateEditor({
  value,
  onChange,
  fields,
  collections,
  placeholder = "{{ title }} — {{ status }}",
}: DisplayTemplateEditorProps) {
  const { t } = useLingui();
  const [segments, setSegments] = useState<Segment[]>(() => seed(value));
  const [raw, setRaw] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Active relation drill-down (null = top level / this collection's fields).
  const [drill, setDrill] = useState<{ field: string; target: string } | null>(null);

  // Caret position of the last-focused text input, so inserts land where the
  // user is typing rather than always at the end. { idx into segments, offset }.
  const caret = useRef<{ idx: number; offset: number } | null>(null);
  // Segment index whose input should grab focus after the next render.
  const pendingFocus = useRef<number | null>(null);
  const inputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  // Reseed when the template changes from the outside (collection switch /
  // Refresh) — but not for our own edits, which already match `value`.
  useEffect(() => {
    if (value !== serializeSegments(segments)) setSegments(seed(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (pendingFocus.current == null) return;
    const el = inputRefs.current[pendingFocus.current];
    if (el) {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
    pendingFocus.current = null;
  });

  const commit = (next: Segment[]) => {
    const normalized = normalize(next);
    setSegments(normalized);
    onChange(serializeSegments(normalized));
  };

  const setTextAt = (idx: number, text: string) => {
    // Keep edits local without re-normalizing every keystroke (which would
    // collapse the array and steal focus); just patch the one segment.
    setSegments((prev) => {
      const next = prev.map((s, i) =>
        i === idx && s.kind === "text" ? { kind: "text", value: text } : s,
      );
      onChange(serializeSegments(next));
      return next;
    });
  };

  const insertField = (path: string) => {
    setPickerOpen(false);
    setDrill(null);
    const at = caret.current;
    setSegments((prev) => {
      let next: Segment[];
      let focusIdx: number;
      if (at && prev[at.idx]?.kind === "text") {
        const text = (prev[at.idx] as { value: string }).value;
        const before = text.slice(0, at.offset);
        const after = text.slice(at.offset);
        next = [
          ...prev.slice(0, at.idx),
          { kind: "text", value: before },
          { kind: "field", path },
          { kind: "text", value: after },
          ...prev.slice(at.idx + 1),
        ];
        focusIdx = at.idx + 2; // the trailing "after" text slot
      } else {
        next = [...prev, { kind: "field", path }, { kind: "text", value: "" }];
        focusIdx = next.length - 1;
      }
      const normalized = normalize(next);
      // Re-find the focus target after normalization may have shifted indices.
      pendingFocus.current = Math.min(focusIdx, normalized.length - 1);
      onChange(serializeSegments(normalized));
      return normalized;
    });
  };

  const removeFieldAt = (idx: number) => {
    setSegments((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      const normalized = normalize(next);
      onChange(serializeSegments(normalized));
      return normalized;
    });
    caret.current = null;
  };

  const rememberCaret = (idx: number, el: HTMLInputElement) => {
    caret.current = { idx, offset: el.selectionStart ?? el.value.length };
  };

  // ── Field picker data ──────────────────────────────────────────────────────
  const relationTargetFields = useMemo(() => {
    if (!drill) return [];
    const col = collections.find((c) => c.slug === drill.target);
    return (col?.fields ?? []).filter((f) => f.name !== "id");
  }, [drill, collections]);

  const isEmpty = segments.every((s) => s.kind === "text" && !s.value);

  // Live preview against a synthetic sample (each token → its leaf field name),
  // so the user sees separators / layout without fetching a real row.
  const preview = useMemo(() => {
    const tpl = serializeSegments(segments);
    if (!tpl.trim()) return "";
    const sample: Record<string, unknown> = {};
    for (const seg of segments) {
      if (seg.kind !== "field") continue;
      const parts = seg.path.split(".");
      let cur = sample;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof cur[p] !== "object" || cur[p] == null) cur[p] = {};
        cur = cur[p] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = parts[parts.length - 1];
    }
    return renderTemplate(tpl, sample);
  }, [segments]);

  const fieldTag = (f: FieldLike) =>
    f.type === "relation" ? "relation" : (f.type ?? "field");

  return (
    <div className="flex flex-col gap-1.5">
      {raw ? (
        <Input
          className="font-mono"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setSegments(seed(e.target.value));
          }}
          placeholder={placeholder}
        />
      ) : (
        <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 focus-within:border-ring focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_22%,transparent)]">
          {segments.map((seg, idx) =>
            seg.kind === "text" ? (
              <input
                key={idx}
                ref={(el) => { inputRefs.current[idx] = el; }}
                value={seg.value}
                size={Math.max(seg.value.length, 1)}
                onChange={(e) => setTextAt(idx, e.target.value)}
                onFocus={(e) => rememberCaret(idx, e.currentTarget)}
                onClick={(e) => rememberCaret(idx, e.currentTarget)}
                onKeyUp={(e) => rememberCaret(idx, e.currentTarget)}
                placeholder={isEmpty && idx === 0 ? placeholder : undefined}
                className="min-w-2 flex-shrink border-0 bg-transparent p-0 font-mono text-[13px] outline-0 placeholder:text-muted-foreground"
                style={{ width: seg.value ? "auto" : undefined }}
              />
            ) : (
              <Badge
                key={idx}
                variant={isNestedPath(seg.path) ? "default" : "secondary"}
                className="gap-1 font-mono"
                title={seg.path}
              >
                {isNestedPath(seg.path) ? <I.Link size={10} /> : <I.Braces size={10} />}
                {seg.path}
                <button
                  type="button"
                  aria-label={t`Remove ${seg.path}`}
                  className="-mr-0.5 ml-0.5 rounded-full opacity-70 hover:opacity-100"
                  onClick={() => removeFieldAt(idx)}
                >
                  <I.X size={11} />
                </button>
              </Badge>
            ),
          )}
          <Popover
            open={pickerOpen}
            onOpenChange={(o) => { setPickerOpen(o); if (!o) setDrill(null); }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ml-auto inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-2 text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <I.Plus size={11} /> <Trans>Insert field</Trans>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[280px] p-0">
              <Command>
                {drill ? (
                  <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
                    <IconButton icon={I.ChevronLeft} title={t`Back`} onClick={() => setDrill(null)} />
                    <span className="font-mono text-[12px] text-muted-foreground">{drill.field}.</span>
                  </div>
                ) : null}
                <CommandInput placeholder={t`Search fields…`} />
                <CommandList>
                  <CommandEmpty><Trans>No fields.</Trans></CommandEmpty>
                  {drill ? (
                    <CommandGroup heading={t`Fields of ${drill.target}`}>
                      {relationTargetFields.map((f) => (
                        <CommandItem
                          key={f.name}
                          value={f.name}
                          onSelect={() => insertField(`${drill.field}.${f.name}`)}
                        >
                          <span className="font-mono">{f.name}</span>
                          <span className="ml-auto text-[10.5px] text-muted-foreground">{fieldTag(f)}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : (
                    <>
                      <CommandGroup heading={t`Fields`}>
                        {fields.map((f) => {
                          const drillable = f.type === "relation" && !!f.to;
                          return (
                            <CommandItem
                              key={f.name}
                              value={f.name}
                              onSelect={() =>
                                drillable
                                  ? setDrill({ field: f.name, target: f.to as string })
                                  : insertField(f.name)
                              }
                            >
                              <span className="font-mono">{f.name}</span>
                              <span className="ml-auto flex items-center gap-1 text-[10.5px] text-muted-foreground">
                                {fieldTag(f)}
                                {drillable ? <I.ChevronRight size={12} /> : null}
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                      <CommandSeparator />
                      <CommandGroup heading={t`System`}>
                        {SYSTEM_FIELDS.map((f) => (
                          <CommandItem key={f.name} value={f.name} onSelect={() => insertField(f.name)}>
                            <span className="font-mono">{f.name}</span>
                            <span className="ml-auto text-[10.5px] text-muted-foreground">{f.type}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-muted-foreground">
          {preview ? (
            <>
              <span className="text-muted-foreground/70"><Trans>Preview:</Trans></span>{" "}
              <span className="font-mono text-foreground">{preview}</span>
            </>
          ) : (
            <Trans>Mustache-style template for row display in pickers and references.</Trans>
          )}
        </span>
        <button
          type="button"
          onClick={() => setRaw((v) => !v)}
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <I.Code size={11} /> {raw ? <Trans>Visual</Trans> : <Trans>Raw</Trans>}
        </button>
      </div>
    </div>
  );
}
