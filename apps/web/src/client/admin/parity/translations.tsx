// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../icons";
import { Badge, Button, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { i18nApi, settingsApi } from "../api";
import { I18N_KEY_PATTERN } from "./_shared";
import { TranslationsSkeleton } from "../page-skeletons";

const TR_TABLE_CLS =
  "[&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

export function TranslationsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [locales, setLocales] = useState<string[]>(["en"]);
  const [data, setData] = useState<Record<string, string>[]>([]);
  // First-load gate — drives the page skeleton until the matrix lands.
  const [loaded, setLoaded] = useState(false);
  const [base, setBase] = useState("en");
  const [showOnly, setShowOnly] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await i18nApi.matrix();
        if (cancelled) return;
        const cols = res.configuredLocales?.length ? res.configuredLocales : res.locales;
        setLocales(cols);
        setBase(res.defaultLocale || cols[0] || "en");
        const keys = Object.keys(res.data || {});
        if (keys.length > 0) {
          const rows = keys.map((k) => {
            const row: Record<string, string> = { key: k };
            for (const l of cols) row[l] = res.data[k]?.[l] ?? "";
            return row;
          });
          setData(rows);
        }
      } catch {
        // leave translations empty
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const persist = (key: string, locale: string, value: string) => {
    void i18nApi.upsert(key, locale, value).catch((e: Error) => pushToast?.(e.message));
  };
  const visible = showOnly === "missing" ? data.filter((r) => locales.some((l) => !r[l])) : data;
  const completion = locales.map((l) => ({ l, pct: data.length === 0 ? 0 : Math.round(data.filter((r) => r[l]).length / data.length * 100) }));
  const update = (key: string, locale: string, value: string) => {
    setData((arr) => arr.map((r) => r.key === key ? { ...r, [locale]: value } : r));
    persist(key, locale, value);
  };

  // First whole-page fetch — the translation matrix hasn't landed yet.
  if (!loaded) return <TranslationsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Translations`}
        description={<Trans>Multi-locale content. Field-level translations attach to <span className="font-mono">c_*_translations</span> sibling tables; UI strings live here.</Trans>}
        actions={<>
          <Button variant="outline" icon={I.Download} onClick={() => {
            const out: Record<string, Record<string, string>> = {};
            for (const r of data) {
              out[r.key] = {};
              for (const l of locales) out[r.key]![l] = r[l] || "";
            }
            const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = "translations.json"; a.click();
            URL.revokeObjectURL(url);
            pushToast(t`Exported translations.json.`);
          }}><Trans>Export</Trans></Button>
          <Button variant="outline" icon={I.Zap} onClick={() => setTranslateOpen(true)} disabled={data.length === 0 || locales.length < 2}><Trans>Auto-translate</Trans></Button>
          <Button variant="primary" icon={I.Plus} onClick={() => setAddOpen(true)}><Trans>New key</Trans></Button>
        </>}
      />
      {translateOpen && (
        <AutoTranslateDialog
          locales={locales}
          base={base}
          data={data}
          busy={translating}
          onClose={() => setTranslateOpen(false)}
          onRun={async ({ targetLocale, sourceLocale, onlyMissing }) => {
            setTranslating(true);
            try {
              const res = await i18nApi.autoTranslate({ targetLocale, sourceLocale, onlyMissing });
              if (res.rows.length > 0) {
                setData((arr) => arr.map((r) => {
                  const hit = res.rows.find((x) => x.key === r.key);
                  return hit ? { ...r, [targetLocale]: hit.value } : r;
                }));
              }
              pushToast(t`Translated ${res.translated}${res.remaining ? ` (${res.remaining} more queued — run again)` : ""}.`);
              if (!res.remaining) setTranslateOpen(false);
            } catch (e) {
              pushToast((e as Error).message);
            } finally {
              setTranslating(false);
            }
          }}
        />
      )}
      {addOpen && (
        <AddTranslationKeyDialog
          base={base}
          locales={[...locales]}
          existingKeys={data.map((r) => r.key)}
          onClose={() => setAddOpen(false)}
          onCreate={async ({ key, value }) => {
            const seed: Record<string, string> = { key };
            for (const l of locales) seed[l] = "";
            if (value) seed[base] = value;
            setData((arr) => [...arr, seed]);
            try {
              await i18nApi.upsert(key, base, value);
              pushToast(value ? t`Key "${key}" added with ${base} value.` : t`Key "${key}" added.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
            setAddOpen(false);
          }}
        />
      )}
      <Card className="grid gap-x-4 gap-y-3 p-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))" }}>
        {completion.map((c) => (
          <div key={c.l} className="min-w-0">
            <div className="truncate text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{c.l}</div>
            <div className="flex items-center gap-1.5">
              <span className="font-medium tabular-nums">{c.pct}%</span>
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-[2px] bg-muted">
                <div className="h-full" style={{ width: `${c.pct}%`, background: c.pct === 100 ? "oklch(0.7 0.18 145)" : c.pct < 80 ? "oklch(0.78 0.16 75)" : "var(--primary)" }} />
              </div>
            </div>
          </div>
        ))}
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] text-muted-foreground"><Trans>base</Trans></span>
        <Select value={base} onChange={setBase} options={[...locales]} />
        <Tabs value={showOnly} onValueChange={(v) => setShowOnly(v)}>
          <TabsList>
            <TabsTrigger value="all"><Trans>All ({data.length})</Trans></TabsTrigger>
            <TabsTrigger value="missing"><Trans>Missing ({data.filter((r) => locales.some((l) => !r[l])).length})</Trans></TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto">
          <Button variant="outline" icon={I.Globe} onClick={() => setManageOpen(true)}><Trans>Manage locales</Trans></Button>
        </div>
      </div>
      {manageOpen && (
        <ManageLocalesDialog
          locales={locales}
          defaultLocale={base}
          onClose={() => setManageOpen(false)}
          onSave={async ({ locales: next, defaultLocale }) => {
            try {
              await settingsApi.patch({ i18nLocales: next, i18nDefaultLocale: defaultLocale });
              setLocales(next);
              setBase(defaultLocale);
              setData((arr) => arr.map((r) => {
                const row: Record<string, string> = { key: r.key };
                for (const l of next) row[l] = r[l] ?? "";
                return row;
              }));
              pushToast(t`Locales updated.`);
              setManageOpen(false);
            } catch (e) {
              pushToast((e as Error).message);
            }
          }}
        />
      )}
      <Card className="py-0 gap-0">
        <Table className={TR_TABLE_CLS} style={{ minWidth: 100 + locales.length * 160 }}>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-[1] w-[220px] bg-card"><Trans>Key</Trans></TableHead>
              {locales.map((l) => <TableHead key={l} className="min-w-[160px]">{l}{l === base && <span className="text-muted-foreground"><Trans> · base</Trans></span>}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="sticky left-0 bg-card px-3.5 font-mono text-xs">{r.key}</TableCell>
                {locales.map((l) => (
                  <TableCell key={l} className="p-0">
                    <Input value={r[l] || ""} onChange={(e) => update(r.key, l, e.target.value)} placeholder={l === base ? "" : (r[base] || "—")} className={`h-auto w-full rounded-none border-0 px-3 py-2.5 text-[12.5px] shadow-none focus-visible:ring-0 ${!r[l] ? "bg-[color-mix(in_oklch,oklch(0.78_0.16_75)_8%,transparent)] text-muted-foreground" : "bg-transparent text-foreground"}`} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

interface AddTranslationKeyDialogProps {
  base: string;
  locales: string[];
  existingKeys: string[];
  onClose: () => void;
  onCreate: (input: { key: string; value: string }) => Promise<void>;
}

function AddTranslationKeyDialog({ base, locales, existingKeys, onClose, onCreate }: AddTranslationKeyDialogProps) {
  const { t } = useLingui();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const trimmedKey = key.trim();
  const duplicate = useMemo(
    () => existingKeys.includes(trimmedKey),
    [existingKeys, trimmedKey],
  );
  const tooLong = trimmedKey.length > 120;
  const badFormat = trimmedKey.length > 0 && !I18N_KEY_PATTERN.test(trimmedKey);
  const error = !trimmedKey
    ? null
    : duplicate
      ? t`A key with this name already exists.`
      : tooLong
        ? t`Key must be 120 characters or fewer.`
        : badFormat
          ? t`Use letters, digits, dots, dashes, or underscores. Must start with a letter or digit.`
          : null;
  const valid = trimmedKey.length > 0 && !error;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await onCreate({ key: trimmedKey, value: value.trim() });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>New translation key</Trans></DialogTitle>
          <DialogDescription className="text-[12.5px]"><Trans>Adds a row to <span className="font-mono">i18n_strings</span>. The key is shared across all locales; values are filled per locale.</Trans></DialogDescription>
        </DialogHeader>
        <ScrollArea viewportClassName="max-h-[calc(min(86vh,720px)-10rem)]">
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground" htmlFor="i18n-new-key">
              <Trans>Key</Trans> <Badge variant="outline" mono>text</Badge> <span className="text-destructive">*</span>
            </label>
            <Input
              id="i18n-new-key"
              className="font-mono"
              aria-invalid={!!error}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="common.cancel"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !submitting) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            {error ? (
              <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{error}</div>
            ) : (
              <div className="text-[11.5px] text-muted-foreground"><Trans>Dotted namespaces are conventional, e.g. <span className="font-mono">common.cancel</span>, <span className="font-mono">auth.signin.title</span>.</Trans></div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground" htmlFor="i18n-new-value">
              <Trans>Base value</Trans> <Badge variant="outline" mono>{base}</Badge> <span className="font-normal text-muted-foreground"><Trans>· optional</Trans></span>
            </label>
            <Textarea
              id="i18n-new-value"
              rows={2}
              placeholder={t`Translation for ${base}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="text-[11.5px] text-muted-foreground"><Trans>Leave blank to create the key with empty values across all locales.</Trans></div>
          </div>

          <div className="flex flex-col gap-1.5 rounded-xl bg-muted p-3">
            <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-foreground">
              <I.Globe size={12} /> <Trans>Locales</Trans>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {locales.map((l) => (
                <Badge key={l} variant={l === base ? "default" : "outline"} mono>
                  {l}{l === base && <Trans> · base</Trans>}
                </Badge>
              ))}
            </div>
            <div className="mt-1.5 text-[11.5px] text-muted-foreground">
              <Trans>Other locales stay empty until filled in the matrix.</Trans>
            </div>
          </div>
        </div>
        </ScrollArea>
        <DialogFooter className="border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={submitting}><Trans>Cancel</Trans></Button>
          <Button variant="primary" icon={I.Plus} onClick={submit} disabled={!valid || submitting}>
            {submitting ? <Trans>Creating…</Trans> : <Trans>Create key</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AutoTranslateDialogProps {
  locales: string[];
  base: string;
  data: Record<string, string>[];
  busy: boolean;
  onClose: () => void;
  onRun: (input: { targetLocale: string; sourceLocale: string; onlyMissing: boolean }) => Promise<void>;
}

function AutoTranslateDialog({ locales, base, data, busy, onClose, onRun }: AutoTranslateDialogProps) {
  const { t } = useLingui();
  const others = locales.filter((l) => l !== base);
  const [target, setTarget] = useState(others[0] || locales[0] || "");
  const [source, setSource] = useState(base);
  const [onlyMissing, setOnlyMissing] = useState(true);

  // Estimate how many keys the request will touch.
  const targetCount = useMemo(() => {
    if (!target) return 0;
    return data.filter((r) => {
      const src = r[source];
      if (!src) return false;
      if (onlyMissing) return !r[target];
      return true;
    }).length;
  }, [data, target, source, onlyMissing]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[460px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Auto-translate</Trans></DialogTitle>
          <DialogDescription className="text-[12.5px]"><Trans>Translate UI strings using Claude. Requires <span className="font-mono">ANTHROPIC_API_KEY</span> on the server.</Trans></DialogDescription>
        </DialogHeader>
        <ScrollArea viewportClassName="max-h-[calc(min(86vh,720px)-10rem)]">
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>From</Trans></label>
            <Select value={source} onChange={setSource} options={locales} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>To</Trans></label>
            <Select value={target} onChange={setTarget} options={locales.filter((l) => l !== source)} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-[12.5px]"><Trans>Only translate missing keys</Trans></span>
              <span className="text-[11px] text-muted-foreground"><Trans>When off, existing translations in the target locale are overwritten.</Trans></span>
            </div>
            <Switch checked={onlyMissing} onChange={setOnlyMissing} />
          </div>
          <div className="flex items-center gap-1.5 rounded-xl bg-muted p-2.5 text-xs">
            <I.Info size={12} />
            <span><Trans>Will translate <strong>{Math.min(targetCount, 50)}</strong> key{targetCount === 1 ? "" : "s"}{targetCount > 50 ? ` of ${targetCount} (capped at 50 per run)` : ""}.</Trans></span>
          </div>
        </div>
        </ScrollArea>
        <DialogFooter className="border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Cancel</Trans></Button>
          <Button
            variant="primary"
            icon={I.Zap}
            onClick={() => void onRun({ targetLocale: target, sourceLocale: source, onlyMissing })}
            disabled={busy || targetCount === 0 || !target || source === target}
          >
            {busy ? <Trans>Translating…</Trans> : <Trans>Translate</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ManageLocalesDialogProps {
  locales: string[];
  defaultLocale: string;
  onClose: () => void;
  onSave: (input: { locales: string[]; defaultLocale: string }) => Promise<void>;
}

const LOCALE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

function ManageLocalesDialog({ locales, defaultLocale, onClose, onSave }: ManageLocalesDialogProps) {
  const { t } = useLingui();
  const [list, setList] = useState<string[]>(locales);
  const [def, setDef] = useState(defaultLocale);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const add = () => {
    const v = draft.trim().toLowerCase();
    if (!v || !LOCALE_PATTERN.test(v) || list.includes(v)) return;
    setList((arr) => [...arr, v]);
    setDraft("");
  };
  const remove = (l: string) => {
    if (list.length <= 1) return;
    setList((arr) => arr.filter((x) => x !== l));
    if (def === l) setDef(list.find((x) => x !== l) || "en");
  };
  const submit = async () => {
    if (submitting || list.length === 0 || !list.includes(def)) return;
    setSubmitting(true);
    try {
      await onSave({ locales: list, defaultLocale: def });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Manage locales</Trans></DialogTitle>
          <DialogDescription className="text-[12.5px]"><Trans>Active languages for this workspace. The default is returned by the public API when a requested locale has no string.</Trans></DialogDescription>
        </DialogHeader>
        <ScrollArea viewportClassName="max-h-[calc(min(86vh,720px)-10rem)]">
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
              <I.Globe size={12} /> <Trans>Active locales</Trans>
            </label>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {list.map((l) => (
                <span key={l} className={`inline-flex items-center gap-1 rounded-[6px] border border-border py-0.5 pl-2 pr-1.5 font-mono text-[11px] ${l === def ? "bg-primary text-primary-foreground" : "bg-transparent"}`}>
                  {l}{l === def && <Trans> · default</Trans>}
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={t`Remove ${l}`}
                    onClick={() => remove(l)}
                    disabled={list.length <= 1}
                    className="size-auto border-0 bg-transparent p-0 text-inherit hover:bg-transparent"
                  >
                    <I.X size={11} />
                  </Button>
                </span>
              ))}
            </div>
            <div className="flex gap-1.5">
              <Input
                placeholder="tr, en-GB, …"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                className="font-mono flex-1"
              />
              <Button variant="outline" icon={I.Plus} onClick={add} disabled={!draft.trim() || !LOCALE_PATTERN.test(draft.trim().toLowerCase()) || list.includes(draft.trim().toLowerCase())}><Trans>Add</Trans></Button>
            </div>
            <div className="mt-1.5 text-[11.5px] text-muted-foreground"><Trans>BCP-47 short codes — e.g. <span className="font-mono">tr</span>, <span className="font-mono">en-GB</span>, <span className="font-mono">pt-BR</span>.</Trans></div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Default locale</Trans></label>
            <Select value={def} onChange={setDef} options={list} />
            <div className="text-[11.5px] text-muted-foreground"><Trans>Used as fallback when the requested locale has no string for a key.</Trans></div>
          </div>
        </div>
        </ScrollArea>
        <DialogFooter className="border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={submitting}><Trans>Cancel</Trans></Button>
          <Button variant="primary" icon={I.Check} onClick={submit} disabled={submitting || list.length === 0}>
            {submitting ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
