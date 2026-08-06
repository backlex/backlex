// Public, unauthenticated booking page — `/book/:token`.
//
// The booker has no account and never gets one. The token in the URL is the
// whole grant, so this page talks only to `/api/public/book/:token`.
//
// Three things here are deliberate rather than stylistic:
//
// - **Slots are grouped by the RESOURCE's local day, not the visitor's.** The
//   API returns instants; which day they fall on depends on whose clock you
//   ask. A clinic in Istanbul publishing 09:00 must not appear under "the
//   previous day" to somebody in London, so every heading and every time is
//   formatted in `resource.timeZone` and the visitor's own zone is named
//   underneath when the two differ — rather than silently swapped for it.
// - **The grid is the offer.** The page never lets somebody type a time; it
//   only ever posts one of the instants the server just handed it. The server
//   re-checks anyway, but a UI that invites an unbookable time is a UI that
//   spends its day showing errors.
// - The page is self-styled with a `<style>` block rather than the admin
//   design system, exactly like the public form and signing pages: nobody
//   booking a haircut should be loading the admin bundle's theme, and a fixed
//   light/dark pair here is stable regardless of what the workspace runs.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useParams } from "react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  bookPublicApi,
  type ApiBookingQuestion,
  type ApiBookingSlot,
  type ApiPublicSlots,
} from "@/admin/api";
import {
  accentInk,
  fontStack,
  paletteFor,
  safeAccent,
  useFonts,
  type PublicAppearance,
} from "@/lib/public-theme";

const CSS = `
.bxb { --bg:#f4f4f7; --card:#fff; --text:#16151f; --muted:#5f5c72; --line:#e2e0ea;
  --accent:#4c39d4; --accent-fg:#fff; --danger:#b3261e; --pad:#fbfbfd;
  min-height:100dvh; background:var(--bg); color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
@media (prefers-color-scheme: dark){ .bxb{ --bg:#0b0a12; --card:#141222; --text:#eceaf7;
  --muted:#a09bbd; --line:#282343; --accent:#8b7bff; --accent-fg:#100c22; --danger:#ff8a80; --pad:#1b1830; } }
.bxb-wrap{ max-width:680px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
.bxb-card{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; }
.bxb h1{ font-size:20px; margin:0 0 4px; font-weight:650; letter-spacing:-.01em; }
.bxb-sub{ color:var(--muted); font-size:13px; margin:0; }
.bxb-day{ font-size:13px; font-weight:650; margin:14px 0 8px; }
.bxb-day:first-child{ margin-top:0; }
.bxb-slots{ display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:8px; }
.bxb-slot{ appearance:none; border:1px solid var(--line); background:var(--pad); color:var(--text);
  border-radius:9px; padding:10px 6px; font:inherit; font-weight:550; cursor:pointer; text-align:center; }
.bxb-slot[aria-pressed="true"]{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxb-slot small{ display:block; font-weight:400; font-size:11px; opacity:.75; }
.bxb-btn{ appearance:none; border:1px solid var(--line); background:transparent; color:var(--text);
  border-radius:9px; padding:10px 14px; font:inherit; font-weight:550; cursor:pointer; }
.bxb-btn:disabled{ opacity:.5; cursor:not-allowed; }
.bxb-btn-primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxb-btn-danger{ color:var(--danger); border-color:var(--danger); }
.bxb-row{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.bxb-field{ display:flex; flex-direction:column; gap:5px; margin-bottom:12px; }
.bxb-field label{ font-size:13px; font-weight:550; }
.bxb-input{ width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:9px;
  background:var(--pad); color:var(--text); font:inherit; padding:10px 12px; }
textarea.bxb-input{ resize:vertical; min-height:78px; }
.bxb-err{ color:var(--danger); font-size:13px; margin:0; }
.bxb-note{ color:var(--muted); font-size:12px; margin:0; }
.bxb-ok{ font-size:15px; font-weight:600; margin:0 0 6px; }
.bxb-skel{ background:linear-gradient(90deg,var(--line) 25%,var(--pad) 37%,var(--line) 63%);
  background-size:400% 100%; animation:bxb-sh 1.4s ease infinite; border-radius:9px; }
@keyframes bxb-sh{ 0%{background-position:100% 50%} 100%{background-position:0 50%} }
`;

