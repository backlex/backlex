import type { PushToast } from "../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { I } from "../icons";
import { Select } from "../select";
import { Button, EmptyState, PageHeader } from "../ui";
import { documentsApi, type ApiDocumentTemplate } from "../api";
import { DocumentsSkeleton } from "../page-skeletons";

/**
 * Document templates — the HTML a contract, quote or invoice is rendered from.
 *
 * Laid out like the email-template editor because it is the same job, with one
 * addition that carries the feature: **Render** produces the actual PDF through
 * the configured backend and opens it. The HTML preview beside the editor is
 * only an approximation — page breaks, running headers and margins exist solely
 * in the renderer — so the button is what tells an operator whether the
 * template works.
 */
const rowExample = "{{ data.total }}";

const FORMATS = [
  { value: "A4", label: "A4" },
  { value: "Letter", label: "Letter" },
  { value: "Legal", label: "Legal" },
  { value: "A3", label: "A3" },
  { value: "A5", label: "A5" },
] as const;

/** The page sizes `ApiDocumentTemplate["pageOptions"]["format"]` accepts. Kept
 *  in step with FORMATS above so the picker and the payload can't disagree. */
type PageFormat = (typeof FORMATS)[number]["value"];
const isPageFormat = (v: string): v is PageFormat =>
  FORMATS.some((f) => f.value === v);

type Tpl = ApiDocumentTemplate & { isNew?: boolean };

const BLANK_BODY = `<html>
  <head><meta charset="utf-8" /></head>
  <body style="font-family: system-ui, sans-serif">
    <h1>{{ data.title }}</h1>
  </body>
</html>`;

