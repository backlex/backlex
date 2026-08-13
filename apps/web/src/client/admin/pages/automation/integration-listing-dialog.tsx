// Putting products ON SALE — the operator's half of the sixth shape.
//
// A listing sync is the only one whose configuration cannot be finished in the
// create dialog, and that is not an omission. Every other sync's form is
// knowable up front: a source declares its settings, a destination its columns.
// A listing's form is a question only the marketplace can answer — which of
// ~4,000 categories this product belongs to, then which of the ~24 attributes
// that category demands, then which of the hundreds of values each one allows.
// So the sync is created first and INTERROGATED here, against the seller's own
// credentials.
//
// Two panels, because an operator does two different jobs. Mapping a category
// is setup, done once per local category and then rarely touched. Watching a
// batch is the opposite — it is the whole reason a listing is not a destination:
// a marketplace refuses one unit at a time, minutes or hours later, with a
// reason a person has to read.
import type { PushToast } from "../../types";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, relativeTime } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { api } from "@/lib/api";
import { fetchSafely } from "../_shared";

/** One node of the marketplace's tree, flat with a parent pointer. */
export type ListingCategory = {
  id: string;
  name: string;
  parentId: string | null;
  /** A product may only be listed against a leaf. */
  leaf: boolean;
};

/** What a chosen category demands, normalised across the marketplaces. */
export type ListingAttribute = {
  id: string;
  name: string;
  required: boolean;
  allowCustom: boolean;
  /** Two products differing only here are one product with two variants. */
  variant: boolean;
  multiple: boolean;
  values: { id: string; name: string }[];
};

/**
 * One answer to one attribute. Exactly one of the three is set.
 *
 * `field` is the one that makes a varianter attribute work: a size or a colour
 * differs per unit, so the answer is a COLUMN to read rather than a value to
 * repeat.
 */
export type ListingBinding = { valueId?: string; custom?: string; field?: string };

export type ListingMap = {
  id: string;
  syncId: string;
  localValue: string;
  categoryId: string;
  attributes: Record<string, ListingBinding>;
  createdAt: number | string | null;
  updatedAt: number | string | null;
};

/** One publish call, and what the marketplace has said about it so far. */
export type ListingBatch = {
  id: string;
  batchId: string;
  status: string;
  unitCount: number;
  pendingCount: number;
  error: string | null;
  createdAt: number | string | null;
  resolvedAt: number | string | null;
};

/** The fixed half of a provider's listing block, straight from the catalog. */
export type ListingInfo = {
  settingFields: { key: string; label: string; placeholder?: string; options?: { value: string; label: string }[] }[];
  /**
   * How this marketplace will let its taxonomy be read.
   *
   * `all` — the whole tree in one request, so the picker is a search box.
   * `levels` — one level at a time, so the picker is a drill-down. Allegro is
   * the reason: it answers with the children of one node and has no whole-tree
   * endpoint, and enumerating its ~23,000 categories would be thousands of
   * requests.
   */
  browse: "all" | "levels";
  columns: { value: string; label: string }[];
  variantColumns: { value: string; label: string }[] | null;
  outputs: { key: string; label: string }[];
  lookups: { key: string; label: string }[];
};

/**
 * How many search hits are drawn at once.
 *
 * The tree is a few thousand nodes and every one of them is a DOM row if the
 * list is not capped. Capping rather than virtualising is the honest trade
 * here: a picker showing 60 hits is a search that needs narrowing, not a list
 * worth scrolling — and the count below says so out loud rather than letting
 * the operator believe they are seeing everything.
 */
const MAX_HITS = 60;

