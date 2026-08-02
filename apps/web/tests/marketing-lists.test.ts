/**
 * Mailchimp and Klaviyo — a collection out to a marketing list, and consent back.
 *
 * Two properties are load-bearing and everything here is about them holding.
 *
 * **A per-contact refusal must never wedge the sync.** The push watermark only
 * advances after `push` resolves, so throwing on one contact that a provider
 * will not accept — someone who unsubscribed, an address that is not real —
 * would hold the sync on that row forever and the contacts behind it would never
 * be reached again. Those are skipped. A batch where EVERY contact was refused
 * is the opposite: that is a bug, not data, and it has to throw.
 *
 * **Consent is never guessed.** Mailchimp forces a status on every contact, so
 * the setting is required and has no default; a mapped status column whose value
 * means nothing is skipped rather than falling back to "subscribed". Klaviyo
 * keeps membership and consent separate, and this provider only ever does
 * membership.
 */
import { describe, expect, test } from "bun:test";
import {
  DESTINATION_BATCH_SIZE,
  DESTINATION_COLUMNS,
  pullFromSource,
  pushToDestination,
} from "@backlex/integrations";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake provider that records every call and answers as told. */
const recorder = (responses: { status: number; body?: unknown }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses[i++] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  };
  return { calls, fetchImpl };
};

// ── Mailchimp ────────────────────────────────────────────────────────────────

// Shaped to exercise the suffix parser without matching a real key's shape:
// 32 hex characters followed by `-us14` is exactly what secret scanners look
// for, and a fixture that trips push protection is a fixture nobody can push.
const MC_KEY = "not-a-real-mailchimp-key-us14";

const mcPush = (
  rows: Record<string, unknown>[],
  opts: {
    fetchImpl: any;
    settings?: Record<string, unknown>;
    columns?: Record<string, string>;
    apiKey?: string;
  },
) =>
  pushToDestination(
    "mailchimp",
    {
      config: { apiKey: opts.apiKey ?? MC_KEY },
      settings: { audienceId: "aud1", status: "pending", ...(opts.settings ?? {}) },
      rows,
      columns: { id: "text", email: "text", ...(opts.columns ?? {}) },
      syncKey: "sync-a",
    },
    opts.fetchImpl,
  );

const mcPull = (opts: {
  fetchImpl: any;
  cursor?: string | null;
  settings?: Record<string, unknown>;
  limit?: number;
}) =>
  pullFromSource(
    "mailchimp",
    {
      config: { apiKey: MC_KEY },
      settings: { audienceId: "aud1", ...(opts.settings ?? {}) },
      cursor: opts.cursor ?? null,
      limit: opts.limit ?? 200,
    },
    opts.fetchImpl,
  );

const CONTACT = { id: "r1", email: "Ayse@Example.com" };

