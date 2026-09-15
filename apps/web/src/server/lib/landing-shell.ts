/**
 * The document a Cloudflare deploy answers for `/` — when `/` reaches the
 * Worker at all, which only `wrangler.playground.toml` arranges.
 *
 * A link preview is the whole reason. LinkedIn, Slack, X and iMessage build
 * their card from the Open Graph tags in the raw HTML and never run
 * JavaScript, and the admin shell carries none: shared, `play.backlex.com`
 * unfurled as a bare "Backlex Admin" with no image and no description. The
 * tags cannot simply go into `index.html`, because that one file is also the
 * admin of every self-hosted instance and every cloud tenant, and each would
 * start advertising the playground. Whether an instance IS the playground is a
 * server-side fact (`DEMO_MODE`), so the server adds them.
 *
 * Answered ahead of the Hono app (`entries/worker.ts`) rather than as a route,
 * because this is the admin dashboard's own document, not a public page: it
 * has to leave with exactly the headers Static Assets gives the same shell
 * under every other URL. Through Hono it would also pick up `secureHeaders()`'s
 * defaults — `Cross-Origin-Opener-Policy: same-origin` and `Referrer-Policy:
 * no-referrer` among them, measured on the worker-served `/f/<token>` shell —
 * and one dashboard would behave differently depending on whether the visitor
 * landed on `/` or on `/collections`.
 */
import { BASE_SECURITY_HEADERS, STRICT_CSP } from "./security-headers";

/** The one call this makes on the binding — structural, so a test can fake it. */
type Assets = { fetch(request: Request): Promise<Response> };

const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TITLE = "Backlex Playground — try the AI-native backend live";
const DESCRIPTION =
  "Sign in with one click and explore a seeded Backlex workspace: collections, permissions, REST + GraphQL, realtime and the built-in MCP server. No signup.";
/**
 * The website's card, by absolute URL. A crawler fetches the image from any
 * host, and pointing at the one served copy means the playground's card cannot
 * drift from the site's when that image is redrawn.
 */
const IMAGE = "https://backlex.com/og.png";
const IMAGE_ALT = "Backlex — ask the AI for a backend. It ships with all of this.";

export const SHARE_CARD_TAGS = (
  [
    ["name", "description", DESCRIPTION],
    ["property", "og:type", "website"],
    ["property", "og:site_name", "Backlex"],
    ["property", "og:title", TITLE],
    ["property", "og:description", DESCRIPTION],
    ["property", "og:image", IMAGE],
    ["property", "og:image:alt", IMAGE_ALT],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", TITLE],
    ["name", "twitter:description", DESCRIPTION],
    ["name", "twitter:image", IMAGE],
  ] as const
)
  .map(([attr, key, content]) => `<meta ${attr}="${key}" content="${escapeAttr(content)}">`)
  .join("");

/**
 * Static Assets' own shell for `/`, re-headed to match what Static Assets
 * sends, with the share card added when `shareCard` is set.
 *
 * The asset is always fetched as a bare GET: no conditional headers, because a
 * 304 hands back no body to add the card to, and no cookies, because a static
 * file needs none. HEAD gets the same headers and no body.
 */
export async function serveLandingShell(
  request: Request,
  assets: Assets,
  { shareCard }: { shareCard: boolean },
): Promise<Response> {
  const asset = await assets.fetch(new Request(request.url, { method: "GET" }));
  const type = asset.headers.get("content-type") ?? "";
  if (!asset.ok || !type.startsWith("text/html")) return asset;

  const headers = new Headers({
    "content-type": type,
    "cache-control": asset.headers.get("cache-control") ?? "public, max-age=0, must-revalidate",
    "content-security-policy": STRICT_CSP,
    ...BASE_SECURITY_HEADERS,
  });
  if (request.method === "HEAD") {
    await asset.body?.cancel();
    return new Response(null, { status: asset.status, headers });
  }

  const html = await asset.text();
  // A function replacement, so a `$` in the tags can never be read as a pattern.
  const body = shareCard ? html.replace("</head>", () => `${SHARE_CARD_TAGS}</head>`) : html;
  return new Response(body, { status: asset.status, headers });
}
