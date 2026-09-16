import type { PushToast } from "../../types";
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { renderTemplate, templatePathValue } from "@backlex/core";
import { withThemeVars } from "@backlex/core/appearance";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Textarea } from "@backlex/ui/components/textarea";
import { cn } from "@backlex/ui/lib/utils";
import { I } from "../../icons";
import { Select } from "../../select";
import { Badge, Button, EmptyState, IconButton, PageHeader } from "../../ui";
import { ConfirmDialog } from "../../sheet";
import { documentsApi, type ApiDocumentTemplate } from "../../api";
import { DocumentsSkeleton } from "../../page-skeletons";
import {
  EMPTY_DOC_DRAFT,
  PAGE_FORMATS,
  buildDocEntries,
  copyDocKey,
  docDraftFor,
  docDraftRefs,
  docEntryReplacedBy,
  docKeyProblem,
  docPageOptions,
  docStatus,
  docVariableWarnings,
  isPageFormat,
  sameDocDraft,
  seedDocSample,
  sheetSize,
  upsertDocRow,
  type DocDraft,
  type DocEntry,
} from "./document-template-model";
import {
  contextSampleValue,
  formatSample,
  insertText,
  isCompleteDocument,
  isThemePath,
  parseSample,
  setPath,
  type RenderContext,
} from "./email-template-model";
import { VariableWarnings, VariablesPanel } from "./email-template-variables";
import { TemplateAppearancePanel, ThemeVariables } from "./template-appearance";
import { ScaledPreview } from "./template-preview-frame";
import { TemplateEditorTabs } from "./template-tabs";

/**
 * Document templates — the HTML a contract, quote or invoice is rendered from.
 *
 * Built as the email-template editor's twin, because it is the same job: a list
 * with search and statuses, an editor that guards unsaved changes, duplicate /
 * delete / reset-to-default, the variables a renderer passes, warnings for the
 * ones sample data leaves empty, a theme, and a preview at the real size. The
 * one thing that carries this feature is **Render PDF**: the HTML preview is an
 * approximation — page breaks, running headers and margins exist only in the
 * renderer — so the button renders the draft as it stands, unsaved edits
 * included, and opens the real file.
 */
const rowExample = "{{ data.total }}";
const PAGE_NUMBER = '<span class="pageNumber"></span>';
const TOTAL_PAGES = '<span class="totalPages"></span>';

type Field = "bodyHtml" | "headerHtml" | "footerHtml" | "filename";
/** A document has a fourth panel the email editor does not: the sheet it is
 *  printed on, and the running header and footer only the renderer draws. */
type EditorTab = "content" | "page" | "appearance" | "variables";
type Confirm = { kind: "discard"; then: () => void } | { kind: "delete" | "reset"; entry: DocEntry };

const CODE_FRAME =
  "rounded-control border border-border bg-[oklch(0.18_0.01_130)] transition-[box-shadow,border-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30";
const CODE_AREA =
  "w-full resize-none rounded-none border-0 bg-transparent p-3 font-mono text-[12.5px] leading-[1.55] text-[oklch(0.92_0.02_130)] focus-visible:ring-0";

