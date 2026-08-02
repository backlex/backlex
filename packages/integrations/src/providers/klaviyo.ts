import { defineProvider, type DestinationRow } from "../provider";

/**
 * Klaviyo — a list's profiles into a collection, and rows back out as profiles.
 *
 * The counterpart to Mailchimp for the same seven subscriber-shaped templates,
 * and it answers the consent question in the opposite way, which is worth
 * stating plainly because it is the whole reason this provider looks different:
 *
 * **Adding a profile to a Klaviyo list does not grant marketing consent.**
 * Klaviyo keeps membership and consent as separate facts, and the endpoint that
 * grants consent is a different one. This provider only ever does the first.
 * There is no setting to turn the second on: backlex holds no record that the
 * people in a collection agreed to be emailed, so asserting it on their behalf
 * would be inventing the one fact that matters. Consent is granted in Klaviyo's
 * own signup flows, and the pull below brings the answer back.
 *
 * Mechanically there are two things to know:
 *
 * **Every request is pinned to a revision.** Klaviyo versions its API by a date
 * header, and an unpinned one silently changes response shapes underneath a
 * running sync. {@link REVISION} is that pin; moving it is a deliberate edit.
 *
 * **There is no upsert-into-a-list.** A profile is upserted to obtain its id,
 * and the ids are then attached to the list — one call per row plus one for the
 * batch, which is why the batch is small.
 */

/**
 * The API revision every call is made against.
 *
 * Pinned, not floated. Klaviyo ships breaking changes behind new revisions and
 * serves old ones indefinitely, so a fixed date is what keeps a sync that worked
 * yesterday working tomorrow. Bumping it means re-reading the response shapes
 * this file parses.
 */
const REVISION = "2026-07-15";

const BASE = "https://a.klaviyo.com/api";

/** JSON:API's own type, which Klaviyo requires on writes. */
const CONTENT_TYPE = "application/vnd.api+json";

/** Klaviyo's page cap for profiles in a list. */
const PAGE = 100;

/**
 * Rows per push call.
 *
 * One upsert per row plus one list attach, and the engine runs up to 20 pages in
 * an invocation: 40 rows is 41 subrequests a page and 820 across the run, inside
 * a Worker's 1000. Klaviyo's own burst limit is 10/s, which sequential awaits
 * stay under without any pacing of their own.
 */
const PUSH_BATCH = 40;

/** Klaviyo requires E.164 and 400s on anything else. */
const E164 = /^\+[1-9]\d{6,14}$/;

