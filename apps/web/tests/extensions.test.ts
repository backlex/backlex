import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  ManifestSchema,
  apiPermits,
  inlineEntryAssets,
  untar,
  validatePackage,
} from "../src/server/services/extensions";

/**
 * Extension system (#13) — service units (manifest validation, tar reader,
 * bridge allow-list) + the REST surface end-to-end through the harness app:
 * upload install → asset serving (CSP) → hook invoke in the real bun-worker
 * sandbox → disable/uninstall gates.
 */

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const SAMPLE_FILES: Record<string, string> = {
  "backlex-extension.json": JSON.stringify({
    name: "sample-ext",
    version: "1.0.0",
    title: "Sample Extension",
    description: "test fixture",
    contributes: {
      panels: [{ id: "main", title: "Sample Panel", entry: "panel.html" }],
      fieldEditors: [
        {
          interface: "color-swatch",
          title: "Color Swatch",
          types: ["text"],
          entry: "editor.html",
        },
      ],
      hooks: [
        { id: "sum", trigger: "manual", entry: "hooks/sum.js" },
        { id: "on-item", trigger: "event", pattern: "items:*", entry: "hooks/sum.js" },
      ],
    },
    permissions: { api: ["GET /api/items/*"] },
  }),
  "panel.html": "<!doctype html><html><body>panel</body></html>",
  "editor.html": "<!doctype html><html><body>editor</body></html>",
  "hooks/sum.js":
    "console.log('sum', ctx.data.a); return { sum: ctx.data.a + ctx.data.b };",
  "README.md": "not referenced by the manifest",
};

describe("extensions — units", () => {
  test("apiPermits matches exact, method-wildcard and prefix patterns", () => {
    const patterns = ["GET /api/items/posts", "* /api/flags/*"];
    expect(apiPermits(patterns, "GET", "/api/items/posts")).toBe(true);
    expect(apiPermits(patterns, "get", "/api/items/posts")).toBe(true);
    expect(apiPermits(patterns, "POST", "/api/items/posts")).toBe(false);
    expect(apiPermits(patterns, "DELETE", "/api/flags/x")).toBe(true);
    expect(apiPermits(patterns, "GET", "/api/items/other")).toBe(false);
    expect(apiPermits(undefined, "GET", "/api/items/posts")).toBe(false);
    expect(apiPermits([], "GET", "/api/items/posts")).toBe(false);
  });

  test("apiPermits refuses non-/api/ paths and traversal regardless of list", () => {
    expect(apiPermits(["* /admin/*"], "GET", "/admin/x")).toBe(false);
    expect(apiPermits(["GET /api/../secret"], "GET", "/api/../secret")).toBe(false);
    expect(apiPermits(["* /api/*"], "GET", "/other")).toBe(false);
  });

  test("untar reads a hand-built ustar archive (nested paths included)", () => {
    const enc = new TextEncoder();
    const block = (name: string, body: Uint8Array): Uint8Array[] => {
      const header = new Uint8Array(512);
      header.set(enc.encode(name), 0);
      header.set(enc.encode(body.length.toString(8).padStart(11, "0")), 124);
      header[156] = 48; // '0' regular file
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      return [header, padded];
    };
    const a = enc.encode("hello");
    const b = enc.encode("nested content");
    const parts = [
      ...block("package/a.txt", a),
      ...block("package/dir/b.txt", b),
      new Uint8Array(1024),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const tar = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      tar.set(p, off);
      off += p.length;
    }
    const files = untar(tar);
    expect(new TextDecoder().decode(files.get("package/a.txt"))).toBe("hello");
    expect(new TextDecoder().decode(files.get("package/dir/b.txt"))).toBe(
      "nested content",
    );
  });

  test("validatePackage returns manifest + only the referenced assets", () => {
    const { manifest, assets } = validatePackage(SAMPLE_FILES);
    expect(manifest.name).toBe("sample-ext");
    expect(Object.keys(assets).sort()).toEqual([
      "editor.html",
      "hooks/sum.js",
      "panel.html",
    ]);
  });

  test("validatePackage rejects a missing entry file and bad manifests", () => {
    expect(() => validatePackage({})).toThrow(/backlex-extension.json/);
    expect(() =>
      validatePackage({ "backlex-extension.json": "not json" }),
    ).toThrow(/valid JSON/);
    const manifest = JSON.parse(SAMPLE_FILES["backlex-extension.json"] as string);
    expect(() =>
      validatePackage({ "backlex-extension.json": JSON.stringify(manifest) }),
    ).toThrow(/missing file/);
  });

  test("inlineEntryAssets inlines same-package script/style refs only", () => {
    const files = {
      "ui/panel.html":
        '<script src="./app.js"></script>' +
        '<link rel="stylesheet" href="../shared/base.css">' +
        '<script src="https://evil.example/x.js"></script>' +
        '<link rel="icon" href="./fav.svg">' +
        '<script src="../../escape.js"></script>',
      "ui/app.js": 'console.log("</script> breaker");',
      "shared/base.css": "body { color: red }",
      "escape.js": "nope()",
    };
    const out = inlineEntryAssets(files, "ui/panel.html", files["ui/panel.html"]);
    expect(out).toContain('console.log("<\\/script> breaker")');
    expect(out).toContain("body { color: red }");
    // External URL + escaping ref stay as-is (CSP blocks them at render time).
    expect(out).toContain("https://evil.example/x.js");
    expect(out).toContain("../../escape.js");
    expect(out).toContain('rel="icon"');
    expect(out).not.toContain("nope()");
  });

  test("validatePackage inlines html entries in the stored asset", () => {
    const files = {
      "backlex-extension.json": JSON.stringify({
        name: "inline-ext",
        version: "1.0.0",
        title: "Inline",
        contributes: { panels: [{ id: "p", title: "P", entry: "panel.html" }] },
      }),
      "panel.html": '<h1>hi</h1><script src="./app.js"></script>',
      "app.js": "boot()",
    };
    const { assets } = validatePackage(files);
    expect(assets["panel.html"]).toContain("boot()");
    expect(assets["panel.html"]).not.toContain('src="./app.js"');
  });

  test("cron hooks require a pattern; valid cron hooks pass", () => {
    const base = {
      name: "cron-ext",
      version: "1.0.0",
      title: "Cron",
      contributes: {
        hooks: [{ id: "tick", trigger: "cron", entry: "tick.js" }],
      },
    };
    expect(ManifestSchema.safeParse(base).success).toBe(false);
    expect(
      ManifestSchema.safeParse({
        ...base,
        contributes: {
          hooks: [
            { id: "tick", trigger: "cron", pattern: "*/5 * * * *", entry: "tick.js" },
          ],
        },
      }).success,
    ).toBe(true);
  });

  test("manifest schema refuses traversal entries and bad slugs", () => {
    const base = JSON.parse(SAMPLE_FILES["backlex-extension.json"] as string);
    expect(
      ManifestSchema.safeParse({ ...base, name: "Bad Name!" }).success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({
        ...base,
        contributes: {
          panels: [{ id: "p", title: "P", entry: "../../etc/passwd" }],
        },
      }).success,
    ).toBe(false);
  });
});

