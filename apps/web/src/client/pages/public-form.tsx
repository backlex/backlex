// Public, unauthenticated form page — renders a form definition resolved from
// `GET /api/public/forms/:token` and submits to `POST .../submit`.
//
// Two routes share this component: `/f/:token` (standalone) and
// `/embed/f/:token` (iframe embed — compact chrome, framable CSP). Neither
// touches an authed endpoint.
//
// The page is themed BY THE FORM, not by the admin: theme (dark/light),
// accent color and font come from the definition, so an embedded form looks
// the same on any host site. Blocks may include `step` page breaks (the form
// becomes multi-step) and per-block show-conditions evaluated as the visitor
// types. `?lang=xx` (or the browser language) picks one of the form's offered
// locales; strings resolve server-side.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { formsPublicApi, type ApiPublicForm, type ApiPublicFormBlock } from "@/admin/api";
import {
  accentInk,
  fontStack,
  paletteFor,
  safeAccent,
  useFonts,
  type Palette,
} from "@/lib/public-theme";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void },
      ) => string;
    };
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Humanize a raw field name (snake/camel → Title Case) — used when neither
 *  the form config nor the collection field defines a display label. */
const humanizeLabel = (name: string): string =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (ch) => ch.toUpperCase());

/* ── turnstile ─────────────────────────────────────────────────────── */

function TurnstileWidget({ siteKey, onToken }: { siteKey: string; onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rendered = useRef(false);

  useEffect(() => {
    const render = () => {
      if (rendered.current || !ref.current || !window.turnstile) return;
      rendered.current = true;
      window.turnstile.render(ref.current, {
        sitekey: siteKey,
        callback: (t) => onToken(t),
        "expired-callback": () => onToken(null),
      });
    };
    if (window.turnstile) {
      render();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = TURNSTILE_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", render);
    return () => script.removeEventListener("load", render);
  }, [siteKey, onToken]);

  return <div ref={ref} />;
}

/* ── inputs ────────────────────────────────────────────────────────── */

function StarRating({
  value,
  onChange,
  accent,
  p,
}: {
  value: number | null;
  onChange: (v: number) => void;
  accent: string;
  p: Palette;
}) {
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const lit = (hover ?? value ?? 0) >= n;
        return (
          <button
            key={n}
            type="button"
            aria-label={String(n)}
            onClick={() => onChange(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(null)}
            style={{ background: "none", border: 0, cursor: "pointer", padding: 2, lineHeight: 0 }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill={lit ? accent : "none"} stroke={lit ? accent : p.faint} strokeWidth="1.6">
              <path d="M12 3l2.7 5.9 6.3.7-4.7 4.3 1.3 6.1L12 17l-5.6 3 1.3-6.1L3 9.6l6.3-.7z" />
            </svg>
          </button>
        );
      })}
      <span style={{ fontSize: 11, color: p.faint, marginLeft: 4 }}>1–5</span>
    </div>
  );
}

/** Value a completed file upload leaves in the answers map — the ticket is
 *  what the submit payload sends; name/size are for display only. */
interface FileUploadValue {
  ticket: string;
  name: string;
  size: number;
}

const isFileValue = (v: unknown): v is FileUploadValue =>
  typeof v === "object" && v !== null && typeof (v as FileUploadValue).ticket === "string";

const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