export function DocumentsPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState<Tpl | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [filename, setFilename] = useState("");
  const [format, setFormat] = useState("A4");
  const [landscape, setLandscape] = useState(false);
  const [sampleVars, setSampleVars] = useState('{\n  "data": {}\n}');
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);

  const loadInto = (tpl: Tpl) => {
    setActive(tpl);
    setKeyDraft(tpl.key);
    setName(tpl.name ?? "");
    setBody(tpl.bodyHtml ?? "");
    setFooter(tpl.footerHtml ?? "");
    setFilename(tpl.filename ?? "");
    setFormat(tpl.pageOptions?.format ?? "A4");
    setLandscape(Boolean(tpl.pageOptions?.landscape));
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await documentsApi.list();
        if (cancelled) return;
        const rows = (res.data ?? []) as Tpl[];
        setTemplates(rows);
        if (rows[0]) loadInto(rows[0]);
      } catch {
        // leave the list empty; the page still offers "New template"
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onNew = () => {
    const draft: Tpl = {
      id: `new-${crypto.randomUUID()}`,
      key: "",
      name: "",
      description: null,
      bodyHtml: BLANK_BODY,
      headerHtml: null,
      footerHtml: null,
      pageOptions: { format: "A4" },
      filename: null,
      variables: [],
      inherited: false,
      isNew: true,
    };
    loadInto(draft);
  };

  const onSave = async () => {
    if (!active) return;
    const key = keyDraft.trim();
    if (!key) {
      pushToast(t`A template needs a key.`);
      return;
    }
    setSaving(true);
    const snapshot = templates;
    const patch: Tpl = {
      ...active,
      key,
      name: name.trim() || key,
      bodyHtml: body,
      footerHtml: footer.trim() || null,
      filename: filename.trim() || null,
      // `format` is held as a plain string because the Select emits one; the
      // API accepts only the five page sizes, so narrow here rather than fight
      // the setter's contravariance at the callsite.
      pageOptions: { format: isPageFormat(format) ? format : "A4", landscape },
      // Saving an inherited default creates this workspace's override, so the
      // badge has to flip immediately or the row lies until the next reload.
      inherited: false,
      isNew: false,
    };
    // Optimistic: the row updates before the round-trip, then reconciles.
    setTemplates((arr) => {
      const rest = arr.filter((x) => x.key !== key && x.id !== active.id);
      return [...rest, patch].sort((a, b) => a.key.localeCompare(b.key));
    });
    setActive(patch);
    try {
      const res = await documentsApi.save(key, {
        name: patch.name,
        bodyHtml: body,
        footerHtml: patch.footerHtml,
        filename: patch.filename,
        pageOptions: patch.pageOptions,
      });
      const saved = res.data as Tpl;
      setTemplates((arr) => arr.map((x) => (x.key === key ? saved : x)));
      setActive(saved);
      pushToast(t`Template saved.`);
    } catch (e) {
      setTemplates(snapshot);
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (tpl: Tpl) => {
    const snapshot = templates;
    const next = templates.filter((x) => x.key !== tpl.key);
    setTemplates(next);
    if (active?.key === tpl.key) {
      if (next[0]) loadInto(next[0]);
      else setActive(null);
    }
    try {
      await documentsApi.remove(tpl.key);
      pushToast(t`Template deleted.`);
    } catch (e) {
      setTemplates(snapshot);
      pushToast((e as Error).message);
    }
  };

  const onRender = async () => {
    if (!active) return;
    if (active.isNew) {
      pushToast(t`Save the template before rendering.`);
      return;
    }
    let vars: Record<string, unknown> = {};
    try {
      vars = JSON.parse(sampleVars);
    } catch {
      pushToast(t`Sample data must be valid JSON.`);
      return;
    }
    setRendering(true);
    try {
      const blob = await documentsApi.render({ templateKey: active.key, vars });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoked on a delay rather than immediately: the new tab still has to
      // fetch it, and revoking first opens a blank window.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setRendering(false);
    }
  };

  let preview = body;
  try {
    const vars = JSON.parse(sampleVars) as Record<string, unknown>;
    preview = body.replace(/\{\{\s*([\w$.]+)\s*\}\}/g, (_m, path: string) => {
      let cur: unknown = vars;
      for (const part of path.split(".")) {
        if (cur && typeof cur === "object" && part in (cur as object)) {
          cur = (cur as Record<string, unknown>)[part];
        } else return "";
      }
      return cur == null ? "" : String(cur);
    });
  } catch {
    // Unparseable sample data — show the template as written rather than
    // blanking the panel while someone is mid-edit.
  }

  if (!loaded) return <DocumentsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Document templates`}
        description={
          <Trans>
            Rendered to PDF from a complete HTML document. Values interpolate with{" "}
            <span className="font-mono">{rowExample}</span> against the row.
          </Trans>
        }
        actions={
          <Button size="sm" variant="primary" icon={I.Plus} onClick={onNew}>
            <Trans>New template</Trans>
          </Button>
        }
      />
      <div className="grid grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)] items-start gap-3.5 max-[1024px]:grid-cols-[minmax(0,1fr)]">
        <Card className="gap-0 py-0">
          {templates.length === 0 && !active?.isNew && (
            <EmptyState
              size="sm"
              icon={I.ScrollText}
              title={<Trans>No templates yet — use "New template" to add one.</Trans>}
            />
          )}
          {active?.isNew && (
            <div className="border-t border-border bg-accent px-3 py-2.5">
              <div className="text-[12.5px] font-medium">
                {name.trim() || <Trans>(new template)</Trans>}
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {keyDraft.trim() || <Trans>unsaved</Trans>}
              </div>
            </div>
          )}
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className={`flex items-center gap-2 border-t border-border px-3 py-2.5 ${active?.key === tpl.key ? "bg-accent" : ""}`}
            >
              <div className="min-w-0 flex-1 cursor-pointer" onClick={() => loadInto(tpl)}>
                <div className="truncate text-[12.5px] font-medium">
                  {tpl.name || <Trans>(unnamed)</Trans>}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {tpl.key}
                  {tpl.inherited ? (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide">
                      <Trans>shared</Trans>
                    </span>
                  ) : null}
                </div>
              </div>
              {!tpl.inherited && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 px-2"
                  aria-label={t`Delete template`}
                  onClick={() => void onDelete(tpl)}
                >
                  <I.Trash size={13} />
                </Button>
              )}
            </div>
          ))}
        </Card>

        <Card className="gap-0 py-0">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
            <span className="text-xs font-medium">
              <Trans>Editor</Trans>
            </span>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              icon={I.Eye}
              onClick={() => void onRender()}
              disabled={!active || rendering}
            >
              {rendering ? <Trans>Rendering…</Trans> : <Trans>Render PDF</Trans>}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={I.Save}
              onClick={() => void onSave()}
              disabled={!active || saving}
            >
              {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          </div>
          <div className="flex flex-col gap-2.5 p-3.5">
            {active?.inherited && (
              <div className="rounded-control border border-border px-3 py-2 text-[11.5px] text-muted-foreground">
                <Trans>
                  This is a shared default. Saving creates a copy for this workspace and leaves the
                  shared one untouched.
                </Trans>
              </div>
            )}
            <div className="flex gap-2.5 max-[640px]:flex-col">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground">
                  <Trans>Name</Trans>
                </label>
                <Input value={name} placeholder={t`Invoice`} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground">
                  <Trans>Key</Trans>
                </label>
                <Input
                  className="font-mono"
                  value={keyDraft}
                  placeholder={t`invoice`}
                  disabled={!active?.isNew}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setKeyDraft(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-2.5 max-[640px]:flex-col">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground">
                  <Trans>Page size</Trans>
                </label>
                <Select value={format} onChange={setFormat} options={FORMATS} className="min-w-0" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground">
                  <Trans>Orientation</Trans>
                </label>
                <Select
                  value={landscape ? "landscape" : "portrait"}
                  onChange={(v: string) => setLandscape(v === "landscape")}
                  options={[
                    { value: "portrait", label: t`Portrait` },
                    { value: "landscape", label: t`Landscape` },
                  ]}
                  className="min-w-0"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground">
                <Trans>Output filename</Trans>
              </label>
              <Input
                value={filename}
                placeholder="invoice-{{ data.no }}"
                onChange={(e) => setFilename(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground">
                <Trans>Body (HTML)</Trans>
              </label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
                className="min-h-[220px] w-full resize-y rounded-control border border-border bg-[oklch(0.18_0.01_130)] p-3 font-mono text-[12.5px] leading-[1.55] text-[oklch(0.92_0.02_130)]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground">
                <Trans>Page footer (HTML)</Trans>
              </label>
              <Input
                value={footer}
                placeholder='<span class="pageNumber"></span>'
                onChange={(e) => setFooter(e.target.value)}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Drawn on every page by the renderer, not in the preview.</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground">
                <Trans>Sample data</Trans>
              </label>
              <Textarea
                value={sampleVars}
                onChange={(e) => setSampleVars(e.target.value)}
                spellCheck={false}
                className="min-h-[80px] w-full resize-y rounded-control border border-border bg-card p-3 font-mono text-[12px]"
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Fills the preview and the test render. The row arrives as `data`.</Trans>
              </span>
            </div>
          </div>
        </Card>

        <Card className="gap-0 py-0">
          <div className="border-b border-border px-4 py-3.5">
            <span className="text-xs font-medium">
              <Trans>Preview</Trans>
            </span>
            <span className="ml-2 text-[11.5px] text-muted-foreground">
              <Trans>· approximate — use Render PDF for the real thing</Trans>
            </span>
          </div>
          <div className="min-h-[280px] bg-[oklch(0.97_0.005_130)] p-6">
            {/* An iframe rather than dangerouslySetInnerHTML, for two reasons.
                A template body is a COMPLETE html document — injected into a
                div the browser discards its <html>/<head>, so the preview
                would not be showing what the renderer sees. And `sandbox=""`
                grants nothing: no scripts, no forms, no same-origin. A
                template is authored by an admin, but in a workspace with more
                than one admin it is still somebody else's markup running in
                this one's session. */}
            <iframe
              title={t`Document preview`}
              sandbox=""
              srcDoc={preview}
              className="mx-auto block h-[420px] w-full max-w-[560px] rounded-surface border-0 bg-white shadow-[0_1px_4px_oklch(0_0_0/0.06)]"
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
