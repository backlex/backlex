import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import {
  BracesIcon,
  CodeIcon,
  FileIcon,
  HistoryIcon,
  InboxIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { Card, CardContent } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import { Switch } from "@workeros/ui/components/switch";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workeros/ui/components/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { Checkbox } from "@workeros/ui/components/checkbox";
import { Separator } from "@workeros/ui/components/separator";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/data-table";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { CodeEditor } from "@/components/code-editor-lazy";
import { RelationCombobox } from "@/components/relation-combobox";
import { DatePicker } from "@/components/date-picker";
import { FilterBuilder } from "@/components/filter-builder";
import {
  buildFilterDSL,
  mergeFilters,
  previewFilterUrl,
  type FilterEntry,
  type FilterMode,
} from "@/lib/filter-dsl";
import { notifyError } from "@/lib/error";
import { toast } from "@workeros/ui/components/sonner";
import { api } from "@/lib/api";

interface FieldValidation {
  regex?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

interface FieldVisibility {
  field: string;
  op: "_eq" | "_neq" | "_in";
  value?: unknown;
}

interface Field {
  name: string;
  type: string;
  required?: boolean;
  /** Target collection slug for `relation` / `relation_many` fields. */
  to?: string;
  /** UI override — dropdown / richtext / color. */
  interface?: "dropdown" | "richtext" | "color";
  /** Interface-specific options (e.g. dropdown values). */
  options?: { values?: string[] };
  /** Soft validation rules — also enforced server-side. */
  validation?: FieldValidation;
  /** Conditional visibility — show the editor only when condition matches. */
  visibleWhen?: FieldVisibility;
  /** Group label for form section rendering. */
  group?: string;
}

const matchesVisibility = (
  cond: FieldVisibility,
  data: Record<string, unknown>,
): boolean => {
  const left = data[cond.field];
  switch (cond.op) {
    case "_eq":
      return left === cond.value;
    case "_neq":
      return left !== cond.value;
    case "_in":
      return Array.isArray(cond.value) && (cond.value as unknown[]).includes(left);
  }
};

interface Permission {
  id: string;
  roleId: string;
  collection: string;
  action: "read" | "create" | "update" | "delete";
  fields: string[] | null;
  condition: unknown;
}

interface Role {
  id: string;
  name: string;
}

const STATUS_VALUES = ["draft", "review", "published", "archived"];

/** Heuristic — a text field named `status` used as the quick-filter source. */
const detectStatusField = (fields: Field[]): Field | null =>
  fields.find((f) => f.name === "status" && f.type === "text") ?? null;

interface Collection {
  slug: string;
  fields: Field[];
  ownerScoped: boolean | number;
}

type Item = Record<string, unknown> & { id: string };

interface Revision {
  id: string;
  collection: string;
  itemId: string;
  parentRevisionId: string | null;
  snapshot: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string | number;
}

interface I18nTextEditorProps {
  value: Record<string, string> | null | undefined;
  onChange: (next: Record<string, string>) => void;
  required?: boolean;
}

/** Per-locale inputs for a `i18n_text` field. Locales are pulled from
 *  /api/i18n (workspace settings); when the endpoint is unreachable we fall
 *  back to a single "en" input so editing isn't blocked. */
const I18nTextEditor = ({ value, onChange, required }: I18nTextEditorProps) => {
  const [locales, setLocales] = useState<string[]>([]);
  const [defaultLocale, setDefaultLocale] = useState("en");
  const map =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: { locales: string[]; defaultLocale: string } }>(
          "/api/i18n",
        );
        if (cancelled) return;
        setLocales(res.data.locales);
        setDefaultLocale(res.data.defaultLocale);
      } catch {
        if (!cancelled) setLocales(["en"]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Show every configured locale plus any locale that already has a value
  // but isn't in the active list (so legacy data isn't hidden).
  const columns = Array.from(new Set([...locales, ...Object.keys(map)]));

  return (
    <div className="space-y-2">
      {columns.map((l) => (
        <div key={l} className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px] min-w-12 justify-center">
            {l}{l === defaultLocale && " ·"}
          </Badge>
          <Input
            value={map[l] ?? ""}
            onChange={(e) => onChange({ ...map, [l]: e.target.value })}
            placeholder={l === defaultLocale ? "(default)" : map[defaultLocale] || ""}
            required={required && l === defaultLocale}
          />
        </div>
      ))}
    </div>
  );
};

const renderInput = (
  field: Field,
  value: unknown,
  onChange: (v: unknown) => void,
) => {
  const required = !!field.required;
  const v = field.validation ?? {};

  // Interface override: dropdown — only allow listed values
  if (field.interface === "dropdown" && field.options?.values) {
    return (
      <Select
        value={(value as string | null | undefined) ?? ""}
        onValueChange={(next) => onChange(next || null)}
      >
        <SelectTrigger>
          <SelectValue
            placeholder={required ? "Pick a value…" : "(none)"}
          />
        </SelectTrigger>
        <SelectContent>
          {!required && (
            <SelectItem value="">
              <span className="text-muted-foreground">(none)</span>
            </SelectItem>
          )}
          {field.options.values.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // Interface override: color — native color picker + hex preview
  if (field.interface === "color") {
    const hex = (value as string | null | undefined) ?? "#000000";
    return (
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          className="size-9 cursor-pointer rounded-3xl border border-input bg-card p-1"
        />
        <Input
          value={(value as string | null | undefined) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#A3E635"
          className="font-mono"
          required={required}
          pattern="^#?[0-9a-fA-F]{3,8}$"
        />
      </div>
    );
  }

  // Interface override: richtext — wider textarea with monospace; full
  // Markdown editor would be a heavier dep, defer.
  if (field.interface === "richtext") {
    return (
      <Textarea
        rows={8}
        value={(value as string | null | undefined) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder="Markdown supported on the consumer side."
      />
    );
  }

  if (field.type === "i18n_text") {
    return (
      <I18nTextEditor
        value={value as Record<string, string> | null | undefined}
        onChange={(v) => onChange(v)}
        required={!!field.required}
      />
    );
  }
  if (field.type === "json") {
    const text =
      value === null || value === undefined
        ? ""
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2);
    return (
      <CodeEditor
        value={text}
        onChange={(next) => {
          // Try to parse — fall back to raw string so the user can keep
          // typing through invalid intermediate states.
          try {
            onChange(JSON.parse(next));
          } catch {
            onChange(next);
          }
        }}
      />
    );
  }
  if (field.type === "longtext") {
    return (
      <Textarea
        rows={4}
        value={(value as string | null | undefined) ?? ""}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        minLength={v.minLength}
        maxLength={v.maxLength}
      />
    );
  }
  if (field.type === "boolean") {
    return (
      <Switch checked={!!value} onCheckedChange={(v) => onChange(v)} />
    );
  }
  if (field.type === "timestamp") {
    return (
      <DatePicker
        value={value as string | number | null}
        onChange={(iso) => onChange(iso)}
      />
    );
  }
  if (field.type === "relation" && field.to) {
    return (
      <RelationCombobox
        to={field.to}
        value={(value as string | null) ?? null}
        onChange={(v) => onChange(v)}
      />
    );
  }
  if (field.type === "relation_many" && field.to) {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="space-y-2">
        <RelationCombobox
          key={ids.length}
          to={field.to}
          value={null}
          onChange={(picked) => {
            if (!picked) return;
            if (ids.includes(picked)) return;
            onChange([...ids, picked]);
          }}
        />
        {ids.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {ids.map((id) => (
              <span
                key={id}
                className="inline-flex h-7 items-center gap-1.5 rounded-3xl border border-border bg-card px-2.5 text-xs"
              >
                <code className="font-mono">{id.slice(0, 8)}…</code>
                <button
                  type="button"
                  onClick={() =>
                    onChange(ids.filter((x) => x !== id))
                  }
                  className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  aria-label={`Remove ${id}`}
                >
                  <XIcon size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (field.type === "file") {
    const key = (value as string | null | undefined) ?? "";
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            value={key}
            onChange={(e) => onChange(e.target.value)}
            placeholder="avatars/me.png"
            className="font-mono"
            required={required}
          />
          <Button asChild type="button" variant="outline" size="sm">
            <a href="/storage" target="_blank" rel="noreferrer">
              <PaperclipIcon /> Browse
            </a>
          </Button>
        </div>
        {key && (
          <a
            href={`/api/storage/${encodeURIComponent(key)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <FileIcon size={12} />
            <span className="font-mono">{key}</span>
          </a>
        )}
      </div>
    );
  }
  if (field.type === "integer" || field.type === "number") {
    return (
      <Input
        type="number"
        step={field.type === "integer" ? 1 : "any"}
        value={(value as number | null | undefined) ?? ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
        required={required}
        min={v.min}
        max={v.max}
      />
    );
  }
  if (field.name === "status" && field.type === "text") {
    const current = (value as string | null | undefined) ?? "";
    const options = STATUS_VALUES.includes(current)
      ? STATUS_VALUES
      : current
        ? [...STATUS_VALUES, current]
        : STATUS_VALUES;
    return (
      <Select
        value={current}
        onValueChange={(next) => onChange(next || null)}
      >
        <SelectTrigger>
          <SelectValue
            placeholder={required ? "Pick a status…" : "(none)"}
          />
        </SelectTrigger>
        <SelectContent>
          {!required && (
            <SelectItem value="">
              <span className="text-muted-foreground">(none)</span>
            </SelectItem>
          )}
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      value={(value as string | null | undefined) ?? ""}
      onChange={(e) => onChange(e.target.value)}
      required={required}
      minLength={v.minLength}
      maxLength={v.maxLength}
      pattern={v.regex}
    />
  );
};

/** Build a friendly hint string from validation rules + interface options. */
const fieldHint = (field: Field): string | null => {
  const parts: string[] = [];
  const v = field.validation;
  if (v) {
    if (v.minLength !== undefined && v.maxLength !== undefined) {
      parts.push(`${v.minLength}–${v.maxLength} chars`);
    } else if (v.minLength !== undefined) {
      parts.push(`min ${v.minLength} chars`);
    } else if (v.maxLength !== undefined) {
      parts.push(`max ${v.maxLength} chars`);
    }
    if (v.min !== undefined && v.max !== undefined) {
      parts.push(`${v.min}–${v.max}`);
    } else if (v.min !== undefined) {
      parts.push(`≥ ${v.min}`);
    } else if (v.max !== undefined) {
      parts.push(`≤ ${v.max}`);
    }
    if (v.regex) parts.push(`pattern /${v.regex}/`);
  }
  if (field.interface === "dropdown" && field.options?.values) {
    parts.push(`one of: ${field.options.values.join(", ")}`);
  }
  return parts.length ? parts.join(" · ") : null;
};

const fmtRelative = (value: string | number): string => {
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return d.toLocaleString();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  published: "default",
  active: "default",
  enabled: "default",
  draft: "outline",
  review: "outline",
  pending: "outline",
  archived: "secondary",
  paused: "secondary",
  failed: "destructive",
  error: "destructive",
};

const renderStatusCell = (raw: string) => {
  const variant = STATUS_VARIANT[raw] ?? "outline";
  return (
    <Badge variant={variant} className="font-mono text-[10px]">
      {variant === "default" && (
        <span className="mr-1 inline-block size-1.5 rounded-full bg-current" />
      )}
      {raw}
    </Badge>
  );
};

const renderCell = (field: Field, value: unknown) => {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (field.type === "boolean") {
    return value ? (
      <Badge variant="default" className="font-mono text-[10px]">
        true
      </Badge>
    ) : (
      <Badge variant="secondary" className="font-mono text-[10px]">
        false
      </Badge>
    );
  }
  if (field.type === "json") {
    const s = JSON.stringify(value);
    return (
      <code
        className="block max-w-xs truncate font-mono text-xs text-muted-foreground"
        title={s}
      >
        {s}
      </code>
    );
  }
  if (field.type === "timestamp") {
    const formatted = fmtRelative(value as string | number);
    return (
      <span
        className="font-mono text-xs tabular-nums text-muted-foreground"
        title={new Date(value as string | number).toLocaleString()}
      >
        {formatted}
      </span>
    );
  }
  if (field.type === "longtext") {
    const s = String(value);
    return (
      <span
        className="block max-w-md truncate text-muted-foreground"
        title={s}
      >
        {s.length > 80 ? s.slice(0, 80) + "…" : s}
      </span>
    );
  }
  if (field.type === "integer" || field.type === "number") {
    return (
      <span className="block text-right font-mono tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : String(value)}
      </span>
    );
  }
  if (field.type === "uuid") {
    const s = String(value);
    return (
      <code
        className="font-mono text-xs text-muted-foreground"
        title={s}
      >
        {s.length > 8 ? s.slice(0, 8) + "…" : s}
      </code>
    );
  }
  if (field.type === "relation") {
    const s = String(value);
    return (
      <code className="font-mono text-xs">
        {s.length > 12 ? s.slice(0, 8) + "…" : s}
      </code>
    );
  }
  if (field.type === "relation_many") {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    if (ids.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="flex items-center gap-1">
        <code className="font-mono text-xs">{ids[0]?.slice(0, 8) ?? "?"}…</code>
        {ids.length > 1 && (
          <Badge variant="outline" className="font-mono text-[10px]">
            +{ids.length - 1}
          </Badge>
        )}
      </span>
    );
  }
  if (field.type === "file") {
    const s = String(value);
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs">
        <FileIcon size={11} className="text-muted-foreground" />
        {s.length > 24 ? "…" + s.slice(-24) : s}
      </span>
    );
  }
  // Special-case: status text field gets a Badge with optional dot.
  if (field.name === "status" && field.type === "text") {
    return renderStatusCell(String(value));
  }
  return <span className="truncate">{String(value)}</span>;
};

const PAGE_SIZE = 25;

export const Items = () => {
  const { slug = "" } = useParams<{ slug: string }>();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [filterCount, setFilterCount] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sort, setSort] = useState<string>("-created_at");
  const [filters, setFilters] = useState<FilterEntry[]>([]);
  const [filterMode, setFilterMode] = useState<FilterMode>("and");
  const [statusTab, setStatusTab] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{
    mode: "create" | "edit";
    id?: string;
    data: Record<string, unknown>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [revisionsFor, setRevisionsFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);

  const statusField = collection ? detectStatusField(collection.fields) : null;
  const firstTextField = collection?.fields.find(
    (f) => f.type === "text" || f.type === "longtext",
  );

  // Free-text search hits the dedicated `q` server param (searches every
  // text/longtext field). The structured DSL only carries chip + status
  // filters now, so it stays clean in the URL preview.
  const combinedFilter = useMemo(() => {
    return mergeFilters(
      buildFilterDSL(filters, filterMode),
      statusTab !== "all" && statusField
        ? { [statusField.name]: { _eq: statusTab } }
        : null,
    );
  }, [filters, filterMode, statusTab, statusField]);

  const refresh = async () => {
    setLoading(true);
    try {
      const c = await api<{ data: Collection }>(`/api/collections/${slug}`);
      setCollection(c.data);
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      params.set("sort", sort);
      params.set("meta", "filter_count");
      if (combinedFilter) {
        params.set("filter", JSON.stringify(combinedFilter));
      }
      if (search.trim()) {
        params.set("q", search.trim());
      }
      const i = await api<{
        data: Item[];
        meta?: { filter_count?: number };
      }>(`/api/items/${slug}?${params}`);
      setItems(i.data);
      setFilterCount(i.meta?.filter_count ?? null);
    } catch (e) {
      notifyError(e, "Loading items");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    setSelected(new Set());
  }, [slug, page, sort, combinedFilter, search]);

  useEffect(() => {
    setPage(0);
  }, [slug]);

  // Filter/search/status changes invalidate the current page index — otherwise
  // a narrow filter on page 3 produces an empty result instead of the matches.
  useEffect(() => {
    setPage(0);
  }, [combinedFilter, search, sort]);

  // Debounce the search box so typing doesn't fire a request per keystroke,
  // while blur/Enter still flush immediately via setSearch directly.
  useEffect(() => {
    if (searchInput === search) return;
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput, search]);

  // Pull permissions + roles when the user clicks the Permissions tab —
  // lazy so we don't hit the API for every collection load.
  const loadPermissions = async () => {
    try {
      const [pRes, rRes] = await Promise.all([
        api<{ data: Permission[] }>(`/api/permissions?collection=${slug}`).catch(
          async () => api<{ data: Permission[] }>(`/api/permissions`),
        ),
        api<{ data: Role[] }>(`/api/roles`).catch(() => ({ data: [] as Role[] })),
      ]);
      setPermissions(pRes.data.filter((p) => p.collection === slug));
      setRoles(rRes.data);
    } catch (e) {
      notifyError(e, "Loading permissions");
      setPermissions([]);
    }
  };

  const startCreate = () => {
    setEditing({ mode: "create", data: {} });
    setRevisions(null);
    setRevisionsFor(null);
  };

  const startEdit = (item: Item) => {
    if (!collection) return;
    const data: Record<string, unknown> = {};
    for (const f of collection.fields) data[f.name] = item[f.name];
    setEditing({ mode: "edit", id: item.id, data });
    loadRevisions(item.id);
  };

  const loadRevisions = async (itemId: string) => {
    setRevisionsFor(itemId);
    setRevisions(null);
    try {
      const r = await api<{ data: Revision[] }>(
        `/api/revisions/${slug}/${itemId}`,
      );
      setRevisions(r.data);
    } catch {
      setRevisions([]);
    }
  };

  const revert = async (revId: string) => {
    try {
      await api(`/api/revisions/${revId}/revert`, { method: "POST" });
      setEditing(null);
      setRevisions(null);
      setRevisionsFor(null);
      toast.success("Revision restored");
      refresh();
    } catch (e) {
      notifyError(e, "Restoring revision");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      if (editing.mode === "create") {
        await api(`/api/items/${slug}`, {
          method: "POST",
          body: JSON.stringify(editing.data),
        });
        toast.success("Item created");
      } else if (editing.id) {
        await api(`/api/items/${slug}/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(editing.data),
        });
        toast.success("Item saved");
      }
      setEditing(null);
      refresh();
    } catch (e) {
      notifyError(e, "Saving item");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/items/${slug}/${id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, "Deleting item");
    }
  };

  const removeMany = async (ids: Array<string | number>) => {
    try {
      await Promise.all(
        ids.map((id) =>
          api(`/api/items/${slug}/${id}`, { method: "DELETE" }),
        ),
      );
      toast.success(`${ids.length} item(s) deleted`);
      setSelected(new Set());
      refresh();
    } catch (e) {
      notifyError(e, "Bulk delete");
    }
  };

  const columns: DataTableColumn<Item>[] = useMemo(() => {
    if (!collection) return [];

    // Smart title cell: if a `title` (or first text) field exists alongside a
    // `slug` field, render them as a 2-line cell — title bold, slug
    // mono-muted underneath. This matches the design's headline pattern.
    const titleField = collection.fields.find(
      (f) => f.name === "title" && f.type === "text",
    );
    const slugField = collection.fields.find(
      (f) => f.name === "slug" && f.type === "text",
    );
    const usePairedTitle = !!titleField && !!slugField;
    const skipNames = new Set<string>();
    if (usePairedTitle) {
      skipNames.add(titleField.name);
      skipNames.add(slugField.name);
    }

    const titleCol: DataTableColumn<Item> | null = usePairedTitle
      ? {
          id: "title",
          header: "Title",
          sortKey: "title",
          cell: (row) => (
            <div className="flex flex-col leading-tight">
              <span className="font-medium text-foreground">
                {String(row[titleField.name] ?? "—")}
              </span>
              {row[slugField.name] != null && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  /{String(row[slugField.name])}
                </span>
              )}
            </div>
          ),
        }
      : null;

    const fieldCols: DataTableColumn<Item>[] = collection.fields
      .filter((f) => !skipNames.has(f.name))
      .map((f, idx) => {
        const numeric = f.type === "integer" || f.type === "number";
        return {
          id: f.name,
          header: f.name,
          sortKey: f.name,
          align: numeric ? ("right" as const) : ("left" as const),
          cell: (row) => renderCell(f, row[f.name]),
          defaultHidden: idx >= (titleCol ? 3 : 4),
          width:
            f.name === "status"
              ? "120px"
              : numeric
                ? "100px"
                : f.type === "uuid"
                  ? "120px"
                  : undefined,
        };
      });

    return [
      {
        id: "id",
        header: "ID",
        sortKey: "id",
        width: "100px",
        defaultHidden: usePairedTitle,
        cell: (row) => (
          <code className="font-mono text-xs text-muted-foreground">
            {String(row.id).slice(0, 8)}…
          </code>
        ),
      },
      ...(titleCol ? [titleCol] : []),
      ...fieldCols,
      {
        id: "updatedAt",
        header: "Updated",
        sortKey: "updated_at",
        width: "110px",
        cell: (row) => {
          const v = (row.updatedAt ?? row.createdAt) as
            | string
            | number
            | undefined;
          return v ? (
            <span
              className="font-mono text-xs tabular-nums text-muted-foreground"
              title={new Date(v).toLocaleString()}
            >
              {fmtRelative(v)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
    ];
  }, [collection]);

  const sortState = useMemo(() => {
    const dir: "asc" | "desc" = sort.startsWith("-") ? "desc" : "asc";
    const key = sort.startsWith("-") ? sort.slice(1) : sort;
    return { key, dir };
  }, [sort]);

  if (!collection && loading) {
    return (
      <div>
        <PageHeader
          title={<span className="font-mono">{slug}</span>}
          breadcrumbs={[
            { label: "Collections", to: "/collections" },
            { label: slug },
          ]}
          description="Loading collection schema and items."
        />
        <Card className="mb-4">
          <CardContent className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-1/3" />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <ul className="divide-y">
              {Array.from({ length: 4 }).map((_, i) => (
                <li key={i} className="space-y-2 py-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    );
  }

  const closeEditor = () => {
    setEditing(null);
    setRevisions(null);
    setRevisionsFor(null);
  };

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{slug}</span>
            {collection?.ownerScoped ? (
              <Badge variant="secondary">owner-scoped</Badge>
            ) : null}
          </span>
        }
        breadcrumbs={[
          { label: "Collections", to: "/collections" },
          { label: slug },
        ]}
        description={`${collection?.fields.length ?? 0} field(s). Click a row to edit; checkbox column enables bulk actions.`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={startCreate}>
              <PlusIcon /> New item
            </Button>
          </>
        }
      />

      <Sheet
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) closeEditor();
        }}
      >
        <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl overflow-hidden p-0">
          <SheetHeader className="border-b px-6 py-4">
            <SheetTitle>
              {editing?.mode === "create"
                ? "New item"
                : editing?.id
                  ? `Edit ${editing.id.slice(0, 8)}…`
                  : "Item"}
            </SheetTitle>
            <SheetDescription className="font-mono text-xs">
              {slug}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-6">
            {editing && collection && (
              <form id="item-form" className="space-y-6" onSubmit={submit}>
                {(() => {
                  // Filter by visibleWhen + group fields by `group`. Each
                  // group renders as its own section with a label; ungrouped
                  // fields are gathered under "" (no header).
                  const visible = collection.fields.filter(
                    (f) =>
                      !f.visibleWhen ||
                      matchesVisibility(f.visibleWhen, editing.data),
                  );
                  const groups = new Map<string, Field[]>();
                  for (const f of visible) {
                    const key = f.group ?? "";
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key)!.push(f);
                  }
                  // Stable ordering: ungrouped first, then groups in
                  // first-appearance order.
                  const ordered = Array.from(groups.entries());
                  return ordered.map(([groupName, groupFields]) => (
                    <section key={groupName || "_default"} className="space-y-4">
                      {groupName && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {groupName}
                          </span>
                          <span className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      {groupFields.map((f) => {
                        const hint = fieldHint(f);
                        return (
                          <div key={f.name} className="space-y-1.5">
                            <Label className="flex items-center gap-2">
                              <span>
                                {f.name}
                                {f.required ? (
                                  <span
                                    className="ml-0.5 text-destructive"
                                    aria-hidden="true"
                                  >
                                    *
                                  </span>
                                ) : null}
                              </span>
                              <Badge
                                variant="outline"
                                className="font-mono text-[10px]"
                              >
                                {f.interface ?? f.type}
                              </Badge>
                              {f.required ? (
                                <span className="sr-only"> required</span>
                              ) : null}
                            </Label>
                            {renderInput(f, editing.data[f.name], (v) =>
                              setEditing((cur) =>
                                cur
                                  ? {
                                      ...cur,
                                      data: { ...cur.data, [f.name]: v },
                                    }
                                  : cur,
                              ),
                            )}
                            {hint && (
                              <p className="text-[11px] text-muted-foreground">
                                {hint}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </section>
                  ));
                })()}
              </form>
            )}

            {editing?.mode === "edit" && editing.id === revisionsFor && (
              <>
                <Separator className="my-6" />
                <div>
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
                    <HistoryIcon className="size-4" /> History
                  </h3>
                  {revisions === null ? (
                    <ul className="space-y-2">
                      {Array.from({ length: 2 }).map((_, i) => (
                        <li key={i} className="space-y-1">
                          <Skeleton className="h-3 w-1/2" />
                          <Skeleton className="h-3 w-full" />
                        </li>
                      ))}
                    </ul>
                  ) : revisions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No revisions yet — save the item to capture one.
                    </p>
                  ) : (
                    <ul className="divide-y">
                      {revisions.map((r) => (
                        <li key={r.id} className="py-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">
                              {new Date(r.createdAt).toLocaleString()}
                            </span>
                            <ConfirmAction
                              title="Restore this revision?"
                              description="The current state will be replaced. Restoring itself creates a new revision, so it's reversible."
                              actionLabel="Restore"
                              onConfirm={() => revert(r.id)}
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                title="Restore this revision"
                              >
                                <Undo2Icon />
                              </Button>
                            </ConfirmAction>
                          </div>
                          <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                            {JSON.stringify(r.snapshot).slice(0, 200)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            {editing?.mode === "edit" && editing.id && (
              <>
                <Separator className="my-6" />
                <ItemComments slug={slug} itemId={editing.id} />
              </>
            )}
          </div>

          <SheetFooter className="border-t px-6 py-3">
            <Button type="button" variant="ghost" onClick={closeEditor}>
              Cancel
            </Button>
            <Button form="item-form" type="submit" disabled={busy}>
              {busy
                ? "Saving…"
                : editing?.mode === "create"
                  ? "Create"
                  : "Save"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Tabs
        defaultValue="items"
        className="space-y-4"
        onValueChange={(v) => {
          if (v === "permissions" && permissions === null) loadPermissions();
        }}
      >
        <div className="-mx-2 overflow-x-auto px-2 sm:mx-0 sm:px-0">
          <TabsList>
            <TabsTrigger value="items">
              <InboxIcon /> Items
              {filterCount !== null && (
                <span className="ml-1 rounded-md border border-border bg-background px-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {filterCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="schema">
              <BracesIcon /> Schema
              <span className="ml-1 rounded-md border border-border bg-background px-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                {collection?.fields.length ?? 0}
              </span>
            </TabsTrigger>
            <TabsTrigger value="permissions">
              <ShieldIcon /> Permissions
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="items" className="space-y-3">
          {/* Filter bar — stacks vertically on mobile so the search pill,
              status quick-tabs, filter chips, and sort select all stay
              comfortable. Single row from md+ where width permits. */}
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
            {/* Search pill — full width on mobile, flex-1 on md+ */}
            <div className="flex h-9 w-full items-center gap-2 rounded-3xl border border-input bg-card px-3.5 md:w-auto md:min-w-[240px] md:flex-1">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onBlur={() => setSearch(searchInput)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setSearch(searchInput);
                  }
                  if (e.key === "Escape") {
                    setSearchInput("");
                    setSearch("");
                  }
                }}
                placeholder={
                  firstTextField ? "Search text fields…" : "Search…"
                }
                className="h-7 min-w-0 flex-1 border-0 bg-transparent p-0 focus-visible:ring-0"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput("");
                    setSearch("");
                  }}
                  className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  aria-label="Clear search"
                >
                  <XIcon size={12} />
                </button>
              )}
            </div>

            {/* Secondary controls row on mobile, inline on md+ */}
            <div className="flex flex-wrap items-center gap-2">
              {statusField && (
                <Tabs value={statusTab} onValueChange={setStatusTab}>
                  <TabsList className="h-9 overflow-x-auto">
                    <TabsTrigger value="all">All</TabsTrigger>
                    {STATUS_VALUES.map((s) => (
                      <TabsTrigger key={s} value={s}>
                        {s}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}

              {collection && (
                <FilterBuilder
                  fields={collection.fields}
                  filters={filters}
                  onChange={setFilters}
                  mode={filterMode}
                  onModeChange={setFilterMode}
                />
              )}

              <Select
                value={sort}
                onValueChange={(v) => {
                  setSort(v);
                  setPage(0);
                }}
              >
                <SelectTrigger
                  className="ml-auto w-[160px] sm:w-[180px]"
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="-created_at">Newest</SelectItem>
                  <SelectItem value="created_at">Oldest</SelectItem>
                  <SelectItem value="-updated_at">Recently updated</SelectItem>
                  <SelectItem value="updated_at">
                    Least recently updated
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Live filter URL preview — shown only when a query is active */}
          {(combinedFilter || search.trim()) && (
            <div className="overflow-hidden rounded-2xl border border-border bg-muted/40 px-4 py-2 font-mono text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">GET</span>{" "}
              <span className="break-all">
                {previewFilterUrl(slug, combinedFilter, search)}
              </span>
            </div>
          )}

          {/* Item count + pagination */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground tabular-nums">
              {filterCount === null ? items.length : filterCount} item(s)
              {filterCount !== null && filterCount > PAGE_SIZE && (
                <>
                  {" "}
                  · page {page + 1} of {Math.ceil(filterCount / PAGE_SIZE)}
                </>
              )}
            </span>
            {filterCount !== null && filterCount > PAGE_SIZE && (
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE_SIZE >= filterCount}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </div>

          <DataTable<Item>
            columns={columns}
            rows={items}
            loading={loading}
            selectable
            selectedIds={selected}
            onSelectionChange={setSelected}
            sort={sortState}
            onSortChange={(s) => {
              if (!s) {
                setSort("-created_at");
              } else {
                setSort(`${s.dir === "desc" ? "-" : ""}${s.key}`);
              }
              setPage(0);
            }}
            bulkActions={(ids) => (
              <ConfirmAction
                title={`Delete ${ids.size} item(s)?`}
                description="This cannot be undone. Each delete records a revision."
                actionLabel={`Delete ${ids.size}`}
                destructive
                onConfirm={() => removeMany(Array.from(ids))}
              >
                <Button variant="destructive" size="sm">
                  <Trash2Icon /> Delete selected
                </Button>
              </ConfirmAction>
            )}
            onRowClick={(row) => startEdit(row)}
            rowActions={(row) => (
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => startEdit(row)}
                >
                  <PencilIcon />
                </Button>
                <ConfirmAction
                  title="Delete this item?"
                  description={`Item ${String(row.id).slice(0, 8)}… will be removed. A revision is recorded so you can undo.`}
                  actionLabel="Delete"
                  destructive
                  onConfirm={() => remove(String(row.id))}
                >
                  <Button variant="ghost" size="icon-sm">
                    <Trash2Icon />
                  </Button>
                </ConfirmAction>
              </div>
            )}
            empty={
              <EmptyState
                icon={InboxIcon}
                title={
                  filters.length > 0 || search || statusTab !== "all"
                    ? "No items match"
                    : "No items yet"
                }
                description={
                  filters.length > 0 || search || statusTab !== "all"
                    ? "Adjust filters above or clear them."
                    : "Create the first item via the API or the New item button above."
                }
                action={
                  filters.length === 0 && !search && statusTab === "all" ? (
                    <Button size="sm" onClick={startCreate}>
                      <PlusIcon /> New item
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setFilters([]);
                        setSearch("");
                        setSearchInput("");
                        setStatusTab("all");
                      }}
                    >
                      Clear filters
                    </Button>
                  )
                }
              />
            }
          />
        </TabsContent>

        <TabsContent value="schema" className="space-y-3">
          <SchemaTab
            collection={collection}
            slug={slug}
            onChanged={refresh}
          />
        </TabsContent>

        <TabsContent value="permissions" className="space-y-3">
          <PermissionsTab
            permissions={permissions}
            roles={roles}
            slug={slug}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

interface SchemaTabProps {
  collection: Collection | null;
  slug: string;
  /** Re-fetch the collection after a successful add/drop. */
  onChanged: () => void;
}

/** Common types surfaced in the Add Field form. */
const ADD_FIELD_TYPES: Field["type"][] = [
  "text",
  "longtext",
  "integer",
  "number",
  "boolean",
  "json",
  "timestamp",
  "uuid",
  "relation",
  "relation_many",
  "file",
  "i18n_text",
];

interface AddFieldFormProps {
  slug: string;
  existing: Field[];
  onClose: () => void;
  onAdded: () => void;
}

const AddFieldForm = ({
  slug,
  existing,
  onClose,
  onAdded,
}: AddFieldFormProps) => {
  const [name, setName] = useState("");
  const [type, setType] = useState<Field["type"]>("text");
  const [required, setRequired] = useState(false);
  const [unique, setUnique] = useState(false);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const isRelation = type === "relation" || type === "relation_many";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      notifyError("Field name must be snake_case (a-z, 0-9, _)");
      return;
    }
    if (existing.some((f) => f.name === name)) {
      notifyError(`Field "${name}" already exists`);
      return;
    }
    if (isRelation && !to) {
      notifyError("Relation needs a target collection slug");
      return;
    }
    setBusy(true);
    try {
      const newField: Field = {
        name,
        type,
        ...(required ? { required: true } : {}),
        ...(unique ? { unique: true } : {}),
        ...(isRelation ? { to } : {}),
      };
      // PATCH /api/collections/:slug expects the FULL fields array (additive
      // update rules apply on the backend — applyCollection only adds the
      // missing column, never alters existing ones).
      await api(`/api/collections/${slug}`, {
        method: "PATCH",
        body: JSON.stringify({ fields: [...existing, newField] }),
      });
      toast.success(`Field "${name}" added`);
      onAdded();
      onClose();
    } catch (e) {
      notifyError(e, "Adding field");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="fname">Name</Label>
          <Input
            id="fname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="reading_time_minutes"
            required
            autoFocus
            pattern="^[a-z][a-z0-9_]*$"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            snake_case · lowercase letters / digits / underscore
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select
            value={type}
            onValueChange={(v) => setType(v as Field["type"])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADD_FIELD_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isRelation && (
        <div className="space-y-1.5">
          <Label htmlFor="ftarget">Target collection slug</Label>
          <Input
            id="ftarget"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="authors"
            required
            pattern="^[a-z][a-z0-9_]*$"
            className="font-mono"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-4 pt-1 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={required}
            onCheckedChange={(v) => setRequired(!!v)}
          />
          required
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={unique}
            onCheckedChange={(v) => setUnique(!!v)}
          />
          unique
        </label>
      </div>

      <p className="rounded-2xl border border-border bg-muted/40 px-3 py-2 text-[11.5px] text-muted-foreground">
        ALTER TABLE <span className="font-mono">c_{slug}</span> ADD COLUMN —
        additive only. Existing rows get NULL (or the type default) until
        backfilled.
      </p>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Adding…" : "Add field"}
        </Button>
      </div>
    </form>
  );
};

const sqlTypeFor = (t: string): string => {
  switch (t) {
    case "integer":
      return "INTEGER";
    case "longtext":
      return "TEXT";
    case "boolean":
      return "INTEGER";
    case "json":
      return "TEXT";
    case "timestamp":
      return "INTEGER";
    case "number":
      return "REAL";
    case "uuid":
      return "TEXT";
    default:
      return "TEXT";
  }
};

const SchemaTab = ({ collection, slug, onChanged }: SchemaTabProps) => {
  const [addOpen, setAddOpen] = useState(false);
  const [dropping, setDropping] = useState<string | null>(null);

  if (!collection) return null;
  const fields = collection.fields;
  const editable = fields.filter(
    (f) => f.name !== "id" && f.name !== "created_at" && f.name !== "updated_at" && f.name !== "owner_id",
  );

  // Sample preview kept as a hint of what the ALTER will look like; the
  // real form below produces the actual SQL.
  const sample = {
    name: "reading_time_minutes",
    type: "integer" as const,
    nullable: false,
    default: "0",
  };

  const dropField = async (fieldName: string) => {
    setDropping(fieldName);
    try {
      await api(`/api/collections/${slug}`, {
        method: "PATCH",
        body: JSON.stringify({
          fields: fields.filter((f) => f.name !== fieldName),
        }),
      });
      toast.success(`Field "${fieldName}" removed from the metadata`);
      onChanged();
    } catch (e) {
      notifyError(e, "Removing field");
    } finally {
      setDropping(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <BracesIcon className="size-4 shrink-0" />
            <span className="text-sm font-medium">fields</span>
            <span className="font-mono text-xs text-muted-foreground">
              {fields.length} total · {editable.length} editable
            </span>
            <div className="ml-auto" />
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <PlusIcon /> Add field
            </Button>
          </div>
          <ul>
            {fields.map((f) => {
              const isSystem =
                f.name === "id" ||
                f.name === "created_at" ||
                f.name === "updated_at" ||
                f.name === "owner_id";
              return (
                <li
                  key={f.name}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_100px_36px]"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-mono text-sm break-all">{f.name}</span>
                    {isSystem && <Badge variant="secondary">system</Badge>}
                    {f.required && !isSystem && (
                      <Badge variant="outline">required</Badge>
                    )}
                    {f.type === "relation" && f.to && (
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px]"
                      >
                        → {f.to}
                      </Badge>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className="justify-self-end font-mono text-[10px]"
                  >
                    {f.type}
                  </Badge>
                  <span className="col-span-2 font-mono text-[11px] text-muted-foreground sm:col-span-1 sm:truncate">
                    {f.required ? (
                      <>NOT NULL</>
                    ) : (
                      <span className="opacity-50">—</span>
                    )}
                  </span>
                  <div className="hidden text-right sm:block">
                    {!isSystem ? (
                      <ConfirmAction
                        title={`Drop column "${f.name}"?`}
                        description={
                          `ALTER TABLE c_${slug} DROP COLUMN "${f.name}" is irreversible. ` +
                          `Existing data in the column is lost.`
                        }
                        actionLabel="Drop column"
                        destructive
                        onConfirm={() => dropField(f.name)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={dropping === f.name}
                          title="Drop column"
                        >
                          <Trash2Icon />
                        </Button>
                      </ConfirmAction>
                    ) : (
                      <span aria-hidden className="inline-block size-7" />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add field to {slug}</DialogTitle>
            <DialogDescription>
              Adds a new column to{" "}
              <code className="font-mono">c_{slug}</code>. Additive only —
              existing rows are not rewritten.
            </DialogDescription>
          </DialogHeader>
          <AddFieldForm
            slug={slug}
            existing={fields}
            onClose={() => setAddOpen(false)}
            onAdded={onChanged}
          />
        </DialogContent>
      </Dialog>

      {/* Pending-alteration preview card — design's signature SQL block */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <CodeIcon className="size-4" />
            <span className="text-sm font-medium">sample alteration</span>
            <span className="font-mono text-xs text-muted-foreground">
              preview · ALTER form generates the real one
            </span>
            <div className="flex-1" />
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
              Add field
            </Button>
          </div>
          <div className="p-4">
            <pre
              className="overflow-x-auto rounded-2xl p-4 font-mono text-xs leading-relaxed"
              style={{
                background: "oklch(0.18 0.01 130)",
                color: "oklch(0.95 0.02 130)",
              }}
            >
              <span style={{ color: "oklch(0.6 0.02 130)" }}>
                {`-- runtime DDL preview · sqlite dialect`}
                {"\n"}
              </span>
              <span style={{ color: "oklch(0.78 0.18 95)" }}>ALTER TABLE</span>{" "}
              <span style={{ color: "oklch(0.85 0.13 200)" }}>
                "c_{slug}"
              </span>
              {"\n  "}
              <span style={{ color: "oklch(0.78 0.18 95)" }}>ADD COLUMN</span>{" "}
              <span style={{ color: "oklch(0.85 0.13 200)" }}>
                "{sample.name}"
              </span>{" "}
              {sqlTypeFor(sample.type)}
              {!sample.nullable && (
                <>
                  {" "}
                  <span style={{ color: "oklch(0.78 0.18 95)" }}>NOT NULL</span>
                </>
              )}
              {sample.default && (
                <>
                  {" "}
                  <span style={{ color: "oklch(0.78 0.18 95)" }}>DEFAULT</span>{" "}
                  <span style={{ color: "oklch(0.85 0.13 130)" }}>
                    {sample.default}
                  </span>
                </>
              )}
              ;{"\n"}
              <span style={{ color: "oklch(0.6 0.02 130)" }}>
                -- additive only — no data is rewritten.
              </span>
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

interface PermissionsTabProps {
  permissions: Permission[] | null;
  roles: Role[];
  slug: string;
}

const PermissionsTab = ({ permissions, roles, slug }: PermissionsTabProps) => {
  const roleName = (id: string) =>
    roles.find((r) => r.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ShieldIcon className="size-4" />
          <span className="text-sm font-medium">permissions for {slug}</span>
          <div className="flex-1" />
          <Button asChild size="sm" variant="outline">
            <a href="/settings">Edit in Settings</a>
          </Button>
        </div>
        {permissions === null ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="px-4 py-3">
                <Skeleton className="h-4 w-2/3" />
              </li>
            ))}
          </ul>
        ) : permissions.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No explicit permissions for this collection. The defaults from the
            built-in roles (admin / authenticated / public) apply.
          </div>
        ) : (
          <ul>
            {permissions.map((p) => (
              <li
                key={p.id}
                className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5 last:border-b-0 text-sm sm:grid-cols-[140px_100px_1fr]"
              >
                <span className="font-mono text-xs">{roleName(p.roleId)}</span>
                <Badge
                  variant="outline"
                  className="justify-self-end font-mono uppercase sm:justify-self-start"
                >
                  {p.action}
                </Badge>
                <span className="col-span-2 break-all font-mono text-xs text-muted-foreground sm:col-span-1">
                  {p.condition
                    ? JSON.stringify(p.condition)
                    : "— no condition (unrestricted within action scope)"}
                  {p.fields && p.fields.length > 0 && (
                    <>
                      {" "}
                      · fields:{" "}
                      <span className="text-foreground">
                        {p.fields.join(", ")}
                      </span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <CardContent className="space-y-3 border-t border-border bg-muted/30 p-4">
        <div className="flex items-center gap-2">
          <CodeIcon className="size-4" />
          <span className="text-sm font-medium">condition DSL</span>
          <span className="font-mono text-xs text-muted-foreground">
            same syntax as filter & realtime gates
          </span>
        </div>
        <pre
          className="overflow-x-auto rounded-2xl p-4 font-mono text-xs leading-relaxed"
          style={{
            background: "oklch(0.18 0.01 130)",
            color: "oklch(0.95 0.02 130)",
          }}
        >
{"{"}
{"\n  "}<span style={{ color: "oklch(0.85 0.13 200)" }}>"$and"</span>: [
{"\n    "}{"{"} <span style={{ color: "oklch(0.85 0.13 200)" }}>"owner_id"</span>: {"{"} <span style={{ color: "oklch(0.85 0.13 200)" }}>"_eq"</span>: <span style={{ color: "oklch(0.85 0.13 130)" }}>"$user.id"</span> {"}"} {"},"}
{"\n    "}{"{"} <span style={{ color: "oklch(0.85 0.13 200)" }}>"status"</span>: {"{"} <span style={{ color: "oklch(0.85 0.13 200)" }}>"_neq"</span>: <span style={{ color: "oklch(0.85 0.13 130)" }}>"archived"</span> {"}"} {"}"}
{"\n  "}]
{"\n}"}
        </pre>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>
            <code className="font-mono text-foreground">$user.id</code> · current user uuid
          </span>
          <span>
            <code className="font-mono text-foreground">$user.email</code> · email
          </span>
          <span>
            <code className="font-mono text-foreground">$user.roles</code> · array of role names
          </span>
          <span>
            <code className="font-mono text-foreground">$now</code> · server time
          </span>
        </div>
      </CardContent>
    </Card>
  );
};

interface CommentRow {
  id: string;
  collection: string;
  itemId: string;
  userId: string | null;
  body: string;
  createdAt: string | number;
}

const ItemComments = ({
  slug,
  itemId,
}: {
  slug: string;
  itemId: string;
}) => {
  const [items, setItems] = useState<CommentRow[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<{ data: CommentRow[] }>(
      `/api/comments?collection=${encodeURIComponent(slug)}&itemId=${encodeURIComponent(itemId)}`,
    )
      .then((r) => setItems(r.data))
      .catch((e) => notifyError(e, "Loading comments"));
  };

  useEffect(load, [slug, itemId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api(`/api/comments`, {
        method: "POST",
        body: JSON.stringify({ collection: slug, itemId, body: body.trim() }),
      });
      setBody("");
      load();
    } catch (e) {
      notifyError(e, "Posting comment");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/comments/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      notifyError(e, "Deleting comment");
    }
  };

  return (
    <div>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <InboxIcon className="size-4" /> Comments
        {items && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {items.length}
          </span>
        )}
      </h3>

      <form className="mb-3 space-y-2" onSubmit={submit}>
        <Textarea
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment…"
          maxLength={4000}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={busy || !body.trim()}>
            {busy ? "Posting…" : "Post"}
          </Button>
        </div>
      </form>

      {items === null ? (
        <ul className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <li key={i} className="space-y-1">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-full" />
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="divide-y">
          {items.map((c) => (
            <li key={c.id} className="py-2">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-mono">
                  {c.userId ? c.userId.slice(0, 8) + "…" : "anon"}
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono tabular-nums">
                    {new Date(c.createdAt).toLocaleString()}
                  </span>
                  <ConfirmAction
                    title="Delete comment?"
                    description="This cannot be undone."
                    actionLabel="Delete"
                    destructive
                    onConfirm={() => remove(c.id)}
                  >
                    <Button variant="ghost" size="icon-xs" title="Delete">
                      <Trash2Icon />
                    </Button>
                  </ConfirmAction>
                </div>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {c.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