describe("extensions — REST surface", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("admin endpoints reject anonymous callers", async () => {
    const bare = makeHarness();
    try {
      expect((await bare.fetch("/api/extensions")).status).toBe(401);
      expect(
        (await bare.fetch("/api/extensions/upload", json({ files: {} }))).status,
      ).toBe(401);
    } finally {
      bare.cleanup();
    }
  });

  test("upload → list → assets → invoke → disable → uninstall lifecycle", async () => {
    const created = await h.fetch(
      "/api/extensions/upload",
      json({ files: SAMPLE_FILES }),
    );
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { data: any }).data;
    expect(row.name).toBe("sample-ext");
    expect(row.enabled).toBe(true);
    expect(row.source).toBe("upload");

    const list = (await (await h.fetch("/api/extensions")).json()) as {
      data: any[];
    };
    expect(list.data.map((e) => e.name)).toContain("sample-ext");
    const enabled = (await (
      await h.fetch("/api/extensions/enabled")
    ).json()) as { data: any[] };
    expect(enabled.data.map((e) => e.name)).toContain("sample-ext");

    // Asset serving: correct content-type + iframe-safe inline-only CSP; the
    // unreferenced README was never stored.
    const asset = await h.fetch("/api/extensions/sample-ext/assets/panel.html");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/html");
    expect(asset.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(await asset.text()).toContain("panel");
    const nested = await h.fetch(
      "/api/extensions/sample-ext/assets/hooks/sum.js",
    );
    expect(nested.status).toBe(200);
    expect(
      (await h.fetch("/api/extensions/sample-ext/assets/README.md")).status,
    ).toBe(404);

    // Hook runs in the real sandbox with the request body as ctx.data.
    const invoked = await h.fetch(
      "/api/extensions/sample-ext/hooks/sum/invoke",
      json({ a: 1, b: 2 }),
    );
    expect(invoked.status).toBe(200);
    const result = (await invoked.json()) as any;
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ sum: 3 });
    expect(result.logs.length).toBeGreaterThan(0);
    expect(
      (await h.fetch("/api/extensions/sample-ext/hooks/nope/invoke", json({})))
        .status,
    ).toBe(404);

    // Disable: manifest drops out of /enabled, assets and invoke go 403.
    const patched = await h.fetch("/api/extensions/sample-ext", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(((await patched.json()) as any).data.enabled).toBe(false);
    const enabledAfter = (await (
      await h.fetch("/api/extensions/enabled")
    ).json()) as { data: any[] };
    expect(enabledAfter.data.map((e) => e.name)).not.toContain("sample-ext");
    expect(
      (await h.fetch("/api/extensions/sample-ext/assets/panel.html")).status,
    ).toBe(403);
    expect(
      (await h.fetch("/api/extensions/sample-ext/hooks/sum/invoke", json({})))
        .status,
    ).toBe(403);

    // Re-upload while installed = in-place upgrade, same name.
    const again = await h.fetch(
      "/api/extensions/upload",
      json({ files: SAMPLE_FILES }),
    );
    expect(again.status).toBe(201);

    const gone = await h.fetch("/api/extensions/sample-ext", {
      method: "DELETE",
    });
    expect(((await gone.json()) as any).ok).toBe(true);
    const after = (await (await h.fetch("/api/extensions")).json()) as {
      data: any[];
    };
    expect(after.data.map((e) => e.name)).not.toContain("sample-ext");
    expect(
      (await h.fetch("/api/extensions/sample-ext/assets/panel.html")).status,
    ).toBe(404);
  });

  test("upload rejects a manifest referencing a missing file with 422", async () => {
    const res = await h.fetch(
      "/api/extensions/upload",
      json({
        files: {
          "backlex-extension.json": JSON.stringify({
            name: "broken",
            version: "1.0.0",
            title: "Broken",
            contributes: { panels: [{ id: "p", title: "P", entry: "gone.html" }] },
          }),
        },
      }),
    );
    expect(res.status).toBe(422);
  });

  test("install validates the npm package name before any network call", async () => {
    const res = await h.fetch(
      "/api/extensions/install",
      json({ package: "Not A Package!!" }),
    );
    expect(res.status).toBe(422);
  });
});