export function DocumentsPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiDocumentTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Set while a new, never-saved template is open. */
  const [newId, setNewId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocDraft>(EMPTY_DOC_DRAFT);
  /** What `draft` was when last opened or saved — the unsaved-changes baseline. */
  const [baseline, setBaseline] = useState<DocDraft>(EMPTY_DOC_DRAFT);
  /** Sample data per entry, as the JSON text being edited. In-session only. */
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  /** Which panel of the editor is open — kept across templates, as on the
   *  email page. */
  const [tab, setTab] = useState<EditorTab>("content");
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const fieldRefs = {
    bodyHtml: useRef<HTMLTextAreaElement>(null),
    headerHtml: useRef<HTMLTextAreaElement>(null),
    footerHtml: useRef<HTMLTextAreaElement>(null),
    filename: useRef<HTMLInputElement>(null),
  };
  /** Where the next inserted variable lands: the field last focused, and the
   *  selection there when the author left it. */
  const caret = useRef<{ field: Field; start: number; end: number } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => buildDocEntries(rows), [rows]);
  const labelOf = (e: DocEntry) => e.row?.name || e.key;

  const active: DocEntry | null = newId
    ? { id: newId, key: draft.key.trim(), row: null, isNew: true }
    : (entries.find((e) => e.key === activeKey) ?? null);
  const sampleKey = newId ?? activeKey ?? "";
  const dirty = active !== null && !sameDocDraft(draft, baseline);

  const load = (e: DocEntry) => {
    const d = docDraftFor(e);
    setDraft(d);
    setBaseline(d);
    setSamples((s) => (s[e.key] !== undefined ? s : { ...s, [e.key]: formatSample(seedDocSample(e, d)) }));
    caret.current = null;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let data: ApiDocumentTemplate[] = [];
      try {
        const res = await documentsApi.list();
        if (Array.isArray(res.data)) data = res.data;
      } catch {
        // Leave the list empty; the page still offers "New template".
      }
      if (cancelled) return;
      setRows(data);
      const first = buildDocEntries(data)[0];
      if (first) {
        setActiveKey(first.key);
        load(first);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Closing the tab mid-edit is the one exit the in-page guard cannot catch.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const guarded = (fn: () => void) => (dirty ? setConfirm({ kind: "discard", then: fn }) : fn());

  /** On a phone the editor stacks under the list; follow the selection down. */
  const revealEditor = () => {
    if (typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 1024px)").matches) return;
    editorRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  const open = (e: DocEntry) => {
    if (!newId && e.key === activeKey) return;
    guarded(() => {
      setNewId(null);
      setActiveKey(e.key);
      load(e);
      revealEditor();
    });
  };

  const onNew = () =>
    guarded(() => {
      const id = `new:${crypto.randomUUID()}`;
      setNewId(id);
      setActiveKey(null);
      setDraft(EMPTY_DOC_DRAFT);
      setBaseline(EMPTY_DOC_DRAFT);
      setSamples((s) => ({ ...s, [id]: formatSample(seedDocSample({ id, key: "", row: null, isNew: true }, EMPTY_DOC_DRAFT)) }));
      caret.current = null;
      revealEditor();
    });

  // ── sample data ────────────────────────────────────────────────────────────
  const sampleText = samples[sampleKey] ?? '{\n  "data": {}\n}';
  const parsedSample = parseSample(sampleText);
  const lastValidSample = useRef<Record<string, unknown>>({});
  if (parsedSample) lastValidSample.current = parsedSample;
  const sampleVars = parsedSample ?? lastValidSample.current;
  const setSampleText = (text: string) => setSamples((s) => ({ ...s, [sampleKey]: text }));

  const warnings = active ? docVariableWarnings(draft, parsedSample) : [];
  const usedPaths = docDraftRefs(draft);

  const addMissingToSample = () => {
    if (!parsedSample) return;
    const next = JSON.parse(JSON.stringify(parsedSample)) as Record<string, unknown>;
    for (const w of warnings) {
      const known = contextSampleValue(w.path);
      setPath(next, w.path, known.found ? known.value : "");
    }
    setSampleText(formatSample(next));
  };

  // ── editing ────────────────────────────────────────────────────────────────
  const remember = (field: Field) => (e: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    caret.current = { field, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
  };
  const patchDraft = (p: Partial<DocDraft>) => setDraft((d) => ({ ...d, ...p }));

  const insertAt = (text: string, fallback: Field = "bodyHtml") => {
    const focused = (Object.keys(fieldRefs) as Field[]).find((f) => fieldRefs[f].current === document.activeElement);
    const field: Field = focused ?? caret.current?.field ?? fallback;
    // The field the caret is in may be behind another tab (a variable clicked
    // in Variables, a theme value in Appearance): show it with the insert,
    // otherwise the placeholder lands somewhere the author cannot see.
    setTab(field === "bodyHtml" ? "content" : "page");
    const el = fieldRefs[field].current;
    const value = draft[field];
    const live = focused && el ? { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length } : null;
    const sel = live ?? (caret.current?.field === field ? caret.current : { start: value.length, end: value.length });
    const next = insertText(value, sel.start, sel.end, text);
    setDraft((d) => ({ ...d, [field]: next.value }));
    caret.current = { field, start: next.caret, end: next.caret };
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange?.(next.caret, next.caret);
    });
  };

  const insertVariable = (path: string, context?: RenderContext) => {
    insertAt(`{{ ${path} }}`);
    // A flow variable the sample lacks is filled as it is inserted, rather than
    // showing up as a warning a moment later. A typed value is never replaced.
    const known = contextSampleValue(path);
    if (context && parsedSample && known.found && !templatePathValue(parsedSample, path).found) {
      const filled = JSON.parse(JSON.stringify(parsedSample)) as Record<string, unknown>;
      setPath(filled, path, known.value);
      setSampleText(formatSample(filled));
    }
  };

  /** The row as the editor would save it — shared by save, duplicate and the
   *  optimistic list entry so the three cannot disagree. */
  const payloadOf = (d: DocDraft, key: string) => ({
    name: d.name.trim() || key,
    bodyHtml: d.bodyHtml,
    headerHtml: d.headerHtml.trim() ? d.headerHtml : null,
    footerHtml: d.footerHtml.trim() ? d.footerHtml : null,
    filename: d.filename.trim() || null,
    pageOptions: docPageOptions(d, active?.row?.pageOptions),
    // `theme.*` is filled on every render, so it is not a variable a caller owes.
    variables: docDraftRefs(d).filter((p) => !isThemePath(p)),
    appearance: d.appearance,
  });

  // ── mutations (optimistic: apply, then reconcile or roll back) ─────────────
  const onSave = async () => {
    if (!active || saving) return;
    const key = active.isNew ? draft.key.trim() : active.key;
    if (active.isNew) {
      const problem = docKeyProblem(key, entries);
      if (problem === "format") {
        pushToast(t`Key must be 1–100 characters: letters, digits, _, - or ., starting with a letter or digit.`);
        return;
      }
      if (problem === "taken") {
        pushToast(t`A template with key "${key}" already exists.`);
        return;
      }
    }
    if (!draft.bodyHtml.trim()) {
      pushToast(t`A template needs a body.`);
      return;
    }
    const payload = payloadOf(draft, key);
    const snapshot = { rows, baseline, newId, activeKey };
    const replaces = active.isNew ? docEntryReplacedBy(key, entries) : null;
    const optimistic: ApiDocumentTemplate = {
      id: active.row && !active.row.inherited ? active.row.id : `pending:${key}`,
      key,
      description: active.row?.description ?? null,
      ...payload,
      inherited: false,
      overridesDefault: Boolean(active.row?.inherited || active.row?.overridesDefault || replaces),
    };
    setRows((r) => upsertDocRow(r, optimistic));
    setBaseline({ ...draft, key });
    if (active.isNew) {
      setSamples((s) => ({ ...s, [key]: s[active.id] ?? '{\n  "data": {}\n}' }));
      setNewId(null);
      setActiveKey(key);
      setDraft((d) => ({ ...d, key }));
    }
    setSaving(true);
    try {
      const saved = (await documentsApi.save(key, payload)).data;
      setRows((r) => upsertDocRow(r, saved));
      pushToast(t`Template saved.`);
    } catch (e) {
      setRows(snapshot.rows);
      setBaseline(snapshot.baseline);
      setNewId(snapshot.newId);
      setActiveKey(snapshot.activeKey);
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onDuplicate = async () => {
    if (!active || active.isNew) return;
    const key = copyDocKey(active.key, entries);
    const label = labelOf(active);
    const name = t`${label} (copy)`.slice(0, 120);
    const copied: DocDraft = { ...draft, key, name };
    const payload = payloadOf(copied, key);
    const snapshot = { rows, activeKey, draft, baseline };
    setRows((r) => [
      ...r,
      { id: `pending:${key}`, key, description: null, ...payload, inherited: false, overridesDefault: false },
    ]);
    // What you see is what gets copied, unsaved edits included; the original
    // keeps what it had saved.
    setActiveKey(key);
    setDraft(copied);
    setBaseline(copied);
    setSamples((s) => ({ ...s, [key]: s[active.key] ?? formatSample(seedDocSample(active, copied)) }));
    try {
      const saved = (await documentsApi.save(key, payload)).data;
      setRows((r) => upsertDocRow(r, saved));
      pushToast(t`Duplicated as "${name}".`);
    } catch (e) {
      setRows(snapshot.rows);
      setActiveKey(snapshot.activeKey);
      setDraft(snapshot.draft);
      setBaseline(snapshot.baseline);
      pushToast((e as Error).message);
    }
  };

  /** Delete a template, or reset a customized one — the same DELETE. The server
   *  answers with what the key resolves to afterwards. */
  const onRemove = async (entry: DocEntry) => {
    const row = entry.row;
    if (!row || row.inherited) return;
    const snapshot = { rows, activeKey, draft, baseline };
    const wasActive = entry.key === activeKey;
    const nextRows = rows.filter((r) => r.key !== row.key);
    setRows(nextRows);
    if (wasActive) {
      const target = buildDocEntries(nextRows)[0] ?? null;
      setActiveKey(target?.key ?? null);
      if (target) load(target);
    }
    try {
      const res = await documentsApi.remove(row.key);
      if (res.data) {
        const restored = res.data;
        setRows((r) => upsertDocRow(r, restored));
        if (wasActive) {
          setActiveKey(restored.key);
          load({ id: restored.id, key: restored.key, row: restored });
        }
      }
      pushToast(docStatus(entry) === "customized" ? t`Reset to default.` : t`Template deleted.`);
    } catch (e) {
      setRows(snapshot.rows);
      setActiveKey(snapshot.activeKey);
      setDraft(snapshot.draft);
      setBaseline(snapshot.baseline);
      pushToast((e as Error).message);
    }
  };

  const onRender = async () => {
    if (!active || rendering) return;
    if (!draft.bodyHtml.trim()) {
      pushToast(t`Add a body before rendering.`);
      return;
    }
    if (!parsedSample) {
      pushToast(t`Sample data must be valid JSON.`);
      return;
    }
    setRendering(true);
    try {
      // The draft as it stands, with the sample data — so the PDF matches the
      // editor, and an unsaved edit can be checked before a flow uses it.
      const blob = await documentsApi.render({
        html: draft.bodyHtml,
        headerHtml: draft.headerHtml.trim() ? draft.headerHtml : null,
        footerHtml: draft.footerHtml.trim() ? draft.footerHtml : null,
        pageOptions: docPageOptions(draft, active.row?.pageOptions),
        appearance: draft.appearance,
        vars: parsedSample,
        ...(draft.filename.trim() ? { filename: draft.filename } : {}),
      });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoked on a delay: the new tab still has to fetch it, and revoking
      // first opens a blank window.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setRendering(false);
    }
  };

  if (!loaded) return <DocumentsSkeleton />;

  const status = active ? docStatus(active) : null;
  const query = search.trim().toLowerCase();
  const visible = entries.filter(
    (e) => !query || labelOf(e).toLowerCase().includes(query) || e.key.toLowerCase().includes(query),
  );
  const sections = [
    { id: "custom", title: t`Your templates`, items: visible.filter((e) => !e.row?.inherited) },
    { id: "shared", title: t`Shared defaults`, items: visible.filter((e) => e.row?.inherited) },
  ].filter((s) => s.items.length > 0);

  const keyIssue = active?.isNew && draft.key.trim() ? docKeyProblem(draft.key.trim(), entries) : null;
  const replaced = active?.isNew && !keyIssue ? docEntryReplacedBy(draft.key.trim(), entries) : null;
  const replacedName = replaced ? labelOf(replaced) : "";
  const renderVars = withThemeVars(sampleVars, draft.appearance);
  const previewHtml = renderTemplate(draft.bodyHtml, renderVars);
  const sheet = sheetSize(draft.format, draft.landscape);
  const orientation = draft.landscape ? t`Landscape` : t`Portrait`;
  const confirmLabel = confirm && confirm.kind !== "discard" ? labelOf(confirm.entry) : "";

  const codeField = (field: "bodyHtml" | "headerHtml" | "footerHtml", props: { label: string; minH: string; maxH: string; placeholder?: string }) => (
    <ScrollArea type="auto" className={CODE_FRAME} viewportClassName={props.maxH}>
      <Textarea
        id={`document-template-${field}`}
        ref={fieldRefs[field]}
        value={draft[field]}
        onChange={(e) => {
          patchDraft({ [field]: e.target.value } as Partial<DocDraft>);
          remember(field)(e);
        }}
        onSelect={remember(field)}
        onFocus={remember(field)}
        onBlur={remember(field)}
        spellCheck={false}
        placeholder={props.placeholder}
        aria-label={props.label}
        className={cn(props.minH, CODE_AREA)}
      />
    </ScrollArea>
  );

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
        <Card className="gap-0 overflow-hidden py-0">
          <div className="border-b border-border p-2.5">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t`Search templates`}
              aria-label={t`Search templates`}
              className="h-8"
            />
          </div>
          <ScrollArea viewportClassName="max-h-[320px] min-[1025px]:max-h-[640px]">
            {active?.isNew && (
              <div className="border-b border-border bg-accent px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium">{draft.name.trim() || <Trans>(new template)</Trans>}</span>
                  <Badge variant="outline" className="ml-auto h-[18px] px-1.5 text-[10px]"><Trans>unsaved</Trans></Badge>
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">{draft.key.trim() || "—"}</div>
              </div>
            )}
            {entries.length === 0 && !active?.isNew ? (
              <EmptyState size="sm" icon={I.ScrollText} title={<Trans>No templates yet — use "New template" to add one.</Trans>} />
            ) : sections.length === 0 ? (
              query ? <EmptyState size="sm" icon={I.Search} title={<Trans>No templates match your search.</Trans>} /> : null
            ) : (
              sections.map((section) => (
                <div key={section.id}>
                  <div className="px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    {section.title}
                  </div>
                  {section.items.map((e) => {
                    const isActive = !newId && e.key === activeKey;
                    const s = docStatus(e);
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => open(e)}
                        aria-current={isActive ? "true" : undefined}
                        className={cn(
                          "flex w-full cursor-pointer items-start gap-2 border-t border-border px-3 py-2.5 text-left hover:bg-accent/60",
                          isActive && "bg-accent hover:bg-accent",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[12.5px] font-medium">{labelOf(e)}</span>
                            {isActive && dirty && (
                              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title={t`Unsaved changes`} />
                            )}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">{e.key}</span>
                        </span>
                        {s === "customized" && (
                          <Badge variant="secondary" className="h-[18px] shrink-0 px-1.5 text-[10px]"><Trans>customized</Trans></Badge>
                        )}
                        {s === "shared" && (
                          <Badge variant="outline" className="h-[18px] shrink-0 px-1.5 text-[10px]"><Trans>shared</Trans></Badge>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </ScrollArea>
        </Card>

        <Card ref={editorRef} className="scroll-mt-4 gap-0 py-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <span className="text-xs font-medium"><Trans>Editor</Trans></span>
            {dirty && (
              <Badge variant="outline" className="h-[18px] px-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                <Trans>unsaved</Trans>
              </Badge>
            )}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              {active && !active.isNew && (
                <IconButton icon={I.Copy} title={t`Duplicate template`} aria-label={t`Duplicate template`} onClick={() => void onDuplicate()} />
              )}
              {status === "custom" && active && (
                <IconButton icon={I.Trash} title={t`Delete template`} aria-label={t`Delete template`} onClick={() => setConfirm({ kind: "delete", entry: active })} />
              )}
              {status === "customized" && active && (
                <IconButton icon={I.RotateCcw} title={t`Reset to default`} aria-label={t`Reset to default`} onClick={() => setConfirm({ kind: "reset", entry: active })} />
              )}
              <Button size="sm" variant="outline" icon={I.Eye} onClick={() => void onRender()} disabled={!active || rendering}>
                {rendering ? <Trans>Rendering…</Trans> : <Trans>Render PDF</Trans>}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={I.Save}
                onClick={() => void onSave()}
                disabled={!active || saving || (!dirty && !active?.isNew && status !== "shared")}
              >
                {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
              </Button>
            </div>
          </div>
          {active && (
            <div className="border-b border-border px-3.5 py-2.5">
              <TemplateEditorTabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: "content", label: <Trans>Content</Trans>, icon: <I.Code size={13} /> },
                  { value: "page", label: <Trans>Page</Trans>, icon: <I.ScrollText size={13} /> },
                  { value: "appearance", label: <Trans>Appearance</Trans>, icon: <I.Palette size={13} /> },
                  {
                    value: "variables",
                    label: <Trans>Variables</Trans>,
                    icon: <I.Braces size={13} />,
                    count: usedPaths.filter((p) => !isThemePath(p)).length,
                    warn: warnings.length > 0,
                  },
                ]}
              />
            </div>
          )}
          {active ? (
            <div className="flex flex-col gap-2.5 p-3.5">
              {tab === "content" && status === "shared" && (
                <div className="rounded-control border border-border px-3 py-2 text-[11.5px] text-muted-foreground">
                  <Trans>This is a shared default. Saving creates a copy for this workspace and leaves the shared one untouched.</Trans>
                </div>
              )}
              {tab === "content" && status === "customized" && (
                <div className="rounded-control border border-border px-3 py-2 text-[11.5px] text-muted-foreground">
                  <Trans>Customized: this workspace renders your version. Reset to go back to the shared default.</Trans>
                </div>
              )}
              {tab === "content" && (<>
              <div className="flex gap-2.5 max-[640px]:flex-col">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor="document-template-name" className="text-[12.5px] font-medium text-foreground"><Trans>Name</Trans></label>
                  <Input id="document-template-name" value={draft.name} maxLength={120} placeholder={t`Invoice`} onChange={(e) => patchDraft({ name: e.target.value })} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor="document-template-key" className="text-[12.5px] font-medium text-foreground"><Trans>Key</Trans></label>
                  <Input
                    id="document-template-key"
                    className="font-mono"
                    value={draft.key}
                    maxLength={100}
                    placeholder="invoice"
                    disabled={!active.isNew}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={keyIssue ? true : undefined}
                    onChange={(e) => patchDraft({ key: e.target.value })}
                  />
                </div>
              </div>
              {keyIssue === "format" && (
                <span className="text-[11.5px] text-destructive">
                  <Trans>1–100 characters: letters, digits, _, - or ., starting with a letter or digit.</Trans>
                </span>
              )}
              {keyIssue === "taken" && (
                <span className="text-[11.5px] text-destructive"><Trans>This workspace already has a template with this key.</Trans></span>
              )}
              {replaced && (
                <span className="text-[11.5px] text-amber-600 dark:text-amber-400">
                  <Trans>Saving under this key replaces “{replacedName}” for this workspace — every flow that renders it uses yours.</Trans>
                </span>
              )}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="document-template-bodyHtml" className="text-[12.5px] font-medium text-foreground"><Trans>Body (HTML)</Trans></label>
                {codeField("bodyHtml", { label: t`Body (HTML)`, minH: "min-h-[220px]", maxH: "max-h-[min(60vh,560px)]" })}
              </div>
              </>)}
              {tab === "page" && (<>
              <div className="flex gap-2.5 max-[640px]:flex-col">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label className="text-[12.5px] font-medium text-foreground"><Trans>Page size</Trans></label>
                  <Select
                    value={draft.format}
                    onChange={(v: string) => isPageFormat(v) && patchDraft({ format: v })}
                    options={PAGE_FORMATS.map((f) => ({ value: f, label: f }))}
                    className="min-w-0"
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label className="text-[12.5px] font-medium text-foreground"><Trans>Orientation</Trans></label>
                  <Select
                    value={draft.landscape ? "landscape" : "portrait"}
                    onChange={(v: string) => patchDraft({ landscape: v === "landscape" })}
                    options={[
                      { value: "portrait", label: t`Portrait` },
                      { value: "landscape", label: t`Landscape` },
                    ]}
                    className="min-w-0"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="document-template-filename" className="text-[12.5px] font-medium text-foreground"><Trans>Output filename</Trans></label>
                <Input
                  id="document-template-filename"
                  ref={fieldRefs.filename}
                  value={draft.filename}
                  maxLength={200}
                  placeholder="invoice-{{ data.no }}"
                  onChange={(e) => { patchDraft({ filename: e.target.value }); remember("filename")(e); }}
                  onSelect={remember("filename")}
                  onFocus={remember("filename")}
                  onBlur={remember("filename")}
                />
              </div>
              <div className="flex gap-2.5 max-[640px]:flex-col">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor="document-template-headerHtml" className="text-[12.5px] font-medium text-foreground"><Trans>Page header (HTML)</Trans></label>
                  {codeField("headerHtml", { label: t`Page header (HTML)`, minH: "min-h-[64px]", maxH: "max-h-[200px]" })}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor="document-template-footerHtml" className="text-[12.5px] font-medium text-foreground"><Trans>Page footer (HTML)</Trans></label>
                  {codeField("footerHtml", { label: t`Page footer (HTML)`, minH: "min-h-[64px]", maxH: "max-h-[200px]", placeholder: PAGE_NUMBER })}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <span><Trans>Drawn on every page by the renderer, not in the preview. Insert:</Trans></span>
                {[
                  { label: t`Page number`, html: PAGE_NUMBER },
                  { label: t`Page count`, html: TOTAL_PAGES },
                ].map((chip) => (
                  <button
                    key={chip.html}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertAt(chip.html, "footerHtml")}
                    className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-control border border-border bg-card px-2 font-mono text-[11px] text-foreground hover:bg-accent"
                  >
                    <I.Plus size={10} />
                    {chip.label}
                  </button>
                ))}
              </div>
              </>)}
              {tab === "appearance" && (
                <>
                  <TemplateAppearancePanel value={draft.appearance} onChange={(appearance) => patchDraft({ appearance })} />
                  <ThemeVariables appearance={draft.appearance} onInsert={(path) => insertVariable(path)} />
                </>
              )}
              {tab === "variables" && (
                <>
                  <VariablesPanel
                    key={active.id}
                    kind="document"
                    entry={{ id: active.id, builtIn: null, isNew: active.isNew }}
                    sample={parsedSample}
                    usedPaths={usedPaths}
                    onInsert={insertVariable}
                  />
                  <VariableWarnings kind="document" warnings={warnings} onAddToSample={parsedSample ? addMissingToSample : undefined} />
                </>
              )}
            </div>
          ) : (
            <EmptyState size="sm" icon={I.ScrollText} title={<Trans>Pick a template, or use "New template" to add one.</Trans>} />
          )}
        </Card>

        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <span className="text-xs font-medium"><Trans>Preview</Trans></span>
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>approximate — use Render PDF for the real thing</Trans>
            </span>
          </div>
          <div className="min-h-[280px] bg-[oklch(0.97_0.005_130)] p-3 sm:p-6">
            {/* An iframe with `sandbox=""` (see html-preview.tsx): a template is
                an admin's markup, but in a workspace with more than one admin it
                is still somebody else's HTML running in this session. It is
                interpolated by `renderTemplate` with `theme.*` filled from the
                draft's appearance — the function and the values the renderer
                uses — and laid out at the sheet's real width. */}
            <ScaledPreview
              html={previewHtml}
              width={sheet.width}
              height={sheet.height}
              complete={isCompleteDocument(previewHtml)}
              title={t`Document preview`}
              testId="document-preview-frame"
              device={`${draft.format}-${draft.landscape ? "landscape" : "portrait"}`}
              caption={`${draft.format} · ${orientation} · ${sheet.width}×${sheet.height}px`}
            />
          </div>
          <div className="flex flex-col gap-1.5 border-t border-border p-3.5">
            <label htmlFor="document-template-sample" className="text-[12.5px] font-medium text-foreground"><Trans>Sample data</Trans></label>
            <ScrollArea type="auto" className="rounded-control border border-border bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30" viewportClassName="max-h-[320px]">
              <Textarea
                id="document-template-sample"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                spellCheck={false}
                aria-invalid={parsedSample ? undefined : true}
                className="min-h-[96px] w-full resize-none rounded-none border-0 bg-transparent p-3 font-mono text-[12px] focus-visible:ring-0"
              />
            </ScrollArea>
            {parsedSample ? (
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Fills the preview and the test render. The row arrives as data. Kept while this page is open; not saved with the template.</Trans>
              </span>
            ) : (
              <span className="text-[11.5px] text-destructive">
                <Trans>Not valid JSON — the preview keeps the last valid sample data until this is fixed.</Trans>
              </span>
            )}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm?.kind === "discard"}
        title={<Trans>Discard unsaved changes?</Trans>}
        description={<Trans>You have edits that haven't been saved. Leaving will lose them.</Trans>}
        actionLabel={t`Discard`}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c?.kind === "discard") c.then();
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        title={<Trans>Delete this template?</Trans>}
        description={<Trans>Flow steps and signature requests that name its key stop rendering. This can't be undone.</Trans>}
        actionLabel={t`Delete`}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c?.kind === "delete") void onRemove(c.entry);
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "reset"}
        title={<Trans>Reset “{confirmLabel}” to default?</Trans>}
        description={<Trans>This workspace's version is deleted and the shared default renders again. Unsaved edits are lost too.</Trans>}
        actionLabel={t`Reset to default`}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c?.kind === "reset") void onRemove(c.entry);
        }}
      />
    </div>
  );
}
