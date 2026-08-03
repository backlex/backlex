import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Geocoding — deriving a point from the address columns a collection already
 * has, which is the half of `geo` that reaches the fifteen templates carrying
 * an address as loose text.
 *
 * The harness's `h.fetch` invokes the Hono app in-process, so it never touches
 * `globalThis.fetch`; only the adapter's outbound call to the geocoding
 * provider does. That is what the mock below intercepts. The workspace is
 * pointed at a self-hosted Nominatim URL (`GEOCODE_URL`), which is both the
 * cheapest provider to fake faithfully and the one whose response shape has the
 * traps worth pinning — string coordinates, and an `{ error }` object where a
 * row is expected.
 */

const GEOCODE_HOST = "http://nominatim.test";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

interface GeocodeCall {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

/** Places the fake provider knows, keyed by the exact `q` it is sent. */
const KNOWN: Record<string, { lat: string; lon: string; display_name: string }> = {
  "Sultanahmet, Fatih, İstanbul, Türkiye": {
    lat: "41.0082",
    lon: "28.9784",
    display_name: "Sultanahmet Meydanı, Fatih, İstanbul, Türkiye",
  },
  "Kızılay, Çankaya, Ankara, Türkiye": {
    lat: "39.9208",
    lon: "32.8541",
    display_name: "Kızılay Meydanı, Çankaya, Ankara, Türkiye",
  },
};

const installGeocodeMock = (
  opts: { fail?: boolean } = {},
): { calls: GeocodeCall[]; restore: () => void } => {
  const real = globalThis.fetch;
  const calls: GeocodeCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(GEOCODE_HOST)) return real(input as never, init);
    const url = new URL(href);
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    if (opts.fail) return new Response("upstream down", { status: 502 });
    if (url.pathname === "/reverse") {
      return Response.json({ lat: "41.0082", lon: "28.9784", display_name: "Sultanahmet" });
    }
    const hit = KNOWN[url.searchParams.get("q") ?? ""];
    // Nominatim answers an unknown place with an empty ARRAY, not a 404.
    return Response.json(hit ? [hit] : []);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
};

