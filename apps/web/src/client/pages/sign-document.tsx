// Public, unauthenticated signing page — `/sign/:token`.
//
// The signer has no account and never gets one. The token in the URL is the
// whole grant, so this page talks only to `/api/public/sign/:token`.
//
// Three things here are deliberate rather than stylistic:
//
// - The document renders in a **sandboxed iframe with `srcDoc`**, not in a div.
//   A frozen document is a COMPLETE html document, so injected into a div the
//   browser discards its `<html>`/`<head>` and the signer stops seeing what
//   the renderer saw. And `sandbox=""` grants nothing — the markup is the
//   operator's, not this page's, and it must not run in the signer's session.
// - The consent wording comes down **from the server** and is displayed
//   verbatim. The person being held to the signature does not get to choose
//   what the certificate says they agreed to.
// - The page is self-styled with a `<style>` block rather than the admin
//   design system, exactly like the public form page: nobody signing a
//   contract should be loading the admin bundle's theme, and a fixed
//   light/dark pair here is stable regardless of what the workspace runs.
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { i18n } from "@/admin/i18n";
import { signPublicApi, type ApiSignerView } from "@/admin/api";

const CSS = `
.bxs { --bg:#f4f4f7; --card:#fff; --text:#16151f; --muted:#5f5c72; --line:#e2e0ea;
  --accent:#4c39d4; --accent-fg:#fff; --danger:#b3261e; --pad:#fbfbfd;
  min-height:100dvh; background:var(--bg); color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
@media (prefers-color-scheme: dark){ .bxs{ --bg:#0b0a12; --card:#141222; --text:#eceaf7;
  --muted:#a09bbd; --line:#282343; --accent:#8b7bff; --accent-fg:#100c22; --danger:#ff8a80; --pad:#1b1830; } }
.bxs-wrap{ max-width:840px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
.bxs-card{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; }
.bxs h1{ font-size:20px; margin:0 0 4px; font-weight:650; letter-spacing:-.01em; }
.bxs-sub{ color:var(--muted); font-size:13px; margin:0; }
.bxs-doc{ width:100%; height:min(58dvh,560px); border:1px solid var(--line);
  border-radius:10px; background:#fff; display:block; }
.bxs-row{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.bxs-btn{ appearance:none; border:1px solid var(--line); background:transparent; color:var(--text);
  border-radius:9px; padding:10px 14px; font:inherit; font-weight:550; cursor:pointer; }
.bxs-btn:disabled{ opacity:.5; cursor:not-allowed; }
.bxs-btn-primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxs-btn-danger{ color:var(--danger); border-color:var(--danger); }
.bxs-tabs{ display:inline-flex; border:1px solid var(--line); border-radius:9px; overflow:hidden; }
.bxs-tab{ appearance:none; border:0; background:transparent; color:var(--muted); font:inherit;
  padding:8px 16px; cursor:pointer; }
.bxs-tab[aria-selected="true"]{ background:var(--accent); color:var(--accent-fg); font-weight:600; }
.bxs-pad{ width:100%; height:180px; border:1px dashed var(--line); border-radius:10px;
  background:var(--pad); touch-action:none; display:block; cursor:crosshair; }
.bxs-input{ width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:9px;
  background:var(--pad); color:var(--text); font:inherit; padding:10px 12px; }
.bxs-typed{ font-family:"Segoe Script","Bradley Hand",cursive; font-size:30px; min-height:56px;
  display:flex; align-items:center; padding:0 12px; border:1px dashed var(--line);
  border-radius:10px; background:var(--pad); overflow:hidden; }
.bxs-consent{ display:flex; gap:10px; align-items:flex-start; color:var(--muted); font-size:13px; }
.bxs-consent input{ margin-top:3px; flex:none; width:17px; height:17px; accent-color:var(--accent); }
.bxs-err{ color:var(--danger); font-size:13px; margin:0; }
.bxs-note{ color:var(--muted); font-size:12px; margin:0; word-break:break-all; }
.bxs-badge{ display:inline-block; border:1px solid var(--line); border-radius:999px;
  padding:3px 10px; font-size:12px; color:var(--muted); }
.bxs-skel{ background:var(--line); border-radius:8px; animation:bxs-pulse 1.4s ease-in-out infinite; }
@keyframes bxs-pulse{ 0%,100%{opacity:.55} 50%{opacity:.95} }
@media (max-width:640px){ .bxs{ padding:10px; } .bxs-card{ padding:14px; border-radius:12px; }
  .bxs-row{ justify-content:flex-end; } .bxs-row .bxs-grow{ margin-right:auto; } }
`;

/** Trim the transparent border off the pad so the signature sits on its own
 *  baseline in the document instead of floating in a mostly-empty rectangle. */
