/**
 * One conformance suite, run against every geocoding backend.
 *
 * `GeocodeAdapter.geocode()` answers `GeocodeResult | null`, and the whole
 * contract turns on what `null` MEANS. `geocode.google.ts` states it in its own
 * header: a provider failure "must throw, or a workspace with an expired key
 * would quietly record every [address] as unlocatable".
 *
 * That is the failure this file exists for, and it is irreversible in practice.
 * `services/geo-backfill.ts` walks a collection, calls `geocode()` per row, and
 * writes what it gets. A `null` is recorded as "we asked, and this address does
 * not exist" — so an adapter that turns a 401, a rate-limit or a DNS failure
 * into `null` marks an entire customer's address book unplaceable in one pass,
 * with no error anywhere, and a re-run does not fix it because every row now
 * looks answered.
 *
 * The second rule is quieter and just as costly: `lat`/`lng` must be finite
 * NUMBERS. Nominatim sends them as strings and Google can send `null` inside an
 * otherwise-valid response; an adapter that forwards either puts a string or a
 * NaN into a numeric column, and every distance query built on it is wrong
 * rather than absent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GeocodeAdapter } from "@backlex/core/adapters";
import { googleGeocode } from "../src/server/adapters/geocode.google";
import { mapboxGeocode } from "../src/server/adapters/geocode.mapbox";
import { nominatimGeocode } from "../src/server/adapters/geocode.nominatim";
import { consoleGeocode } from "../src/server/adapters/geocode.console";
import { asFetch } from "./helpers/fetch-stub";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ADDRESS = "1 Infinite Loop, Cupertino CA";

type Wire = {
  /** A real hit. */
  found: () => Response;
  /** The provider understood the request and has no result for it. */
  notFound: () => Response;
  /** The provider refused — bad key, quota, outage. */
  refused: () => Response;
};

/**
 * Each provider's wire shapes, read off its own parsing code.
 *
 * Nominatim's coordinates are deliberately STRINGS here because that is what
 * its API sends — the point of the number assertion below is that the adapter
 * converts them, and a fake that sent numbers would prove nothing.
 */
const BACKENDS: Array<{ label: GeocodeAdapter["provider"]; make: () => GeocodeAdapter; wire: Wire }> = [
  {
    label: "google",
    make: () => googleGeocode({ apiKey: "k" }),
    wire: {
      found: () =>
        json({
          status: "OK",
          results: [
            { geometry: { location: { lat: 37.3318, lng: -122.0312 } }, formatted_address: "1 Infinite Loop" },
          ],
        }),
      notFound: () => json({ status: "ZERO_RESULTS", results: [] }),
      // The exact shape an expired or over-quota key produces.
      refused: () => json({ status: "REQUEST_DENIED", error_message: "key expired" }),
    },
  },
  {
    label: "mapbox",
    make: () => mapboxGeocode({ accessToken: "t" }),
    wire: {
      found: () => json({ features: [{ center: [-122.0312, 37.3318], place_name: "1 Infinite Loop" }] }),
      notFound: () => json({ features: [] }),
      refused: () => json({ message: "Not Authorized" }, 401),
    },
  },
  {
    label: "nominatim",
    make: () => nominatimGeocode({ userAgent: "backlex-tests" }),
    wire: {
      found: () => json([{ lat: "37.3318", lon: "-122.0312", display_name: "1 Infinite Loop", importance: 0.8 }]),
      notFound: () => json([]),
      refused: () => new Response("rate limited", { status: 429 }),
    },
  },
];

const stub = (reply: () => Response) => {
  globalThis.fetch = asFetch(async () => reply());
};

