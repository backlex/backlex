// Onboarding card — shown on the Overview page only while the workspace has no
// collections. Lets the user pick a schema template (preselected to the
// cloud-chosen SEED_TEMPLATE), preview its collections, and apply it.
import { useEffect, useState } from "react";
import { Trans } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button } from "../ui";
import { templatesApi, type TemplateSummary } from "../api";

export function TemplateOnboarding({
  pushToast,
  onApplied,
}: {
  pushToast: (msg: string, type?: "success" | "error") => void;
  onApplied: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string>("blank");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await templatesApi.list();
        if (cancelled) return;
        if (res.hasCollections) {
          setHidden(true); // workspace already has collections — nothing to do
          return;
        }
        setTemplates(res.data);
        setSelected(res.defaultTemplateId || "blank");
      } catch {
        setHidden(true); // unauthenticated / no tenant — stay out of the way
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (hidden || !templates) return null;

  const current = templates.find((t) => t.id === selected);

  const apply = async () => {
    setApplying(true);
    try {
      if (selected === "blank") {
        setHidden(true);
        return;
      }
      const res = await templatesApi.apply(selected);
      pushToast(`Created ${res.data.created.length} collections`, "success");
      setHidden(true);
      onApplied();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not apply template", "error");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden mb-5">
      <div className="px-5 py-4 border-b border-border flex items-start gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary shrink-0">
          <I.Sparkles size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold">
            <Trans>Start with a template</Trans>
          </h3>
          <p className="text-[12px] text-muted-foreground">
            <Trans>
              Seed a ready-made set of collections for your use case. You can edit or add more
              anytime.
            </Trans>
          </p>
        </div>
        <button
          type="button"
          className="text-[12px] text-muted-foreground hover:text-foreground"
          onClick={() => setHidden(true)}
        >
          <Trans>Dismiss</Trans>
        </button>
      </div>

      <div className="grid grid-cols-[260px_1fr] max-md:grid-cols-1">
        {/* template list */}
        <div className="border-r border-border max-md:border-r-0 max-md:border-b max-h-[320px] overflow-y-auto">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t.id)}
              className={`w-full text-left px-4 py-2.5 border-b border-border/60 flex items-center gap-2 ${
                selected === t.id ? "bg-primary/5" : "hover:bg-muted/40"
              }`}
            >
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] font-medium truncate">{t.label}</span>
                <span className="block text-[11px] text-muted-foreground truncate">
                  {t.collections.length > 0 ? `${t.collections.length} collections` : "Empty"}
                </span>
              </span>
              {selected === t.id && <I.Check size={14} className="text-primary shrink-0" />}
            </button>
          ))}
        </div>

        {/* preview */}
        <div className="p-5 flex flex-col">
          <p className="text-[12.5px] text-muted-foreground mb-3">{current?.description}</p>
          {current && current.collections.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {current.collections.map((c) => (
                <Badge key={c.slug} variant="default">
                  {c.label} · {c.fieldCount}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground mb-4">
              <Trans>No collections — you'll start from scratch.</Trans>
            </p>
          )}
          <div className="mt-auto flex gap-2">
            <Button variant="primary" icon={I.Check} onClick={apply} disabled={applying}>
              {selected === "blank" ? <Trans>Start blank</Trans> : <Trans>Apply template</Trans>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