const cropSignature = (canvas: HTMLCanvasElement): string | null => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let top = height;
  let left = width;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right < left || bottom < top) return null;
  const pad = 6;
  const w = Math.min(width, right - left + pad * 2);
  const h = Math.min(height, bottom - top + pad * 2);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out
    .getContext("2d")!
    .drawImage(canvas, Math.max(0, left - pad), Math.max(0, top - pad), w, h, 0, 0, w, h);
  return out.toDataURL("image/png");
};

const SignaturePad = ({
  onChange,
  color,
}: {
  onChange: (empty: boolean) => void;
  color: string;
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  // Size the backing store to the device pixel ratio — a canvas sized only in
  // CSS pixels produces a signature that is visibly soft on every phone.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = color;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [color]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <canvas
      ref={ref}
      className="bxs-pad"
      data-testid="signature-pad"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const ctx = e.currentTarget.getContext("2d");
        if (!ctx) return;
        drawing.current = true;
        const p = point(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        // A tap with no drag is still a mark — without this a dot signature
        // leaves the canvas empty.
        ctx.lineTo(p.x + 0.01, p.y);
        ctx.stroke();
        onChange(false);
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return;
        const ctx = e.currentTarget.getContext("2d");
        if (!ctx) return;
        const p = point(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }}
      onPointerUp={() => {
        drawing.current = false;
      }}
      onPointerLeave={() => {
        drawing.current = false;
      }}
    />
  );
};

