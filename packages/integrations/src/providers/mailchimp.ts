import { b64 } from "../lib";
import { defineProvider, type DestinationRow } from "../provider";

/**
 * Mailchimp — an audience's members into a collection, and rows back out.
 *
 * Seven of the schema templates model a subscriber list, and a subscriber list
 * that lives only in backlex is one nobody can send to. Both directions matter
 * here for a reason the other providers do not have: **consent moves the other
 * way.** Someone unsubscribes in an email, and unless the pull brings that back
 * the collection keeps saying they are a subscriber and every later push
 * argues with Mailchimp about it.
 *
 * It is a source + destination rather than a `sink` on purpose. A sink fires
 * per event with the row attached and has no settings, so it could not ask the
 * one question that has to be asked — what status a contact is added with. That
 * is a consent decision, and the whole design below refuses to make it silently.
 *
 * Two facts about this API shape everything:
 *
 * **The host is in the credential.** The API key ends `-us14`, and that suffix
 * IS the data centre subdomain. There is no account-wide host, so it is derived
 * rather than asked for — and validated, because it goes into a hostname.
 *
 * **Mailchimp is the consent authority, and it answers per contact.** The batch
 * endpoint returns 200 with an `errors[]` array; a member who unsubscribed
 * earlier is refused there, individually, while the rest of the batch lands.
 * Those refusals are permanent, so they are skipped rather than thrown — see
 * the note on `push`.
 */

/**
 * The data centre subdomain, as it appears in the key.
 *
 * Anchored and narrow because the result is interpolated into a hostname: a key
 * whose suffix were `evil.com` would otherwise send the credential somewhere
 * nobody chose. Real values look like `us1`, `us21`, `eu2`.
 */
const DC_PATTERN = /^[a-z]{2,6}\d{1,3}$/;

/** Mailchimp's own page cap for members. Default is 10, which is not useful. */
const PAGE = 1000;

/**
 * How far the next incremental pull rewinds.
 *
 * `since_last_changed` is second-precision and Mailchimp reads from replicas, so
 * resuming at exactly the newest `last_changed` seen can step over a record that
 * landed just behind it. Re-reading is an upsert and therefore free; a skipped
 * record is invisible forever, so the window is deliberately generous.
 */
const RESUME_OVERLAP_MS = 60_000;

/** The statuses Mailchimp recognises. */
const STATUSES = ["subscribed", "unsubscribed", "cleaned", "pending", "transactional"] as const;
type Status = (typeof STATUSES)[number];

/** Deliberately loose — Mailchimp does the real validation. This only stops an
 *  obviously non-address (a name, an empty cell) costing a batch slot. */
const EMAIL_LIKE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** `<key>-<dc>` → the API root, or `null` when the key carries no usable one. */
const baseFor = (apiKey: string): string | null => {
  const at = apiKey.lastIndexOf("-");
  if (at <= 0) return null;
  const dc = apiKey.slice(at + 1).trim().toLowerCase();
  return DC_PATTERN.test(dc) ? `https://${dc}.api.mailchimp.com/3.0` : null;
};

/** Basic auth with any username — the documented way to present an API key. */
const authHeader = (apiKey: string): string => {
  const encoded = b64(`backlex:${apiKey}`);
  if (!encoded) throw new Error("Mailchimp needs base64 support in this runtime");
  return `Basic ${encoded}`;
};

