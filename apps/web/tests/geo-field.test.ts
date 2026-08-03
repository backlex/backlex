import { describe, expect, test, beforeAll } from "bun:test";
import { distanceKm, parseGeoPoint, parseRadiusKm, planNear, isNear } from "@backlex/db/geo";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Geo fields — a place a row is at, and the `_near` operator that asks what is
 * close to it.
 *
 * The shape under test is the one 15 of the 27 schema templates carry as loose
 * `text`: venues, warehouses, clinics, properties and technicians that have an
 * address and, until now, no way to answer "which of these is near me".
 *
 * Everything that can assert through the REST surface does, so the SQL the
 * compiler emits is exercised against a real SQLite exactly as a request drives
 * it — the arithmetic-only distance expression is the whole point of the
 * feature and a unit test of the JS twin would not have run any of it.
 */
describe("geo fields", () => {
  let h: TestHarness;

  const venues = "geo_venues";
  // Istanbul — the origin every proximity assertion below measures from.
  const SULTANAHMET = { lat: 41.0082, lng: 28.9784 };

  /** Reference points at known, very different distances from the origin. */
  const PLACES: Record<string, { lat: number; lng: number }> = {
    // ~1.4 km — same neighbourhood.
    eminonu: { lat: 41.0175, lng: 28.9709 },
    // ~5.7 km — across the Golden Horn.
    besiktas: { lat: 41.0422, lng: 29.0083 },
    // ~19 km — outer district, still Istanbul.
    maltepe: { lat: 40.9354, lng: 29.1553 },
    // ~350 km — another city entirely.
    ankara: { lat: 39.9334, lng: 32.8597 },
    // ~1150 km — far enough to be outside every radius the tests below use,
    // and near enough that the projection is still meaningful. Nothing here
    // asserts across a quarter of the planet: the projection is documented as
    // increasingly optimistic past a few hundred kilometres, so a test that
    // relied on it at 15 000 km would be asserting a number the feature does
    // not promise.
    warsaw: { lat: 52.2297, lng: 21.0122 },
  };

  const list = async (query: string) => {
    const r = await h.fetch(`/api/items/${venues}?${query}`);
    return { status: r.status, body: (await r.json()) as any };
  };
  /** Row names a query returned, in the order the API returned them. */
  const namesOf = (body: any): string[] => body.data.map((r: any) => r.name);
  const near = (origin: { lat: number; lng: number }, radius: string | number) =>
    encodeURIComponent(JSON.stringify({ location: { _near: { ...origin, radius } } }));

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug: venues,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "city", type: "text" },
          { name: "location", type: "geo" },
        ],
      }),
    );
    for (const [name, point] of Object.entries(PLACES)) {
      const r = await h.fetch(
        `/api/items/${venues}`,
        json({ name, city: "x", location: point }),
      );
      expect(r.status).toBe(201);
    }
    // A row with no location at all — the "not located yet" case that must
    // never be returned as near anything.
    await h.fetch(`/api/items/${venues}`, json({ name: "unlocated", city: "x" }));
  });

  describe("the value", () => {
    test("round-trips as a canonical { lat, lng }", async () => {
      const { body } = await list(`filter=${encodeURIComponent(JSON.stringify({ name: { _eq: "ankara" } }))}`);
      expect(body.data[0].location).toEqual(PLACES.ankara);
    });

    test("accepts the shapes that actually arrive, and normalizes them", async () => {
      // GeoJSON array order is [lng, lat]; a geocoder emits latitude/longitude;
      // a map site puts "lat,lng" on the clipboard. All three are the same place.
      const shapes: [string, unknown][] = [
        ["geojson_pair", [28.9784, 41.0082]],
        ["long_names", { latitude: 41.0082, longitude: 28.9784 }],
        ["pasted_string", "41.0082, 28.9784"],
      ];
      for (const [name, value] of shapes) {
        const r = await h.fetch(`/api/items/${venues}`, json({ name, location: value }));
        expect(r.status).toBe(201);
        const created = (await r.json()) as any;
        expect(created.data.location).toEqual(SULTANAHMET);
      }
    });

    test("refuses coordinates that are not on the earth", async () => {
      for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: "north", lng: 0 }]) {
        const r = await h.fetch(`/api/items/${venues}`, json({ name: "bad", location: bad }));
        expect(r.status).toBe(422);
      }
    });
  });

  describe("_near", () => {
    test("returns what is inside the radius and nothing else", async () => {
      const { body } = await list(`filter=${near(SULTANAHMET, "10km")}&limit=100`);
      const got = new Set(namesOf(body));
      expect(got.has("eminonu")).toBe(true);
      expect(got.has("besiktas")).toBe(true);
      expect(got.has("maltepe")).toBe(false);
      expect(got.has("ankara")).toBe(false);
      expect(got.has("warsaw")).toBe(false);
    });

    test("a row with no point is near nothing", async () => {
      // A radius wide enough to sweep up every located row still must not
      // return the one that has no location.
      const { body } = await list(`filter=${near(SULTANAHMET, "2000km")}&limit=100`);
      expect(namesOf(body)).not.toContain("unlocated");
      // ...and the radius really was wide enough to have caught it otherwise.
      expect(namesOf(body)).toContain("warsaw");
    });

    test("the radius unit is honoured, not assumed", async () => {
      // The same number in different units is a different query — 2000 metres
      // reaches Eminönü and not Beşiktaş; 2000 km reaches Warsaw.
      const metres = await list(`filter=${near(SULTANAHMET, "2000m")}&limit=100`);
      const withinMetres = namesOf(metres.body).filter((n) => n in PLACES);
      expect(withinMetres).toEqual(["eminonu"]);
      const km = await list(`filter=${near(SULTANAHMET, "2000km")}&limit=100`);
      expect(namesOf(km.body)).toContain("warsaw");
    });

    test("combines with an ordinary filter", async () => {
      const filter = encodeURIComponent(
        JSON.stringify({ location: { _near: { ...SULTANAHMET, radius: "10km" } }, name: { _eq: "besiktas" } }),
      );
      const { body } = await list(`filter=${filter}&limit=100`);
      expect(namesOf(body)).toEqual(["besiktas"]);
    });

    test("is refused on a field that is not a point", async () => {
      const filter = encodeURIComponent(JSON.stringify({ city: { _near: { ...SULTANAHMET, radius: 5 } } }));
      const { status, body } = await list(`filter=${filter}`);
      expect(status).toBe(422);
      expect(String(body.error?.message ?? body.message)).toContain("geo field");
    });

    test("a bad radius is a 422, not an empty page", async () => {
      for (const radius of ["soon", 0, -5, "5 parsecs"]) {
        const filter = encodeURIComponent(JSON.stringify({ location: { _near: { ...SULTANAHMET, radius } } }));
        const { status } = await list(`filter=${filter}`);
        expect(status).toBe(422);
      }
    });

    test("scalar operators on a point are refused with a reason", async () => {
      const filter = encodeURIComponent(JSON.stringify({ location: { _contains: "41" } }));
      const { status, body } = await list(`filter=${filter}`);
      expect(status).toBe(422);
      expect(String(body.error?.message ?? body.message)).toContain("_near");
    });

    test("`_null` still works — 'which rows have not been located?'", async () => {
      const filter = encodeURIComponent(JSON.stringify({ location: { _null: true } }));
      const { status, body } = await list(`filter=${filter}&limit=100`);
      expect(status).toBe(200);
      expect(namesOf(body)).toEqual(["unlocated"]);
    });
  });

  describe("sorting by distance", () => {
    test("orders nearest first from the filter's origin", async () => {
      const { body } = await list(`filter=${near(SULTANAHMET, "2000km")}&sort=location&limit=100`);
      const got = namesOf(body).filter((n) => n in PLACES);
      expect(got).toEqual(["eminonu", "besiktas", "maltepe", "ankara", "warsaw"]);
    });

    test("`-` reverses it", async () => {
      const { body } = await list(`filter=${near(SULTANAHMET, "2000km")}&sort=-location&limit=100`);
      const got = namesOf(body).filter((n) => n in PLACES);
      expect(got).toEqual(["warsaw", "ankara", "maltepe", "besiktas", "eminonu"]);
    });

    test("refuses to sort by distance from nowhere", async () => {
      const { status, body } = await list("sort=location");
      expect(status).toBe(422);
      expect(String(body.error?.message ?? body.message)).toContain("_near");
    });

    test("paginates by distance without repeating or skipping a row", async () => {
      // Keyset mode selects the ORDER BY expression as a boundary column, so a
      // synthetic distance has to survive the encode/decode round trip like any
      // real column would.
      const seen: string[] = [];
      let cursor = "";
      for (let page = 0; page < 8; page++) {
        const { body } = await list(
          `filter=${near(SULTANAHMET, "2000km")}&sort=location&limit=2&cursor=${encodeURIComponent(cursor)}`,
        );
        seen.push(...namesOf(body));
        if (!body.next_cursor || body.data.length === 0) break;
        cursor = body.next_cursor;
      }
      const located = seen.filter((n) => n in PLACES);
      expect(located).toEqual(["eminonu", "besiktas", "maltepe", "ankara", "warsaw"]);
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  describe("the arithmetic", () => {
    // The SQL and the JS twin must agree — the admin labels rows with a
    // distance the server never sent, so a divergence would show as a row the
    // query returned and the UI says is out of range.
    test("SQL membership matches the JS predicate row for row", async () => {
      for (const radiusKm of [2, 10, 50, 400, 2000]) {
        const { body } = await list(`filter=${near(SULTANAHMET, `${radiusKm}km`)}&limit=100`);
        const fromSql = new Set(namesOf(body).filter((n) => n in PLACES));
        const plan = planNear({ ...SULTANAHMET, radius: `${radiusKm}km` });
        const fromJs = new Set(
          Object.entries(PLACES)
            .filter(([, p]) => isNear(p, plan))
            .map(([name]) => name),
        );
        expect(fromSql).toEqual(fromJs);
      }
    });

    test("is within a fraction of a percent of great-circle distance", () => {
      // Haversine, written out here so the assertion has an independent
      // reference rather than comparing the projection against itself.
      const haversine = (a: typeof SULTANAHMET, b: typeof SULTANAHMET): number => {
        const R = 6371.0088;
        const rad = (d: number) => (d * Math.PI) / 180;
        const dLat = rad(b.lat - a.lat);
        const dLng = rad(b.lng - a.lng);
        const s =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      for (const [name, tolerance] of [["eminonu", 0.001], ["besiktas", 0.001], ["maltepe", 0.001], ["ankara", 0.01]] as const) {
        const p = PLACES[name]!;
        const exact = haversine(p, SULTANAHMET);
        const got = distanceKm(p, SULTANAHMET);
        expect(Math.abs(got - exact) / exact).toBeLessThan(tolerance);
      }
    });

    test("measures across the antimeridian the short way", async () => {
      // 179.9°E and 179.9°W are 0.2° apart, not 359.8°. Plain subtraction gets
      // this wrong, and it is wrong only in the one place nobody tests.
      const west = { lat: 0, lng: -179.9 };
      const east = { lat: 0, lng: 179.9 };
      expect(distanceKm(east, west)).toBeLessThan(30);

      await h.fetch(`/api/items/${venues}`, json({ name: "fiji_east", location: east }));
      const filter = encodeURIComponent(
        JSON.stringify({ location: { _near: { ...west, radius: "50km" } } }),
      );
      const { body } = await list(`filter=${filter}&limit=100`);
      expect(namesOf(body)).toContain("fiji_east");
    });
  });

  describe("the pure module", () => {
    test("parses radii with and without units", () => {
      expect(parseRadiusKm(5)).toBe(5);
      expect(parseRadiusKm("5")).toBe(5);
      expect(parseRadiusKm("5km")).toBe(5);
      expect(parseRadiusKm("500 m")).toBe(0.5);
      expect(parseRadiusKm("1mi")).toBeCloseTo(1.609344, 6);
      expect(parseRadiusKm("1nmi")).toBeCloseTo(1.852, 6);
      for (const bad of ["", "0km", "-1km", "5 lightyears", null, {}]) {
        expect(() => parseRadiusKm(bad)).toThrow();
      }
    });

    test("normalizes -0 so two equal points stringify alike", () => {
      expect(JSON.stringify(parseGeoPoint({ lat: -0, lng: 0 }))).toBe(
        JSON.stringify({ lat: 0, lng: 0 }),
      );
    });
  });
});