export const SignDocument = () => {
  const { token = "" } = useParams();
  const { t } = useLingui();
  const [mode, setMode] = useState<"drawn" | "typed">("drawn");
  const [typed, setTyped] = useState("");
  const [consent, setConsent] = useState(false);
  const [padEmpty, setPadEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<"signed" | "declined" | null>(null);
  const padRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError, error: loadError, refetch } = useQuery({
    queryKey: ["public-sign", token, i18n.locale],
    // The locale goes with the request: the consent sentence is the server's,
    // and it should be in the language this page is painting in.
    queryFn: () => signPublicApi.get(token, i18n.locale).then((r) => r.data),
    retry: false,
  });

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  useEffect(() => {
    if (data?.signerName || data?.signerEmail) {
      setTyped((prev) => prev || data.signerName || "");
    }
  }, [data?.signerName, data?.signerEmail]);

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      let image: string | undefined;
      if (mode === "drawn") {
        const canvas = padRef.current?.querySelector("canvas");
        const cropped = canvas ? cropSignature(canvas as HTMLCanvasElement) : null;
        if (!cropped) throw new Error(t`Draw your signature first`);
        image = cropped;
      }
      await signPublicApi.sign(
        token,
        {
          kind: mode,
          ...(image ? { image } : {}),
          ...(mode === "typed" ? { text: typed.trim() } : {}),
          consent,
        },
        i18n.locale,
      );
      setDone("signed");
      await refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [consent, mode, refetch, t, token, typed]);

  const decline = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await signPublicApi.decline(token, reason.trim() || null);
      setDone("declined");
      await refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [reason, refetch, token]);

  if (isLoading) {
    return (
      <div className="bxs">
        <div className="bxs-wrap">
          <div className="bxs-card">
            <div className="bxs-skel" style={{ height: 22, width: "45%" }} />
            <div className="bxs-skel" style={{ height: 13, width: "70%", marginTop: 10 }} />
          </div>
          <div className="bxs-skel" style={{ height: "min(58dvh,560px)", borderRadius: 14 }} />
          <div className="bxs-card">
            <div className="bxs-skel" style={{ height: 180, borderRadius: 10 }} />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bxs">
        <div className="bxs-wrap">
          <div className="bxs-card">
            <h1>
              <Trans>This link is not available</Trans>
            </h1>
            <p className="bxs-sub">{(loadError as Error | null)?.message}</p>
          </div>
        </div>
      </div>
    );
  }

  const view: ApiSignerView = data;
  const signed = done === "signed" || view.signerStatus === "signed";
  const declined = done === "declined" || view.signerStatus === "declined";
  const closed = view.status !== "pending" && !signed;
  const who = view.signerName || view.signerEmail;

  return (
    <div className="bxs">
      <div className="bxs-wrap">
        <div className="bxs-card">
          <h1>{view.title}</h1>
          <p className="bxs-sub">
            <Trans>Signing as {who}</Trans>
            {view.signerRole ? ` · ${view.signerRole}` : ""}
          </p>
          {view.message ? <p style={{ marginTop: 10 }}>{view.message}</p> : null}
          <div className="bxs-row" style={{ marginTop: 12 }}>
            <span className="bxs-badge">
              <Trans>
                {view.signedCount} of {view.signerCount} signed
              </Trans>
            </span>
            <a className="bxs-btn" href={signPublicApi.documentUrl(token)} target="_blank" rel="noreferrer">
              <Trans>Download PDF</Trans>
            </a>
          </div>
        </div>

        {/* sandbox="" — no scripts, no forms, no same-origin. The markup is the
            operator's; it renders, it does not run. */}
        <iframe className="bxs-doc" title={view.title} sandbox="" srcDoc={view.html} />

        {signed ? (
          <div className="bxs-card">
            <h1>
              <Trans>Signed</Trans>
            </h1>
            <p className="bxs-sub">
              {view.status === "completed" ? (
                <Trans>Everyone has signed. A copy has been emailed to you.</Trans>
              ) : (
                <Trans>Your signature is recorded. You will get a copy once everyone has signed.</Trans>
              )}
            </p>
          </div>
        ) : declined ? (
          <div className="bxs-card">
            <h1>
              <Trans>Declined</Trans>
            </h1>
            <p className="bxs-sub">
              <Trans>You declined to sign this document. The sender has been notified.</Trans>
            </p>
          </div>
        ) : closed ? (
          <div className="bxs-card">
            <h1>
              <Trans>This document is no longer open for signature</Trans>
            </h1>
            <p className="bxs-sub">
              {view.status === "expired" ? (
                <Trans>The signing link has expired.</Trans>
              ) : view.status === "voided" ? (
                <Trans>The sender cancelled this request.</Trans>
              ) : view.status === "declined" ? (
                <Trans>Another signer declined it.</Trans>
              ) : (
                <Trans>It has already been completed.</Trans>
              )}
            </p>
          </div>
        ) : !view.yourTurn ? (
          <div className="bxs-card">
            <h1>
              <Trans>Waiting on another signer</Trans>
            </h1>
            <p className="bxs-sub">
              <Trans>You will be emailed as soon as it is your turn to sign.</Trans>
            </p>
          </div>
        ) : (
          <div className="bxs-card">
            <div className="bxs-row" style={{ justifyContent: "space-between" }}>
              <div className="bxs-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  className="bxs-tab"
                  aria-selected={mode === "drawn"}
                  onClick={() => setMode("drawn")}
                >
                  <Trans>Draw</Trans>
                </button>
                <button
                  type="button"
                  role="tab"
                  className="bxs-tab"
                  aria-selected={mode === "typed"}
                  onClick={() => setMode("typed")}
                >
                  {/* `context` splits this from the "Type" that means a field's
                      data type — which is already translated as such, and read
                      as "species" on a signature pad. */}
                  <Trans context="sign with the keyboard">Type</Trans>
                </button>
              </div>
              {mode === "drawn" ? (
                <button
                  type="button"
                  className="bxs-btn"
                  onClick={() => {
                    const canvas = padRef.current?.querySelector("canvas") as HTMLCanvasElement | null;
                    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
                    setPadEmpty(true);
                  }}
                >
                  <Trans>Clear</Trans>
                </button>
              ) : null}
            </div>

            <div ref={padRef} style={{ marginTop: 12 }}>
              {mode === "drawn" ? (
                <SignaturePad onChange={setPadEmpty} color="#16151f" />
              ) : (
                <>
                  <input
                    className="bxs-input"
                    value={typed}
                    maxLength={120}
                    placeholder={t`Your full name`}
                    onChange={(e) => setTyped(e.target.value)}
                    aria-label={t`Your full name`}
                  />
                  <div className="bxs-typed" style={{ marginTop: 10 }}>
                    {typed.trim()}
                  </div>
                </>
              )}
            </div>

            <label className="bxs-consent" style={{ marginTop: 14 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              {/* Server wording, verbatim. */}
              <span>{view.consentText}</span>
            </label>

            {error ? (
              <p className="bxs-err" style={{ marginTop: 10 }}>
                {error}
              </p>
            ) : null}

            <div className="bxs-row" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="bxs-btn bxs-btn-danger bxs-grow"
                disabled={busy}
                onClick={() => setDeclining((v) => !v)}
              >
                <Trans>Decline</Trans>
              </button>
              <button
                type="button"
                className="bxs-btn bxs-btn-primary"
                disabled={busy || !consent || (mode === "drawn" ? padEmpty : typed.trim().length === 0)}
                onClick={submit}
              >
                {busy ? <Trans>Signing…</Trans> : <Trans>Sign document</Trans>}
              </button>
            </div>

            {declining ? (
              <div style={{ marginTop: 14 }}>
                <input
                  className="bxs-input"
                  value={reason}
                  maxLength={500}
                  placeholder={t`Why are you declining? (optional)`}
                  onChange={(e) => setReason(e.target.value)}
                  aria-label={t`Reason for declining`}
                />
                <div className="bxs-row" style={{ marginTop: 10 }}>
                  <button type="button" className="bxs-btn bxs-grow" onClick={() => setDeclining(false)}>
                    <Trans>Keep reviewing</Trans>
                  </button>
                  <button type="button" className="bxs-btn bxs-btn-danger" disabled={busy} onClick={decline}>
                    <Trans>Confirm decline</Trans>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        <p className="bxs-note">
          <Trans>Document fingerprint (SHA-256)</Trans>: {view.documentHash}
        </p>
      </div>
    </div>
  );
};