/* ── The panel a listing sync opens ─────────────────────────────────────── */
export function ListingDialog({
  syncId,
  integrationId,
  providerName,
  info,
  /**
   * The columns an attribute may read its value from.
   *
   * The product's fields AND the variant's, because the engine resolves an
   * attribute against the variant row first and falls back to the product —
   * so a size or a colour, which is exactly what a varianter attribute is,
   * has to be offerable.
   */
  productFields,
  onClose,
  pushToast,
}: {
  syncId: string;
  integrationId: string;
  providerName: string;
  info: ListingInfo;
  productFields: { value: string; label: string }[];
  onClose: () => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [maps, setMaps] = useState<ListingMap[] | null>(null);
  const [batches, setBatches] = useState<ListingBatch[] | null>(null);
  /** The whole tree, fetched once and reused by every mapping dialog. */
  const [categories, setCategories] = useState<ListingCategory[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ListingMap | "new" | null>(null);
  /** Levels already fetched, so a walk back down does not re-ask. */
  const loadedLevels = useRef<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    void (async () => {
      const [m, b] = await Promise.all([
        fetchSafely<{ data: ListingMap[] }>(`/api/admin/integrations/syncs/${syncId}/listing/maps`),
        fetchSafely<{ data: ListingBatch[] }>(`/api/admin/integrations/syncs/${syncId}/listing/batches`),
      ]);
      if (!live) return;
      setMaps(m?.data ?? []);
      setBatches(b?.data ?? []);
      // A mapping stores the marketplace's own id, so without the tree the list
      // reads "abiye → 3535" — not something an operator can check. Fetched
      // only when there is something to name; with no mappings there is nothing
      // to label, and the picker fetches it when they go to add one.
      if ((m?.data ?? []).length > 0) {
        try {
          const cats = await api<{ data: ListingCategory[] }>(
            `/api/admin/integrations/${integrationId}/listing/categories`,
          );
          if (live) setCategories(cats.data);
        } catch (e) {
          if (live) setCatalogError((e as Error).message);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [syncId, integrationId]);

  /**
   * The tree, once per open.
   *
   * Not fetched alongside the two lists above: it is hundreds of kilobytes.
   * Failing is reported rather than swallowed — a marketplace refusing the
   * catalog is almost always the credentials, and an empty picker would read as
   * "this marketplace has no categories".
   */
  const loadCategories = async () => {
    if (categories) return;
    // A level-walked marketplace has no "whole tree" to ask for; its picker
    // starts at the roots and fetches on the way down.
    if (info.browse === "levels") return loadLevel(null);
    try {
      const res = await api<{ data: ListingCategory[] }>(
        `/api/admin/integrations/${integrationId}/listing/categories`,
      );
      setCategories(res.data);
      setCatalogError(null);
    } catch (e) {
      setCatalogError((e as Error).message);
    }
  };

  /**
   * One level, MERGED into what is already known.
   *
   * Accumulating rather than replacing is what keeps the breadcrumb working:
   * everything above the current node was fetched on the way down, so `pathOf`
   * can still name it. It also makes going back free.
   */
  const loadLevel = async (parentId: string | null) => {
    if (loadedLevels.current.has(parentId ?? "")) return;
    try {
      const res = await api<{ data: ListingCategory[] }>(
        `/api/admin/integrations/${integrationId}/listing/categories?parentId=${encodeURIComponent(parentId ?? "")}`,
      );
      loadedLevels.current.add(parentId ?? "");
      setCategories((prev) => {
        const seen = new Set((prev ?? []).map((c) => c.id));
        return [...(prev ?? []), ...res.data.filter((c) => !seen.has(c.id))];
      });
      setCatalogError(null);
    } catch (e) {
      setCatalogError((e as Error).message);
    }
  };


  const saveMap = async (input: { localValue: string; categoryId: string; attributes: Record<string, ListingBinding> }) => {
    const snapshot = maps ?? [];
    // Optimistic on the row that is about to exist. An upsert keyed on
    // `localValue` means a re-map REPLACES rather than adds, so the snapshot is
    // filtered by that key and not by id.
    const optimistic: ListingMap = {
      id: `pending-${input.localValue}`,
      syncId,
      localValue: input.localValue,
      categoryId: input.categoryId,
      attributes: input.attributes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setMaps([...snapshot.filter((m) => m.localValue !== input.localValue), optimistic]);
    setMapping(null);
    try {
      const res = await api<{ data: ListingMap }>(`/api/admin/integrations/syncs/${syncId}/listing/maps`, {
        method: "PUT",
        body: JSON.stringify(input),
      });
      setMaps((prev) =>
        (prev ?? []).map((m) => (m.localValue === input.localValue ? res.data : m)),
      );
    } catch (e) {
      setMaps(snapshot);
      pushToast((e as Error).message);
    }
  };

  const removeMap = async (row: ListingMap) => {
    const snapshot = maps ?? [];
    setMaps(snapshot.filter((m) => m.id !== row.id));
    try {
      await api(`/api/admin/integrations/syncs/${syncId}/listing/maps/${row.id}`, { method: "DELETE" });
      pushToast(t`Unmapped. Products in it are skipped by the next run rather than published uncategorised.`);
    } catch (e) {
      setMaps(snapshot);
      pushToast((e as Error).message);
    }
  };

  /** The name a mapped category goes by. Falls back to the id, which is what a
   *  category the marketplace has since retired leaves behind. */
  const nameOf = (categoryId: string): string =>
    categories?.find((c) => c.id === categoryId)?.name ?? categoryId;

  /** `open` is the one an operator watches; the rest are settled. */
  const tone = (status: string): "secondary" | "destructive" | "default" =>
    status === "open" ? "secondary" : status === "failed" ? "destructive" : "default";

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        {/* `[&>*]:min-w-0` for the same reason the endpoint panel needs it: a
            category id and a batch ticket are unbroken tokens, and their
            min-content would otherwise size the dialog's implicit grid track and
            stretch the header off a phone screen. */}
        <DialogContent className="w-full gap-0 p-0 sm:max-w-[600px] [&>*]:min-w-0">
          <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
            <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
              <Trans>Listing at {providerName}</Trans>
            </DialogTitle>
            <DialogDescription className="text-[12.5px] text-muted-foreground">
              <Trans>
                Every product carries a local category; each one is mapped to a marketplace category once, and
                that mapping answers what the category demands. A product whose category is not mapped is
                skipped rather than published uncategorised.
              </Trans>
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div className="flex flex-col gap-4 px-5 py-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[11.5px] font-medium">
                    <Trans>Category mapping</Trans>
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void loadCategories();
                      setMapping("new");
                    }}
                  >
                    <Trans>Map a category</Trans>
                  </Button>
                </div>

                {maps === null ? (
                  <div className="flex flex-col gap-1.5">
                    {[0, 1].map((i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                ) : maps.length === 0 ? (
                  <p className="text-[11.5px] leading-snug text-muted-foreground">
                    <Trans>
                      Nothing is mapped yet, so a run would publish nothing. Map the value your products carry
                      in the category column to the marketplace category it belongs in.
                    </Trans>
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {maps.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
                      >
                        <code className="min-w-0 shrink truncate text-[11.5px]">{m.localValue}</code>
                        <I.ArrowRight size={12} className="shrink-0 text-muted-foreground" />
                        {categories === null && !catalogError ? (
                          // The tree is still on its way. A skeleton rather than
                          // the raw id: an id an operator cannot read is worse
                          // than an obvious placeholder, and it would then flip
                          // to a name a moment later.
                          <Skeleton className="h-3.5 min-w-0 flex-1" />
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
                            {nameOf(m.categoryId)}
                          </span>
                        )}
                        {Object.keys(m.attributes ?? {}).length > 0 && (
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            {/* Written out per case: this codebase has no
                                `<Plural>` anywhere, and "1 attributes" is the
                                same slip "Every 1 hours" was. */}
                            {Object.keys(m.attributes).length === 1 ? (
                              <Trans>1 attribute</Trans>
                            ) : (
                              <Trans>{Object.keys(m.attributes).length} attributes</Trans>
                            )}
                          </Badge>
                        )}
                        <Button
                          variant="ghost"
                          className="shrink-0 px-2"
                          onClick={() => {
                            void loadCategories();
                            setMapping(m);
                          }}
                        >
                          <Trans>Edit</Trans>
                        </Button>
                        <Button
                          variant="ghost"
                          className="shrink-0 px-2"
                          aria-label={t`Unmap`}
                          onClick={() => void removeMap(m)}
                        >
                          <I.X size={13} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {catalogError && (
                  <p className="mt-1.5 text-[11.5px] leading-snug text-destructive">
                    <Trans>
                      {providerName} would not hand over its categories: {catalogError}
                    </Trans>
                  </p>
                )}
              </div>

              <div>
                <span className="mb-1.5 block text-[11.5px] font-medium">
                  <Trans>Published batches</Trans>{" "}
                  <span className="font-normal text-muted-foreground">
                    · <Trans>newest first</Trans>
                  </span>
                </span>
                {batches === null ? (
                  <div className="flex flex-col gap-1.5">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-7 w-full" />
                    ))}
                  </div>
                ) : batches.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground">
                    <Trans>Nothing has been published yet.</Trans>
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {batches.slice(0, 12).map((b) => (
                      <div key={b.id} className="flex items-center gap-2 text-[11.5px]">
                        <Badge variant={tone(b.status)} className="shrink-0 text-[10px]">
                          {b.status}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {/* What the operator is actually waiting on. A batch
                              stays open until the marketplace has ruled on every
                              unit, which can take hours. */}
                          {b.pendingCount > 0 ? (
                            b.pendingCount === 1 ? (
                              <Trans>1 of {b.unitCount} still undecided</Trans>
                            ) : (
                              <Trans>
                                {b.pendingCount} of {b.unitCount} still undecided
                              </Trans>
                            )
                          ) : b.unitCount === 1 ? (
                            <Trans>1 unit, all ruled on</Trans>
                          ) : (
                            <Trans>{b.unitCount} units, all ruled on</Trans>
                          )}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {b.createdAt ? relativeTime(b.createdAt) : ""}
                        </span>
                      </div>
                    ))}
                    {batches.some((b) => b.error) && (
                      <p className="mt-1 text-[11.5px] leading-snug text-destructive">
                        {batches.find((b) => b.error)?.error}
                      </p>
                    )}
                  </div>
                )}
                <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                  <Trans>
                    A verdict lands on the row the unit came from, in the columns this sync writes back to.
                    Batches are swept on their own schedule, so an open one settles without anything being
                    re-run.
                  </Trans>
                </p>
              </div>
            </div>
          </DialogBody>

          <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
            <Button onClick={onClose}>
              <Trans>Done</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {mapping && (
        <CategoryMapDialog
          integrationId={integrationId}
          providerName={providerName}
          info={info}
          categories={categories}
          browse={info.browse}
          onLoadLevel={loadLevel}
          productFields={productFields}
          existing={mapping === "new" ? null : mapping}
          onClose={() => setMapping(null)}
          onSave={(input) => void saveMap(input)}
        />
      )}
    </>
  );
}

/* ── Map one local category, and answer what it demands ─────────────────── */
/**
 * The interrogation, in the order the answers become knowable.
 *
 * The local value first, then the marketplace category — and only THEN the
 * attributes, because until a category is chosen there is nothing to ask. That
 * ordering is why this is a form that grows rather than one that is filled: a
 * blank attribute section is not an unfinished form, it is a question that has
 * not been asked yet.
 */
export function CategoryMapDialog({
  integrationId,
  providerName,
  info,
  categories,
  browse,
  onLoadLevel,
  productFields,
  existing,
  onClose,
  onSave,
}: {
  integrationId: string;
  providerName: string;
  info: ListingInfo;
  /** `null` while the tree is still being fetched. */
  categories: ListingCategory[] | null;
  /** Whether the picker searches every leaf or walks a level at a time. */
  browse: "all" | "levels";
  /** Fetch and merge one level. Only called in `levels` mode. */
  onLoadLevel: (parentId: string | null) => Promise<void>;
  productFields: { value: string; label: string }[];
  existing: ListingMap | null;
  onClose: () => void;
  onSave: (input: {
    localValue: string;
    categoryId: string;
    attributes: Record<string, ListingBinding>;
  }) => void;
}) {
  const { t } = useLingui();
  const [localValue, setLocalValue] = useState(existing?.localValue ?? "");
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? "");
  const [search, setSearch] = useState("");
  /**
   * The node whose children are on screen, in `levels` mode. `null` is the top.
   *
   * Only ever set to something already fetched, which is what lets the
   * breadcrumb name it.
   */
  const [level, setLevel] = useState<string | null>(null);
  const [attributes, setAttributes] = useState<ListingAttribute[] | null>(null);
  const [attrError, setAttrError] = useState<string | null>(null);
  const [bindings, setBindings] = useState<Record<string, ListingBinding>>(existing?.attributes ?? {});

  /** Parent chain, so two categories called "Kolye" are told apart. */
  const pathOf = useMemo(() => {
    const byId = new Map((categories ?? []).map((c) => [c.id, c]));
    return (id: string): string => {
      const parts: string[] = [];
      let node = byId.get(id);
      // Bounded rather than `while (node)`: the tree comes from somebody else's
      // data and a parent cycle in it should not be able to hang the admin.
      for (let i = 0; node && i < 12; i++) {
        parts.unshift(node.name);
        node = node.parentId ? byId.get(node.parentId) : undefined;
      }
      return parts.join(" › ");
    };
  }, [categories]);

  /**
   * Leaves only, filtered by every word typed.
   *
   * A product may only be listed against a leaf, so a parent in this list would
   * be an option the marketplace refuses. Matching on the full PATH rather than
   * the node name is what makes "kadın kolye" find a category whose own name is
   * just "Kolye".
   */
  const hits = useMemo(() => {
    if (!categories) return [];
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const leaves = categories.filter((c) => c.leaf);
    if (words.length === 0) return leaves.slice(0, MAX_HITS);
    const out: ListingCategory[] = [];
    for (const c of leaves) {
      const hay = pathOf(c.id).toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(c);
      if (out.length >= MAX_HITS) break;
    }
    return out;
  }, [categories, search, pathOf]);

  /** Fetch whichever level is on screen. A no-op once it has been seen. */
  useEffect(() => {
    if (browse !== "levels" || categoryId) return;
    void onLoadLevel(level);
  }, [browse, categoryId, level, onLoadLevel]);

  /** The children of the level on screen, for a drill-down picker. */
  const levelItems = useMemo(
    () => (categories ?? []).filter((c) => (c.parentId ?? null) === level),
    [categories, level],
  );

  /** The parent of a node the walk has already seen. */
  const parentOf = useMemo(() => {
    const byId = new Map((categories ?? []).map((c) => [c.id, c]));
    return (id: string): string | null => byId.get(id)?.parentId ?? null;
  }, [categories]);

  /** What the chosen category demands. Re-asked whenever the choice changes. */
  useEffect(() => {
    if (!categoryId) return;
    let live = true;
    setAttributes(null);
    setAttrError(null);
    void (async () => {
      try {
        const res = await api<{ data: ListingAttribute[] }>(
          `/api/admin/integrations/${integrationId}/listing/attributes?categoryId=${encodeURIComponent(categoryId)}`,
        );
        if (live) setAttributes(res.data);
      } catch (e) {
        if (live) setAttrError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [categoryId, integrationId]);

  const setBinding = (attributeId: string, next: ListingBinding | null) =>
    setBindings((prev) => {
      const copy = { ...prev };
      if (next === null) delete copy[attributeId];
      else copy[attributeId] = next;
      return copy;
    });

  /**
   * Every required attribute has an answer, and the local value and category
   * are chosen.
   *
   * The required check is worth doing here rather than leaving to the
   * marketplace: a listing refused for a missing attribute comes back hours
   * later, per unit, as a rejection an operator has to read and trace back to
   * this form.
   */
  const ready =
    Boolean(localValue.trim()) &&
    Boolean(categoryId) &&
    (attributes ?? []).every((a) => {
      if (!a.required) return true;
      const b = bindings[a.id];
      return Boolean(b?.valueId || b?.custom?.trim() || b?.field);
    });

  const submit = () => {
    // Only the answers that say something. An attribute left blank is an
    // attribute the marketplace is not told about, which is different from one
    // sent empty.
    const cleaned: Record<string, ListingBinding> = {};
    for (const [id, b] of Object.entries(bindings)) {
      if (b.valueId) cleaned[id] = { valueId: b.valueId };
      else if (b.field) cleaned[id] = { field: b.field };
      else if (b.custom?.trim()) cleaned[id] = { custom: b.custom.trim() };
    }
    onSave({ localValue: localValue.trim(), categoryId, attributes: cleaned });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[600px] [&>*]:min-w-0">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            {existing ? <Trans>Re-map a category</Trans> : <Trans>Map a category</Trans>}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              Only the deepest categories can be sold into, so the list offers those. What {providerName}{" "}
              demands is asked once the category is chosen.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Your category value</Trans>
              </span>
              <Input
                placeholder={t`exactly what the product's category column holds`}
                value={localValue}
                // The key of the upsert. Changing it on an existing row maps a
                // DIFFERENT local value rather than renaming this one, so it is
                // left editable but the footer says which is being written.
                onChange={(e) => setLocalValue(e.target.value)}
              />
              <span className="mt-1 block text-[11.5px] leading-snug text-muted-foreground">
                <Trans>Matched verbatim — a product whose column holds anything else is skipped.</Trans>
              </span>
            </label>

            <div>
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Marketplace category</Trans>
              </span>
              {categoryId && (
                <div className="mb-1.5 flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{pathOf(categoryId) || categoryId}</span>
                  <Button
                    variant="ghost"
                    className="shrink-0 px-2"
                    aria-label={t`Choose a different category`}
                    onClick={() => setCategoryId("")}
                  >
                    <I.X size={13} />
                  </Button>
                </div>
              )}

              {!categoryId &&
                (categories === null ? (
                  <div className="flex flex-col gap-1.5">
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-7 w-full" />
                    ))}
                  </div>
                ) : browse === "levels" ? (
                  // A marketplace that will not hand its taxonomy over is
                  // walked instead of searched. Everything above the node on
                  // screen was fetched on the way down, so the breadcrumb can
                  // name it and going back costs nothing.
                  <>
                    <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                      {level !== null && (
                        <Button
                          variant="ghost"
                          className="shrink-0 px-2"
                          aria-label={t`Go up one level`}
                          onClick={() => setLevel(parentOf(level))}
                        >
                          <I.ChevronLeft size={13} />
                        </Button>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
                        {level === null ? t`All categories` : pathOf(level)}
                      </span>
                    </div>
                    <ScrollArea className="mt-1.5 w-full rounded-md border border-border" viewportClassName="max-h-[190px]">
                      <div className="flex flex-col p-1">
                        {levelItems.length === 0 ? (
                          <div className="flex flex-col gap-1.5 p-1">
                            {[0, 1, 2].map((i) => (
                              <Skeleton key={i} className="h-7 w-full" />
                            ))}
                          </div>
                        ) : (
                          levelItems.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11.5px] hover:bg-muted"
                              // A leaf is the answer; anything else is a step.
                              onClick={() => (c.leaf ? setCategoryId(c.id) : setLevel(c.id))}
                            >
                              <span className="min-w-0 flex-1 truncate">{c.name}</span>
                              {!c.leaf && <I.ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
                            </button>
                          ))
                        )}
                      </div>
                    </ScrollArea>
                    <span className="mt-1 block text-[11.5px] leading-snug text-muted-foreground">
                      <Trans>
                        {providerName} hands its categories over a level at a time, so this walks down rather
                        than searching.
                      </Trans>
                    </span>
                  </>
                ) : (
                  <>
                    <Input
                      placeholder={t`Search the categories`}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <ScrollArea className="mt-1.5 w-full rounded-md border border-border" viewportClassName="max-h-[190px]">
                      <div className="flex flex-col p-1">
                        {hits.length === 0 ? (
                          <p className="px-2 py-3 text-[11.5px] text-muted-foreground">
                            <Trans>Nothing matches that.</Trans>
                          </p>
                        ) : (
                          hits.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              className="rounded-sm px-2 py-1.5 text-left text-[11.5px] hover:bg-muted"
                              onClick={() => setCategoryId(c.id)}
                            >
                              <span className="block truncate">{pathOf(c.id)}</span>
                            </button>
                          ))
                        )}
                      </div>
                    </ScrollArea>
                    {hits.length >= MAX_HITS && (
                      // Never a silent cap: a list that stops at 60 with no note
                      // reads as "these are all of them".
                      <span className="mt-1 block text-[11.5px] text-muted-foreground">
                        <Trans>Showing the first {MAX_HITS} — narrow the search to see the rest.</Trans>
                      </span>
                    )}
                  </>
                ))}
            </div>

            {categoryId && (
              <div>
                <span className="mb-1 block text-[11.5px] font-medium">
                  <Trans>What this category demands</Trans>
                </span>
                {attrError ? (
                  <p className="text-[11.5px] leading-snug text-destructive">{attrError}</p>
                ) : attributes === null ? (
                  <div className="flex flex-col gap-1.5">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-14 w-full" />
                    ))}
                  </div>
                ) : attributes.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground">
                    <Trans>This category demands nothing beyond the product's own fields.</Trans>
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {attributes.map((a) => (
                      <AttributeRow
                        key={a.id}
                        attribute={a}
                        binding={bindings[a.id] ?? {}}
                        productFields={productFields}
                        onChange={(next) => setBinding(a.id, next)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {info.lookups.length > 0 && (
              <p className="text-[11.5px] leading-snug text-muted-foreground">
                {/* The registries are searched from the mapping form only where
                    they are an ATTRIBUTE. A brand is a product column, so it is
                    mapped in the sync's field mapping instead — saying so here
                    is cheaper than an operator hunting for a brand picker. */}
                <Trans>
                  {providerName} also needs a brand, which is a product column rather than a category
                  attribute — map it in the sync's field mapping.
                </Trans>
              </p>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!ready} onClick={submit}>
            <Trans>Save mapping</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── One attribute, answered one of three ways ──────────────────────────── */
/**
 * The three answers, offered in the order they are usually right.
 *
 * A closed-set attribute gets its own values. A varianter one — a size, a
 * colour — is almost always a COLUMN, because its whole point is differing per
 * unit, so that option leads for those. Free text is offered only where the
 * marketplace actually accepts it: typing into an attribute that refuses custom
 * values produces a rejection hours later with a reason that does not mention
 * this form.
 */
function AttributeRow({
  attribute,
  binding,
  productFields,
  onChange,
}: {
  attribute: ListingAttribute;
  binding: ListingBinding;
  productFields: { value: string; label: string }[];
  onChange: (next: ListingBinding | null) => void;
}) {
  const { t } = useLingui();
  const hasValues = attribute.values.length > 0;
  /**
   * Which of the three the operator is answering with.
   *
   * Keyed on the PRESENCE of the key, never its truthiness. Switching mode
   * seeds the binding with an empty string — `{field: ""}` — and an empty
   * string is falsy, so a truthiness test sent the row straight back to "Pick a
   * value" and the mode dropdown appeared to do nothing at all. Presence also
   * re-opens a saved mapping on the mode it was saved in, which is the other
   * thing this has to get right.
   */
  const mode: "value" | "field" | "custom" =
    binding.field !== undefined
      ? "field"
      : binding.custom !== undefined
        ? "custom"
        : hasValues
          ? "value"
          : "custom";

  const modes = [
    ...(hasValues ? [{ value: "value", label: t`Pick a value` }] : []),
    { value: "field", label: t`Read it from a column` },
    ...(attribute.allowCustom || !hasValues ? [{ value: "custom", label: t`Type it` }] : []),
  ];

  return (
    <div className="rounded-md border border-border p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[11.5px] font-medium">{attribute.name}</span>
        {attribute.required && (
          <Badge variant="destructive" className="text-[10px]">
            <Trans>required</Trans>
          </Badge>
        )}
        {attribute.variant && (
          <Badge variant="secondary" className="text-[10px]">
            <Trans>splits variants</Trans>
          </Badge>
        )}
        {!attribute.required && (
          <Button
            variant="ghost"
            className="ml-auto shrink-0 px-2"
            aria-label={t`Clear this attribute`}
            onClick={() => onChange(null)}
          >
            <I.X size={12} />
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-1.5 sm:flex-row">
        <div className="min-w-0 sm:w-[46%]">
          <Select
            value={mode}
            onChange={(v: string) =>
              // Switching how it is answered drops the previous answer rather
              // than carrying it: a value id means nothing as free text, and a
              // column name sent as a literal would list every unit as the word
              // "colour".
              onChange(v === "value" ? {} : v === "field" ? { field: "" } : { custom: "" })
            }
            options={modes}
            className="min-w-0"
          />
        </div>
        <div className="min-w-0 flex-1">
          {mode === "value" ? (
            <Select
              value={binding.valueId || undefined}
              onChange={(v: string) => onChange({ valueId: v })}
              placeholder={t`Choose a value`}
              options={attribute.values.map((v) => ({ value: v.id, label: v.name }))}
              className="min-w-0"
            />
          ) : mode === "field" ? (
            <Select
              value={binding.field || undefined}
              onChange={(v: string) => onChange({ field: v })}
              placeholder={t`Which column`}
              options={productFields}
              className="min-w-0"
            />
          ) : (
            <Input
              placeholder={t`The value to send`}
              value={binding.custom ?? ""}
              onChange={(e) => onChange({ custom: e.target.value })}
            />
          )}
        </div>
      </div>

      {attribute.variant && mode !== "field" && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
          {/* The one mistake this form can make that looks fine and is not:
              every unit gets the same size, so the variants collapse into one
              listing at the marketplace. */}
          <Trans>
            This attribute is what tells two units apart. A fixed answer gives every unit the same one — read
            it from a column instead unless that is what you mean.
          </Trans>
        </p>
      )}
    </div>
  );
}
