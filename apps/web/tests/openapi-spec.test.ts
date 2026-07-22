import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import staticSpec from "../src/server/lib/openapi-static.generated.json" with { type: "json" };
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * OpenAPI spec endpoints — `GET /api/openapi.json` / `GET /api/openapi.yaml`
 * (routes/openapi.ts). Pins the admin-only gate (401 anon / 403 non-admin),
 * the static half of the doc (sub-app mounts composed into full paths), and
 * the dynamic per-collection half (services/openapi-dynamic.ts::
 * buildDynamicCollectionPaths): a just-created collection must appear in the
 * very next fetch — the route sends Cache-Control: no-store for exactly this.
 */

const JSON_HEADERS = { "content-type": "application/json" } as const;

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
  servers?: Array<{ url: string }>;
}

describe("openapi spec endpoints", () => {
  let h: TestHarness;
  let admin: { email: string; password: string };
  const slug = `oapi_widgets_${Date.now()}`;

  const anon = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("Origin")) headers.set("Origin", "http://localhost:5173");
    return h.app.fetch(
      new Request(`http://localhost:5173${path}`, { ...init, headers }),
    );
  };

  beforeAll(async () => {
    h = makeHarness();
    admin = await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("anonymous request is 401", async () => {
    const res = await anon("/api/openapi.json");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("non-admin user is 403", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `oapi-viewer-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(su.status).toBe(200);

    const res = await h.fetch("/api/openapi.json");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN",
    );

    // Back to the admin session for the rest of the suite.
    const back = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    });
    expect(back.status).toBe(200);
  });

  test("admin gets a parseable 3.1 doc with core static paths", async () => {
    const res = await h.fetch("/api/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const doc = (await res.json()) as OpenApiDoc;

    expect(doc.openapi.startsWith("3.")).toBe(true);
    expect(doc.info.title).toBeTruthy();
    // `servers` is injected per request from the request's own origin.
    expect(doc.servers?.[0]?.url).toBe("http://localhost:5173");

    // Sub-app mounts composed with their route paths (mount + "/" collapses
    // to the bare mount) — spot-check a few core surfaces.
    expect(doc.paths["/api/api-keys"]).toBeDefined();
    expect(doc.paths["/api/admin/i18n"]).toBeDefined();
    expect(doc.paths["/api/admin/i18n"]?.put).toBeDefined();
    expect(doc.paths["/api/folders"]).toBeDefined();
    expect(doc.paths["/api/webhooks"]).toBeDefined();
    // Generic (static) items surface — distinct from the per-collection
    // dynamic paths asserted in the next test.
    expect(doc.paths["/api/items/{slug}"]).toBeDefined();

    // `/api/flows` — the recursive Operation tree used to blow the generator
    // ("Maximum call stack size exceeded") and the whole mount was skipped.
    // Fixed by registering the lazy schemas under explicit ref ids
    // (FlowOperation / FlowCondition) so self-references emit $ref.
    expect(doc.paths["/api/flows"]?.get).toBeDefined();
    expect(doc.paths["/api/flows"]?.post).toBeDefined();
    expect(doc.paths["/api/flows/{id}"]?.patch).toBeDefined();
    expect(doc.paths["/api/flows/{id}/run"]?.post).toBeDefined();
    expect(doc.components?.schemas?.FlowOperation).toBeDefined();

    // `/api/collections` + `/api/admin/adopt` are plain `Hono` apps (no
    // openAPIRegistry); their paths come from the hand-authored sibling
    // metadata files (collections.openapi.ts / adopt.openapi.ts).
    expect(doc.paths["/api/collections"]?.get).toBeDefined();
    expect(doc.paths["/api/collections"]?.post).toBeDefined();
    expect(doc.paths["/api/collections/{slug}"]?.get).toBeDefined();
    expect(doc.paths["/api/collections/{slug}"]?.patch).toBeDefined();
    expect(doc.paths["/api/collections/{slug}"]?.delete).toBeDefined();
    expect(doc.paths["/api/collections/{slug}/fields/{name}"]?.delete).toBeDefined();
    expect(doc.paths["/api/admin/adopt/tables"]?.get).toBeDefined();
    expect(doc.paths["/api/admin/adopt/inspect"]?.post).toBeDefined();
  });

  test("a new collection shows up as dynamic /api/items paths on the next fetch", async () => {
    const before = (await (await h.fetch("/api/openapi.json")).json()) as OpenApiDoc;
    expect(before.paths[`/api/items/${slug}`]).toBeUndefined();

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "stock", type: "number" },
        ],
      }),
    });
    expect(create.status).toBe(201);

    const after = (await (await h.fetch("/api/openapi.json")).json()) as OpenApiDoc;
    const listPath = after.paths[`/api/items/${slug}`] as
      | Record<string, any>
      | undefined;
    const itemPath = after.paths[`/api/items/${slug}/{id}`] as
      | Record<string, any>
      | undefined;
    expect(listPath).toBeDefined();
    expect(itemPath).toBeDefined();

    // CRUD verbs present on the generated paths.
    expect(listPath?.get).toBeDefined();
    expect(listPath?.post).toBeDefined();
    expect(itemPath?.get).toBeDefined();

    // The generated create schema reflects the collection's fields, with
    // `required` carried through.
    const createSchema = listPath?.post?.requestBody?.content?.[
      "application/json"
    ]?.schema as
      | { properties?: Record<string, { type?: string }>; required?: string[] }
      | undefined;
    expect(createSchema?.properties?.title).toBeDefined();
    expect(createSchema?.properties?.stock).toBeDefined();
    expect(createSchema?.required).toContain("title");
  });

  test("openapi.yaml returns YAML content that contains the doc", async () => {
    const res = await h.fetch("/api/openapi.yaml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/yaml");
    const text = await res.text();
    // Cheap parse-ability probes without pulling a YAML parser into the test:
    // the doc's top-level keys and the dynamic collection path must be there.
    expect(text).toContain("openapi:");
    expect(text).toContain("paths:");
    expect(text).toContain(`/api/items/${slug}`);
    // JSON braces at the start would mean it's not YAML output.
    expect(text.trimStart().startsWith("{")).toBe(false);

    // The yaml surface is admin-gated too.
    const anonRes = await anon("/api/openapi.yaml");
    expect(anonRes.status).toBe(401);
  });
});

/**
 * The committed static spec must stay byte-stable across builds.
 *
 * `routes/openapi-metadata.ts::loadMetadata()` imports its `*.openapi` modules
 * through `Promise.all`, and each registers paths as a top-level side effect —
 * so registry order follows import-resolution order and varies run to run.
 * `scripts/gen-openapi-static.ts` sorts `paths` and `components.schemas` on
 * write to absorb that. Without the sort every `bun run build` rewrites the
 * file with reordered keys, dirtying the working tree and burying real spec
 * changes in noise. This pins the invariant so a regenerate with a
 * sort-less generator fails here instead of leaking churn into commits.
 */
describe("static openapi spec is deterministic", () => {
  const doc = staticSpec as unknown as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };

  test("paths keys are sorted", () => {
    const keys = Object.keys(doc.paths);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...keys].sort());
  });

  test("components.schemas keys are sorted", () => {
    const keys = Object.keys(doc.components.schemas);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...keys].sort());
  });
});