function FileUploadInput({
  block,
  token,
  value,
  onChange,
  accent,
  p,
}: {
  block: ApiPublicFormBlock;
  token: string;
  value: unknown;
  onChange: (v: unknown) => void;
  accent: string;
  p: Palette;
}) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const val = isFileValue(value) ? value : null;

  const pick = async (file: File | null | undefined) => {
    if (!file || uploading || !block.name) return;
    if (block.maxBytes && file.size > block.maxBytes) {
      setErr(t`File is too large — the limit is ${fmtBytes(block.maxBytes)}`);
      return;
    }
    setErr(null);
    setUploading(true);
    try {
      const res = await formsPublicApi.upload(token, block.name, file);
      onChange({ ticket: res.data.ticket, name: res.data.name, size: res.data.size });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t`Upload failed — please try again`);
    } finally {
      setUploading(false);
    }
  };

  const boxStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    minHeight: 76,
    borderRadius: 10,
    border: `1.5px dashed ${dragOver ? accent : p.border}`,
    background: dragOver ? `${accent}0f` : p.inputBg,
    color: p.muted,
    fontSize: 13,
    fontFamily: "inherit",
    cursor: uploading ? "progress" : "pointer",
    padding: "14px 12px",
    boxSizing: "border-box",
    textAlign: "center",
  };

  if (val) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: `1px solid ${p.border}`,
          background: p.inputBg,
          borderRadius: 10,
          padding: "10px 12px",
          minWidth: 0,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="1.8" style={{ flexShrink: 0 }}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13.5 }}>
          {val.name}
        </span>
        <span style={{ fontSize: 11, color: p.faint, flexShrink: 0 }}>{fmtBytes(val.size)}</span>
        <button
          type="button"
          aria-label={t`Remove file`}
          onClick={() => {
            onChange(undefined);
            setErr(null);
          }}
          style={{
            background: "none",
            border: 0,
            color: p.muted,
            cursor: "pointer",
            padding: 4,
            lineHeight: 0,
            flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <input
        ref={inputRef}
        type="file"
        accept={block.accept?.join(",") ?? undefined}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
        style={{ display: "none" }}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void pick(e.dataTransfer.files?.[0]);
        }}
        style={boxStyle}
      >
        {uploading ? (
          <Trans>Uploading…</Trans>
        ) : (
          <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M17 8l-5-5-5 5M12 3v12" />
            </svg>
            <span>
              <Trans>Choose a file or drag it here</Trans>
            </span>
            {block.maxBytes && (
              <span style={{ fontSize: 11, color: p.faint }}>
                <Trans>up to {fmtBytes(block.maxBytes)}</Trans>
              </span>
            )}
          </span>
        )}
      </button>
      {err && (
        <p role="alert" style={{ fontSize: 12, color: "#e5484d", margin: 0 }}>
          {err}
        </p>
      )}
    </div>
  );
}

function BlockInput({
  block,
  token,
  value,
  onChange,
  accent,
  p,
}: {
  block: ApiPublicFormBlock;
  token: string;
  value: unknown;
  onChange: (v: unknown) => void;
  accent: string;
  p: Palette;
}) {
  const { t } = useLingui();
  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 40,
    borderRadius: 10,
    border: `1px solid ${p.border}`,
    background: p.inputBg,
    color: p.text,
    padding: "0 12px",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
  };
  if (block.choices && block.choices.length > 0 && block.type === "json") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (v: string) =>
      onChange(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {block.choices.map((ch) => (
          <label
            key={ch.value}
            style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13.5 }}
          >
            <input
              type="checkbox"
              checked={arr.includes(ch.value)}
              onChange={() => toggle(ch.value)}
              style={{ width: 17, height: 17, accentColor: accent, flexShrink: 0 }}
            />
            <span>{ch.label ?? ch.value}</span>
          </label>
        ))}
      </div>
    );
  }
  if (block.choices && block.choices.length > 0) {
    return (
      <select
        value={typeof value === "string" ? value : ""}
        required={block.required}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, appearance: "auto" as never }}
      >
        <option value="" disabled>
          {t`Select one…`}
        </option>
        {block.choices.map((ch) => (
          <option key={ch.value} value={ch.value}>
            {ch.label ?? ch.value}
          </option>
        ))}
      </select>
    );
  }
  if (block.type === "file") {
    return (
      <FileUploadInput
        block={block}
        token={token}
        value={value}
        onChange={onChange}
        accent={accent}
        p={p}
      />
    );
  }
  if (block.rating) {
    return (
      <StarRating
        value={typeof value === "number" ? value : null}
        onChange={(v) => onChange(v)}
        accent={accent}
        p={p}
      />
    );
  }
  switch (block.type) {
    case "longtext":
      return (
        <textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          required={block.required}
          placeholder={block.placeholder ?? ""}
          style={{ ...inputStyle, height: "auto", padding: "10px 12px", resize: "vertical" }}
        />
      );
    case "integer":
    case "number":
      return (
        <input
          type="number"
          step={block.type === "integer" ? 1 : "any"}
          value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(e.target.value)}
          required={block.required}
          placeholder={block.placeholder ?? ""}
          style={inputStyle}
        />
      );
    case "boolean":
      return (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: p.muted, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: accent }}
          />
          <Trans>Yes</Trans>
        </label>
      );
    case "timestamp":
      return (
        <input
          type="datetime-local"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          required={block.required}
          style={inputStyle}
        />
      );
    default: {
      const format = (block.validation?.format as string | undefined) ?? undefined;
      return (
        <input
          type={format === "email" ? "email" : format === "url" ? "url" : "text"}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          required={block.required}
          placeholder={block.placeholder ?? ""}
          style={inputStyle}
        />
      );
    }
  }
}

/* ── payload ───────────────────────────────────────────────────────── */

