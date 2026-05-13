import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { DatabaseIcon, PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";
import { toast } from "@workeros/ui/components/sonner";

type FieldType =
  | "text"
  | "longtext"
  | "integer"
  | "number"
  | "boolean"
  | "json"
  | "timestamp"
  | "uuid"
  | "relation";

const FIELD_TYPES: FieldType[] = [
  "text",
  "longtext",
  "integer",
  "number",
  "boolean",
  "json",
  "timestamp",
  "uuid",
  "relation",
];

interface Field {
  name: string;
  type: FieldType;
  required?: boolean;
  to?: string;
  /** Include this field in the embed text. Only meaningful for text/longtext. */
  vectorize?: boolean;
}

interface Collection {
  slug: string;
  fields: Field[];
  ownerScoped: boolean | number;
  vectorize?: boolean | number;
  vectorizeModel?: string | null;
}

/** Mirrors EMBEDDING_MODELS in packages/core. Kept inline so the admin
 *  bundle doesn't pull the whole core package for one label list. */
const EMBEDDING_MODEL_CHOICES: Array<{ id: string; label: string }> = [
  { id: "", label: "Default (env)" },
  { id: "bge-m3", label: "BGE-M3 (Workers AI, 1024)" },
  { id: "openai-3-small", label: "OpenAI text-embedding-3-small (1536)" },
  { id: "openai-3-large", label: "OpenAI text-embedding-3-large (3072)" },
  { id: "self-host-bge-m3", label: "Self-host bge-m3 (1024)" },
];

const isVectorizableType = (t: FieldType): boolean =>
  t === "text" || t === "longtext";

export const Collections = () => {
  const [items, setItems] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [slug, setSlug] = useState("");
  const [ownerScoped, setOwnerScoped] = useState(false);
  const [vectorize, setVectorize] = useState(false);
  const [vectorizeModel, setVectorizeModel] = useState("");
  const [fields, setFields] = useState<Field[]>([
    { name: "title", type: "text", required: true },
  ]);
  const [busy, setBusy] = useState(false);
  const [vectorizingSlug, setVectorizingSlug] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    api<{ data: Collection[] }>("/api/collections")
      .then((r) => setItems(r.data))
      .catch((e) => notifyError(e, "Loading collections"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const addField = () =>
    setFields((f) => [...f, { name: "", type: "text" }]);
  const updateField = (i: number, patch: Partial<Field>) =>
    setFields((f) => f.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeField = (i: number) =>
    setFields((f) => f.filter((_, j) => j !== i));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/collections", {
        method: "POST",
        body: JSON.stringify({
          slug,
          fields: fields
            .filter((f) => f.name)
            // Strip `vectorize` on non-text types — only relevant for text/longtext.
            .map((f) =>
              isVectorizableType(f.type) ? f : { ...f, vectorize: undefined },
            ),
          ownerScoped,
          vectorize,
          vectorizeModel: vectorizeModel || null,
        }),
      });
      setShowForm(false);
      setSlug("");
      setFields([{ name: "title", type: "text", required: true }]);
      setOwnerScoped(false);
      setVectorize(false);
      setVectorizeModel("");
      refresh();
    } catch (e) {
      notifyError(e, "Saving collection");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: string) => {
    try {
      await api(`/api/collections/${s}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, "Dropping collection");
    }
  };

  const vectorizeAll = async (s: string) => {
    setVectorizingSlug(s);
    try {
      const res = await api<{
        processed: number;
        skipped: number;
        total: number;
      }>(`/api/collections/${s}/vectorize`, { method: "POST" });
      toast.success(
        `Vectorized ${res.processed}/${res.total} item(s)${res.skipped ? ` — ${res.skipped} skipped (no text)` : ""}`,
      );
    } catch (e) {
      notifyError(e, "Vectorizing collection");
    } finally {
      setVectorizingSlug(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Collections"
        description="Dynamic schema. Each collection becomes a physical c_<slug> table at runtime; drop or alter via this UI."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => setShowForm((s) => !s)}>
              <PlusIcon /> {showForm ? "Cancel" : "New"}
            </Button>
          </>
        }
      />

      {showForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Create collection</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="slug">Slug (snake_case)</Label>
                  <Input
                    id="slug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    placeholder="posts"
                    pattern="^[a-z][a-z0-9_]*$"
                    required
                  />
                </div>
                <label className="flex items-end gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ownerScoped}
                    onChange={(e) => setOwnerScoped(e.target.checked)}
                  />
                  Owner-scoped (each user sees only their own items)
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={vectorize}
                    onChange={(e) => setVectorize(e.target.checked)}
                  />
                  Vectorize records (auto-embed selected text fields on write)
                </label>
                {vectorize && (
                  <div className="space-y-1.5">
                    <Label htmlFor="vectorize-model">Embedding model</Label>
                    <select
                      id="vectorize-model"
                      className="h-9 w-full rounded-3xl border border-input bg-background px-3 text-sm"
                      value={vectorizeModel}
                      onChange={(e) => setVectorizeModel(e.target.value)}
                    >
                      {EMBEDDING_MODEL_CHOICES.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <Label>Fields</Label>
                  <Button type="button" variant="outline" size="xs" onClick={addField}>
                    <PlusIcon /> Add field
                  </Button>
                </div>
                <div className="space-y-2">
                  {fields.map((f, i) => (
                    <div key={i} className="space-y-2">
                      <div className="flex gap-2">
                        <Input
                          className="flex-1"
                          placeholder="field_name"
                          value={f.name}
                          onChange={(e) => updateField(i, { name: e.target.value })}
                        />
                        <select
                          className="h-9 rounded-3xl border border-input bg-background px-3 text-sm"
                          value={f.type}
                          onChange={(e) => {
                            const t = e.target.value as FieldType;
                            updateField(i, {
                              type: t,
                              ...(t !== "relation" ? { to: undefined } : {}),
                            });
                          }}
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <label className="flex items-center gap-1 text-sm">
                          <input
                            type="checkbox"
                            checked={f.required ?? false}
                            onChange={(e) =>
                              updateField(i, { required: e.target.checked })
                            }
                          />
                          required
                        </label>
                        {vectorize && isVectorizableType(f.type) && (
                          <label className="flex items-center gap-1 text-sm">
                            <input
                              type="checkbox"
                              checked={f.vectorize ?? false}
                              onChange={(e) =>
                                updateField(i, { vectorize: e.target.checked })
                              }
                            />
                            vectorize
                          </label>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeField(i)}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                      {f.type === "relation" && (
                        <Input
                          className="ml-1"
                          placeholder="target collection slug (e.g. users)"
                          value={f.to ?? ""}
                          onChange={(e) => updateField(i, { to: e.target.value })}
                          required
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowForm(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {!loading && items.length === 0 && (
        <EmptyState
          icon={DatabaseIcon}
          title="No collections yet"
          description="Collections are physical tables generated at runtime. Create one to start storing items via the REST or GraphQL API."
        />
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => {
          const vec = Boolean(c.vectorize);
          return (
            <Card key={c.slug}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="font-mono text-sm">
                    <Link to={`/collections/${c.slug}`} className="hover:underline">
                      {c.slug}
                    </Link>
                  </CardTitle>
                  <div className="flex items-center gap-1">
                    {vec && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Vectorize all existing records"
                        disabled={vectorizingSlug === c.slug}
                        onClick={() => vectorizeAll(c.slug)}
                      >
                        <SparklesIcon />
                      </Button>
                    )}
                    <ConfirmAction
                      title={`Drop collection "${c.slug}"?`}
                      description="The physical table and all rows will be removed. This cannot be undone."
                      actionLabel="Drop collection"
                      destructive
                      onConfirm={() => remove(c.slug)}
                    >
                      <Button variant="ghost" size="icon-sm">
                        <Trash2Icon />
                      </Button>
                    </ConfirmAction>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {c.fields.map((f) => (
                    <li key={f.name}>
                      <span className="font-medium text-foreground">{f.name}</span>{" "}
                      <span className="text-xs">({f.type})</span>
                      {f.required && <span className="ml-1 text-xs">required</span>}
                      {vec && f.vectorize && (
                        <span className="ml-1 text-xs text-primary">vectorize</span>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.ownerScoped ? (
                    <Badge variant="secondary">owner-scoped</Badge>
                  ) : null}
                  {vec ? (
                    <Badge variant="secondary">
                      vectorize{c.vectorizeModel ? ` · ${c.vectorizeModel}` : ""}
                    </Badge>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
};