const EMAIL_LIKE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export const klaviyo = defineProvider({
  id: "klaviyo",
  label: "Klaviyo",
  category: "marketing",
  capabilities: ["source", "destination"],
  configFields: [
    {
      key: "apiKey",
      label: "Private API key",
      placeholder: "pk_…, from Settings → API keys",
      secret: true,
    },
  ],
  source: {
    settingFields: [
      { key: "listId", label: "List ID", placeholder: "from Lists & Segments" },
    ],
    async pull(ctx) {
      const { apiKey, listId } = readConfig(ctx, "sync");

      const url = new URL(`${BASE}/lists/${encodeURIComponent(listId)}/profiles`);
      url.searchParams.set("page[size]", String(Math.min(ctx.limit, PAGE)));
      if (ctx.cursor) url.searchParams.set("page[cursor]", ctx.cursor);

      const res = await ctx.fetch(url.toString(), { headers: readHeaders(apiKey) });
      if (!res.ok) throw await readError(res, "read the list");
      const body = (await res.json()) as {
        data?: { id?: unknown; attributes?: Record<string, unknown> }[];
        links?: { next?: unknown };
      };

      const records = (body.data ?? [])
        .filter((p): p is { id: string; attributes?: Record<string, unknown> } => typeof p.id === "string")
        .map((p) => ({ externalId: p.id, data: profileData(p.attributes ?? {}) }));

      // There is no incremental marker for list membership, so a run that ends is
      // a run that starts over next time — which is how edits to a profile are
      // noticed at all.
      return { records, cursor: nextCursor(body.links?.next) };
    },
  },
  destination: {
    batchSize: PUSH_BATCH,
    columns: [
      { value: "email", label: "Email address" },
      { value: "phone", label: "Phone (E.164)" },
      { value: "externalId", label: "External ID" },
      { value: "firstName", label: "First name" },
      { value: "lastName", label: "Last name" },
      { value: "organization", label: "Organization" },
      { value: "title", label: "Job title" },
    ],
    settingFields: [{ key: "listId", label: "List ID", placeholder: "from Lists & Segments" }],
    /**
     * Upsert each row's profile, then attach the batch to the list.
     *
     * The failure rule mirrors Mailchimp's, for the same reason. A 400 on one
     * profile is that profile — an address Klaviyo will not accept, a property it
     * refuses — and it is permanent. Throwing would hold the watermark on that
     * row and the sync would never again reach the rows behind it, so one bad
     * address would wedge the whole thing. Those are skipped.
     *
     * A batch where EVERY row was refused is not data, it is a bug: a mis-mapped
     * email column, a body this code is building wrongly. That throws, because
     * reporting a clean run would advance the watermark over rows nothing
     * received.
     */
    async push(ctx) {
      const { apiKey, listId } = readConfig(ctx, "write-back");
      const headers = { ...readHeaders(apiKey), "Content-Type": CONTENT_TYPE };

      const ids: string[] = [];
      let attempted = 0;
      let refused = 0;
      for (const row of ctx.rows) {
        const attributes = profileAttributes(row);
        // Klaviyo identifies a profile by email, phone or external id. With none
        // of them there is nothing to upsert ON, and the call would create a new
        // anonymous profile on every single run.
        if (!attributes) continue;
        attempted++;

        const res = await ctx.fetch(`${BASE}/profile-import`, {
          method: "POST",
          headers,
          body: JSON.stringify({ data: { type: "profile", attributes } }),
        });
        if (res.status === 400) {
          refused++;
          continue;
        }
        if (!res.ok) throw await readError(res, "write the profile");
        const body = (await res.json()) as { data?: { id?: unknown } };
        if (typeof body.data?.id === "string") ids.push(body.data.id);
      }

      if (attempted > 0 && refused >= attempted) {
        throw new Error(
          "Klaviyo refused every profile in the batch — check the email column and the mapping",
        );
      }
      if (ids.length === 0) return;

      const res = await ctx.fetch(
        `${BASE}/lists/${encodeURIComponent(listId)}/relationships/profiles`,
        {
          method: "POST",
          headers,
          // Membership only. This does NOT grant marketing consent, and that is
          // the intended behaviour — see the note at the top of the file.
          body: JSON.stringify({ data: ids.map((id) => ({ type: "profile", id })) }),
        },
      );
      if (!res.ok) throw await readError(res, "add the profiles to the list");
    },
  },
});

// ── Shared ───────────────────────────────────────────────────────────────────

const readHeaders = (apiKey: string): Record<string, string> => ({
  // Klaviyo's own scheme name, not `Bearer` — the usual one is rejected.
  Authorization: `Klaviyo-API-Key ${apiKey}`,
  revision: REVISION,
  Accept: CONTENT_TYPE,
});

const readConfig = (
  ctx: { str(k: string): string | null; setting(k: string): string | null },
  what: string,
): { apiKey: string; listId: string } => {
  const apiKey = ctx.str("apiKey");
  if (!apiKey) throw new Error(`Klaviyo ${what} has no private API key`);
  const listId = ctx.setting("listId");
  if (!listId) throw new Error(`Klaviyo ${what} has no list id`);
  return { apiKey, listId };
};

