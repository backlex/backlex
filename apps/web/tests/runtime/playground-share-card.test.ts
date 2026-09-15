/**
 * The playground's link-preview card (`lib/landing-shell.ts`), and the landing
 * document it rides on.
 *
 * Shared on LinkedIn, `play.backlex.com` unfurled as a bare "Backlex Admin" —
 * no image, no description — because the admin shell has no Open Graph tags
 * and a crawler never runs the SPA. The worker entry now answers `/` itself on
 * a playground and adds them. Three things have to hold for that to be a fix
 * rather than a new problem, and each gets a block below: the card is really
 * in the HEAD of the shell we ship; the document still leaves with the static
 * shell's headers, not Hono's; and a real instance gets its shell back
 * untouched. Plus the config line without which none of it is reachable.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker from "../../src/server/entries/worker";
import type { Env } from "../../src/server/env";
import { SHARE_CARD_TAGS } from "../../src/server/lib/landing-shell";
import { BASE_SECURITY_HEADERS, STRICT_CSP } from "../../src/server/lib/security-headers";

const WEB = resolve(import.meta.dir, "..", "..");
// The shell source rather than a hand-written fixture, so "the tags land in
// <head>" is a statement about the file this repo actually builds from.
const SHELL = readFileSync(resolve(WEB, "index.html"), "utf8");
// What Cloudflare Static Assets sends with `index.html`, measured on
// play.backlex.com before this change.
const STATIC_CACHE_CONTROL = "public, max-age=0, must-revalidate";

function fakeAssets(response: () => Response = () => shellResponse()) {
  const seen: Request[] = [];
  return {
    seen,
    fetch: async (req: Request) => {
      seen.push(req);
      return response();
    },
  };
}

const shellResponse = (): Response =>
  new Response(SHELL, {
    headers: { "content-type": "text/html", "cache-control": STATIC_CACHE_CONTROL, etag: '"shell-v1"' },
  });

const hit = (env: Partial<Env>, init?: RequestInit) =>
  worker.fetch(new Request("https://play.example/", init), env as Env, {} as ExecutionContext);

const playground = (assets = fakeAssets()): Partial<Env> => ({ DEMO_MODE: "1", ASSETS: assets as never });

describe("a playground's landing page carries the share card", () => {
  test("the Open Graph and Twitter tags are inside <head>, and the shell is otherwise intact", async () => {
    const res = await hit(playground());
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<meta property="og:image" content="https://backlex.com/og.png">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta property="og:title" content="Backlex Playground');
    // Inside the head, not appended after the document.
    expect(html.indexOf("og:image")).toBeLessThan(html.indexOf("</head>"));
    expect(html.split("</head>")).toHaveLength(2);
    // Exactly the source plus the card — nothing of the shell lost or moved.
    expect(html.replace(SHARE_CARD_TAGS, "")).toBe(SHELL);
  });

  test("every tag is well-formed, so a later copy edit cannot break the head", () => {
    // Eleven complete `<meta>` elements and nothing between them — an
    // unescaped quote or angle bracket in the copy would fail this.
    const tags = SHARE_CARD_TAGS.match(/<meta (?:name|property)="[^"]+" content="[^"<>]*">/g) ?? [];
    expect(tags).toHaveLength(11);
    expect(tags.join("")).toBe(SHARE_CARD_TAGS);
  });
});

describe("the landing document leaves with the static shell's headers", () => {
  test("the same CSP and security headers `_headers` gives it, and none of Hono's extras", async () => {
    // `security-headers-parity.test.ts` pins `public/_headers` to these same
    // constants, so equality here is equality with the static shell.
    const res = await hit(playground());

    expect(res.headers.get("content-security-policy")).toBe(STRICT_CSP);
    for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
      expect(`${name}: ${res.headers.get(name)}`).toBe(`${name}: ${value}`);
    }
    // What the worker-served `/f/<token>` shell carries and the static one
    // does not. On the admin's own document these would change how the
    // dashboard behaves depending on the URL it was opened at.
    expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
  });

  test("it keeps the static cache policy, and drops the ETag of a body it changed", async () => {
    const res = await hit(playground());

    expect(res.headers.get("cache-control")).toBe(STATIC_CACHE_CONTROL);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("etag")).toBeNull();
  });

  test("HEAD answers the same headers with no body", async () => {
    const res = await hit(playground(), { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(STRICT_CSP);
    expect(await res.text()).toBe("");
  });

  test("the asset is fetched as a bare GET — a 304 would leave no body to put the card in", async () => {
    const assets = fakeAssets();
    await hit(playground(assets), {
      method: "HEAD",
      headers: { "if-none-match": '"shell-v1"', cookie: "better-auth.session_token=x" },
    });

    expect(assets.seen).toHaveLength(1);
    expect(assets.seen[0]?.method).toBe("GET");
    expect(assets.seen[0]?.headers.get("if-none-match")).toBeNull();
    expect(assets.seen[0]?.headers.get("cookie")).toBeNull();
  });
});

describe("everywhere else the shell is untouched", () => {
  test("an instance without DEMO_MODE gets its shell back byte for byte", async () => {
    // The guard that lets "/" sit in any config safely: routing is the
    // config's decision, whether this is a playground is the env's.
    const res = await hit({ ASSETS: fakeAssets() as never });
    const html = await res.text();

    expect(html).toBe(SHELL);
    expect(html).not.toContain("og:");
    expect(res.headers.get("content-security-policy")).toBe(STRICT_CSP);
  });

  test("an asset that is not an HTML 200 passes through as it came", async () => {
    const missing = fakeAssets(() => new Response("gone", { status: 404 }));
    const res = await hit(playground(missing));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("gone");
  });
});

describe("the playground deploy routes / to the worker", () => {
  test("wrangler.playground.toml lists \"/\" in run_worker_first, with DEMO_MODE on", () => {
    // Without the route, Static Assets answers `/` before any code runs and
    // every assertion above is true of a handler nobody reaches.
    const toml = readFileSync(resolve(WEB, "wrangler.playground.toml"), "utf8");
    const line = toml.split("\n").find((l) => l.startsWith("run_worker_first"));
    const routes = line ? (JSON.parse(line.slice(line.indexOf("["))) as string[]) : [];

    expect(routes).toContain("/");
    expect(toml).toMatch(/^DEMO_MODE = "1"$/m);
  });
});