/**
 * Mount the page's stylesheet, the same way the signing page does — appended
 * to `document.head` and removed on unmount, rather than rendered as an inline
 * `<style>` element. Both public pages are outside the admin shell and each
 * owns its own theme.
 */
const usePageStyles = () => {
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
};

/** A fortnight is what the server defaults to; asking for the same window
 *  explicitly keeps the "next two weeks" wording honest. */
const WINDOW_DAYS = 14;

const fmt = (iso: string, timeZone: string, opts: Intl.DateTimeFormatOptions): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, ...opts }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
};

/**
 * Which local day a slot belongs to, in the RESOURCE's zone.
 *
 * `en-CA` is used only because it formats as `YYYY-MM-DD`, which sorts —
 * the string is a grouping key, never shown.
 */
const dayKey = (iso: string, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
};

const groupByDay = (slots: ApiBookingSlot[], timeZone: string): Array<[string, ApiBookingSlot[]]> => {
  const map = new Map<string, ApiBookingSlot[]>();
  for (const s of slots) {
    const key = dayKey(s.start, timeZone);
    const bucket = map.get(key);
    if (bucket) bucket.push(s);
    else map.set(key, [s]);
  }
  return [...map.entries()];
};

/**
 * The resource's appearance, as CSS variables the page's own stylesheet
 * already reads.
 *
 * Only what was actually chosen is written. A resource with no settings keeps
 * the stylesheet's system light/dark pair — the page has always followed the
 * visitor's own preference, and gaining an appearance panel must not silently
 * pin every existing calendar to one theme. Choosing only an accent likewise
 * leaves the light/dark following the visitor.
 *
 * The values come from the shared public-page palette, so this calendar and a
 * form published by the same workspace agree about what "light" is.
 */
const appearanceVars = (s: PublicAppearance | null | undefined): Record<string, string> => {
  if (!s) return {};
  const vars: Record<string, string> = {};
  if (s.theme) {
    const p = paletteFor(s.theme);
    vars["--bg"] = p.bg;
    vars["--card"] = p.card;
    vars["--text"] = p.text;
    vars["--muted"] = p.muted;
    vars["--line"] = p.border;
    vars["--pad"] = p.inputBg;
    vars["--danger"] = s.theme === "light" ? "#b3261e" : "#ff8a80";
  }
  if (s.accent) {
    const accent = safeAccent(s.accent);
    vars["--accent"] = accent;
    vars["--accent-fg"] = accentInk(accent);
  }
  if (s.font) vars.fontFamily = fontStack(s.font);
  return vars;
};

/**
 * What a question is actually rendered as.
 *
 * The stored `type` is advisory and the options are decisive: a question
 * carrying options is a choice whatever it calls itself, and a `select` with
 * none would draw an empty dropdown nobody can answer, so it falls back to
 * free text. Anything unrecognised is text too — a resource written by an
 * older client, or by hand, must not lose the question entirely.
 */
const questionType = (q: ApiBookingQuestion): "text" | "textarea" | "select" | "boolean" => {
  if (Array.isArray(q.options) && q.options.length > 0) return "select";
  const raw = String(q.type ?? "text");
  return raw === "textarea" || raw === "boolean" ? raw : "text";
};

function Skeleton() {
  return (
    <div className="bxb-card">
      <div className="bxb-skel" style={{ height: 20, width: "45%", marginBottom: 10 }} />
      <div className="bxb-skel" style={{ height: 13, width: "70%", marginBottom: 18 }} />
      <div className="bxb-slots">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bxb-skel" style={{ height: 42 }} />
        ))}
      </div>
    </div>
  );
}

