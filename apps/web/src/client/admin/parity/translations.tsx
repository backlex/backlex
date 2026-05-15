// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import { i18nApi, settingsApi } from "../api";
import { I18N_KEY_PATTERN } from "./_shared";

export function TranslationsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const [locales, setLocales] = useState<string[]>(["en"]);
  const [data, setData] = useState<Record<string, string>[]>([]);
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Translations"
        description={<>Multi-locale content. Field-level translations attach to <span className="font-mono">c_*_translations</span> sibling tables; UI strings live here.</>}
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
            pushToast("Exported translations.json.");
          }}>Export</Button>
          <Button variant="outline" icon={I.Zap} onClick={() => setTranslateOpen(true)} disabled={data.length === 0 || locales.length < 2}>Auto-translate</Button>
          <Button variant="primary" icon={I.Plus} onClick={() => setAddOpen(true)}>New key</Button>
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
              pushToast(`Translated ${res.translated}${res.remaining ? ` (${res.remaining} more queued — run again)` : ""}.`);
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
              pushToast(value ? `Key "${key}" added with ${base} value.` : `Key "${key}" added.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
            setAddOpen(false);
          }}
        />
      )}
      <div className="card" style={{ padding: 14, display: "grid", gridTemplateColumns: `repeat(${locales.length}, 1fr)`, gap: 12 }}>
        {completion.map((c) => (
          <div key={c.l}>
            <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{c.l}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="tabular-nums" style={{ fontWeight: 500 }}>{c.pct}%</span>
              <div style={{ flex: 1, height: 4, background: "var(--muted)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${c.pct}%`, height: "100%", background: c.pct === 100 ? "oklch(0.7 0.18 145)" : c.pct < 80 ? "oklch(0.78 0.16 75)" : "var(--primary)" }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="filter-bar">
        <span className="muted" style={{ fontSize: 11.5 }}>base</span>
        <Select value={base} onChange={setBase} options={[...locales]} />
        <button className={`chip ${showOnly === "all" ? "active" : ""}`} onClick={() => setShowOnly("all")}>All ({data.length})</button>
        <button className={`chip ${showOnly === "missing" ? "active" : ""}`} onClick={() => setShowOnly("missing")}>Missing ({data.filter((r) => locales.some((l) => !r[l])).length})</button>
        <div style={{ marginLeft: "auto" }}>
          <Button variant="outline" icon={I.Globe} onClick={() => setManageOpen(true)}>Manage locales</Button>
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
              pushToast("Locales updated.");
              setManageOpen(false);
            } catch (e) {
              pushToast((e as Error).message);
            }
          }}
        />
      )}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table className="table" style={{ minWidth: 100 + locales.length * 160 }}>
          <thead>
            <tr>
              <th style={{ width: 220, position: "sticky", left: 0, background: "var(--card)", zIndex: 1 }}>Key</th>
              {locales.map((l) => <th key={l} style={{ minWidth: 160 }}>{l}{l === base && <span className="muted"> · base</span>}</th>)}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key}>
                <td className="font-mono" style={{ fontSize: 12, position: "sticky", left: 0, background: "var(--card)" }}>{r.key}</td>
                {locales.map((l) => (
                  <td key={l} style={{ padding: 0 }}>
                    <input value={r[l] || ""} onChange={(e) => update(r.key, l, e.target.value)} placeholder={l === base ? "" : (r[base] || "—")} style={{ width: "100%", border: 0, outline: 0, background: !r[l] ? "color-mix(in oklch, oklch(0.78 0.16 75) 8%, transparent)" : "transparent", padding: "10px 12px", fontSize: 12.5, fontFamily: l === "ja" ? "inherit" : "Geist, sans-serif", color: !r[l] ? "var(--muted-foreground)" : "var(--foreground)" }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      ? "A key with this name already exists."
      : tooLong
        ? "Key must be 120 characters or fewer."
        : badFormat
          ? "Use letters, digits, dots, dashes, or underscores. Must start with a letter or digit."
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
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-i18n-key-title"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: "92vw" }}
      >
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2 id="add-i18n-key-title">New translation key</h2>
            <p>Adds a row to <span className="font-mono">i18n_strings</span>. The key is shared across all locales; values are filled per locale.</p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>
        <div className="dialog-body">
          <div className="field">
            <label className="field-label" htmlFor="i18n-new-key">
              Key <Badge variant="outline" mono>text</Badge> <span style={{ color: "var(--destructive)" }}>*</span>
            </label>
            <input
              id="i18n-new-key"
              className={`input font-mono ${error ? "error" : ""}`}
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
              <div className="field-error"><I.AlertTriangle size={11} />{error}</div>
            ) : (
              <div className="field-hint">Dotted namespaces are conventional, e.g. <span className="font-mono">common.cancel</span>, <span className="font-mono">auth.signin.title</span>.</div>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="i18n-new-value">
              Base value <Badge variant="outline" mono>{base}</Badge> <span className="muted" style={{ fontWeight: 400 }}>· optional</span>
            </label>
            <textarea
              id="i18n-new-value"
              className="textarea"
              rows={2}
              placeholder={`Translation for ${base}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="field-hint">Leave blank to create the key with empty values across all locales.</div>
          </div>

          <div className="field" style={{ background: "var(--muted)", padding: 12, borderRadius: "var(--radius-xl)" }}>
            <div className="field-label" style={{ marginBottom: 6 }}>
              <I.Globe size={12} /> Locales
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {locales.map((l) => (
                <Badge key={l} variant={l === base ? "default" : "outline"} mono>
                  {l}{l === base && " · base"}
                </Badge>
              ))}
            </div>
            <div className="field-hint" style={{ marginTop: 6 }}>
              Other locales stay empty until filled in the matrix.
            </div>
          </div>
        </div>
        <div className="sheet-footer">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" icon={I.Plus} onClick={submit} disabled={!valid || submitting}>
            {submitting ? "Creating…" : "Create key"}
          </Button>
        </div>
      </div>
    </div>
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
    <div className="dialog-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="dialog-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-translate-title"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460, maxWidth: "92vw" }}
      >
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2 id="auto-translate-title">Auto-translate</h2>
            <p>Translate UI strings using Claude. Requires <span className="font-mono">ANTHROPIC_API_KEY</span> on the server.</p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" disabled={busy} />
        </div>
        <div className="dialog-body">
          <div className="field">
            <label className="field-label">From</label>
            <Select value={source} onChange={setSource} options={locales} />
          </div>
          <div className="field">
            <label className="field-label">To</label>
            <Select value={target} onChange={setTarget} options={locales.filter((l) => l !== source)} />
          </div>
          <div className="field-row">
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 12.5 }}>Only translate missing keys</span>
              <span className="muted" style={{ fontSize: 11 }}>When off, existing translations in the target locale are overwritten.</span>
            </div>
            <Switch checked={onlyMissing} onChange={setOnlyMissing} />
          </div>
          <div style={{ background: "var(--muted)", padding: 10, borderRadius: "var(--radius-xl)", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <I.Info size={12} />
            <span>Will translate <strong>{Math.min(targetCount, 50)}</strong> key{targetCount === 1 ? "" : "s"}{targetCount > 50 ? ` of ${targetCount} (capped at 50 per run)` : ""}.</span>
          </div>
        </div>
        <div className="sheet-footer">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            icon={I.Zap}
            onClick={() => void onRun({ targetLocale: target, sourceLocale: source, onlyMissing })}
            disabled={busy || targetCount === 0 || !target || source === target}
          >
            {busy ? "Translating…" : "Translate"}
          </Button>
        </div>
      </div>
    </div>
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
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-locales-title"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: "92vw" }}
      >
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2 id="manage-locales-title">Manage locales</h2>
            <p>Active languages for this workspace. The default is returned by the public API when a requested locale has no string.</p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>
        <div className="dialog-body">
          <div className="field">
            <label className="field-label">
              <I.Globe size={12} /> Active locales
            </label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {list.map((l) => (
                <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px 2px 8px", border: "1px solid var(--border)", borderRadius: 6, background: l === def ? "var(--primary)" : "transparent", color: l === def ? "var(--primary-foreground)" : "inherit", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                  {l}{l === def && " · default"}
                  <button
                    aria-label={`Remove ${l}`}
                    onClick={() => remove(l)}
                    disabled={list.length <= 1}
                    style={{ background: "transparent", border: 0, padding: 0, cursor: list.length <= 1 ? "not-allowed" : "pointer", color: "inherit", display: "inline-flex" }}
                  >
                    <I.X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input font-mono"
                placeholder="tr, en-GB, …"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                style={{ flex: 1 }}
              />
              <Button variant="outline" icon={I.Plus} onClick={add} disabled={!draft.trim() || !LOCALE_PATTERN.test(draft.trim().toLowerCase()) || list.includes(draft.trim().toLowerCase())}>Add</Button>
            </div>
            <div className="field-hint" style={{ marginTop: 6 }}>BCP-47 short codes — e.g. <span className="font-mono">tr</span>, <span className="font-mono">en-GB</span>, <span className="font-mono">pt-BR</span>.</div>
          </div>

          <div className="field">
            <label className="field-label">Default locale</label>
            <Select value={def} onChange={setDef} options={list} />
            <div className="field-hint">Used as fallback when the requested locale has no string for a key.</div>
          </div>
        </div>
        <div className="sheet-footer">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" icon={I.Check} onClick={submit} disabled={submitting || list.length === 0}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
