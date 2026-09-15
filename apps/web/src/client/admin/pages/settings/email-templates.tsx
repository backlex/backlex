import type { PushToast } from "../../types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { renderTemplate, templatePathValue } from "@backlex/core";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Textarea } from "@backlex/ui/components/textarea";
import { cn } from "@backlex/ui/lib/utils";
import { BUILT_IN_EMAIL_TEMPLATES, type BuiltInEmailFeature } from "@backlex/core/email-templates";
import { I } from "../../icons";
import { Badge, Button, EmptyState, IconButton, PageHeader } from "../../ui";
import { ConfirmDialog } from "../../sheet";
import { emailTemplatesApi, type ApiEmailTemplate, type EmailTemplateInput } from "../../api";
import { EmailTemplatesSkeleton } from "../../page-skeletons";
import { HtmlPreview } from "../../html-preview";
import {
  EMPTY_DRAFT,
  PREVIEW_SIZE,
  buildEntries,
  contextSampleValue,
  copyKey,
  draftFor,
  draftRefs,
  entryReplacedBy,
  entryStatus,
  formatSample,
  insertText,
  isCompleteDocument,
  keyProblem,
  parseSample,
  sameDraft,
  seedSample,
  setPath,
  upsertRow,
  variableWarnings,
  type Draft,
  type PreviewDevice,
  type RenderContext,
  type TemplateEntry,
} from "./email-template-model";
import { BUILT_IN_EMAIL_LABELS, FEATURE_LABELS, VariableWarnings, VariablesPanel } from "./email-template-variables";

const userEmailExample = "{{ user.email }}";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Field = "subject" | "bodyHtml" | "bodyText";
type Confirm =
  | { kind: "discard"; then: () => void }
  | { kind: "delete" | "reset"; entry: TemplateEntry };

/** The editor's two code fields share one frame: the textarea grows with its
 *  content inside a capped ScrollArea, so a long body scrolls in place instead
 *  of stretching the page — and the frame carries the border and focus ring,
 *  which the clipped textarea cannot. Same shape as the document editor. */
const CODE_FRAME =
  "rounded-control border border-border bg-[oklch(0.18_0.01_130)] transition-[box-shadow,border-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30";
const CODE_AREA =
  "w-full resize-none rounded-none border-0 bg-transparent p-3 font-mono text-[12.5px] leading-[1.55] text-[oklch(0.92_0.02_130)] focus-visible:ring-0";

