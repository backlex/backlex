// Public, unauthenticated booking page — `/book/:token`.
//
// The booker has no account and never gets one. The token in the URL is the
// whole grant, so this page talks only to `/api/public/book/:token`.
//
// Four things here are deliberate rather than stylistic:
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
// - The page is self-styled rather than dressed in the admin design system,
//   exactly like the public form and signing pages: nobody booking a haircut
//   should be loading the admin bundle's theme.
// - **It is the same page as the public form.** A workspace that publishes a
//   form and a calendar publishes two pages a stranger reads back to back, so
//   the frame, the palette, the type scale, the controls, the progress bar,
//   the success mark and the footer are the form's — read from
//   `@/lib/public-theme` rather than restated. What differs here is only what
//   is genuinely different: a day rail and a grid of times. The stylesheet
//   below exists for the things inline styles cannot express (a scroll
//   snapport, `:hover`, `prefers-color-scheme`), not for a second look.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useParams } from "react-router";
import { useDocumentLang, useDocumentTitle } from "./use-document-title";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  bookPublicApi,
  type ApiBookingQuestion,
  type ApiBookingSlot,
  type ApiPublicSlots,
} from "@/admin/api";
import {
  accentInk,
  DARK,
  DEFAULT_ACCENT,
  fontStack,
  LIGHT,
  paletteFor,
  safeAccent,
  useFonts,
  type Palette,
  type PublicAppearance,
} from "@/lib/public-theme";

/** The palette, as the custom properties the stylesheet below reads. Written
 *  once here so the `prefers-color-scheme` defaults and a resource that picked
 *  a theme cannot drift apart — and so this page and a form published by the
 *  same workspace agree about what "light" is down to the border alpha. */
const vars = (p: Palette): string => `--bg:${p.bg}; --card:${p.card}; --text:${p.text};
  --muted:${p.muted}; --faint:${p.faint}; --line:${p.border}; --pad:${p.inputBg};`;

