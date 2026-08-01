/**
 * Google Drive, Google Calendar and Contentful as sources.
 *
 * The engine is covered elsewhere; this is about what each connector does with
 * a page. Calendar carries the only genuinely new idea — a real incremental
 * sync token, which is NOT a cursor and loops forever if treated as one.
 */
import { describe, expect, test } from "bun:test";
import { PROVIDERS, pullFromSource } from "../../../packages/integrations/src/index";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spy = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return Object.assign(fn, { calls });
};

const TOKEN = { _oauthAccessToken: "tok" };

describe("Google Drive", () => {
  const pull = (settings: Record<string, unknown>, respond: Parameters<typeof spy>[0], cursor = null) => {
    const f = spy(respond);
    return pullFromSource("google-drive", { config: TOKEN, settings, cursor, limit: 200 }, f).then(
      (page) => ({ page, f }),
    );
  };

  test("it lists the folder and skips the trash by default", async () => {
    const { f } = await pull({ folderId: "fold123" }, () => json({ files: [] }));
    const q = new URL(f.calls[0]!.url).searchParams.get("q");
    expect(q).toBe("'fold123' in parents and trashed = false");
  });

  test("a folder id that is not an id is refused rather than escaped", async () => {
    // It is quoted into Drive's own query language, so a value carrying a quote
    // could rewrite the clause.
    await expect(
      pull({ folderId: "x' in parents or '1'='1" }, () => json({ files: [] })),
    ).rejects.toThrow(/not a valid id/);
  });

  test("size comes back as a string and is coerced, folders have none", async () => {
    const { page } = await pull({ folderId: "f" }, () =>
      json({
        files: [
          { id: "a", name: "doc.pdf", size: "10240", mimeType: "application/pdf" },
          { id: "b", name: "sub", mimeType: "application/vnd.google-apps.folder" },
        ],
      }),
    );
    // A string would fail a number column, and a missing one would insert NaN.
    expect(page.records[0]!.data.size).toBe(10240);
    expect(page.records[1]!.data.size).toBeNull();
  });

  test("the page token carries the run forward", async () => {
    const { page } = await pull({ folderId: "f" }, () => json({ files: [{ id: "a" }], nextPageToken: "np" }));
    expect(page.cursor).toBe("np");
  });

  test("it asks for a scope that cannot read file contents", () => {
    // Requesting a broader scope in order not to use it is the wrong thing to
    // put on somebody's consent screen.
    expect(PROVIDERS["google-drive"].oauth?.scopes).toEqual([
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ]);
  });
});

describe("Google Calendar", () => {
  const pull = (cursor: string | null, respond: Parameters<typeof spy>[0]) => {
    const f = spy(respond);
    return pullFromSource(
      "google-calendar",
      { config: TOKEN, settings: { calendarId: "primary" }, cursor, limit: 250 },
      f,
    ).then((page) => ({ page, f }));
  };

  test("a page token continues the run; a sync token ends it", async () => {
    const mid = await pull(null, () => json({ items: [{ id: "e1" }], nextPageToken: "np" }));
    expect(mid.page.cursor).toBe("p:np");
    expect(mid.page.resumeToken).toBeUndefined();

    const last = await pull("p:np", () => json({ items: [{ id: "e2" }], nextSyncToken: "st" }));
    // Returning the sync token as a cursor would leave the engine believing
    // there is another page, and it would ask forever.
    expect(last.page.cursor).toBeNull();
    expect(last.page.resumeToken).toBe("s:st");
  });

  test("the two token kinds are sent under their own parameter", async () => {
    const a = await pull("p:np", () => json({ items: [] }));
    expect(new URL(a.f.calls[0]!.url).searchParams.get("pageToken")).toBe("np");
    expect(new URL(a.f.calls[0]!.url).searchParams.get("syncToken")).toBeNull();

    const b = await pull("s:st", () => json({ items: [] }));
    // Handing a page token to `syncToken` gets a 410 and silently restarts the
    // whole calendar, so the tag is not cosmetic.
    expect(new URL(b.f.calls[0]!.url).searchParams.get("syncToken")).toBe("st");
    expect(new URL(b.f.calls[0]!.url).searchParams.get("pageToken")).toBeNull();
  });

  test("recurring events are expanded rather than sent as a rule", async () => {
    const { f } = await pull(null, () => json({ items: [] }));
    // Without this a weekly meeting is one row with an RRULE nobody downstream
    // can evaluate.
    expect(new URL(f.calls[0]!.url).searchParams.get("singleEvents")).toBe("true");
  });

  test("start and end are flattened, all-day events included", async () => {
    const { page } = await pull(null, () =>
      json({
        items: [
          { id: "e1", start: { dateTime: "2026-08-01T09:00:00Z" }, end: { dateTime: "2026-08-01T10:00:00Z" } },
          { id: "e2", start: { date: "2026-08-02" }, end: { date: "2026-08-03" } },
        ],
      }),
    );
    expect(page.records[0]!.data.start).toBe("2026-08-01T09:00:00Z");
    // An all-day event has `date`, not `dateTime`; dropping it would leave the
    // row with no time at all.
    expect(page.records[1]!.data.start).toBe("2026-08-02");
  });

  test("a cancellation travels, which is why the sync token exists", async () => {
    const { page } = await pull("s:st", () => json({ items: [{ id: "e1", status: "cancelled" }] }));
    expect(page.records[0]!.data.status).toBe("cancelled");
  });

  test("an expired sync token says what to do about it", async () => {
    await expect(
      pull("s:stale", () => new Response("gone", { status: 410 })),
    ).rejects.toThrow(/sync token expired/);
  });
});