export function EmailTemplatesPage({ pushToast }: { pushToast: PushToast }) {
  const { t, i18n } = useLingui();
  const [rows, setRows] = useState<ApiEmailTemplate[]>([]);
  // First-load gate — drives the page skeleton until templates land.
  const [loaded, setLoaded] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Set while a new, never-saved template is open. */
  const [newId, setNewId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /** What `draft` was when last opened or saved — the unsaved-changes baseline. */
  const [baseline, setBaseline] = useState<Draft>(EMPTY_DRAFT);
  /** Sample data per entry, as the JSON text being edited. In-session only. */
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const fieldRefs = {
    subject: useRef<HTMLInputElement>(null),
    bodyHtml: useRef<HTMLTextAreaElement>(null),
    bodyText: useRef<HTMLTextAreaElement>(null),
  };
  /** Where the next inserted variable lands: the field the author was last in,
   *  and their selection there when they left it. */
  const caret = useRef<{ field: Field; start: number; end: number } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => buildEntries(rows), [rows]);
  const builtInName = (e: TemplateEntry) => (e.builtIn ? i18n._(BUILT_IN_EMAIL_LABELS[e.builtIn].name) : "");
  const labelOf = (e: TemplateEntry) => e.row?.name || builtInName(e) || e.key;

  const active: TemplateEntry | null = newId
    ? { id: newId, key: draft.key.trim(), row: null, builtIn: null, isNew: true }
    : (entries.find((e) => e.key === activeKey) ?? null);
  const sampleKey = newId ?? activeKey ?? "";
  const dirty = active !== null && !sameDraft(draft, baseline);

  const seedFor = (e: TemplateEntry, d: Draft) =>
    setSamples((s) => (s[e.isNew ? e.id : e.key] !== undefined ? s : { ...s, [e.isNew ? e.id : e.key]: formatSample(seedSample(e, d)) }));

  const load = (e: TemplateEntry) => {
    const d = draftFor(e, builtInName(e));
    setDraft(d);
    setBaseline(d);
    seedFor(e, d);
    caret.current = null;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let data: ApiEmailTemplate[] = [];
      try {
        const res = await emailTemplatesApi.list();
        if (Array.isArray(res.data)) data = res.data;
      } catch {
        // The built-in emails still list without a response — they exist
        // whether or not anything is stored.
      }
      if (cancelled) return;
      setRows(data);
      const first = buildEntries(data)[0];
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

  /** On a phone the editor stacks under a long list; follow the selection down. */
  const revealEditor = () => {
    if (typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 1024px)").matches) return;
    editorRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  const open = (e: TemplateEntry) => {
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
      setDraft(EMPTY_DRAFT);
      setBaseline(EMPTY_DRAFT);
      setSamples((s) => ({ ...s, [id]: "{}" }));
      caret.current = null;
      revealEditor();
    });

  // ── sample data ────────────────────────────────────────────────────────────
  const sampleText = samples[sampleKey] ?? "{}";
  const parsedSample = parseSample(sampleText);
  const lastValidSample = useRef<Record<string, unknown>>({});
  if (parsedSample) lastValidSample.current = parsedSample;
  const sampleVars = parsedSample ?? lastValidSample.current;
  const setSampleText = (text: string) => setSamples((s) => ({ ...s, [sampleKey]: text }));

  const warnings = active ? variableWarnings(active, draft, parsedSample) : [];
  const usedPaths = draftRefs(draft);

  const addMissingToSample = () => {
    if (!parsedSample) return;
    const next = JSON.parse(JSON.stringify(parsedSample)) as Record<string, unknown>;
    for (const w of warnings) {
      if (w.reason !== "no-sample") continue;
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
  const setField = (field: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [field]: value }));

  const insertVariable = (path: string, context?: RenderContext) => {
    const placeholder = `{{ ${path} }}`;
    const focused = (Object.keys(fieldRefs) as Field[]).find((f) => fieldRefs[f].current === document.activeElement);
    const field: Field = focused ?? caret.current?.field ?? "bodyHtml";
    const el = fieldRefs[field].current;
    const value = draft[field];
    const live = focused && el ? { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length } : null;
    const sel = live ?? (caret.current?.field === field ? caret.current : { start: value.length, end: value.length });
    const next = insertText(value, sel.start, sel.end, placeholder);
    setDraft((d) => ({ ...d, [field]: next.value }));
    caret.current = { field, start: next.caret, end: next.caret };
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange?.(next.caret, next.caret);
    });
    // A caller-supplied variable the sample data lacks would only show up as a
    // warning a moment later; fill it in as it is inserted instead. A value the
    // author already typed is never overwritten.
    const known = contextSampleValue(path);
    if (context && parsedSample && known.found && !templatePathValue(parsedSample, path).found) {
      const filled = JSON.parse(JSON.stringify(parsedSample)) as Record<string, unknown>;
      setPath(filled, path, known.value);
      setSampleText(formatSample(filled));
    }
  };

  // ── mutations (optimistic: apply, then reconcile or roll back) ─────────────
  const onSave = async () => {
    if (!active || saving) return;
    const key = draft.key.trim();
    const from = draft.fromAddress.trim();
    if (active.isNew) {
      const problem = keyProblem(key, entries);
      if (problem === "format") {
        pushToast(t`Key must be 2–40 characters: letters, digits, _, - or ., starting with a letter or digit.`);
        return;
      }
      if (problem === "taken") {
        pushToast(t`A template with key "${key}" already exists.`);
        return;
      }
    }
    if (!draft.subject.trim()) {
      pushToast(t`Subject is required.`);
      return;
    }
    if (from && !EMAIL_RE.test(from)) {
      pushToast(t`From must be an email address, or empty to use the configured default.`);
      return;
    }
    const fields: EmailTemplateInput = {
      key: active.isNew ? key : active.key,
      name: draft.name.trim() || labelOf(active) || key,
      subject: draft.subject,
      fromAddress: from || null,
      bodyHtml: draft.bodyHtml,
      bodyText: draft.bodyText.trim() ? draft.bodyText : null,
      variables: usedPaths,
    };
    const snapshot = { rows, baseline, newId, activeKey };
    const replaces = active.isNew ? entryReplacedBy(fields.key, entries) : null;
    const optimistic: ApiEmailTemplate = {
      id: active.row && !active.row.inherited ? active.row.id : `pending:${fields.key}`,
      tenantId: active.row?.tenantId ?? "pending",
      ...fields,
      inherited: false,
      overridesDefault: Boolean(active.row?.inherited || active.row?.overridesDefault || replaces?.row?.inherited),
    };
    setRows((r) => upsertRow(r, optimistic));
    setBaseline({ ...draft, key: fields.key });
    if (active.isNew) {
      // The new template becomes an ordinary entry — carrying its sample data.
      setSamples((s) => ({ ...s, [fields.key]: s[active.id] ?? "{}" }));
      setNewId(null);
      setActiveKey(fields.key);
      setDraft((d) => ({ ...d, key: fields.key }));
    }
    setSaving(true);
    try {
      const saved = active.row
        ? (await emailTemplatesApi.patch(active.row.id, {
            name: fields.name,
            subject: fields.subject,
            fromAddress: fields.fromAddress,
            bodyHtml: fields.bodyHtml,
            bodyText: fields.bodyText,
            variables: fields.variables,
          })).data
        : (await emailTemplatesApi.create(fields)).data;
      setRows((r) => upsertRow(r, saved));
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
    const key = copyKey(active.key, entries);
    const label = labelOf(active);
    const name = t`${label} (copy)`.slice(0, 80);
    const input: EmailTemplateInput = {
      key,
      name,
      subject: draft.subject,
      fromAddress: draft.fromAddress.trim() || null,
      bodyHtml: draft.bodyHtml,
      bodyText: draft.bodyText.trim() ? draft.bodyText : null,
      variables: usedPaths,
    };
    const snapshot = { rows, activeKey, draft, baseline };
    const copy: TemplateEntry = { id: `pending:${key}`, key, row: null, builtIn: null };
    setRows((r) => [
      ...r,
      { id: `pending:${key}`, tenantId: "pending", ...input, inherited: false, overridesDefault: false },
    ]);
    // What you see is what gets copied, unsaved edits included; the original
    // keeps what it had saved.
    const copied: Draft = { ...draft, key, name };
    setActiveKey(key);
    setDraft(copied);
    setBaseline(copied);
    setSamples((s) => ({ ...s, [key]: s[active.key] ?? formatSample(seedSample(copy, copied)) }));
    try {
      const saved = (await emailTemplatesApi.create(input)).data;
      setRows((r) => upsertRow(r, saved));
      pushToast(t`Duplicated as "${name}".`);
    } catch (e) {
      setRows(snapshot.rows);
      setActiveKey(snapshot.activeKey);
      setDraft(snapshot.draft);
      setBaseline(snapshot.baseline);
      pushToast((e as Error).message);
    }
  };

  /** Delete a custom template, or reset a customized one — the same DELETE. The
   *  server answers with what the key resolves to afterwards. */
  const onRemove = async (entry: TemplateEntry) => {
    const row = entry.row;
    if (!row || row.inherited) return;
    const snapshot = { rows, activeKey, draft, baseline };
    const wasActive = entry.key === activeKey;
    // Optimistic: a customized shared default reverts in place (its content
    // arrives with the response); a built-in email loses its row and falls
    // back to the starter; a custom template leaves the list.
    const placeholder: ApiEmailTemplate | null = row.overridesDefault
      ? { ...row, id: `pending:${row.key}`, tenantId: null, inherited: true, overridesDefault: false }
      : null;
    const nextRows = placeholder ? upsertRow(rows, placeholder) : rows.filter((r) => r.key !== row.key);
    setRows(nextRows);
    if (wasActive) {
      const next = buildEntries(nextRows);
      const same = next.find((e) => e.key === row.key);
      const target = same ?? next[0] ?? null;
      setActiveKey(target?.key ?? null);
      if (target) load(target);
    }
    try {
      const res = await emailTemplatesApi.remove(row.id);
      if (res.data) {
        const restored = res.data;
        setRows((r) => upsertRow(r, restored));
        if (wasActive) load({ id: restored.id, key: restored.key, row: restored, builtIn: entry.builtIn });
      } else if (placeholder) {
        setRows((r) => r.filter((x) => x.key !== row.key));
      }
      pushToast(entryStatus(entry) === "customized" ? t`Reset to default.` : t`Template deleted.`);
    } catch (e) {
      setRows(snapshot.rows);
      setActiveKey(snapshot.activeKey);
      setDraft(snapshot.draft);
      setBaseline(snapshot.baseline);
      pushToast((e as Error).message);
    }
  };

  const onSendTest = async () => {
    if (!active || sending) return;
    if (!draft.subject.trim() || !draft.bodyHtml.trim()) {
      pushToast(t`Add a subject and a body before sending a test.`);
      return;
    }
    if (!parsedSample) {
      pushToast(t`Sample data must be valid JSON.`);
      return;
    }
    const from = draft.fromAddress.trim();
    setSending(true);
    try {
      // The draft as it stands, with the sample data — so the inbox matches the
      // preview, and an unsaved edit to a live email can be tested before it
      // reaches a real recipient.
      await emailTemplatesApi.sendDraftTest({
        subject: draft.subject,
        bodyHtml: draft.bodyHtml,
        bodyText: draft.bodyText.trim() ? draft.bodyText : null,
        fromAddress: from && EMAIL_RE.test(from) ? from : null,
        vars: parsedSample,
      });
      pushToast(t`Test email sent.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  // First whole-page fetch — email templates haven't landed yet.
  if (!loaded) return <EmailTemplatesSkeleton />;

  const status = active ? entryStatus(active) : null;
  const query = search.trim().toLowerCase();
  const visible = entries.filter((e) => !query || labelOf(e).toLowerCase().includes(query) || e.key.toLowerCase().includes(query));
  const features: BuiltInEmailFeature[] = ["forms", "signatures", "approvals", "booking"];
  const sections = [
    ...features.map((f) => ({
      id: f,
      title: i18n._(FEATURE_LABELS[f]),
      items: visible.filter((e) => e.builtIn && BUILT_IN_EMAIL_TEMPLATES[e.builtIn].feature === f),
    })),
    { id: "custom", title: t`Your templates`, items: visible.filter((e) => !e.builtIn) },
  ].filter((s) => s.items.length > 0);

  const keyIssue = active?.isNew && draft.key.trim() ? keyProblem(draft.key.trim(), entries) : null;
  const replaced = active?.isNew && !keyIssue ? entryReplacedBy(draft.key.trim(), entries) : null;
  const replacedName = replaced ? labelOf(replaced) : "";
  const renderedSubject = renderTemplate(draft.subject, sampleVars);
  const previewHtml = renderTemplate(draft.bodyHtml, sampleVars);
  const confirmLabel = confirm && confirm.kind !== "discard" ? labelOf(confirm.entry) : "";

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Email templates`}
        description={
          <Trans>
            Customize the emails backlex sends, or write your own for flows and scheduled reports. Variables use{" "}
            <span className="font-mono">{userEmailExample}</span> placeholders.
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
            {sections.length === 0 ? (
              <EmptyState size="sm" icon={I.Search} title={<Trans>No templates match your search.</Trans>} />
            ) : (
              sections.map((section) => (
                <div key={section.id}>
                  <div className="px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    {section.title}
                  </div>
                  {section.items.map((e) => {
                    const isActive = !newId && e.key === activeKey;
                    const s = entryStatus(e);
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
              <Button size="sm" variant="outline" icon={I.Send} onClick={() => void onSendTest()} disabled={!active || sending}>
                {sending ? <Trans>Sending…</Trans> : <Trans>Send test</Trans>}
              </Button>
              <Button size="sm" variant="primary" icon={I.Save} onClick={() => void onSave()} disabled={!active || saving || (!dirty && status !== "builtin" && !active?.isNew)}>
                {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
              </Button>
            </div>
          </div>
          {active ? (
            <div className="flex flex-col gap-2.5 p-3.5">
              {active.builtIn && !active.isNew && (
                <div className="flex flex-col gap-0.5 rounded-control border border-border px-3 py-2 text-[11.5px] text-muted-foreground">
                  <span className="text-foreground">{i18n._(BUILT_IN_EMAIL_LABELS[active.builtIn].when)}</span>
                  {status === "builtin" && (
                    <span><Trans>Not customized: backlex sends its built-in wording. The editor starts from a similar version — saving puts yours live for this workspace.</Trans></span>
                  )}
                  {status === "customized" && (
                    <span><Trans>Customized: this workspace sends your version. Reset to go back to the built-in email.</Trans></span>
                  )}
                </div>
              )}
              {status === "shared" && (
                <div className="rounded-control border border-border px-3 py-2 text-[11.5px] text-muted-foreground">
                  <Trans>This is a shared default. Saving creates a copy for this workspace and leaves the shared one untouched.</Trans>
                </div>
              )}
              {!active.builtIn && (status === "shared" || (status === "customized" && active.row?.overridesDefault)) && (
                <div className="rounded-control border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11.5px]">
                  <Trans>No built-in email uses this template — sign-in, verification, password-reset and invite emails have fixed wording. It is sent only when a flow step or a scheduled report names its key.</Trans>
                </div>
              )}
              <div className="flex gap-2.5 max-[640px]:flex-col">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor="email-template-name" className="text-[12.5px] font-medium text-foreground"><Trans>Name</Trans></label>
                  <Input id="email-template-name" value={draft.name} maxLength={80} placeholder={t`Verify email`} onChange={(e) => setField("name")(e.target.value)} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor="email-template-key" className="text-[12.5px] font-medium text-foreground"><Trans>Key</Trans></label>
                  <Input
                    id="email-template-key"
                    className="font-mono"
                    value={draft.key}
                    maxLength={40}
                    placeholder={t`verify`}
                    disabled={!active.isNew}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={keyIssue ? true : undefined}
                    onChange={(e) => setField("key")(e.target.value)}
                  />
                </div>
              </div>
              {keyIssue === "format" && (
                <span className="text-[11.5px] text-destructive">
                  <Trans>2–40 characters: letters, digits, _, - or ., starting with a letter or digit.</Trans>
                </span>
              )}
              {keyIssue === "taken" && (
                <span className="text-[11.5px] text-destructive"><Trans>This workspace already has a template with this key.</Trans></span>
              )}
              {replaced && (
                <span className="text-[11.5px] text-amber-600 dark:text-amber-400">
                  <Trans>
                    Saving under this key replaces “{replacedName}” for this workspace — it goes live for real
                    recipients.
                  </Trans>
                </span>
              )}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="email-template-subject" className="text-[12.5px] font-medium text-foreground"><Trans>Subject</Trans></label>
                <Input
                  id="email-template-subject"
                  ref={fieldRefs.subject}
                  value={draft.subject}
                  maxLength={200}
                  onChange={(e) => { setField("subject")(e.target.value); remember("subject")(e); }}
                  onSelect={remember("subject")}
                  onFocus={remember("subject")}
                  onBlur={remember("subject")}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="email-template-from" className="text-[12.5px] font-medium text-foreground"><Trans>From</Trans></label>
                <Input id="email-template-from" value={draft.fromAddress} placeholder={t`(use the configured default)`} onChange={(e) => setField("fromAddress")(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="email-template-html" className="text-[12.5px] font-medium text-foreground"><Trans>Body (HTML)</Trans></label>
                <ScrollArea type="auto" className={CODE_FRAME} viewportClassName="max-h-[min(60vh,560px)]">
                  <Textarea
                    id="email-template-html"
                    ref={fieldRefs.bodyHtml}
                    value={draft.bodyHtml}
                    onChange={(e) => { setField("bodyHtml")(e.target.value); remember("bodyHtml")(e); }}
                    onSelect={remember("bodyHtml")}
                    onFocus={remember("bodyHtml")}
                    onBlur={remember("bodyHtml")}
                    spellCheck={false}
                    aria-label={t`Body (HTML)`}
                    className={cn("min-h-[220px]", CODE_AREA)}
                  />
                </ScrollArea>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="email-template-text" className="text-[12.5px] font-medium text-foreground"><Trans>Plain-text body</Trans></label>
                <ScrollArea type="auto" className={CODE_FRAME} viewportClassName="max-h-[min(40vh,320px)]">
                  <Textarea
                    id="email-template-text"
                    ref={fieldRefs.bodyText}
                    value={draft.bodyText}
                    onChange={(e) => { setField("bodyText")(e.target.value); remember("bodyText")(e); }}
                    onSelect={remember("bodyText")}
                    onFocus={remember("bodyText")}
                    onBlur={remember("bodyText")}
                    spellCheck={false}
                    placeholder={t`Leave empty to generate it from the HTML body.`}
                    aria-label={t`Plain-text body`}
                    className={cn("min-h-[88px]", CODE_AREA)}
                  />
                </ScrollArea>
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>What text-only mail clients show. Empty means it is generated from the HTML body when the email is sent.</Trans>
                </span>
              </div>
              <VariablesPanel key={active.id} entry={active} sample={parsedSample} usedPaths={usedPaths} onInsert={insertVariable} />
              <VariableWarnings
                warnings={warnings}
                onAddToSample={parsedSample ? addMissingToSample : undefined}
              />
            </div>
          ) : (
            <EmptyState size="sm" icon={I.Mail} title={<Trans>Pick a template, or use "New template" to add one.</Trans>} />
          )}
        </Card>

        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <span className="text-xs font-medium"><Trans>Preview</Trans></span>
            <div role="group" aria-label={t`Preview width`} className="ml-auto inline-flex rounded-control border border-border bg-muted/60 p-[3px]">
              {(["desktop", "mobile"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={device === d}
                  onClick={() => setDevice(d)}
                  className={cn(
                    "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors",
                    device === d ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {d === "desktop" ? <I.Monitor size={12} /> : <I.Smartphone size={12} />}
                  {d === "desktop" ? <Trans>Desktop</Trans> : <Trans>Mobile</Trans>}
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 items-baseline gap-2 border-b border-border px-4 py-2.5 text-[12.5px]">
            <span className="shrink-0 text-muted-foreground"><Trans>Subject</Trans></span>
            <span className="min-w-0 truncate font-medium" data-testid="email-preview-subject">{renderedSubject}</span>
          </div>
          <div className="min-h-[280px] bg-[oklch(0.97_0.005_130)] p-3 sm:p-6">
            {/* Same reasoning as the document-template preview next door: a
                template authored by one workspace admin is still somebody
                else's markup running in another one's session, so it renders
                in `sandbox=""`, which grants nothing. The body renders through
                `renderTemplate` — the function the mailer calls — and nothing
                is restyled on the way in: the preview used to paint every link
                as a pill button, which no recipient ever saw. */}
            <PreviewFrame html={previewHtml} device={device} title={t`Email preview`} />
          </div>
          <div className="flex flex-col gap-1.5 border-t border-border p-3.5">
            <label htmlFor="email-template-sample" className="text-[12.5px] font-medium text-foreground"><Trans>Sample data</Trans></label>
            <ScrollArea type="auto" className="rounded-control border border-border bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30" viewportClassName="max-h-[320px]">
              <Textarea
                id="email-template-sample"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                spellCheck={false}
                aria-invalid={parsedSample ? undefined : true}
                className="min-h-[96px] w-full resize-none rounded-none border-0 bg-transparent p-3 font-mono text-[12px] focus-visible:ring-0"
              />
            </ScrollArea>
            {parsedSample ? (
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Fills the preview and the test email. Kept while this page is open; not saved with the template.</Trans>
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
        description={
          <Trans>
            Flow steps and reports that name its key fall back to their own subject and body. This can't be undone.
          </Trans>
        }
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
        description={<Trans>This workspace's version is deleted and the default is sent again. Unsaved edits are lost too.</Trans>}
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

/**
 * The preview at a device's layout width, scaled down to fit when the column is
 * narrower than that — which a desktop email always is here. Shrinking a frame
 * of the real width shows how the email lays out on that device; squeezing the
 * email into the column instead would only ever show the column's width.
 *
 * The sizer carries the scaled box, so nothing wider than the column reaches the
 * layout and a phone viewport never scrolls sideways.
 */
function PreviewFrame({ html, device, title }: { html: string; device: PreviewDevice; title: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { width, height } = PREVIEW_SIZE[device];
  // `available` is 0 until measured (and always, without layout): show 1:1.
  const scale = available > 0 && available < width ? available / width : 1;
  return (
    <div ref={outer} className="w-full min-w-0">
      <div
        className="mx-auto overflow-hidden rounded-surface bg-white shadow-[0_1px_4px_oklch(0_0_0/0.06)]"
        style={{ width: Math.floor(width * scale), height: Math.floor(height * scale) }}
      >
        <div
          data-testid="email-preview-frame"
          data-device={device}
          style={{
            width,
            height,
            transform: scale < 1 ? `scale(${scale})` : undefined,
            transformOrigin: "top left",
          }}
        >
          <HtmlPreview title={title} complete={isCompleteDocument(html)} html={html} className="h-full" />
        </div>
      </div>
      <div className="mt-2 text-center font-mono text-[10.5px] text-muted-foreground">
        {width}px{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}
      </div>
    </div>
  );
}
