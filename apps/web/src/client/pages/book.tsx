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
  --shadow:0 1px 2px rgba(16,15,35,.05), 0 10px 30px -16px rgba(16,15,35,.22);
  min-height:100dvh; background:var(--bg); color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  padding:20px 16px 28px; -webkit-font-smoothing:antialiased; }
@media (prefers-color-scheme: dark){ .bxb{ --bg:#0b0a12; --card:#141222; --text:#eceaf7;
  --muted:#a09bbd; --line:#282343; --accent:#8b7bff; --accent-fg:#100c22; --danger:#ff8a80; --pad:#1b1830;
  --shadow:0 1px 2px rgba(0,0,0,.4); } }
.bxb-wrap{ max-width:560px; margin:0 auto; display:flex; flex-direction:column; gap:12px; }
.bxb-card{ position:relative; background:var(--card); border:1px solid var(--line);
  border-radius:16px; padding:20px; box-shadow:var(--shadow); }

/* The operator's colour is present before anything is touched — one quiet
   3px seam along the top of the first card, and nowhere else. */
.bxb-card-lead{ overflow:hidden; }
.bxb-card-lead::before{ content:""; position:absolute; inset:0 0 auto; height:3px; background:var(--accent); }

.bxb h1{ font-size:23px; margin:0; font-weight:650; letter-spacing:-.022em; line-height:1.2; }
.bxb-sub{ color:var(--muted); font-size:13px; margin:0; }
.bxb-meta{ color:var(--muted); font-size:12.5px; margin:7px 0 0; }

/* eyebrow — the one repeated structural device. Says what KIND of thing the
   rows under it are; never used decoratively. */
.bxb-eyebrow{ font-size:10.5px; font-weight:650; letter-spacing:.1em; text-transform:uppercase;
  color:var(--muted); margin:0 0 9px; }

/* The day rail: only days that HAVE openings, so the first chip is always the
   soonest one. Numerals are the display type — this page is made of numbers. */
.bxb-rail{ display:flex; gap:8px; overflow-x:auto; scroll-snap-type:x mandatory;
  margin:0 -20px; padding:2px 20px 6px; scrollbar-width:none; }
.bxb-rail::-webkit-scrollbar{ display:none; }
.bxb-chip{ scroll-snap-align:start; flex:0 0 auto; min-width:64px; appearance:none; cursor:pointer;
  border:1px solid var(--line); background:var(--pad); color:var(--text); border-radius:13px;
  padding:9px 11px 8px; font:inherit; text-align:center; white-space:nowrap;
  transition:background .12s, border-color .12s; }