export const mailchimp = defineProvider({
  id: "mailchimp",
  label: "Mailchimp",
  category: "marketing",
  capabilities: ["source", "destination"],
  configFields: [
    {
      key: "apiKey",
      label: "API key",
      // The suffix is load-bearing, so the placeholder shows it.
      placeholder: "…-us14, from Account → Extras → API keys",
      secret: true,
    },
  ],
  source: {
    settingFields: [
      { key: "audienceId", label: "Audience ID", placeholder: "from Audience → Settings" },
      {
        key: "status",
        label: "Only these members (optional)",
        options: [
          { value: "any", label: "Every member" },
          { value: "subscribed", label: "Subscribed" },
          { value: "unsubscribed", label: "Unsubscribed" },
          { value: "pending", label: "Pending — unconfirmed" },
          { value: "cleaned", label: "Cleaned — bounced" },
          { value: "transactional", label: "Transactional only" },
        ],
      },
    ],
    async pull(ctx) {
      const apiKey = ctx.str("apiKey");
      if (!apiKey) throw new Error("Mailchimp sync has no API key");
      const base = baseFor(apiKey);
      if (!base) {
        throw new Error(
          "Mailchimp API key carries no data centre suffix — it should end in something like -us14",
        );
      }
      const audienceId = ctx.setting("audienceId");
      if (!audienceId) throw new Error("Mailchimp sync has no audience id");

      const { since, offset } = parseCursor(ctx.cursor);
      const count = Math.min(ctx.limit, PAGE);
      const url = new URL(`${base}/lists/${encodeURIComponent(audienceId)}/members`);
      url.searchParams.set("count", String(count));
      url.searchParams.set("offset", String(offset));
      // Sorted so the last row of the final page carries the newest change, which
      // is what the next run resumes from. Without the sort there is no such row.
      url.searchParams.set("sort_field", "last_changed");
      url.searchParams.set("sort_dir", "ASC");
      if (since) url.searchParams.set("since_last_changed", since);
      const status = ctx.setting("status");
      if (status && status !== "any") url.searchParams.set("status", status);

      const res = await ctx.fetch(url.toString(), {
        headers: { Authorization: authHeader(apiKey) },
      });
      if (!res.ok) throw await readError(res, "read the audience");
      const body = (await res.json()) as { members?: Record<string, unknown>[] };
      const members = body.members ?? [];

      const records = members
        .filter((m): m is { id: string } & Record<string, unknown> => typeof m.id === "string")
        .map((m) => ({ externalId: m.id, data: memberData(m) }));

      // A short page means the audience ran out. Anything else continues the walk
      // at the next offset, carrying the same `since` so the window does not move
      // underneath us mid-run.
      if (members.length >= count) {
        return { records, cursor: formatCursor(since, offset + members.length) };
      }
      return {
        records,
        cursor: null,
        // Sorted ASC, so the last member of the last page holds the newest change
        // in the whole run. An empty final page leaves the previous mark alone
        // rather than resetting the sync to a full read.
        ...(resumeFrom(members) ?? (since ? { resumeToken: formatCursor(since, 0) } : {})),
      };
    },
  },
  destination: {
    // Mailchimp's own docs describe this as a batch endpoint and the engine's
    // 200-row page fits comfortably inside it, so there is nothing to clamp.
    columns: [
      { value: "email", label: "Email address" },
      { value: "firstName", label: "First name (FNAME)" },
      { value: "lastName", label: "Last name (LNAME)" },
      { value: "phone", label: "Phone (PHONE)" },
      { value: "birthday", label: "Birthday (BIRTHDAY)" },
      { value: "status", label: "Subscription status" },
    ],
    settingFields: [
      { key: "audienceId", label: "Audience ID", placeholder: "from Audience → Settings" },
      {
        // Required, and deliberately without a default. Every contact Mailchimp
        // accepts arrives with a status, and picking one on an operator's behalf
        // would be this code deciding that the people in a database consented to
        // marketing. That is not a decision it is in a position to make.
        key: "status",
        label: "Add new contacts as",
        // Kept short deliberately. The picker draws a selected label in full
        // rather than truncating it, so a sentence here is clipped at phone
        // width — where the operator most needs to read which one is chosen.
        // The long form of each lives in docs/integrations.md.
        options: [
          { value: "pending", label: "Pending — double opt-in" },
          { value: "subscribed", label: "Subscribed — needs consent" },
          { value: "transactional", label: "Transactional — no marketing" },
        ],
      },
    ],
    /**
     * Send one batch.
     *
     * The failure rule is the interesting part. Mailchimp answers 200 and lists
     * per-contact refusals in `errors[]`, and those are permanent: a contact who
     * unsubscribed cannot be re-added by an API call, by design. Throwing on one
     * would hold the watermark on that row forever — the sync would never again
     * reach the contacts behind it, and a single opted-out address would wedge
     * the whole thing. So a per-contact refusal is skipped.
     *
     * The exception is a batch where EVERY contact was refused. One refusal is
     * data; all of them is a bug — a wrong audience, a mis-mapped email column —
     * and reporting a clean run there would advance the watermark over rows
     * nothing ever received. `error_code` cannot make this call for us: it only
     * has two values, and `ERROR_GENERIC` covers both the permanent and the
     * transient cases.
     */
    async push(ctx) {
      const apiKey = ctx.str("apiKey");
      if (!apiKey) throw new Error("Mailchimp write-back has no API key");
      const base = baseFor(apiKey);
      if (!base) {
        throw new Error(
          "Mailchimp API key carries no data centre suffix — it should end in something like -us14",
        );
      }
      const audienceId = ctx.setting("audienceId");
      if (!audienceId) throw new Error("Mailchimp write-back has no audience id");
      const fallback = asStatus(ctx.setting("status"));
      if (!fallback) throw new Error("Mailchimp write-back has no status to add contacts with");
      // The mapping declares ownership: a collection that maps a status column is
      // the one deciding who is subscribed, and its value wins over the setting.
      const ownsStatus = "status" in ctx.columns;

      const members: Record<string, unknown>[] = [];
      for (const row of ctx.rows) {
        const email = emailOf(row.email);
        if (!email) continue;
        let status: Status | null = fallback;
        if (ownsStatus) {
          // A mapped column whose value means nothing to Mailchimp is NOT quietly
          // treated as the configured status — that would subscribe someone whose
          // row says "bounced". Skipped instead; a guess about consent is worse
          // than a contact that does not travel.
          status = asStatus(row.status);
          if (!status) continue;
        }
        const merge = mergeFields(row);
        members.push({
          email_address: email,
          status,
          ...(Object.keys(merge).length > 0 ? { merge_fields: merge } : {}),
        });
      }
      if (members.length === 0) return;

      const res = await ctx.fetch(`${base}/lists/${encodeURIComponent(audienceId)}`, {
        method: "POST",
        headers: { Authorization: authHeader(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({
          members,
          // Edits to a mapped column are the point of a sync, so they propagate.
          update_existing: true,
          // Never true: this replaces a contact's tags with the ones in the
          // request, and the request has none. Segmentation an operator built by
          // hand would be wiped by a sync that has nothing to say about tags.
          sync_tags: false,
        }),
      });
      if (!res.ok) throw await readError(res, "write to the audience");

      const body = (await res.json()) as {
        errors?: { email_address?: string; error?: string }[];
        error_count?: number;
      };
      const errors = body.errors ?? [];
      if (errors.length >= members.length) {
        const first = errors[0];
        throw new Error(
          `Mailchimp refused every contact in the batch — check the audience id and the email column (first: ${
            first?.error?.slice(0, 160) ?? "no detail"
          })`,
        );
      }
    },
  },
});

// ── Shared ───────────────────────────────────────────────────────────────────

const emailOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const email = v.trim();
  return EMAIL_LIKE.test(email) ? email.toLowerCase() : null;
};

/** A value that means something to Mailchimp's status enum, or `null`. */
const asStatus = (v: unknown): Status | null => {
  // A `subscribed` boolean column is an ordinary way to hold this, and reading it
  // as a status is unambiguous in a way that guessing at a string is not.
  if (v === true) return "subscribed";
  if (v === false) return "unsubscribed";
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return (STATUSES as readonly string[]).includes(s) ? (s as Status) : null;
};

/**
 * The merge tags a mapped row carries.
 *
 * Only Mailchimp's default tags, which every audience has. Custom merge tags are
 * a stated gap rather than free text: the batch endpoint drops an unknown tag
 * without complaint, so accepting one would report a clean run while quietly
 * losing a column — exactly what a closed column set exists to prevent.
 */
const mergeFields = (row: DestinationRow): Record<string, string> => {
  const out: Record<string, string> = {};
  const first = text(row.firstName);
  if (first) out.FNAME = first;
  const last = text(row.lastName);
  if (last) out.LNAME = last;
  const phone = text(row.phone);
  if (phone) out.PHONE = phone;
  const birthday = toBirthday(row.birthday);
  if (birthday) out.BIRTHDAY = birthday;
  return out;
};

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

/**
 * `BIRTHDAY` is `MM/DD` and nothing else — a year makes Mailchimp reject it.
 *
 * Timestamps arrive as epoch milliseconds on SQLite and as a `Date` on Postgres,
 * so both are read rather than assuming the dialect. An unparseable value is
 * omitted; one bad cell must not cost the contact its other fields.
 */
const toBirthday = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /^\d{2}\/\d{2}$/.test(v.trim())) return v.trim();
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}`;
};

/**
 * One member, flattened for mapping.
 *
 * Merge tags are spread at the top level: they are uppercase by convention and
 * Mailchimp's own member keys are lowercase, so the two cannot collide, and an
 * operator mapping `FNAME` is naming what they see in Mailchimp. `tags` becomes
 * a plain array of names — a list of `{id, name}` objects is not something a
 * text or json column can usefully hold.
 */
const memberData = (m: Record<string, unknown>): Record<string, unknown> => {
  const merge = m.merge_fields && typeof m.merge_fields === "object" ? m.merge_fields : {};
  return {
    ...(merge as Record<string, unknown>),
    id: m.id,
    email_address: m.email_address ?? null,
    status: m.status ?? null,
    // The reason an unsubscribe happened, which is the half of consent that only
    // ever exists on Mailchimp's side.
    unsubscribe_reason: m.unsubscribe_reason ?? null,
    language: m.language ?? null,
    vip: m.vip ?? null,
    tags: Array.isArray(m.tags)
      ? m.tags
          .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : t))
          .filter((n): n is string => typeof n === "string")
      : [],
    last_changed: m.last_changed ?? null,
    timestamp_opt: m.timestamp_opt ?? null,
    timestamp_signup: m.timestamp_signup ?? null,
  };
};

/** Where the NEXT run should start, rewound by the overlap window. */
const resumeFrom = (members: Record<string, unknown>[]): { resumeToken: string } | null => {
  for (let i = members.length - 1; i >= 0; i--) {
    const at = members[i]?.last_changed;
    const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(ms)) continue;
    return { resumeToken: formatCursor(new Date(ms - RESUME_OVERLAP_MS).toISOString(), 0) };
  }
  return null;
};

/**
 * The cursor carries both halves of a walk: the window this run is reading, and
 * how far into it we are.
 *
 * Parsed rather than trusted — it round-trips through our own database — and
 * split on the LAST separator, the same shape the push watermark uses, because
 * an ISO timestamp contains colons but never a pipe.
 */
const parseCursor = (cursor: string | null): { since: string | null; offset: number } => {
  if (!cursor) return { since: null, offset: 0 };
  const at = cursor.lastIndexOf("|");
  if (at < 0) return { since: null, offset: 0 };
  const since = cursor.slice(0, at);
  const offset = Number.parseInt(cursor.slice(at + 1), 10);
  return {
    since: since || null,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
};

const formatCursor = (since: string | null, offset: number): string => `${since ?? ""}|${offset}`;

/** Turn a failed call into something an operator can act on. Mailchimp answers
 *  RFC 7807, so the useful sentence is in `detail`. */
const readError = async (res: Response, what: string): Promise<Error> => {
  const body = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
  const detail = body.detail ?? body.title ?? "";
  if (res.status === 401) {
    return new Error("Mailchimp rejected the API key — check it has not been revoked");
  }
  if (res.status === 404) {
    return new Error(`Mailchimp has no such audience — check the audience id`);
  }
  if (res.status === 429) {
    // Mailchimp allows ten simultaneous connections and answers 429 past that,
    // which is a wait rather than anything an admin should go and change.
    return new Error("Mailchimp rate-limited the request — it will be retried");
  }
  return new Error(
    `Mailchimp responded ${res.status} and could not ${what}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
  );
};