const CSS = `
.bxb { ${vars(DARK)}
  --accent:${DEFAULT_ACCENT}; --accent-fg:${accentInk(DEFAULT_ACCENT)}; --danger:#e5484d;
  /* One number the card's padding and everything that bleeds through it both
     read, so a rail can reach the card edge at any width. */
  --cardpad:clamp(20px, 5vw, 36px);
  min-height:100svh; background:var(--bg); color:var(--text);
  font-family:${fontStack("sans")}; font-size:14px; line-height:1.55;
  display:flex; justify-content:center; align-items:flex-start;
  padding:48px 16px; box-sizing:border-box; -webkit-font-smoothing:antialiased; }
@media (prefers-color-scheme: light){ .bxb{ ${vars(LIGHT)} } }
.bxb-wrap{ width:100%; max-width:620px; }
.bxb-card{ background:var(--card); border:1px solid var(--line); border-radius:16px;
  padding:var(--cardpad); box-sizing:border-box; }
.bxb-foot{ text-align:center; font-size:11.5px; color:var(--faint); margin:16px 0 0; }

.bxb h1{ font-size:clamp(22px, 5vw, 28px); margin:0; font-weight:600; letter-spacing:-.02em;
  line-height:1.2; }
.bxb h2{ font-size:16.5px; font-weight:600; margin:0 0 12px; }
.bxb-sub{ color:var(--muted); font-size:14px; margin:8px 0 0; }
.bxb-meta{ color:var(--faint); font-size:11.5px; margin:8px 0 0; }

/* Which of the two questions is open — the form's step bar, for the same
   reason: a page that puts one thing in front of you owes you the count. */
.bxb-steps{ display:flex; align-items:center; gap:8px; margin-top:18px; }
.bxb-steps span{ height:3px; flex:1; border-radius:2px; background:var(--line); }
.bxb-steps span[data-on="1"]{ background:var(--accent); }
.bxb-steps b{ font:400 10px 'JetBrains Mono',ui-monospace,monospace; color:var(--faint); }

/* eyebrow — the one device this page adds. Says what KIND of thing the rows
   under it are; never used decoratively. */
.bxb-eyebrow{ font-size:10.5px; font-weight:600; letter-spacing:.1em; text-transform:uppercase;
  color:var(--faint); margin:0 0 9px; }

/* The day rail: only days that HAVE openings, so the first chip is always the
   soonest one. Numerals are the display type — this page is made of numbers. */
/* scroll-padding-inline is load-bearing, not a nicety. A scroll snapport is
   the PADDING box, so scroll-snap-align:start lines a chip up with the
   container's BORDER edge — and mandatory snapping happens on load, not only
   on scroll. Without it the rail silently scrolls itself by its own padding,
   and the first chip sits flush against the card edge while every other line
   on the card is indented. */
.bxb-rail{ display:flex; gap:8px; overflow-x:auto; scroll-snap-type:x mandatory;
  margin-inline:calc(-1 * var(--cardpad)); padding:2px var(--cardpad) 6px;
  scroll-padding-inline:var(--cardpad); scrollbar-width:none; }
/* A chip sliced in half by the card edge reads as a rendering fault rather
   than as "there is more this way", so the last 36px fade — but only while
   there IS more. At a desktop width every day fits, and a fade with nothing
   behind it reads as the last day being greyed out. The data-more attribute is
   measured; see useRailFade. Only the right edge, the only one that cuts. */
.bxb-rail[data-more="1"]{
  -webkit-mask-image:linear-gradient(to right, #000 calc(100% - 36px), transparent);
  mask-image:linear-gradient(to right, #000 calc(100% - 36px), transparent); }
.bxb-rail::-webkit-scrollbar{ display:none; }
.bxb-chip{ scroll-snap-align:start; flex:0 0 auto; min-width:64px; appearance:none; cursor:pointer;
  border:1px solid var(--line); background:var(--pad); color:var(--text); border-radius:10px;
  padding:9px 11px 8px; font:inherit; text-align:center; white-space:nowrap;
  transition:background .12s, border-color .12s; }
.bxb-chip[aria-pressed="true"]{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxb-chip-dow{ display:block; font-size:10px; font-weight:600; letter-spacing:.08em;
  text-transform:uppercase; opacity:.72; }
.bxb-chip-num{ display:block; font-size:21px; font-weight:600; line-height:1.25;
  font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
.bxb-chip-free{ display:block; font-size:10.5px; font-weight:400; opacity:.68;
  font-variant-numeric:tabular-nums; }

.bxb-daytitle{ font-size:14px; font-weight:600; margin:18px 0 14px; letter-spacing:-.01em; }
.bxb-part + .bxb-part{ margin-top:16px; }
.bxb-times{ display:grid; grid-template-columns:repeat(auto-fill,minmax(88px,1fr)); gap:7px; }
.bxb-time{ appearance:none; min-height:44px; border:1px solid var(--line); background:var(--pad);
  color:var(--text); border-radius:10px; padding:9px 6px; font:inherit; font-weight:500;
  font-variant-numeric:tabular-nums; cursor:pointer; text-align:center;
  transition:background .12s, border-color .12s; }
.bxb-time:hover{ border-color:var(--accent); }
.bxb-time small{ display:block; font-weight:400; font-size:10.5px; opacity:.68; }

/* The chosen time, once the grid has been put away. */
.bxb-chosen{ display:flex; align-items:center; gap:12px; border-left:3px solid var(--accent);
  padding-left:12px; margin:0 0 20px; }
.bxb-chosen-when{ font-size:15px; font-weight:600; letter-spacing:-.01em; }

/* The success / dead-end mark, and the same controls the form draws. */
.bxb-mark{ width:40px; height:40px; border-radius:50%; display:grid; place-items:center;
  margin-bottom:14px; background:color-mix(in srgb, var(--accent) 20%, transparent); }
/* Element-qualified so it outranks the bare h1 rule above — a dead link and a
   confirmation are a line of prose, not the name of a calendar. */
.bxb h1.bxb-title-sm{ font-size:19px; margin:0 0 8px; font-weight:600; letter-spacing:-.01em; }

.bxb-btn{ appearance:none; height:40px; border:1px solid var(--line); background:transparent;
  color:var(--muted); border-radius:10px; padding:0 16px; font:inherit; font-size:13.5px;
  cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; }
.bxb-btn:disabled{ opacity:.55; cursor:not-allowed; }
.bxb-btn-primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg);
  padding:0 20px; font-weight:600; }
.bxb-btn-danger{ color:var(--danger); border-color:color-mix(in srgb, var(--danger) 45%, transparent); }
.bxb-btn-quiet{ border:0; padding:4px 2px; height:auto; margin-left:auto; color:var(--muted);
  font-size:11.5px; text-decoration:underline; text-underline-offset:2px; }
.bxb-row{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.bxb-field{ display:flex; flex-direction:column; gap:6px; margin-bottom:18px; min-width:0; }
.bxb-field label{ font-size:13.5px; font-weight:500; }
.bxb-req{ color:var(--accent); }
.bxb-input{ width:100%; box-sizing:border-box; height:40px; border:1px solid var(--line);
  border-radius:10px; background:var(--pad); color:var(--text); font:inherit; font-size:14px;
  padding:0 12px; outline:none; }
.bxb-input:focus{ border-color:var(--accent); }
select.bxb-input{ appearance:auto; }
textarea.bxb-input{ height:auto; resize:vertical; min-height:78px; padding:10px 12px; }
.bxb-err{ color:var(--danger); font-size:12.5px; margin:0 0 14px; }
.bxb-note{ color:var(--faint); font-size:11.5px; margin:0; }
.bxb-skel{ background:linear-gradient(90deg,var(--line) 25%,var(--pad) 37%,var(--line) 63%);
  background-size:400% 100%; animation:bxb-sh 1.4s ease infinite; border-radius:10px; }
@keyframes bxb-sh{ 0%{background-position:100% 50%} 100%{background-position:0 50%} }

.bxb :focus-visible{ outline:2px solid var(--accent); outline-offset:2px; border-radius:10px; }
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

/**
 * Whether the day rail still has days to the right of what is on screen.
 *
 * Overflow is not something CSS can ask about, and the fade that marks it is a
 * claim — "there is more this way" — that has to be false when it is. So it is
 * measured: on mount, on scroll, on resize, and whenever the number of days
 * changes underneath (which it does every time a slot is taken and the grid
 * reloads).
 *
 * Returns a ref callback rather than a ref object because the listeners have to
 * attach the moment the element exists, and the rail is only rendered on one of
 * the two steps.
 */
const useRailFade = (dayCount: number) => {
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!rail) return;
    const sync = () => {
      rail.dataset.more = rail.scrollWidth - rail.clientWidth - rail.scrollLeft > 1 ? "1" : "0";
    };
    sync();
    rail.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(rail);
    return () => {
      rail.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [rail, dayCount]);
  return setRail;
};

/** A fortnight is what the server defaults to; asking for the same window
 *  explicitly keeps the "next two weeks" wording honest. */
const WINDOW_DAYS = 14;

/**
 * A slot's printable date/time, in the RESOURCE's zone and the PAGE's language.
 *
 * `locale` is not optional decoration. This used to pass `undefined`, which
 * means "the JS runtime's default locale" — and in a browser that is the
 * BROWSER UI language, not `navigator.language` and not `Accept-Language`.
 * Lingui boots from `navigator.language`, so the two disagree the moment a
 * visitor asks for one language in a browser whose UI is another, which is an
 * ordinary combination rather than a corner case.
 *
 * Measured on a live booking page on 2026-08-27 with `navigator.language =
 * tr-TR` and the browser UI in English: `Intl.DateTimeFormat().resolvedOptions()
 * .locale` reported `en-US`, and the page drew "BUGÜN 27" and "MON 31" in the
 * SAME strip, under the heading "Thursday, August 27", with every other word
 * on the page in Turkish and the clock in 12-hour AM/PM.
 *
 * So the language is passed in from the one place that already decided it.
 */
const fmt = (
  iso: string,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions,
  locale: string,
): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat(locale || undefined, { timeZone, ...opts }).format(new Date(ms));
  } catch {
    // An unshipped or malformed tag: the runtime default is still better than
    // nothing, and it is what this whole function used to do.
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
    vars["--faint"] = p.faint;
    vars["--line"] = p.border;
    vars["--pad"] = p.inputBg;
  }
  if (s.accent) {
    const accent = safeAccent(s.accent);
    vars["--accent"] = accent;
    vars["--accent-fg"] = accentInk(accent);
  }
  // The font is the form's default — Manrope — unless the resource named
  // another. A calendar that never opened the appearance panel still has to
  // look like the form next to it, so "unset" is a choice made here rather
  // than a fall-through to whatever the browser draws body text in.
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

/** The accent disc the form ends on. Same size, same tint, same stroke — an
 *  appointment confirmed and a form submitted are the same moment. */
function Mark({ children }: { children: ReactNode }) {
  return (
    <div className="bxb-mark">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8">
        {children}
      </svg>
    </div>
  );
}

const CHECK = <path d="M20 6L9 17l-5-5" />;
const CLOCK = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>
);

/** Every state of both pages sits in this frame, so a dead link and a
 *  confirmed appointment are recognisably the same page. */
function Shell({ style, children }: { style: CSSProperties; children: ReactNode }) {
  return (
    <div className="bxb" style={style}>
      <div className="bxb-wrap">
        {children}
        <p className="bxb-foot">
          <Trans>Powered by backlex</Trans>
        </p>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="bxb-card">
      <div className="bxb-skel" style={{ height: 26, width: "52%", marginBottom: 10 }} />
      <div className="bxb-skel" style={{ height: 13, width: "38%", marginBottom: 26 }} />
      <div className="bxb-skel" style={{ height: 10, width: 74, marginBottom: 11 }} />
      <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bxb-skel" style={{ height: 66, width: 64, flex: "0 0 auto" }} />
        ))}
      </div>
      <div className="bxb-skel" style={{ height: 14, width: "44%", marginBottom: 14 }} />
      <div className="bxb-times">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bxb-skel" style={{ height: 44 }} />
        ))}
      </div>
    </div>
  );
}

export function Book() {
  const { token = "" } = useParams();
  const { t, i18n } = useLingui();
  // The language the page is actually rendering in — see `fmt`. Read from
  // Lingui rather than left to the JS runtime, because the two disagree.
  const lang = i18n.locale;
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

  useDocumentTitle(data?.resource.name);
  useDocumentLang(lang);
  const zone = data?.resource.timeZone ?? "UTC";
  const days = useMemo(() => groupByDay(data?.slots ?? [], zone), [data, zone]);
  const railRef = useRailFade(days.length);

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
  // The page draws in the same face the public form does, so the webfont is
  // fetched unless the resource explicitly asked for the visitor's own.
  useFonts(look?.font !== "system");

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

  if (!loaded) {
    return (
      <Shell style={style as CSSProperties}>
        <Skeleton />
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell style={style as CSSProperties}>
        <div className="bxb-card">
          <Mark>{CLOCK}</Mark>
          <h1 className="bxb-title-sm">
            <Trans>This booking link is not valid</Trans>
          </h1>
          <p className="bxb-sub" style={{ margin: 0 }}>
            <Trans>It may have been replaced, or the calendar may be closed.</Trans>
          </p>
        </div>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell style={style as CSSProperties}>
        <div className="bxb-card">
          <Mark>{CHECK}</Mark>
          <h1 className="bxb-title-sm">
            <Trans>You are booked in.</Trans>
          </h1>
          <p className="bxb-sub" style={{ margin: 0 }}>
            {fmt(done.start, zone, { dateStyle: "full", timeStyle: "short" }, lang)}
            {zonesDiffer ? ` (${zone})` : ""}
          </p>
          {data.resource.confirmationMessage && (
            <p className="bxb-sub">{data.resource.confirmationMessage}</p>
          )}
          <p className="bxb-note" style={{ marginTop: 16 }}>
            {done.emailed ? (
              <Trans>A confirmation is on its way, with a calendar invite attached.</Trans>
            ) : (
              <Trans>Keep this link — it is how you change or cancel this booking.</Trans>
            )}
          </p>
          <p className="bxb-row" style={{ marginTop: 16 }}>
            <a className="bxb-btn" href={done.manageUrl}>
              <Trans>Change or cancel</Trans>
            </a>
          </p>
        </div>
      </Shell>
    );
  }

  const bookable = days.length > 0 && activeDay !== null;
  const step = picked ? 1 : 0;

  return (
    <Shell style={style as CSSProperties}>
      <div className="bxb-card">
        <h1>{data.resource.name}</h1>
        {data.resource.description && <p className="bxb-sub">{data.resource.description}</p>}
        <p className="bxb-meta">
          <Trans>{data.resource.slotMinutes}-minute appointments</Trans>
          {zonesDiffer ? (
            <>
              {" · "}
              <Trans>times in {zone}, not your {visitorZone}</Trans>
            </>
          ) : null}
        </p>

        {/* Two questions, asked one at a time: which day, then which time.
            Both at once is what a wall of identical buttons looks like — and
            asking them one at a time is what earns the step bar. */}
        {bookable && (
          <div className="bxb-steps">
            {[0, 1].map((i) => (
              <span key={i} data-on={i <= step ? "1" : "0"} />
            ))}
            <b>{step + 1}/2</b>
          </div>
        )}

        <div style={{ marginTop: 22 }}>
          {!bookable ? (
            <>
              <h2>
                <Trans>Availability</Trans>
              </h2>
              <p className="bxb-sub" style={{ margin: 0 }}>
                <Trans>No open times in the next two weeks.</Trans>
              </p>
            </>
          ) : !picked ? (
            <>
              <h2>
                <Trans>Pick a day</Trans>
              </h2>
              <div className="bxb-rail" role="tablist" ref={railRef}>
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
                            : fmt(first, zone, { weekday: "short" }, lang)}
                      </span>
                      <span className="bxb-chip-num">{fmt(first, zone, { day: "numeric" }, lang)}</span>
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
                }, lang)}
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
                        {fmt(s.start, zone, { hour: "numeric", minute: "2-digit" }, lang)}
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
          ) : (
            <>
              {/* The grid is put away once a time is chosen — the third step
                  is filling this in, and a phone should not have to scroll
                  past everything it has already answered. */}
              <div className="bxb-chosen">
                <div>
                  <p className="bxb-eyebrow" style={{ margin: "0 0 2px" }}>
                    <Trans>Your appointment</Trans>
                  </p>
                  <div className="bxb-chosen-when">
                    {fmt(picked.start, zone, { dateStyle: "long", timeStyle: "short" }, lang)}
                  </div>
                </div>
                <button type="button" className="bxb-btn bxb-btn-quiet" onClick={() => setPicked(null)}>
                  <Trans>Change</Trans>
                </button>
              </div>

              <h2>
                <Trans>Your details</Trans>
              </h2>

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
                      {q.required === true ? <span className="bxb-req"> *</span> : null}
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

              {error && (
                <p role="alert" className="bxb-err">
                  {error}
                </p>
              )}

              <div className="bxb-row">
                <button type="button" className="bxb-btn" onClick={() => setPicked(null)}>
                  <Trans>Back</Trans>
                </button>
                <button
                  type="button"
                  className="bxb-btn bxb-btn-primary"
                  disabled={busy}
                  onClick={() => void onBook()}
                >
                  {busy ? <Trans>Booking…</Trans> : <Trans>Confirm booking</Trans>}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Shell>
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
  const { i18n } = useLingui();
  const lang = i18n.locale;
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

  useDocumentTitle(view?.resource.name);
  useDocumentLang(lang);
  const zone = view?.resource.timeZone ?? "UTC";

  const look = view?.resource.settings ?? null;
  const style = useMemo(() => appearanceVars(look), [look]);
  useFonts(look?.font !== "system");

  if (!loaded) {
    return (
      <Shell style={style as CSSProperties}>
        <Skeleton />
      </Shell>
    );
  }

  if (!view) {
    return (
      <Shell style={style as CSSProperties}>
        <div className="bxb-card">
          <Mark>{CLOCK}</Mark>
          <h1 className="bxb-title-sm">
            <Trans>This booking link is not valid</Trans>
          </h1>
          <p className="bxb-sub" style={{ margin: 0 }}>
            <Trans>It may have been replaced by a newer one.</Trans>
          </p>
        </div>
      </Shell>
    );
  }

  const live = view.status !== "cancelled" && view.status !== "completed";

  return (
    <Shell style={style as CSSProperties}>
      <div className="bxb-card">
        <Mark>{live ? CHECK : CLOCK}</Mark>
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
        <div className="bxb-chosen" style={{ margin: "20px 0" }}>
          <div>
            <p className="bxb-eyebrow" style={{ margin: "0 0 2px" }}>
              <Trans>Your appointment</Trans>
            </p>
            <div className="bxb-chosen-when">
              {fmt(view.start, zone, { dateStyle: "long", timeStyle: "short" }, lang)}
            </div>
            <p className="bxb-note" style={{ marginTop: 3 }}>{zone}</p>
          </div>
        </div>
        <p className="bxb-sub" style={{ margin: 0 }}>
          {view.status === "cancelled" ? (
            <Trans>This booking was cancelled.</Trans>
          ) : view.status === "completed" ? (
            <Trans>This appointment has already happened.</Trans>
          ) : (
            <Trans>You are booked in.</Trans>
          )}
        </p>
        {error && (
          <p role="alert" className="bxb-err" style={{ margin: "12px 0 0" }}>
            {error}
          </p>
        )}
        {view.canCancel && (
          <div className="bxb-row" style={{ marginTop: 20 }}>
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
    </Shell>
  );
}