describe("mailchimp destination", () => {
  test("declares a closed column set", () => {
    // Custom merge tags are a stated gap rather than free text: the batch
    // endpoint drops an unknown tag without complaint, so accepting one would
    // report a clean run while quietly losing a column.
    expect(DESTINATION_COLUMNS.mailchimp?.map((c) => c.value)).toEqual([
      "email",
      "firstName",
      "lastName",
      "phone",
      "birthday",
      "status",
    ]);
  });

  test("derives the host from the key's data centre suffix", async () => {
    const { calls, fetchImpl } = recorder();
    await mcPush([CONTACT], { fetchImpl });
    expect(calls[0]!.url).toBe("https://us14.api.mailchimp.com/3.0/lists/aud1");
    expect(calls[0]!.method).toBe("POST");
    // Basic auth with any username is the documented way to present an API key.
    expect(calls[0]!.headers.Authorization).toStartWith("Basic ");
  });

  test("a key with no usable suffix fails before any call is made", async () => {
    for (const bad of ["nosuffix", "0123-evil.com", "0123-US14/x"]) {
      const { calls, fetchImpl } = recorder();
      // The suffix goes into a hostname, so a key that does not carry a real one
      // must not be allowed to choose where the credential is sent.
      await expect(mcPush([CONTACT], { fetchImpl, apiKey: bad })).rejects.toThrow(
        /data centre suffix/i,
      );
      expect(calls).toHaveLength(0);
    }
  });

  test("updates existing contacts but never touches their tags", async () => {
    const { calls, fetchImpl } = recorder();
    await mcPush([CONTACT], { fetchImpl });
    expect(calls[0]!.body.update_existing).toBe(true);
    // `sync_tags: true` REPLACES a contact's tags with the ones in the request,
    // and the request has none — segmentation an operator built by hand would be
    // wiped by a sync that has nothing to say about tags.
    expect(calls[0]!.body.sync_tags).toBe(false);
  });

  test("normalises the address and carries the default merge tags", async () => {
    const { calls, fetchImpl } = recorder();
    await mcPush(
      [{ ...CONTACT, firstName: " Ayşe ", lastName: "Yılmaz", phone: "+905551112233" }],
      { fetchImpl, columns: { firstName: "text", lastName: "text", phone: "text" } },
    );
    expect(calls[0]!.body.members).toEqual([
      {
        email_address: "ayse@example.com",
        status: "pending",
        merge_fields: { FNAME: "Ayşe", LNAME: "Yılmaz", PHONE: "+905551112233" },
      },
    ]);
  });

  test("a birthday becomes MM/DD, because a year is rejected", async () => {
    const { calls, fetchImpl } = recorder();
    await mcPush([{ ...CONTACT, birthday: "1990-03-07T00:00:00.000Z" }], {
      fetchImpl,
      columns: { birthday: "timestamp" },
    });
    expect(calls[0]!.body.members[0].merge_fields).toEqual({ BIRTHDAY: "03/07" });
  });

  test("epoch milliseconds are accepted, because that is what SQLite stores", async () => {
    const { calls, fetchImpl } = recorder();
    await mcPush([{ ...CONTACT, birthday: Date.parse("1990-12-25T00:00:00Z") }], {
      fetchImpl,
      columns: { birthday: "timestamp" },
    });
    expect(calls[0]!.body.members[0].merge_fields).toEqual({ BIRTHDAY: "12/25" });
  });

  test("an unparseable birthday is omitted, not sent", async () => {
    const { calls, fetchImpl } = recorder();
    // One bad cell must not cost the contact its other fields.
    await mcPush([{ ...CONTACT, firstName: "Ayşe", birthday: "sometime" }], {
      fetchImpl,
      columns: { firstName: "text", birthday: "text" },
    });
    expect(calls[0]!.body.members[0].merge_fields).toEqual({ FNAME: "Ayşe" });
  });

  test("rows without a real address are skipped", async () => {
    const { calls, fetchImpl } = recorder();
    await mcPush([{ id: "a", email: "" }, { id: "b", email: "Ayşe Yılmaz" }, CONTACT], {
      fetchImpl,
    });
    expect(calls[0]!.body.members).toHaveLength(1);
  });

  test("a batch with nothing sendable makes no call at all", async () => {
    const { calls, fetchImpl } = recorder();
    await mcPush([{ id: "a", email: null }], { fetchImpl });
    expect(calls).toHaveLength(0);
  });

  describe("consent", () => {
    test("the configured status is used when the collection maps none", async () => {
      const { calls, fetchImpl } = recorder();
      await mcPush([CONTACT], { fetchImpl, settings: { status: "transactional" } });
      expect(calls[0]!.body.members[0].status).toBe("transactional");
    });

    test("a mapped status column wins — the mapping declares ownership", async () => {
      const { calls, fetchImpl } = recorder();
      await mcPush([{ ...CONTACT, status: "unsubscribed" }], {
        fetchImpl,
        columns: { status: "text" },
        settings: { status: "subscribed" },
      });
      // This is how an unsubscribe held in the collection reaches Mailchimp.
      expect(calls[0]!.body.members[0].status).toBe("unsubscribed");
    });

    test("a boolean column reads as a status", async () => {
      const { calls, fetchImpl } = recorder();
      await mcPush([{ ...CONTACT, status: false }], {
        fetchImpl,
        columns: { status: "boolean" },
      });
      expect(calls[0]!.body.members[0].status).toBe("unsubscribed");
    });

    test("an unrecognised mapped status skips the row instead of defaulting", async () => {
      const { calls, fetchImpl } = recorder();
      // Falling back to the configured status would subscribe someone whose row
      // says "bounced". A guess about consent is worse than a contact that does
      // not travel.
      await mcPush([{ ...CONTACT, status: "bounced" }], {
        fetchImpl,
        columns: { status: "text" },
        settings: { status: "subscribed" },
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe("failures an operator has to tell apart", () => {
    test("a contact Mailchimp refuses is skipped, not thrown", async () => {
      const { fetchImpl } = recorder([
        {
          status: 200,
          body: {
            error_count: 1,
            errors: [{ email_address: "gone@example.com", error: "cannot be re-subscribed" }],
          },
        },
      ]);
      // Throwing would hold the watermark on this row forever and the contacts
      // behind it would never be reached again.
      await expect(
        mcPush([CONTACT, { id: "r2", email: "gone@example.com" }], { fetchImpl }),
      ).resolves.toBeUndefined();
    });

    test("but a batch where every contact was refused throws", async () => {
      const { fetchImpl } = recorder([
        {
          status: 200,
          body: {
            error_count: 1,
            errors: [{ email_address: "ayse@example.com", error: "looks fake or invalid" }],
          },
        },
      ]);
      // One refusal is data; all of them is a wrong audience or a mis-mapped
      // column, and a clean run there would step over rows nothing received.
      await expect(mcPush([CONTACT], { fetchImpl })).rejects.toThrow(/refused every contact/i);
    });

    test("a bad key says so rather than naming the audience", async () => {
      const { fetchImpl } = recorder([{ status: 401 }]);
      await expect(mcPush([CONTACT], { fetchImpl })).rejects.toThrow(/rejected the API key/i);
    });

    test("a missing audience says which id to check", async () => {
      const { fetchImpl } = recorder([{ status: 404 }]);
      await expect(mcPush([CONTACT], { fetchImpl })).rejects.toThrow(/audience id/i);
    });

    test("a rate limit reads as a wait, not as something to go and change", async () => {
      const { fetchImpl } = recorder([{ status: 429 }]);
      await expect(mcPush([CONTACT], { fetchImpl })).rejects.toThrow(/rate-limited/i);
    });
  });
});

describe("mailchimp source", () => {
  const MEMBER = {
    id: "abc123",
    email_address: "ayse@example.com",
    status: "unsubscribed",
    unsubscribe_reason: "Too many emails",
    merge_fields: { FNAME: "Ayşe", LNAME: "Yılmaz" },
    tags: [{ id: 1, name: "vip" }, { id: 2, name: "istanbul" }],
    last_changed: "2026-08-01T10:00:00+00:00",
  };

  const page = (members: unknown[]) => ({ status: 200, body: { members } });

  test("walks newest-change-last so the run has something to resume from", async () => {
    const { calls, fetchImpl } = recorder([page([MEMBER])]);
    await mcPull({ fetchImpl, limit: 50 });
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://us14.api.mailchimp.com");
    expect(url.pathname).toBe("/3.0/lists/aud1/members");
    expect(url.searchParams.get("count")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("0");
    // Without the sort there is no "last row of the last page", and so no mark.
    expect(url.searchParams.get("sort_field")).toBe("last_changed");
    expect(url.searchParams.get("sort_dir")).toBe("ASC");
    expect(url.searchParams.get("since_last_changed")).toBeNull();
  });

  test("flattens merge tags and reduces tags to their names", async () => {
    const { fetchImpl } = recorder([page([MEMBER])]);
    const out = await mcPull({ fetchImpl });
    expect(out.records[0]!.externalId).toBe("abc123");
    expect(out.records[0]!.data).toMatchObject({
      // Uppercase by convention, so a merge tag cannot collide with a member key.
      FNAME: "Ayşe",
      LNAME: "Yılmaz",
      email_address: "ayse@example.com",
      status: "unsubscribed",
      // The half of consent that only ever exists on Mailchimp's side.
      unsubscribe_reason: "Too many emails",
      tags: ["vip", "istanbul"],
    });
  });

  test("a full page continues at the next offset inside the same window", async () => {
    const { fetchImpl } = recorder([page([MEMBER, MEMBER])]);
    const out = await mcPull({ fetchImpl, limit: 2, cursor: "2026-07-01T00:00:00.000Z|0" });
    // Same `since`, advanced offset: the window must not move underneath a run.
    expect(out.cursor).toBe("2026-07-01T00:00:00.000Z|2");
    expect(out.resumeToken).toBeUndefined();
  });

  test("the cursor's window is carried back into the request", async () => {
    const { calls, fetchImpl } = recorder([page([])]);
    await mcPull({ fetchImpl, cursor: "2026-07-01T00:00:00.000Z|40" });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("since_last_changed")).toBe("2026-07-01T00:00:00.000Z");
    expect(url.searchParams.get("offset")).toBe("40");
  });

  test("a short page ends the run and hands back a rewound mark", async () => {
    const { fetchImpl } = recorder([page([MEMBER])]);
    const out = await mcPull({ fetchImpl, limit: 200 });
    expect(out.cursor).toBeNull();
    // A resume token is NOT a cursor: returned as one the engine would believe
    // there is another page and loop.
    const [since] = (out.resumeToken ?? "").split("|");
    // Rewound, because `since_last_changed` is second-precision and Mailchimp
    // reads from replicas — a re-read is an upsert, a skipped row is invisible.
    expect(Date.parse(since!)).toBe(Date.parse(MEMBER.last_changed) - 60_000);
  });

  test("an empty final page keeps the previous window rather than resetting", async () => {
    const { fetchImpl } = recorder([page([])]);
    const out = await mcPull({ fetchImpl, cursor: "2026-07-01T00:00:00.000Z|40" });
    // Dropping the mark here would make the next run re-read the whole audience.
    expect(out.resumeToken).toBe("2026-07-01T00:00:00.000Z|0");
  });

  test("the status filter is a real filter, and 'any' means no filter", async () => {
    const filtered = recorder([page([])]);
    await mcPull({ fetchImpl: filtered.fetchImpl, settings: { status: "unsubscribed" } });
    expect(new URL(filtered.calls[0]!.url).searchParams.get("status")).toBe("unsubscribed");

    const all = recorder([page([])]);
    await mcPull({ fetchImpl: all.fetchImpl, settings: { status: "any" } });
    // Mailchimp has no `any` status — omitting the parameter is what returns all.
    expect(new URL(all.calls[0]!.url).searchParams.get("status")).toBeNull();
  });
});

// ── Klaviyo ──────────────────────────────────────────────────────────────────

const KL_KEY = "pk_not-a-real-klaviyo-key";

const klPush = (
  rows: Record<string, unknown>[],
  opts: { fetchImpl: any; columns?: Record<string, string> },
) =>
  pushToDestination(
    "klaviyo",
    {
      config: { apiKey: KL_KEY },
      settings: { listId: "LIST1" },
      rows,
      columns: { id: "text", email: "text", ...(opts.columns ?? {}) },
      syncKey: "sync-a",
    },
    opts.fetchImpl,
  );

const klPull = (opts: { fetchImpl: any; cursor?: string | null; limit?: number }) =>
  pullFromSource(
    "klaviyo",
    {
      config: { apiKey: KL_KEY },
      settings: { listId: "LIST1" },
      cursor: opts.cursor ?? null,
      limit: opts.limit ?? 200,
    },
    opts.fetchImpl,
  );

const PROFILE_OK = { status: 200, body: { data: { id: "P1" } } };

describe("klaviyo destination", () => {
  test("declares a closed column set and a small batch", () => {
    expect(DESTINATION_COLUMNS.klaviyo?.map((c) => c.value)).toEqual([
      "email",
      "phone",
      "externalId",
      "firstName",
      "lastName",
      "organization",
      "title",
    ]);
    // One upsert per row plus one list attach, across 20 engine pages: the
    // default 200-row batch would be past what a Worker invocation allows.
    expect(DESTINATION_BATCH_SIZE.klaviyo).toBeLessThanOrEqual(40);
  });

  test("pins the revision and uses Klaviyo's own auth scheme", async () => {
    const { calls, fetchImpl } = recorder([PROFILE_OK, { status: 204 }]);
    await klPush([{ id: "r1", email: "ayse@example.com" }], { fetchImpl });
    // `Bearer` is rejected, and an unpinned revision changes response shapes
    // underneath a running sync.
    expect(calls[0]!.headers.Authorization).toBe(`Klaviyo-API-Key ${KL_KEY}`);
    expect(calls[0]!.headers.revision).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls[0]!.headers["Content-Type"]).toBe("application/vnd.api+json");
  });

  test("upserts each profile, then attaches the batch to the list", async () => {
    const { calls, fetchImpl } = recorder([
      PROFILE_OK,
      { status: 200, body: { data: { id: "P2" } } },
      { status: 204 },
    ]);
    await klPush(
      [
        { id: "r1", email: "ayse@example.com" },
        { id: "r2", email: "mehmet@example.com" },
      ],
      { fetchImpl },
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://a.klaviyo.com/api/profile-import",
      "https://a.klaviyo.com/api/profile-import",
      "https://a.klaviyo.com/api/lists/LIST1/relationships/profiles",
    ]);
    // Membership only. Klaviyo keeps consent as a separate fact and this
    // provider never asserts it.
    expect(calls[2]!.body).toEqual({
      data: [
        { type: "profile", id: "P1" },
        { type: "profile", id: "P2" },
      ],
    });
  });

  test("carries the mapped attributes in JSON:API shape", async () => {
    const { calls, fetchImpl } = recorder([PROFILE_OK, { status: 204 }]);
    await klPush(
      [
        {
          id: "r1",
          email: "Ayse@Example.com",
          firstName: "Ayşe",
          lastName: "Yılmaz",
          organization: "Backlex",
          title: "Kurucu",
          externalId: "cust-9",
        },
      ],
      {
        fetchImpl,
        columns: {
          firstName: "text",
          lastName: "text",
          organization: "text",
          title: "text",
          externalId: "text",
        },
      },
    );
    expect(calls[0]!.body).toEqual({
      data: {
        type: "profile",
        attributes: {
          email: "ayse@example.com",
          external_id: "cust-9",
          first_name: "Ayşe",
          last_name: "Yılmaz",
          organization: "Backlex",
          title: "Kurucu",
        },
      },
    });
  });

  test("a phone that is not E.164 is dropped, and the profile still travels", async () => {
    const { calls, fetchImpl } = recorder([PROFILE_OK, { status: 204 }]);
    await klPush([{ id: "r1", email: "ayse@example.com", phone: "0555 111 22 33" }], {
      fetchImpl,
      columns: { phone: "text" },
    });
    // Klaviyo 400s the whole profile on a bad number, so one badly formatted cell
    // would cost the contact its name, its company and its list membership too.
    expect(calls[0]!.body.data.attributes.phone_number).toBeUndefined();
    expect(calls[0]!.body.data.attributes.email).toBe("ayse@example.com");
  });

  test("a row identifying nobody is skipped before any call", async () => {
    const { calls, fetchImpl } = recorder();
    // With no email, phone or external id there is nothing to upsert ON, and the
    // call would create a fresh anonymous profile on every run.
    await klPush([{ id: "r1", email: "", firstName: "Ayşe" }], {
      fetchImpl,
      columns: { firstName: "text" },
    });
    expect(calls).toHaveLength(0);
  });

  describe("failures an operator has to tell apart", () => {
    test("a profile Klaviyo refuses is skipped, and the rest still land", async () => {
      const { calls, fetchImpl } = recorder([
        { status: 400, body: { errors: [{ detail: "invalid email" }] } },
        PROFILE_OK,
        { status: 204 },
      ]);
      await klPush(
        [
          { id: "r1", email: "bad@example.com" },
          { id: "r2", email: "ayse@example.com" },
        ],
        { fetchImpl },
      );
      expect(calls[2]!.body.data).toEqual([{ type: "profile", id: "P1" }]);
    });

    test("but a batch where every profile was refused throws", async () => {
      const { fetchImpl } = recorder([{ status: 400 }, { status: 400 }]);
      await expect(
        klPush(
          [
            { id: "r1", email: "a@example.com" },
            { id: "r2", email: "b@example.com" },
          ],
          { fetchImpl },
        ),
      ).rejects.toThrow(/refused every profile/i);
    });

    test("a bad key says so", async () => {
      const { fetchImpl } = recorder([{ status: 401 }]);
      await expect(klPush([{ id: "r1", email: "a@example.com" }], { fetchImpl })).rejects.toThrow(
        /rejected the private API key/i,
      );
    });

    test("a rate limit reads as a wait", async () => {
      const { fetchImpl } = recorder([{ status: 429 }]);
      await expect(klPush([{ id: "r1", email: "a@example.com" }], { fetchImpl })).rejects.toThrow(
        /rate-limited/i,
      );
    });

    test("a failed list attach throws so the batch is retried", async () => {
      const { fetchImpl } = recorder([PROFILE_OK, { status: 500 }]);
      await expect(klPush([{ id: "r1", email: "a@example.com" }], { fetchImpl })).rejects.toThrow(
        /500/,
      );
    });
  });
});

describe("klaviyo source", () => {
  const PROFILE = {
    id: "P1",
    attributes: {
      email: "ayse@example.com",
      first_name: "Ayşe",
      properties: { email: "not-the-real-one", plan: "pro" },
      subscriptions: {
        email: { marketing: { consent: "UNSUBSCRIBED" } },
        sms: { marketing: { consent: "SUBSCRIBED" } },
      },
    },
  };

  test("pages with Klaviyo's own parameters", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: { data: [PROFILE] } }]);
    await klPull({ fetchImpl, limit: 500, cursor: "CUR1" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/lists/LIST1/profiles");
    // Clamped to Klaviyo's cap, not the engine's page size.
    expect(url.searchParams.get("page[size]")).toBe("100");
    expect(url.searchParams.get("page[cursor]")).toBe("CUR1");
  });

  test("brings marketing consent back, which is the point of the pull", async () => {
    const { fetchImpl } = recorder([{ status: 200, body: { data: [PROFILE] } }]);
    const out = await klPull({ fetchImpl });
    expect(out.records[0]!.externalId).toBe("P1");
    expect(out.records[0]!.data).toMatchObject({
      email: "ayse@example.com",
      first_name: "Ayşe",
      email_marketing_consent: "UNSUBSCRIBED",
      sms_marketing_consent: "SUBSCRIBED",
    });
  });

  test("custom properties stay an object rather than being spread", async () => {
    const { fetchImpl } = recorder([{ status: 200, body: { data: [PROFILE] } }]);
    const out = await klPull({ fetchImpl });
    // Properties are operator-defined, so a key of `email` there would otherwise
    // overwrite the address with whatever it happens to hold.
    expect(out.records[0]!.data.email).toBe("ayse@example.com");
    expect(out.records[0]!.data.properties).toEqual({ email: "not-the-real-one", plan: "pro" });
  });

  test("reads the cursor out of links.next instead of following it", async () => {
    const { fetchImpl } = recorder([
      {
        status: 200,
        body: {
          data: [PROFILE],
          // Following a URL the far end chose would let it decide where this
          // sync sends its API key next.
          links: { next: "https://evil.example.com/api/lists/LIST1/profiles?page%5Bcursor%5D=NEXT2" },
        },
      },
    ]);
    const out = await klPull({ fetchImpl });
    expect(out.cursor).toBe("NEXT2");

    const second = recorder([{ status: 200, body: { data: [] } }]);
    await klPull({ fetchImpl: second.fetchImpl, cursor: out.cursor });
    expect(new URL(second.calls[0]!.url).origin).toBe("https://a.klaviyo.com");
  });

  test("no next link ends the run", async () => {
    const { fetchImpl } = recorder([{ status: 200, body: { data: [PROFILE] } }]);
    expect((await klPull({ fetchImpl })).cursor).toBeNull();
  });

  test("a missing list says which id to check", async () => {
    const { fetchImpl } = recorder([{ status: 404 }]);
    await expect(klPull({ fetchImpl })).rejects.toThrow(/list id/i);
  });
});