function buildPayload(
  blocks: ApiPublicFormBlock[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const b of blocks) {
    if (b.kind !== "field" || !b.name) continue;
    const raw = values[b.name];
    if (raw === undefined || raw === "" || raw === null) continue;
    if (b.type === "integer" || b.type === "number") {
      const n = Number(raw);
      if (!Number.isNaN(n)) data[b.name] = n;
    } else if (b.type === "boolean") {
      data[b.name] = raw === true;
    } else if (b.type === "json") {
      if (Array.isArray(raw) && raw.length > 0) data[b.name] = raw;
    } else if (b.type === "file") {
      if (isFileValue(raw)) data[b.name] = raw.ticket;
    } else if (b.type === "timestamp" && typeof raw === "string") {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) data[b.name] = d.toISOString();
    } else {
      data[b.name] = raw;
    }
  }
  return data;
}

/** Does a show-condition pass for the current answers? */
const condPasses = (
  cond: ApiPublicFormBlock["cond"],
  values: Record<string, unknown>,
): boolean => {
  if (!cond) return true;
  const v = values[cond.field];
  const match = String(v ?? "") === cond.value;
  return cond.op === "is_not" ? !match : match;
};

/* ── page ──────────────────────────────────────────────────────────── */

export function PublicForm({ embed = false }: { embed?: boolean }) {
  const { token } = useParams<{ token: string }>();
  const [params, setParams] = useSearchParams();
  const { t } = useLingui();
  useFonts();

  // Script-embed support: report our content height to the parent so the
  // loader (/embed/form.js) can auto-size the iframe — no fixed heights.
  useEffect(() => {
    if (!embed || typeof window === "undefined" || window.parent === window) return;
    const report = () => {
      window.parent.postMessage(
        { type: "backlex-form-height", height: document.documentElement.scrollHeight },
        "*",
      );
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [embed]);

  // Language: explicit ?lang= wins; else the browser language when offered.
  const requestedLang =
    params.get("lang") ?? (typeof navigator !== "undefined" ? navigator.language.split("-")[0] : null);

  const query = useQuery({
    queryKey: ["public-form", token, requestedLang],
    queryFn: () => formsPublicApi.get(token ?? "", requestedLang ?? undefined),
    enabled: !!token,
    retry: false,
  });

  const def: ApiPublicForm | null = query.data?.data ?? null;

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [honeypot, setHoneypot] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Split visible blocks into step pages. A `step` block both closes the
  // current page and titles the next one.
  const pages = useMemo(() => {
    if (!def) return [] as { title: string | null; blocks: ApiPublicFormBlock[] }[];
    const visible = def.blocks.filter((b) => condPasses(b.cond, values));
    const out: { title: string | null; blocks: ApiPublicFormBlock[] }[] = [
      { title: null, blocks: [] },
    ];
    for (const b of visible) {
      if (b.kind === "step") out.push({ title: b.label || null, blocks: [] });
      else out[out.length - 1]!.blocks.push(b);
    }
    return out.filter((pg, i) => pg.blocks.length > 0 || i === 0);
  }, [def, values]);

  const pageIdx = Math.min(page, Math.max(0, pages.length - 1));
  const current = pages[pageIdx];
  const isLast = pageIdx === pages.length - 1;

  const p = paletteFor(def?.theme);
  const accent = safeAccent(def?.accent);
  const family = fontStack(def?.font ?? "sans");

  const setValue = useCallback((name: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [name]: v }));
  }, []);

  /** Required-check for the current page only (Next/Submit gate). */
  const pageValid = (blocks: ApiPublicFormBlock[]): string | null => {
    for (const b of blocks) {
      if (b.kind !== "field" || !b.name || !b.required) continue;
      const v = values[b.name];
      if (b.consent) {
        if (v !== true) return t`Please accept "${b.label || humanizeLabel(b.name)}"`;
        continue;
      }
      if (b.type === "json") {
        if (!Array.isArray(v) || v.length === 0)
          return t`Please fill in "${b.label || humanizeLabel(b.name)}"`;
        continue;
      }
      if (b.type === "file") {
        if (!isFileValue(v))
          return t`Please attach a file for "${b.label || humanizeLabel(b.name)}"`;
        continue;
      }
      if (v === undefined || v === null || v === "") {
        return t`Please fill in "${b.label || humanizeLabel(b.name)}"`;
      }
    }
    return null;
  };

  const onNext = () => {
    const missing = pageValid(current?.blocks ?? []);
    if (missing) {
      setError(missing);
      return;
    }
    setError(null);
    setPage(pageIdx + 1);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!def || !token || submitting) return;
    if (!isLast) {
      onNext();
      return;
    }
    const missing = pageValid(current?.blocks ?? []);
    if (missing) {
      setError(missing);
      return;
    }
    if (def.turnstileSiteKey && turnstileToken === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const allVisible = pages.flatMap((pg) => pg.blocks);
      const res = await formsPublicApi.submit(
        token,
        {
          data: buildPayload(allVisible, values),
          ...(turnstileToken ? { turnstileToken } : {}),
          ...(honeypot ? { website: honeypot } : {}),
        },
        def.locale,
      );
      if (res.data.redirectUrl) {
        window.location.assign(res.data.redirectUrl);
        return;
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Submission failed — please try again`);
    } finally {
      setSubmitting(false);
    }
  };

  /* shell + cards share the form's own theme */
  const shellStyle: React.CSSProperties = {
    minHeight: "100svh",
    width: "100%",
    background: p.bg,
    color: p.text,
    fontFamily: family,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: embed ? "14px 12px" : "48px 16px",
    boxSizing: "border-box",
  };
  const cardStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: 620,
    background: p.card,
    border: `1px solid ${p.border}`,
    borderRadius: 16,
    padding: "clamp(20px, 5vw, 36px)",
    boxSizing: "border-box",
  };
  const footer = embed ? null : (
    <p style={{ textAlign: "center", fontSize: 11.5, color: p.faint, marginTop: 16 }}>
      <Trans>Powered by backlex</Trans>
    </p>
  );

  if (query.isLoading) {
    return (
      <div style={shellStyle}>
        <div style={{ width: "100%", maxWidth: 620 }}>
          <div style={cardStyle}>
            {[64, 40, 40, 90, 40].map((h, i) => (
              <div
                key={i}
                style={{
                  height: h,
                  borderRadius: 10,
                  background: p.inputBg,
                  border: `1px solid ${p.border}`,
                  marginBottom: 14,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (query.isError || !def) {
    const gone = (query.error as { status?: number } | null)?.status === 410;
    return (
      <div style={shellStyle}>
        <div style={{ width: "100%", maxWidth: 620 }}>
          <div style={cardStyle}>
            <h1 style={{ fontSize: 19, margin: "0 0 8px", fontWeight: 600 }}>
              {gone ? <Trans>This form is paused</Trans> : <Trans>This form is no longer available</Trans>}
            </h1>
            <p style={{ fontSize: 13.5, color: p.muted, margin: 0 }}>
              {gone ? (
                <Trans>It isn't accepting submissions right now — try again later.</Trans>
              ) : (
                <Trans>The form may have been deactivated, or its link replaced.</Trans>
              )}
            </p>
          </div>
          {footer}
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div style={shellStyle}>
        <div style={{ width: "100%", maxWidth: 620 }}>
          <div style={cardStyle}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: `${accent}22`,
                display: "grid",
                placeItems: "center",
                marginBottom: 14,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <h1 style={{ fontSize: 19, margin: "0 0 8px", fontWeight: 600 }}>
              <Trans>Thank you</Trans>
            </h1>
            <p style={{ fontSize: 13.5, color: p.muted, margin: 0 }}>
              {def.successMessage ?? t`Your submission has been received.`}
            </p>
          </div>
          {footer}
        </div>
      </div>
    );
  }

  const totalSteps = pages.length;
  const canSubmit = !submitting && (!def.turnstileSiteKey || turnstileToken !== null);

  return (
    <div style={shellStyle}>
      <div style={{ width: "100%", maxWidth: 620 }}>
        {def.languages.length > 1 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 10 }}>
            {def.languages.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setParams({ lang: l }, { replace: true })}
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  padding: "3px 9px",
                  borderRadius: 999,
                  cursor: "pointer",
                  border: `1px solid ${def.locale === l ? accent : p.border}`,
                  background: def.locale === l ? `${accent}22` : "transparent",
                  color: def.locale === l ? accent : p.muted,
                }}
              >
                {l}
              </button>
            ))}
          </div>
        )}
        <div style={cardStyle}>
          <h1 style={{ fontSize: "clamp(22px, 5vw, 28px)", margin: 0, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {def.name}
          </h1>
          {def.description && (
            <p style={{ fontSize: 14, color: p.muted, margin: "8px 0 0" }}>{def.description}</p>
          )}
          {totalSteps > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 18 }}>
              {pages.map((_, i) => (
                <span
                  key={i}
                  style={{
                    height: 3,
                    flex: 1,
                    borderRadius: 2,
                    background: i <= pageIdx ? accent : p.border,
                  }}
                />
              ))}
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: p.faint }}>
                {pageIdx + 1}/{totalSteps}
              </span>
            </div>
          )}
          {current?.title && (
            <h2 style={{ fontSize: 16.5, fontWeight: 600, margin: "20px 0 0" }}>{current.title}</h2>
          )}

          <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 22 }}>
            {(current?.blocks ?? []).map((b) =>
              b.consent ? (
                <label
                  key={b.name}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    cursor: "pointer",
                    border: `1px solid ${accent}52`,
                    background: `${accent}0f`,
                    borderRadius: 10,
                    padding: "11px 13px",
                    minWidth: 0,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={values[b.name!] === true}
                    onChange={(e) => b.name && setValue(b.name, e.target.checked)}
                    style={{
                      width: 19,
                      height: 19,
                      marginTop: 1,
                      accentColor: accent,
                      flexShrink: 0,
                      borderRadius: 6,
                    }}
                  />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "flex", alignItems: "baseline", gap: 5, fontSize: 13.5, lineHeight: 1.5 }}>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        {b.label === b.name ? humanizeLabel(b.name ?? "") : b.label}
                      </span>
                      <span style={{ color: accent, fontWeight: 700 }}>*</span>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, fontSize: 11, color: p.muted }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 22s8-3 8-10V5l-8-3-8 3v7c0 7 8 10 8 10z" />
                      </svg>
                      <Trans>must be accepted to submit</Trans>
                      {b.policyUrl && (
                        <>
                          <span>·</span>
                          <a
                            href={b.policyUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: accent, textDecoration: "underline", textUnderlineOffset: 2 }}
                          >
                            <Trans>read the full text</Trans>
                          </a>
                        </>
                      )}
                    </span>
                    {b.help && <span style={{ display: "block", fontSize: 11.5, color: p.faint, marginTop: 4 }}>{b.help}</span>}
                  </span>
                </label>
              ) : b.type === "boolean" ? (
                <div key={b.name} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13.5, lineHeight: 1.5 }}>
                    <input
                      type="checkbox"
                      checked={values[b.name!] === true}
                      onChange={(e) => b.name && setValue(b.name, e.target.checked)}
                      style={{ width: 19, height: 19, accentColor: accent, flexShrink: 0 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      {b.label === b.name ? humanizeLabel(b.name ?? "") : b.label}
                    </span>
                    {b.required && <span style={{ color: accent, fontWeight: 700 }}>*</span>}
                  </label>
                  {b.help && <p style={{ fontSize: 11.5, color: p.faint, margin: 0, paddingLeft: 29 }}>{b.help}</p>}
                </div>
              ) : (
              <div key={b.name} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                <label style={{ fontSize: 13.5, fontWeight: 500 }}>
                  {b.label === b.name ? humanizeLabel(b.name ?? "") : b.label}
                  {b.required && <span style={{ color: accent }}> *</span>}
                </label>
                <BlockInput
                  block={b}
                  token={token ?? ""}
                  value={b.name ? values[b.name] : undefined}
                  onChange={(v) => b.name && setValue(b.name, v)}
                  accent={accent}
                  p={p}
                />
                {b.help && <p style={{ fontSize: 11.5, color: p.faint, margin: 0 }}>{b.help}</p>}
              </div>
              ),
            )}

            {/* Honeypot — humans never see it; bots fill it. */}
            <input
              type="text"
              name="website"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              style={{ position: "absolute", left: -9999, top: "auto", width: 1, height: 1, overflow: "hidden" }}
            />

            {isLast && def.turnstileSiteKey && (
              <TurnstileWidget siteKey={def.turnstileSiteKey} onToken={setTurnstileToken} />
            )}

            {error && (
              <p role="alert" style={{ fontSize: 12.5, color: "#e5484d", margin: 0 }}>
                {error}
              </p>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {pageIdx > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setPage(pageIdx - 1);
                  }}
                  style={{
                    height: 40,
                    padding: "0 16px",
                    borderRadius: 10,
                    border: `1px solid ${p.border}`,
                    background: "transparent",
                    color: p.muted,
                    fontSize: 13.5,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  <Trans>Back</Trans>
                </button>
              )}
              <button
                type="submit"
                disabled={isLast && !canSubmit}
                style={{
                  height: 40,
                  padding: "0 20px",
                  borderRadius: 10,
                  border: 0,
                  background: accent,
                  color: accentInk(accent),
                  fontSize: 13.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  opacity: isLast && !canSubmit ? 0.55 : 1,
                }}
              >
                {!isLast ? (
                  <Trans>Next →</Trans>
                ) : submitting ? (
                  <Trans>Submitting…</Trans>
                ) : (
                  (def.submitLabel ?? t`Submit`)
                )}
              </button>
            </div>
          </form>
        </div>
        {footer}
      </div>
    </div>
  );
}