/**
 * The attributes a mapped row becomes, or `null` when it identifies nobody.
 *
 * A phone number that is not E.164 is dropped rather than sent: Klaviyo answers
 * 400 for the whole profile, so one badly formatted cell would cost the contact
 * its name, its company and its list membership too.
 */
const profileAttributes = (row: DestinationRow): Record<string, unknown> | null => {
  const attributes: Record<string, unknown> = {};
  const email = text(row.email);
  if (email && EMAIL_LIKE.test(email)) attributes.email = email.toLowerCase();
  const phone = text(row.phone);
  if (phone && E164.test(phone)) attributes.phone_number = phone;
  const externalId = text(row.externalId);
  if (externalId) attributes.external_id = externalId;
  if (!attributes.email && !attributes.phone_number && !attributes.external_id) return null;

  const first = text(row.firstName);
  if (first) attributes.first_name = first;
  const last = text(row.lastName);
  if (last) attributes.last_name = last;
  const organization = text(row.organization);
  if (organization) attributes.organization = organization;
  const title = text(row.title);
  if (title) attributes.title = title;
  return attributes;
};

const text = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

/**
 * One profile, flattened for mapping.
 *
 * `subscriptions` is the part worth carrying: it holds whether this person
 * consented to email or SMS marketing, which is the fact that only ever exists
 * on Klaviyo's side. A collection that pulls it back stops arguing with Klaviyo
 * about who is a subscriber.
 */
const profileData = (a: Record<string, unknown>): Record<string, unknown> => ({
  email: a.email ?? null,
  phone_number: a.phone_number ?? null,
  external_id: a.external_id ?? null,
  first_name: a.first_name ?? null,
  last_name: a.last_name ?? null,
  organization: a.organization ?? null,
  title: a.title ?? null,
  locale: a.locale ?? null,
  created: a.created ?? null,
  updated: a.updated ?? null,
  email_marketing_consent: consentOf(a.subscriptions, "email"),
  sms_marketing_consent: consentOf(a.subscriptions, "sms"),
  // Custom properties stay an object rather than being spread: they are
  // operator-defined, so a key of `email` there would otherwise overwrite the
  // address with whatever it happens to hold.
  properties: a.properties ?? null,
  location: a.location ?? null,
});

const consentOf = (subscriptions: unknown, channel: "email" | "sms"): string | null => {
  if (!subscriptions || typeof subscriptions !== "object") return null;
  const marketing = (subscriptions as Record<string, { marketing?: { consent?: unknown } }>)[channel]
    ?.marketing?.consent;
  return typeof marketing === "string" ? marketing : null;
};

/**
 * The cursor for the next page.
 *
 * Klaviyo hands back `links.next` as a whole URL, and following it would let the
 * far end choose where this sync sends its API key next. The cursor is read out
 * of it and the URL is rebuilt here instead — the same reason the pull builds
 * every other request itself.
 */
const nextCursor = (next: unknown): string | null => {
  if (typeof next !== "string" || !next) return null;
  try {
    const cursor = new URL(next).searchParams.get("page[cursor]");
    return cursor || null;
  } catch {
    return null;
  }
};

/** Turn a failed call into something an operator can act on. Klaviyo answers
 *  JSON:API, so the useful sentence is the first error's `detail`. */
const readError = async (res: Response, what: string): Promise<Error> => {
  const body = (await res.json().catch(() => ({}))) as {
    errors?: { detail?: string; title?: string }[];
  };
  const first = body.errors?.[0];
  const detail = first?.detail ?? first?.title ?? "";
  if (res.status === 401 || res.status === 403) {
    return new Error(
      "Klaviyo rejected the private API key — check it is still valid and has list and profile access",
    );
  }
  if (res.status === 404) return new Error("Klaviyo has no such list — check the list id");
  if (res.status === 429) {
    return new Error("Klaviyo rate-limited the request — it will be retried");
  }
  return new Error(
    `Klaviyo responded ${res.status} and could not ${what}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
  );
};