describe("geocoding", () => {
  let h: TestHarness;
  let mock: ReturnType<typeof installGeocodeMock>;

  const clinics = "geo_clinics";

  const makeCollection = (over: Record<string, unknown> = {}) =>
    h.fetch(
      "/api/collections",
      json({
        slug: clinics,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "address", type: "text" },
          { name: "district", type: "text" },
          { name: "city", type: "text" },
          { name: "country", type: "text" },
          // Carries the app-user id a conditioned permission keys off — see the
          // row-scoping test at the bottom of this file.
          { name: "owner_tag", type: "text" },
          {
            name: "location",
            type: "geo",
            geo: { geocodeFrom: ["address", "district", "city", "country"] },
          },
        ],
        ...over,
      }),
    );

  const create = async (body: unknown) => {
    const r = await h.fetch(`/api/items/${clinics}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };

  beforeEach(async () => {
    h = makeHarness({ GEOCODE_PROVIDER: "nominatim", GEOCODE_URL: GEOCODE_HOST });
    await seedAdmin(h);
    mock = installGeocodeMock();
    await makeCollection();
  });
  afterEach(() => {
    mock.restore();
    h.cleanup();
  });

  describe("on write", () => {
    test("fills the point in from the address columns", async () => {
      const { status, body } = await create({
        name: "Dr Yılmaz",
        address: "Sultanahmet",
        district: "Fatih",
        city: "İstanbul",
        country: "Türkiye",
      });
      expect(status).toBe(201);
      expect(body.data.location).toEqual({ lat: 41.0082, lng: 28.9784 });
      // One provider call, with the columns joined in the configured order.
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.query.q).toBe("Sultanahmet, Fatih, İstanbul, Türkiye");
    });

    test("identifies itself, as the provider's policy requires", async () => {
      await create({ name: "x", address: "Sultanahmet", district: "Fatih", city: "İstanbul", country: "Türkiye" });
      expect(mock.calls[0]!.headers["user-agent"]).toContain("backlex");
    });

    test("never overrides a point the caller supplied", async () => {
      const { body } = await create({
        name: "Dr Yılmaz",
        address: "Sultanahmet",
        city: "İstanbul",
        location: { lat: 1, lng: 2 },
      });
      expect(body.data.location).toEqual({ lat: 1, lng: 2 });
      expect(mock.calls).toHaveLength(0);
    });

    test("an explicit null is a decision, not a gap to fill", async () => {
      const { body } = await create({
        name: "Dr Yılmaz",
        address: "Sultanahmet",
        district: "Fatih",
        city: "İstanbul",
        country: "Türkiye",
        location: null,
      });
      expect(body.data.location).toBeNull();
      expect(mock.calls).toHaveLength(0);
    });

    test("skips the call when every address column is blank", async () => {
      const { status, body } = await create({ name: "Nowhere" });
      expect(status).toBe(201);
      expect(body.data.location ?? null).toBeNull();
      expect(mock.calls).toHaveLength(0);
    });

    test("an unplaceable address still saves the row", async () => {
      const { status, body } = await create({ name: "Atlantis", city: "Atlantis" });
      expect(status).toBe(201);
      expect(body.data.location ?? null).toBeNull();
      expect(mock.calls).toHaveLength(1);
    });

    test("a provider outage still saves the row", async () => {
      mock.restore();
      mock = installGeocodeMock({ fail: true });
      const { status, body } = await create({
        name: "Dr Yılmaz",
        address: "Sultanahmet",
        district: "Fatih",
        city: "İstanbul",
        country: "Türkiye",
      });
      // The whole point: a geocoder being down is not a reason to refuse
      // someone's customer record.
      expect(status).toBe(201);
      expect(body.data.location ?? null).toBeNull();
    });
  });

  describe("on update", () => {
    test("re-resolves when the address moves", async () => {
      const { body } = await create({
        name: "Dr Yılmaz",
        address: "Sultanahmet",
        district: "Fatih",
        city: "İstanbul",
        country: "Türkiye",
      });
      const id = body.data.id;
      const patched = await h.fetch(
        `/api/items/${clinics}/${id}`,
        json({ address: "Kızılay", district: "Çankaya", city: "Ankara" }, "PATCH"),
      );
      const out = (await patched.json()) as any;
      expect(out.data.location).toEqual({ lat: 39.9208, lng: 32.8541 });
      // The second call carried `country` — a column the patch never mentioned,
      // read from the stored row.
      expect(mock.calls[1]!.query.q).toBe("Kızılay, Çankaya, Ankara, Türkiye");
    });

    test("spends nothing on a patch that touches no address column", async () => {
      const { body } = await create({
        name: "Dr Yılmaz",
        address: "Sultanahmet",
        district: "Fatih",
        city: "İstanbul",
        country: "Türkiye",
      });
      const before = mock.calls.length;
      await h.fetch(`/api/items/${clinics}/${body.data.id}`, json({ name: "Dr Y." }, "PATCH"));
      expect(mock.calls.length).toBe(before);
    });
  });

  describe("the endpoints", () => {
    test("resolve an address on demand", async () => {
      const r = await h.fetch("/api/geo/geocode", json({ address: "Sultanahmet, Fatih, İstanbul, Türkiye" }));
      expect(r.status).toBe(200);
      const body = (await r.json()) as any;
      expect(body.data).toMatchObject({ lat: 41.0082, lng: 28.9784 });
      expect(body.data.formatted).toContain("Sultanahmet");
    });

    test("report 'found nothing' as a null, not an error", async () => {
      const r = await h.fetch("/api/geo/geocode", json({ address: "Atlantis" }));
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).data).toBeNull();
    });

    test("reverse a point", async () => {
      const r = await h.fetch("/api/geo/reverse", json({ lat: 41.0082, lng: 28.9784 }));
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).data.lat).toBe(41.0082);
    });

    test("refuse coordinates that are not on the earth", async () => {
      const r = await h.fetch("/api/geo/reverse", json({ lat: 91, lng: 0 }));
      expect(r.status).toBe(422);
    });

    test("say so plainly when no provider is configured", async () => {
      const bare = makeHarness();
      try {
        await seedAdmin(bare);
        const r = await bare.fetch("/api/geo/geocode", json({ address: "anywhere" }));
        expect(r.status).toBe(503);
        expect(await r.text()).toContain("GEOCODE_");
      } finally {
        bare.cleanup();
      }
    });
  });

  describe("backfill", () => {
    /**
     * Rows the way a real import leaves them: addresses, no points.
     *
     * Seeded through the actual import endpoint rather than faked, because
     * "the import does not geocode" is half of what backfill exists for — if
     * that ever stopped being true these tests would go green for the wrong
     * reason, having quietly become a test of a twenty-minute request.
     */
    const seedUnlocated = async () => {
      const res = await h.fetch(`/api/items/${clinics}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { name: "a", address: "Sultanahmet", district: "Fatih", city: "İstanbul", country: "Türkiye" },
          { name: "b", address: "Kızılay", district: "Çankaya", city: "Ankara", country: "Türkiye" },
          { name: "c", city: "Atlantis" },
          { name: "d" },
        ]),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).data.inserted).toBe(4);
      // The import spent no provider calls — that is the premise.
      expect(mock.calls).toHaveLength(0);
    };

    test("fills in the rows a bulk import left unlocated", async () => {
      await seedUnlocated();
      const r = await h.fetch(`/api/geo/backfill/${clinics}`, json({ field: "location" }));
      expect(r.status).toBe(200);
      const { data } = (await r.json()) as any;
      expect(data).toMatchObject({ located: 2, unresolved: 1, skipped: 1 });
      // The two it could not place are still without a point, so `remaining`
      // does not lie about the collection being finished.
      expect(data.remaining).toBe(2);

      const listed = await (await h.fetch(`/api/items/${clinics}?limit=100`)).json() as any;
      const byName = Object.fromEntries(listed.data.map((r: any) => [r.name, r.location]));
      expect(byName.a).toEqual({ lat: 41.0082, lng: 28.9784 });
      expect(byName.b).toEqual({ lat: 39.9208, lng: 32.8541 });
      expect(byName.c ?? null).toBeNull();
    });

    test("never revises a point that is already set", async () => {
      await create({
        name: "hand-placed",
        address: "Sultanahmet",
        district: "Fatih",
        city: "İstanbul",
        country: "Türkiye",
        // An operator dragged the pin; the address still says Sultanahmet.
        location: { lat: 12.34, lng: 56.78 },
      });
      const before = mock.calls.length;
      const r = await h.fetch(`/api/geo/backfill/${clinics}`, json({ field: "location" }));
      expect(((await r.json()) as any).data.located).toBe(0);
      expect(mock.calls.length).toBe(before);
      const listed = await (await h.fetch(`/api/items/${clinics}?limit=100`)).json() as any;
      expect(listed.data[0].location).toEqual({ lat: 12.34, lng: 56.78 });
    });

    test("is bounded, and says what is left", async () => {
      await seedUnlocated();
      const r = await h.fetch(`/api/geo/backfill/${clinics}`, json({ field: "location", limit: 1 }));
      const { data } = (await r.json()) as any;
      expect(data.located + data.unresolved + data.skipped).toBe(1);
      expect(data.remaining).toBe(3);
    });

    test("refuses a field that is not a point", async () => {
      const r = await h.fetch(`/api/geo/backfill/${clinics}`, json({ field: "city" }));
      expect(r.status).toBe(422);
      expect(await r.text()).toContain("not a geo field");
    });

    /**
     * Holding `update` on a collection is not holding it on every ROW of it.
     *
     * The bundled self-service roles grant update conditioned on
     * `app_user_id = $user.id`, and the backfill endpoint originally applied
     * only the tenant filter — so a portal end-user could geocode, and write a
     * point onto, every other customer's record in the workspace, shipping
     * their addresses to a third-party provider on the way. The row-level
     * condition has to reach the SELECT, the UPDATE and the `remaining` count
     * alike, which is what these three assertions pin.
     */
    test("a conditioned grant reaches only the rows its condition matches", async () => {
      const roleRes = await h.fetch("/api/roles", json({ name: "Portal" }));
      const roleId = ((await roleRes.json()) as any).data.id;
      for (const action of ["read", "update"]) {
        await h.fetch(
          `/api/roles/${roleId}/permissions`,
          json({ collection: clinics, action, condition: { owner_tag: { _eq: "$user.id" } } }),
        );
      }

      const signup = await h.fetch(
        "/api/t/default/auth/sign-up/email",
        json({ email: "portal.geo@example.com", password: "portal-pass-123", name: "Portal Geo" }),
      );
      expect(signup.status).toBe(200);
      const token = ((await signup.json()) as any).token as string;
      const users = (await (await h.fetch("/api/app-users")).json()) as any;
      const appUserId = users.data.find((u: any) => u.email === "portal.geo@example.com").id;
      await h.fetch(`/api/app-users/${appUserId}/roles`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleIds: [roleId] }),
      });

      // One row the portal user owns, one belonging to somebody else. Both have
      // a resolvable address and neither has a point.
      const mine = await create({ name: "mine", address: "Sultanahmet", district: "Fatih", city: "İstanbul", country: "Türkiye", owner_tag: appUserId, location: null });
      const theirs = await create({ name: "theirs", address: "Sultanahmet", district: "Fatih", city: "İstanbul", country: "Türkiye", owner_tag: "someone-else", location: null });
      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      const callsBefore = mock.calls.length;

      const res = await h.app.request(`/api/geo/backfill/${clinics}`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ field: "location" }),
      });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as any;

      // Exactly one row was in scope — and exactly one provider call was made,
      // so the other customer's address never left the building.
      expect(data.located).toBe(1);
      expect(mock.calls.length - callsBefore).toBe(1);
      // `remaining` counts the caller's own leftovers, not the workspace's.
      expect(data.remaining).toBe(0);

      const listed = (await (await h.fetch(`/api/items/${clinics}?limit=100`)).json()) as any;
      const byName = Object.fromEntries(listed.data.map((r: any) => [r.name, r.location]));
      expect(byName.mine).toEqual({ lat: 41.0082, lng: 28.9784 });
      expect(byName.theirs ?? null).toBeNull();
    });

    test("refuses a geo field with nothing to derive from", async () => {
      await h.fetch(
        "/api/collections",
        json({
          slug: "geo_bare",
          fields: [
            { name: "name", type: "text" },
            { name: "spot", type: "geo" },
          ],
        }),
      );
      const r = await h.fetch("/api/geo/backfill/geo_bare", json({ field: "spot" }));
      expect(r.status).toBe(422);
      expect(await r.text()).toContain("geocodeFrom");
    });
  });
});
