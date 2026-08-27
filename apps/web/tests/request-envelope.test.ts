/**
 * The envelope a request arrives in is never checked, because every fixture
 * builds a correct one.
 *
 * Measured across the suite before this file existed: of the 516 spec files in
 * `apps/web/tests`, 397 send a request body and exactly ONE of them sends a
 * malformed body — and that one was written the same day, for the fix below. Every other
 * body in 6,500 tests is `JSON.stringify(<literal>)` — well-formed by
 * construction, an object by construction, under the right content-type by
 * construction. So the whole class of "the caller sent something we cannot
 * even parse" was unreachable from the tests, which is how hono's own
 * `HTTPException(400, "Malformed JSON in request body")` reached callers as
 * `500 INTERNAL / "Internal server error"` on every write endpoint at once.
 *
 * `error-http-exception.test.ts` guards the handler that fixed it. This file
 * guards the PROPERTY, swept across route modules rather than proven at one
 * endpoint: whatever shape a caller puts on the wire, the answer is a 4xx that
 * says what is wrong. A 5xx here is always our bug — the caller cannot have
 * caused a server error by mistyping a body — and a refusal the caller cannot
 * read is only half an answer, so the code has to be there too.
 *
 * Deliberately NOT asserted: the exact status within 4xx. A truncated body is a
 * 400 and a well-formed-but-wrong body is a 422, but which side of that line a
 * given shape falls on is a routing detail per endpoint. Pinning it here would
 * make this file break on harmless changes and teach nobody anything.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/** One JSON-accepting write per route module, chosen to spread the sweep. */
interface Endpoint {
  label: string;
  path: string;
  method: "POST" | "PATCH";
}

/** A way of being wrong that no fixture in the suite produces. */
interface Envelope {
  label: string;
  body: string | undefined;
  contentType?: string | null;
}

const ENVELOPES: Envelope[] = [
  { label: "truncated JSON", body: '{"name": "half a ro' },
  { label: "empty body under a JSON content-type", body: "" },
  { label: "no body at all, but content-type says JSON", body: undefined },
  { label: "an array where an object belongs", body: "[]" },
  { label: "a bare string", body: '"just a string"' },
  { label: "a bare number", body: "42" },
  { label: "the null literal", body: "null" },
  { label: "the false literal", body: "false" },
  { label: "trailing comma (valid to a human, not to JSON.parse)", body: '{"name": "x",}' },
  { label: "single-quoted keys", body: "{'name': 'x'}" },
  { label: "a BOM before the object", body: '﻿{"name":"x"}' },
  { label: "valid JSON under text/plain", body: '{"name":"x"}', contentType: "text/plain" },
  { label: "valid JSON under no content-type at all", body: '{"name":"x"}', contentType: null },
  { label: "valid JSON under a form content-type", body: '{"name":"x"}', contentType: "application/x-www-form-urlencoded" },
  { label: "200 levels of nesting", body: `${"[".repeat(200)}${"]".repeat(200)}` },
  { label: "a 256 KB string in an unknown key", body: JSON.stringify({ pad: "x".repeat(262_144) }) },
];

describe("a hostile request envelope is refused, never a 500", () => {
  let h: TestHarness;
  let itemId = "";
  let endpoints: Endpoint[] = [];

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "widgets", fields: [{ name: "title", type: "text" }] }),
    });
    expect(made.status).toBe(201);

    const row = await h.fetch("/api/items/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "a widget" }),
    });
    expect(row.status).toBe(201);
    itemId = ((await row.json()) as { data: { id: string } }).data.id;

    endpoints = [
      { label: "schema: create a collection", path: "/api/collections", method: "POST" },
      { label: "data: insert a row", path: "/api/items/widgets", method: "POST" },
      { label: "data: update a row", path: `/api/items/widgets/${itemId}`, method: "PATCH" },
      { label: "roles: create a role", path: "/api/roles", method: "POST" },
      { label: "webhooks: create a subscription", path: "/api/webhooks", method: "POST" },
      { label: "folders: create a folder", path: "/api/folders", method: "POST" },
      { label: "flows: create a flow", path: "/api/flows", method: "POST" },
      { label: "templates: apply one", path: "/api/admin/templates/apply", method: "POST" },
    ];
  });

  afterAll(() => h.cleanup());

  for (const env of ENVELOPES) {
    test(`${env.label} — every endpoint answers 4xx with a readable code`, async () => {
      const bad: string[] = [];
      for (const ep of endpoints) {
        const headers: Record<string, string> = {};
        if (env.contentType !== null) headers["Content-Type"] = env.contentType ?? "application/json";

        const res = await h.fetch(ep.path, { method: ep.method, headers, body: env.body });

        if (res.status >= 500) {
          bad.push(`${ep.label} → ${res.status} (a caller cannot cause a server error by mistyping a body)`);
          continue;
        }
        if (res.status < 400) {
          bad.push(`${ep.label} → ${res.status} (accepted a body it could not have understood)`);
          continue;
        }
        const text = await res.text();
        let code: unknown;
        try {
          code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
        } catch {
          bad.push(`${ep.label} → ${res.status} with a non-JSON body: ${text.slice(0, 60)}`);
          continue;
        }
        if (typeof code !== "string" || code === "") {
          bad.push(`${ep.label} → ${res.status} with no error.code the caller can branch on`);
        }
      }
      expect(bad).toEqual([]);
    });
  }

  test("a well-formed body still gets through — the sweep is not just refusing everything", async () => {
    const res = await h.fetch("/api/items/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "still fine" }),
    });
    expect(res.status).toBe(201);
  });

  test("no route reads the request body without attributing a parse failure to it", async () => {
    // The runtime sweep above proves eight endpoints. This proves the rest of
    // them, and — more usefully — proves it for the endpoint somebody adds
    // next month. `c.req.json()` is `Request.json()`: a body that is not JSON
    // throws a bare `SyntaxError`, which the global handler can only read as
    // ours. `readJson` / `readJsonOr` in `server/lib/body.ts` are the two ways
    // to say what should happen instead, and there is no third way.
    const { readdir } = await import("node:fs/promises");
    const routesDir = new URL("../src/server/routes/", import.meta.url).pathname;
    const files = await readdir(routesDir, { recursive: true, withFileTypes: true });

    const offenders: string[] = [];
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const full = `${entry.parentPath ?? routesDir}/${entry.name}`;
      const src = await Bun.file(full).text();
      src.split("\n").forEach((line, i) => {
        // A doc comment may name the method it is explaining.
        if (/^\s*\*/.test(line)) return;
        if (line.includes("c.req.json(")) {
          offenders.push(`${full.slice(routesDir.length)}:${i + 1}: ${line.trim().slice(0, 80)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the query string is an envelope too — a nonsense paging value is refused, not coerced", async () => {
    // `Number("abc")` is NaN and `Number("")` is 0; a server that coerces
    // rather than validates answers 200 to both and silently pages wrongly.
    const bad: string[] = [];
    for (const q of ["limit=abc", "limit=-1", "limit=0", "limit=1e9", "limit=", "offset=abc", "offset=-5"]) {
      const res = await h.fetch(`/api/items/widgets?${q}`);
      if (res.status !== 422) bad.push(`?${q} → ${res.status}, expected 422`);
    }
    expect(bad).toEqual([]);
  });
});