for (const { label, make, wire } of BACKENDS) {
  describe(`GeocodeAdapter conformance — ${label}`, () => {
    test("reports its own provider name", () => {
      // Read back by the geo service to label a stored coordinate with where it
      // came from. A mislabelled row cannot be re-resolved when a provider is
      // swapped out.
      expect(make().provider).toBe(label);
    });

    test("a hit resolves to finite NUMBERS, never strings or NaN", async () => {
      stub(wire.found);
      const r = await make().geocode(ADDRESS);
      expect(`${label}: got a result: ${r !== null}`).toBe(`${label}: got a result: true`);
      expect(`${label}: lat is number ${typeof r!.lat}`).toBe(`${label}: lat is number number`);
      expect(`${label}: lng is number ${typeof r!.lng}`).toBe(`${label}: lng is number number`);
      expect(`${label}: lat finite ${Number.isFinite(r!.lat)}`).toBe(`${label}: lat finite true`);
      expect(`${label}: lng finite ${Number.isFinite(r!.lng)}`).toBe(`${label}: lng finite true`);
      // Sanity that it parsed the RIGHT numbers rather than any numbers.
      expect(Math.round(r!.lat)).toBe(37);
      expect(Math.round(r!.lng)).toBe(-122);
    });

    test("a genuine not-found is null, not an exception", async () => {
      // The backfill treats this as "asked and answered". It must be reachable
      // without an error, or a single unplaceable address aborts the whole
      // collection's pass.
      stub(wire.notFound);
      expect(`${label}: ${await make().geocode(ADDRESS)}`).toBe(`${label}: null`);
    });

    test("a provider REFUSAL throws — it must never look like not-found", async () => {
      // The invariant `geocode.google.ts` names in its own header, asserted for
      // all of them: an expired key, a quota wall or an outage must reach the
      // caller as an error. Returning null here marks a workspace's entire
      // address book unlocatable in one backfill pass, silently, and a re-run
      // does not repair it because every row now looks answered.
      stub(wire.refused);
      await expect(make().geocode(ADDRESS)).rejects.toThrow();
    });

    test("a transport failure throws rather than resolving null", async () => {
      // Same rule, one layer down: DNS or a dropped connection is a provider
      // failure, not a verdict about the address.
      globalThis.fetch = asFetch(async () => {
        throw new Error("ECONNREFUSED");
      });
      await expect(make().geocode(ADDRESS)).rejects.toThrow();
    });
  });
}

describe("GeocodeAdapter conformance — console", () => {
  test("answers null for everything, which is the unconfigured verdict", async () => {
    // The no-provider sink. It returns null rather than throwing ON PURPOSE:
    // a workspace with no geocoder configured should not have every save fail,
    // it should have no coordinates. That is the one legitimate exception to
    // the rule above, and it is stated rather than left as an oddity.
    const g = consoleGeocode();
    expect(g.provider).toBe("console");
    expect(await g.geocode(ADDRESS)).toBeNull();
    expect(await g.reverse!(37.3, -122.0)).toBeNull();
  });

  test("does not log the address itself", async () => {
    // These collections hold home addresses, and a log line is read by more
    // people than a row is. The adapter logs the LENGTH; a change that started
    // logging the value would be a privacy regression no test would otherwise
    // see.
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await consoleGeocode().geocode("221B Baker Street, London");
    } finally {
      console.log = orig;
    }
    expect(`logged something: ${lines.length > 0}`).toBe("logged something: true");
    expect(lines.join("\n")).not.toContain("Baker Street");
    expect(lines.join("\n")).not.toContain("221B");
  });
});

describe("the suite covers the backends that exist", () => {
  test("every geocode adapter file is exercised", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../src/server/adapters", import.meta.url))
      .filter((f) => /^geocode\..*\.ts$/.test(f))
      .map((f) => f.replace(/^geocode\.|\.ts$/g, ""))
      .sort();
    // All four run here — no exemptions to justify, unlike sms and push.
    expect(files).toEqual(["console", "google", "mapbox", "nominatim"]);
    expect([...BACKENDS.map((b) => b.label), "console"].sort()).toEqual(files);
  });
});