describe("Contentful", () => {
  const CONFIG = { spaceId: "sp", accessToken: "cda-token" };
  const pull = (cursor: string | null, respond: Parameters<typeof spy>[0]) => {
    const f = spy(respond);
    return pullFromSource(
      "contentful",
      { config: CONFIG, settings: { contentType: "blogPost" }, cursor, limit: 100 },
      f,
    ).then((page) => ({ page, f }));
  };

  test("it pages by offset and stops on a short page", async () => {
    const first = await pull(null, () =>
      json({ items: Array.from({ length: 100 }, (_, i) => ({ sys: { id: `e${i}` } })) }),
    );
    expect(first.page.cursor).toBe("100");

    const last = await pull("100", () => json({ items: [{ sys: { id: "x" } }] }));
    expect(last.page.cursor).toBeNull();
  });

  test("a junk cursor from our own database is parsed, not trusted", async () => {
    const { f } = await pull("not-a-number", () => json({ items: [] }));
    expect(new URL(f.calls[0]!.url).searchParams.get("skip")).toBe("0");
  });

  test("a link becomes the referenced id, not [object Object]", async () => {
    const { page } = await pull(null, () =>
      json({
        items: [
          {
            sys: { id: "e1", updatedAt: "2026-08-01T00:00:00Z" },
            fields: {
              title: "Hello",
              author: { sys: { id: "author-1", type: "Link" } },
              tags: [{ sys: { id: "t1" } }, { sys: { id: "t2" } }],
            },
          },
        ],
      }),
    );
    const data = page.records[0]!.data;
    expect(data.title).toBe("Hello");
    // The id is the only part a collection can hold without resolving the graph
    // — and it is what a relation field wants anyway.
    expect(data.author).toBe("author-1");
    expect(data.tags).toEqual(["t1", "t2"]);
    expect(data._updatedAt).toBe("2026-08-01T00:00:00Z");
  });

  test("an unrecognised nested value is dropped rather than stringified", async () => {
    const { page } = await pull(null, () =>
      json({ items: [{ sys: { id: "e1" }, fields: { location: { lat: 1, lon: 2 } } }] }),
    );
    // `[object Object]` in a text column looks like data and is not.
    expect(page.records[0]!.data.location).toBeNull();
  });

  test("the environment defaults to master and is part of the path", async () => {
    const { f } = await pull(null, () => json({ items: [] }));
    expect(f.calls[0]!.url).toContain("/spaces/sp/environments/master/entries");
  });
});

describe("registration", () => {
  test("all three pull, and Calendar also pushes", () => {
    for (const kind of ["google-drive", "google-calendar", "contentful"] as const) {
      expect(PROVIDERS[kind].capabilities).toContain("source");
      expect(typeof PROVIDERS[kind].source?.pull).toBe("function");
    }
    expect(PROVIDERS["google-drive"].capabilities).toEqual(["source"]);
    expect(PROVIDERS.contentful.capabilities).toEqual(["source"]);
    // Calendar gained the reverse direction: a booking row becomes an event.
    expect(PROVIDERS["google-calendar"].capabilities).toEqual(["source", "destination"]);
    expect(typeof PROVIDERS["google-calendar"].destination?.push).toBe("function");
  });

  test("the Google pair still asks only for what it uses", () => {
    // Least privilege: Drive cannot read a calendar and vice versa. Calendar
    // now asks for write as well, because it writes — `calendar.events` alone
    // would cover both, but the read scope stays listed so the consent screen
    // says "read" to an admin connecting this only to mirror a calendar in.
    expect(PROVIDERS["google-calendar"].oauth?.scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    expect(PROVIDERS["google-drive"].oauth?.scopes.join(" ")).not.toContain("calendar");
  });

  test("Contentful is a pasted token, not an OAuth flow", () => {
    // The Content Delivery API is read-only by design, so the token an admin
    // pastes cannot write to their space.
    expect(PROVIDERS.contentful.oauth).toBeUndefined();
  });

  test("none of them receive record contents — they produce them", () => {
    for (const kind of ["google-drive", "google-calendar", "contentful"] as const) {
      expect(PROVIDERS[kind].recordPayload).toBeFalsy();
    }
  });
});