.bxb-chip[aria-pressed="true"]{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxb-chip-dow{ display:block; font-size:10px; font-weight:650; letter-spacing:.08em;
  text-transform:uppercase; opacity:.72; }
.bxb-chip-num{ display:block; font-size:21px; font-weight:620; line-height:1.25;
  font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
.bxb-chip-free{ display:block; font-size:10.5px; font-weight:500; opacity:.68;
  font-variant-numeric:tabular-nums; }

.bxb-daytitle{ font-size:15px; font-weight:620; margin:16px 0 12px; letter-spacing:-.01em; }
.bxb-part + .bxb-part{ margin-top:16px; }
.bxb-times{ display:grid; grid-template-columns:repeat(auto-fill,minmax(88px,1fr)); gap:7px; }
.bxb-time{ appearance:none; min-height:44px; border:1px solid var(--line); background:var(--pad);
  color:var(--text); border-radius:11px; padding:9px 6px; font:inherit; font-weight:550;
  font-variant-numeric:tabular-nums; cursor:pointer; text-align:center;
  transition:background .12s, border-color .12s; }
.bxb-time:hover{ border-color:var(--accent); }
.bxb-time small{ display:block; font-weight:400; font-size:10.5px; opacity:.68; }

/* The chosen time, once the grid has been put away. */
.bxb-chosen{ display:flex; align-items:center; gap:12px; border-left:3px solid var(--accent);
  padding-left:12px; margin:0 0 16px; }
.bxb-chosen-when{ font-size:15px; font-weight:620; letter-spacing:-.01em; }

.bxb-btn{ appearance:none; min-height:44px; border:1px solid var(--line); background:transparent;
  color:var(--text); border-radius:11px; padding:10px 16px; font:inherit; font-weight:550;
  cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; }
.bxb-btn:disabled{ opacity:.5; cursor:not-allowed; }
.bxb-btn-primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxb-btn-danger{ color:var(--danger); border-color:var(--danger); }
.bxb-btn-quiet{ border:0; padding:4px 2px; min-height:0; margin-left:auto; color:var(--muted);
  font-size:13px; text-decoration:underline; text-underline-offset:3px; }
.bxb-row{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.bxb-field{ display:flex; flex-direction:column; gap:5px; margin-bottom:13px; }
.bxb-field label{ font-size:13px; font-weight:550; }
.bxb-input{ width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:11px;
  background:var(--pad); color:var(--text); font:inherit; padding:11px 12px; }
.bxb-input:focus{ outline:none; border-color:var(--accent); }
textarea.bxb-input{ resize:vertical; min-height:78px; }
.bxb-err{ color:var(--danger); font-size:13px; margin:0 0 10px; }
.bxb-note{ color:var(--muted); font-size:12px; margin:0; }
.bxb-ok{ font-size:17px; font-weight:620; margin:0 0 6px; letter-spacing:-.015em; }
.bxb-skel{ background:linear-gradient(90deg,var(--line) 25%,var(--pad) 37%,var(--line) 63%);
  background-size:400% 100%; animation:bxb-sh 1.4s ease infinite; border-radius:11px; }
@keyframes bxb-sh{ 0%{background-position:100% 50%} 100%{background-position:0 50%} }

.bxb :focus-visible{ outline:2px solid var(--accent); outline-offset:2px; border-radius:11px; }
@media (prefers-reduced-motion: reduce){
  .bxb *,.bxb *::before{ animation-duration:.01ms !important; animation-iteration-count:1 !important;
    transition-duration:.01ms !important; }
}
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
    // The stylesheet drops the card shadow under a dark colour scheme, where
    // it only muddies the edge. A forced theme has to carry its own, or a
    // light page on a dark-preferring visitor's screen loses its lift.
    vars["--shadow"] =
      s.theme === "light"
        ? "0 1px 2px rgba(16,15,35,.05), 0 10px 30px -16px rgba(16,15,35,.22)"
        : "0 1px 2px rgba(0,0,0,.4)";
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

/**
 * The hour of a slot in the RESOURCE's zone, for grouping by part of day.
 *
 * `en-GB` with `hour12:false` is used only because it formats as `00`–`23`,
 * which parses; the string is never shown.
 */
const hourInZone = (iso: string, timeZone: string): number => {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(
      new Date(iso),
    );
    return Number(h) % 24;
  } catch {
    return new Date(iso).getUTCHours();
  }
};

/**
 * Morning / afternoon / evening.
 *
 * People ask for appointments this way — "can you do a morning?" — long before
 * they have a time in mind, so it is the grouping the list is cut on. The
 * boundaries are the plain-English ones rather than anything the resource
 * configures: a clinic's idea of "afternoon" is not the visitor's.
 */
const partOfDay = (hour: number): "morning" | "afternoon" | "evening" =>
  hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

const PART_ORDER = ["morning", "afternoon", "evening"] as const;

function Skeleton() {
  return (
    <>
      <div className="bxb-card bxb-card-lead">
        <div className="bxb-skel" style={{ height: 23, width: "52%", marginBottom: 9 }} />
        <div className="bxb-skel" style={{ height: 12, width: "38%" }} />
      </div>
      <div className="bxb-card">
        <div className="bxb-skel" style={{ height: 10, width: 74, marginBottom: 11 }} />
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bxb-skel" style={{ height: 66, width: 64, flex: "0 0 auto" }} />
          ))}
        </div>
        <div className="bxb-skel" style={{ height: 15, width: "44%", marginBottom: 13 }} />
        <div className="bxb-times">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bxb-skel" style={{ height: 44 }} />
          ))}
        </div>
      </div>
    </>
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

  /**
   * Which day is open, as a day KEY rather than an index.
   *
   * An index would silently point at a different day whenever the grid
   * reloads — which it does every time a slot is taken from under someone.
   * Falling back to the first available day means "the soonest", which is
   * what a visitor arriving on the page wants offered first.
   */
  const [openDay, setOpenDay] = useState<string | null>(null);
  const activeDay = days.find(([key]) => key === openDay) ?? days[0] ?? null;

  /** Today and tomorrow in the RESOURCE's zone — "Today" has to mean the
   *  clinic's today, since every time on the page is in the clinic's clock. */
  const [todayKey, tomorrowKey] = useMemo(() => {
    const now = Date.now();
    return [dayKey(new Date(now).toISOString(), zone), dayKey(new Date(now + 86_400_000).toISOString(), zone)];
  }, [zone]);

  /** The active day's times, cut into morning / afternoon / evening. */
  const parts = useMemo(() => {
    const slots = activeDay?.[1] ?? [];
    return PART_ORDER.map((part) => ({
      part,
      slots: slots.filter((s) => partOfDay(hourInZone(s.start, zone)) === part),
    })).filter((g) => g.slots.length > 0);
  }, [activeDay, zone]);

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
          <div className="bxb-card bxb-card-lead">
            <p className="bxb-eyebrow">
              <Trans>Confirmed</Trans>
            </p>
            <p className="bxb-ok">
              <Trans>You are booked in.</Trans>
            </p>
            <p className="bxb-sub">
              {fmt(done.start, zone, { dateStyle: "full", timeStyle: "short" })}
              {zonesDiffer ? ` (${zone})` : ""}
            </p>
            {data.resource.confirmationMessage && (
              <p className="bxb-sub" style={{ marginTop: 12 }}>
                {data.resource.confirmationMessage}
              </p>
            )}
            <p className="bxb-note" style={{ marginTop: 16 }}>
              {done.emailed ? (
                <Trans>A confirmation is on its way, with a calendar invite attached.</Trans>
              ) : (
                <Trans>Keep this link — it is how you change or cancel this booking.</Trans>
              )}
            </p>
            <p className="bxb-row" style={{ marginTop: 12 }}>
              <a className="bxb-btn" href={done.manageUrl}>
                <Trans>Change or cancel</Trans>
              </a>
            </p>
          </div>
        ) : (
          <>
            <div className="bxb-card bxb-card-lead">
              <h1>{data.resource.name}</h1>
              {data.resource.description && (
                <p className="bxb-sub" style={{ marginTop: 6 }}>
                  {data.resource.description}
                </p>
              )}
              <p className="bxb-meta">
                <Trans>{data.resource.slotMinutes}-minute appointments</Trans>
                {zonesDiffer ? (
                  <>
                    {" · "}
                    <Trans>times in {zone}, not your {visitorZone}</Trans>
                  </>
                ) : null}
              </p>
            </div>

            {/* Two questions, asked one at a time: which day, then which time.
                Both at once is what a wall of identical buttons looks like. */}
            {!picked && (
              <div className="bxb-card">
                {days.length === 0 || !activeDay ? (
                  <>
                    <p className="bxb-eyebrow">
                      <Trans>Availability</Trans>
                    </p>
                    <p className="bxb-sub">
                      <Trans>No open times in the next two weeks.</Trans>
                    </p>
                  </>
                ) : (
                  <>
                    <p className="bxb-eyebrow">
                      <Trans>Pick a day</Trans>
                    </p>
                    <div className="bxb-rail" role="tablist">
                      {days.map(([key, slots]) => {
                        const first = slots[0]!.start;
                        const on = key === activeDay[0];
                        return (
                          <button
                            key={key}
                            type="button"
                            role="tab"
                            className="bxb-chip"
                            aria-pressed={on}
                            aria-selected={on}
                            onClick={() => setOpenDay(key)}
                          >
                            <span className="bxb-chip-dow">
                              {key === todayKey
                                ? t`Today`
                                : key === tomorrowKey
                                  ? t`Tomorrow`
                                  : fmt(first, zone, { weekday: "short" })}
                            </span>
                            <span className="bxb-chip-num">
                              {fmt(first, zone, { day: "numeric" })}
                            </span>
                            <span className="bxb-chip-free">
                              <Trans>{slots.length} free</Trans>
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="bxb-daytitle">
                      {fmt(activeDay[1][0]!.start, zone, {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })}
                    </div>

                    {parts.map(({ part, slots }) => (
                      <div key={part} className="bxb-part">
                        <p className="bxb-eyebrow">
                          {part === "morning" ? (
                            <Trans>Morning</Trans>
                          ) : part === "afternoon" ? (
                            <Trans>Afternoon</Trans>
                          ) : (
                            <Trans>Evening</Trans>
                          )}
                        </p>
                        <div className="bxb-times">
                          {slots.map((s) => (
                            <button
                              key={s.start}
                              type="button"
                              className="bxb-time"
                              onClick={() => setPicked(s)}
                            >
                              {fmt(s.start, zone, { hour: "numeric", minute: "2-digit" })}
                              {data.resource.capacity > 1 && (
                                <small>
                                  <Trans>{s.remaining} left</Trans>
                                </small>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {picked && (
              <div className="bxb-card">
                {/* The grid is put away once a time is chosen — the third step
                    is filling this in, and a phone should not have to scroll
                    past everything it has already answered. */}
                <div className="bxb-chosen">
                  <div>
                    <p className="bxb-eyebrow" style={{ margin: "0 0 2px" }}>
                      <Trans>Your appointment</Trans>
                    </p>
                    <div className="bxb-chosen-when">
                      {fmt(picked.start, zone, { dateStyle: "long", timeStyle: "short" })}
                    </div>
                  </div>
                  <button type="button" className="bxb-btn bxb-btn-quiet" onClick={() => setPicked(null)}>
                    <Trans>Change</Trans>
                  </button>
                </div>

                <p className="bxb-eyebrow">
                  <Trans>Your details</Trans>
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

                <button
                  type="button"
                  className="bxb-btn bxb-btn-primary"
                  style={{ width: "100%", marginTop: 4 }}
                  disabled={busy}
                  onClick={() => void onBook()}
                >
                  {busy ? <Trans>Booking…</Trans> : <Trans>Confirm booking</Trans>}
                </button>
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
          <div className="bxb-card bxb-card-lead">
            <p className="bxb-eyebrow">
              {view.status === "cancelled" ? (
                <Trans>Cancelled</Trans>
              ) : view.status === "completed" ? (
                <Trans>Past</Trans>
              ) : (
                <Trans>Confirmed</Trans>
              )}
            </p>
            <h1>{view.resource.name}</h1>
            <div className="bxb-chosen" style={{ margin: "16px 0" }}>
              <div>
                <p className="bxb-eyebrow" style={{ margin: "0 0 2px" }}>
                  <Trans>Your appointment</Trans>
                </p>
                <div className="bxb-chosen-when">
                  {fmt(view.start, zone, { dateStyle: "long", timeStyle: "short" })}
                </div>
                <p className="bxb-note" style={{ marginTop: 3 }}>{zone}</p>
              </div>
            </div>
            <p className="bxb-sub">
              {view.status === "cancelled" ? (
                <Trans>This booking was cancelled.</Trans>
              ) : view.status === "completed" ? (
                <Trans>This appointment has already happened.</Trans>
              ) : (
                <Trans>You are booked in.</Trans>
              )}
            </p>
            {error && <p className="bxb-err" style={{ marginTop: 12 }}>{error}</p>}
            {view.canCancel && (
              <div className="bxb-row" style={{ marginTop: 16 }}>
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