export function Book() {
  const { token = "" } = useParams();
  const { t } = useLingui();
  usePageStyles();

  const [data, setData] = useState<ApiPublicSlots | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ApiBookingSlot | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ start: string; manageUrl: string; emailed: boolean } | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  /** Humans never see the field this comes from; bots fill every input. A
   *  filled value makes the server answer exactly as it would have. */
  const [honeypot, setHoneypot] = useState("");

  const load = async () => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + WINDOW_DAYS * 86_400_000).toISOString();
    const res = await bookPublicApi.slots(token, { from, to });
    setData(res.data);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const from = new Date().toISOString();
        const to = new Date(Date.now() + WINDOW_DAYS * 86_400_000).toISOString();
        const res = await bookPublicApi.slots(token, { from, to });
        if (!cancelled) setData(res.data);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const zone = data?.resource.timeZone ?? "UTC";
  const days = useMemo(() => groupByDay(data?.slots ?? [], zone), [data, zone]);

  const look = data?.resource.settings ?? null;
  const style = useMemo(() => appearanceVars(look), [look]);
  // Only fetch the webfonts a chosen face actually needs. A calendar that
  // never picked one should not cost its visitors a stylesheet request.
  useFonts(Boolean(look?.font) && look?.font !== "system");

  /** Named only when it differs from the resource's, because that is the only
   *  time it can mislead. */
  const visitorZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zonesDiffer = Boolean(data) && visitorZone !== zone;

  const onBook = async () => {
    if (!picked) return;
    for (const q of data?.resource.questions ?? []) {
      if (q.required === true && !String(answers[String(q.name)] ?? "").trim()) {
        setError(t`Please answer "${String(q.label ?? q.name)}".`);
        return;
      }
    }
    // A yes/no leaves here as a real boolean rather than the string "true":
    // the answer may be mirrored into a collection column, and a boolean
    // column refuses text. Only the resource's own questions are sent — the
    // server drops the rest anyway, and there is no reason to post them.
    const payload: Record<string, unknown> = {};
    for (const q of data?.resource.questions ?? []) {
      const key = String(q.name ?? "");
      const raw = answers[key];
      if (!key || raw === undefined || raw === "") continue;
      payload[key] = questionType(q) === "boolean" ? raw === "true" : raw;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await bookPublicApi.book(token, {
        start: picked.start,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(Object.keys(payload).length > 0 ? { answers: payload } : {}),
        ...(honeypot ? { website: honeypot } : {}),
      });
      setDone({
        start: res.data.booking.start,
        manageUrl: res.data.manageUrl,
        emailed: res.data.emailed,
      });
    } catch (e) {
      setError((e as Error).message);
      // Somebody else may have taken it while this form was being filled in,
      // so the grid is refreshed rather than left showing a slot that is gone.
      setPicked(null);
      void load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bxb" style={style as CSSProperties}>
      <div className="bxb-wrap">
        {!loaded ? (
          <Skeleton />
        ) : !data ? (
          <div className="bxb-card">
            <h1>
              <Trans>This booking link is not valid</Trans>
            </h1>
            <p className="bxb-sub">
              <Trans>It may have been replaced, or the calendar may be closed.</Trans>
            </p>
          </div>
        ) : done ? (
          <div className="bxb-card">
            <p className="bxb-ok">
              <Trans>You are booked in.</Trans>
            </p>
            <p className="bxb-sub">
              {fmt(done.start, zone, { dateStyle: "full", timeStyle: "short" })}
              {zonesDiffer ? ` (${zone})` : ""}
            </p>
            {data.resource.confirmationMessage && (
              <p className="bxb-sub" style={{ marginTop: 10 }}>
                {data.resource.confirmationMessage}
              </p>
            )}
            <p className="bxb-note" style={{ marginTop: 14 }}>
              {done.emailed ? (
                <Trans>A confirmation is on its way, with a calendar invite attached.</Trans>
              ) : (
                <Trans>Keep this link — it is how you change or cancel this booking.</Trans>
              )}
            </p>
            <p className="bxb-row" style={{ marginTop: 10 }}>
              <a className="bxb-btn" href={done.manageUrl}>
                <Trans>Change or cancel</Trans>
              </a>
            </p>
          </div>
        ) : (
          <>
            <div className="bxb-card">
              <h1>{data.resource.name}</h1>
              {data.resource.description && <p className="bxb-sub">{data.resource.description}</p>}
              <p className="bxb-sub" style={{ marginTop: 6 }}>
                <Trans>{data.resource.slotMinutes} minutes</Trans>
                {zonesDiffer ? (
                  <>
                    {" · "}
                    <Trans>Times shown in {zone}, not your {visitorZone}</Trans>
                  </>
                ) : null}
              </p>
            </div>

            <div className="bxb-card">
              {days.length === 0 ? (
                <p className="bxb-sub">
                  <Trans>Nothing is free in the next two weeks.</Trans>
                </p>
              ) : (
                days.map(([key, slots]) => (
                  <div key={key}>
                    <div className="bxb-day">
                      {fmt(slots[0]!.start, zone, { weekday: "long", day: "numeric", month: "long" })}
                    </div>
                    <div className="bxb-slots">
                      {slots.map((s) => (
                        <button
                          key={s.start}
                          type="button"
                          className="bxb-slot"
                          aria-pressed={picked?.start === s.start}
                          onClick={() => setPicked(s)}
                        >
                          {fmt(s.start, zone, { hour: "2-digit", minute: "2-digit" })}
                          {data.resource.capacity > 1 && (
                            <small>
                              <Trans>{s.remaining} left</Trans>
                            </small>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {picked && (
              <div className="bxb-card">
                <p className="bxb-ok">
                  {fmt(picked.start, zone, { dateStyle: "full", timeStyle: "short" })}
                </p>
                <p className="bxb-sub" style={{ marginBottom: 14 }}>
                  <Trans>Tell them who is coming.</Trans>
                </p>

                <div className="bxb-field">
                  <label htmlFor="bxb-name">
                    <Trans>Name</Trans>
                  </label>
                  <input
                    id="bxb-name"
                    className="bxb-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                  />
                </div>
                <div className="bxb-field">
                  <label htmlFor="bxb-email">
                    <Trans>Email</Trans>
                  </label>
                  <input
                    id="bxb-email"
                    className="bxb-input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                  <p className="bxb-note">
                    <Trans>Where the confirmation and the cancel link go.</Trans>
                  </p>
                </div>
                <div className="bxb-field">
                  <label htmlFor="bxb-phone">
                    <Trans>Phone</Trans>
                  </label>
                  <input
                    id="bxb-phone"
                    className="bxb-input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                  />
                </div>

                {(data.resource.questions ?? []).map((q) => {
                  const key = String(q.name ?? "");
                  const label = String(q.label ?? key);
                  const kind = questionType(q);
                  const options = Array.isArray(q.options) ? (q.options as unknown[]).map(String) : [];
                  const value = answers[key] ?? "";
                  const set = (v: string) => setAnswers({ ...answers, [key]: v });
                  return (
                    <div key={key} className="bxb-field">
                      <label htmlFor={`bxb-q-${key}`}>
                        {label}
                        {q.required === true ? " *" : ""}
                      </label>
                      {kind === "select" ? (
                        <select
                          id={`bxb-q-${key}`}
                          className="bxb-input"
                          value={value}
                          onChange={(e) => set(e.target.value)}
                        >
                          <option value="">{t`Choose…`}</option>
                          {options.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : kind === "boolean" ? (
                        // A dropdown rather than a checkbox, so that "required"
                        // keeps meaning "must be answered". An unticked box is
                        // indistinguishable from an untouched one, which would
                        // make a required yes/no impossible to enforce.
                        <select
                          id={`bxb-q-${key}`}
                          className="bxb-input"
                          value={value}
                          onChange={(e) => set(e.target.value)}
                        >
                          <option value="">{t`Choose…`}</option>
                          <option value="true">{t`Yes`}</option>
                          <option value="false">{t`No`}</option>
                        </select>
                      ) : kind === "textarea" ? (
                        <textarea
                          id={`bxb-q-${key}`}
                          className="bxb-input"
                          rows={3}
                          value={value}
                          onChange={(e) => set(e.target.value)}
                        />
                      ) : (
                        <input
                          id={`bxb-q-${key}`}
                          className="bxb-input"
                          value={value}
                          onChange={(e) => set(e.target.value)}
                        />
                      )}
                    </div>
                  );
                })}

                {/* Honeypot — off-screen rather than `display:none`, which the
                    better bots skip. Humans never reach it: no tab stop, no
                    label, hidden from the accessibility tree. */}
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

                {error && <p className="bxb-err">{error}</p>}

                <div className="bxb-row" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="bxb-btn bxb-btn-primary"
                    disabled={busy}
                    onClick={() => void onBook()}
                  >
                    {busy ? <Trans>Booking…</Trans> : <Trans>Confirm booking</Trans>}
                  </button>
                  <button type="button" className="bxb-btn" onClick={() => setPicked(null)}>
                    <Trans>Pick another time</Trans>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The booker's own page for one appointment — `/booking/:token`.
 *
 * Reached from the confirmation email. A cancelled or past booking still
 * resolves here, so the page can say what happened rather than look broken;
 * `canCancel` is what decides whether it can still be acted on.
 */
export function ManageBooking() {
  const { token = "" } = useParams();
  usePageStyles();
  const [view, setView] = useState<Awaited<ReturnType<typeof bookPublicApi.get>>["data"] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await bookPublicApi.get(token);
        if (!cancelled) setView(res.data);
      } catch {
        // Falls through to the "not valid" card — an unknown, a cancelled and
        // a replaced token all look the same on purpose.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onCancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await bookPublicApi.cancel(token);
      setView(res.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const zone = view?.resource.timeZone ?? "UTC";

  const look = view?.resource.settings ?? null;
  const style = useMemo(() => appearanceVars(look), [look]);
  useFonts(Boolean(look?.font) && look?.font !== "system");

  return (
    <div className="bxb" style={style as CSSProperties}>
      <div className="bxb-wrap">
        {!loaded ? (
          <Skeleton />
        ) : !view ? (
          <div className="bxb-card">
            <h1>
              <Trans>This booking link is not valid</Trans>
            </h1>
            <p className="bxb-sub">
              <Trans>It may have been replaced by a newer one.</Trans>
            </p>
          </div>
        ) : (
          <div className="bxb-card">
            <h1>{view.resource.name}</h1>
            <p className="bxb-sub">
              {fmt(view.start, zone, { dateStyle: "full", timeStyle: "short" })} ({zone})
            </p>
            <p className="bxb-sub" style={{ marginTop: 10 }}>
              {view.status === "cancelled" ? (
                <Trans>This booking was cancelled.</Trans>
              ) : view.status === "completed" ? (
                <Trans>This appointment has already happened.</Trans>
              ) : (
                <Trans>You are booked in.</Trans>
              )}
            </p>
            {error && <p className="bxb-err">{error}</p>}
            {view.canCancel && (
              <div className="bxb-row" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="bxb-btn bxb-btn-danger"
                  disabled={busy}
                  onClick={() => void onCancel()}
                >
                  {busy ? <Trans>Cancelling…</Trans> : <Trans>Cancel this booking</Trans>}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
