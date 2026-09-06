/**
 * The five providers that invented their own resume field now resume.
 *
 * `SourcePullPage` declares `records`, `cursor` and `resumeToken?`. allegro,
 * bol, ebay, etsy and otto returned `complete: !more` and `resumeAt:
 * Date.now()` — neither name is in the contract, nothing reads either, and both
 * type-check because they are extra properties on a returned object literal.
 * So `integration-syncs.ts` found `page.resumeToken` undefined, stored `null`,
 * and every run re-read the whole `lookbackDays` window for ever. Not data loss
 * (writes are upserts by `externalId`) — just wasted provider quota on a
 * rate-limited API, permanently. See #318.
 *
 * The assertion is deliberately NOT on the field. An `expect(page.resumeToken)`
 * would go green on a token the provider cannot parse back, which is exactly
 * the shape-not-behaviour blind spot that hid this: `resumeAt` was a
 * well-formed value nobody could read. So each case runs the provider TWICE —
 * feeding run one's resume token back in as run two's cursor — and asserts on
 * the WINDOW the second request actually carries.
 *
 * That is also the check that catches the per-provider trap the issue warns
 * about: each parses its own cursor grammar, and a resume marker that reads
 * back as a page number or an opaque page token would silently skip or repeat a
 * window rather than fail.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { pullFromSource, resetThrottleState } from "@backlex/integrations";

beforeEach(() => resetThrottleState());

const DAY_MS = 86_400_000;

/** Records every request URL and answers each call from a scripted list. */
const recorder = (responses: { status?: number; body?: unknown }[]) => {
  const urls: URL[] = [];
  let i = 0;
  const fetchImpl = async (url: string, _init?: RequestInit) => {
    const u = new URL(url);
    urls.push(u);
    // Every one of these providers mints a token first; answer any auth host
    // with a generic grant so the scripted list stays about the DATA calls.
    if (/login|auth|token|oauth|sso/i.test(u.hostname + u.pathname)) {
      return new Response(
        JSON.stringify({ access_token: "atoken", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const next = responses[i++] ?? {};
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { urls, fetchImpl };
};

interface Case {
  id: string;
  config: Record<string, unknown>;
  settings?: Record<string, string>;
  /** An empty final page — the shape that ends a walk. */
  responses: { status?: number; body?: unknown }[];
  /** The request whose window parameter is the one under test. */
  windowOf: (urls: URL[]) => number | null;
}

/** Epoch ms out of whichever shape the provider puts on the wire. */
const epochParam = (u: URL, key: string): number | null => {
  const raw = u.searchParams.get(key);
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n > 1e11 ? n : n * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const pickWindow = (urls: URL[], keys: string[]): number | null => {
  for (const u of urls) {
    for (const k of keys) {
      const v = epochParam(u, k);
      if (v !== null) return v;
    }
  }
  return null;
};

const CASES: Case[] = [
  {
    id: "bol",
    config: { clientId: "cid", clientSecret: "csecret" },
    responses: [{ body: { orders: [] } }],
    // A DATE, not a timestamp — bol filters on the day an item last changed.
    windowOf: (urls) => pickWindow(urls, ["latest-change-date"]),
  },
  {
    id: "etsy",
    config: {
      clientId: "keystring-1",
      clientSecret: "shh",
      shopId: "12345",
      _oauthAccessToken: "tok-1",
    },
    responses: [{ body: { count: 0, results: [] } }],
    windowOf: (urls) => pickWindow(urls, ["min_last_modified", "min_created"]),
  },
  {
    id: "allegro",
    config: {
      environment: "sandbox",
      clientId: "cid",
      clientSecret: "csecret",
      language: "en-US",
      _oauthAccessToken: "atoken",
    },
    responses: [{ body: { checkoutForms: [], totalCount: 0, count: 0 } }],
    windowOf: (urls) => pickWindow(urls, ["updatedAt.gte", "lineItems.boughtAt.gte"]),
  },
  {
    id: "ebay",
    config: {
      environment: "sandbox",
      marketplaceId: "EBAY_DE",
      clientId: "cid",
      clientSecret: "csecret",
      ruName: "Acme-Acme-abcde-xyz",
      _oauthAccessToken: "atoken",
    },
    responses: [{ body: { orders: [], total: 0 } }],
    windowOf: (urls) => {
      // eBay puts the window inside a `filter=` expression rather than its own
      // parameter, so it is read out of the string.
      for (const u of urls) {
        const f = u.searchParams.get("filter");
        const m = f?.match(/\[([0-9TZ:.-]+)\.\./);
        if (m?.[1]) {
          const t = Date.parse(m[1]);
          if (Number.isFinite(t)) return t;
        }
      }
      return null;
    },
  },
  {
    id: "otto",
    config: { environment: "production", username: "partner", password: "s3cret" },
    settings: { currency: "EUR", vat: "FULL" },
    responses: [{ body: { resources: [], links: [] } }],
    windowOf: (urls) => pickWindow(urls, ["fromDate"]),
  },
];

describe("a marketplace walk that finished resumes where it stopped", () => {
  for (const c of CASES) {
    test(`${c.id} narrows its window on the next run`, async () => {
      const settings = { lookbackDays: "30", ...(c.settings ?? {}) };

      const first = recorder(c.responses);
      const page1 = await pullFromSource(
        c.id,
        { config: c.config, settings, cursor: null, limit: 200, connectionKey: "c1" },
        first.fetchImpl,
      );

      // A finished walk. `cursor === null` is the engine's ONLY end-of-run
      // signal, so this is what makes the resume token the stored cursor.
      expect(page1.cursor).toBeNull();
      expect(typeof page1.resumeToken).toBe("string");

      const firstWindow = c.windowOf(first.urls);
      expect(firstWindow, `${c.id}: no window parameter found on run 1`).not.toBeNull();

      const second = recorder(c.responses);
      await pullFromSource(
        c.id,
        { config: c.config, settings, cursor: page1.resumeToken!, limit: 200, connectionKey: "c1" },
        second.fetchImpl,
      );
      const secondWindow = c.windowOf(second.urls);
      expect(secondWindow, `${c.id}: no window parameter found on run 2`).not.toBeNull();

      // THE assertion. Run one reads back `lookbackDays`; run two must start
      // near now instead. Before the rename the stored cursor was always null
      // and this was an equality.
      expect(secondWindow!).toBeGreaterThan(firstWindow! + 20 * DAY_MS);

      // And it must not have jumped into the future, which would skip
      // everything between the walk and the next run.
      expect(secondWindow!).toBeLessThanOrEqual(Date.now() + DAY_MS);
    });

    test(`${c.id} resumes with an OVERLAP rather than at the instant it stopped`, async () => {
      // A page walk over a mutating set cannot be exact: a record edited while
      // the walk is in progress can land on a page already gone past. Resuming
      // at the moment the walk ended steps over it for ever. Re-reading is an
      // upsert and therefore free, so the marker is deliberately behind now.
      const { fetchImpl } = recorder(c.responses);
      const before = Date.now();
      const page = await pullFromSource(
        c.id,
        {
          config: c.config,
          settings: { lookbackDays: "30", ...(c.settings ?? {}) },
          cursor: null,
          limit: 200,
          connectionKey: "c1",
        },
        fetchImpl,
      );
      const at = Number(page.resumeToken);
      expect(Number.isFinite(at)).toBe(true);
      expect(at).toBeLessThan(before);
      // Bounded on the other side too — an overlap wide enough to swallow the
      // whole lookback would make the resume pointless.
      expect(at).toBeGreaterThan(before - DAY_MS);
    });
  }

  test("no provider still returns the invented field names", async () => {
    // `complete` was pure noise (the engine derives completeness from
    // `cursor === null`) and `resumeAt` was read by nothing. Neither is in
    // `SourcePullPage`, and both type-check as excess properties on a returned
    // object literal — which is precisely why this needs a runtime assertion
    // rather than the compiler.
    for (const c of CASES) {
      const { fetchImpl } = recorder(c.responses);
      const page = (await pullFromSource(
        c.id,
        { config: c.config, settings: { lookbackDays: "30" }, cursor: null, limit: 200, connectionKey: "c1" },
        fetchImpl,
      )) as Record<string, unknown>;
      expect({ id: c.id, resumeAt: "resumeAt" in page, complete: "complete" in page }).toEqual({
        id: c.id,
        resumeAt: false,
        complete: false,
      });
    }
  });
});
