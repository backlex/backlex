/**
 * Confirm that a deployed Worker is actually serving the commit you think it
 * is — and do it in one command.
 *
 * Why this exists: `wrangler deployments list` is STALE for Cloudflare
 * Workers Builds deploys (the native git integration this repo uses), so it
 * will happily show a deployment from days ago while the current bundle is
 * live. The only trustworthy check is behavioural: fetch the real origin and
 * look for something that exists solely in the commit you just shipped.
 *
 * The two traps this encodes, both of which have cost real time:
 *
 *   1. **The health route is `/health`, not `/api/health`.** The latter is a
 *      404 that looks exactly like "deploy hasn't landed yet", so polling it
 *      reads as a stuck deploy forever.
 *
 *   2. **Admin pages are lazy chunks.** They are NOT referenced from
 *      `index.html`, so grepping the entry chunks for a new string finds
 *      nothing even after a successful deploy. The chunk name has to be
 *      recovered from inside an entry chunk first — which is what
 *      `--marker` searching does here automatically.
 *
 *   3. **That recovery has to be transitive.** Fetching the entries and then
 *      their direct references is not enough; see `collectChunks`. Getting
 *      this wrong produces a false FAIL, which is the expensive direction —
 *      it accuses a deploy that actually landed.
 *
 * Usage:
 *   bun scripts/verify-deploy.ts --host https://backlex-admin.kinyasfurkan.workers.dev \
 *     --marker adyen --marker 0ABF53
 *
 *   # wait for a deploy to roll, then check
 *   bun scripts/verify-deploy.ts --marker adyen --wait 600
 *
 * Exits non-zero if the host is unreachable or any marker is absent, so it can
 * gate a publish step.
 */

const DEFAULT_HOST = "https://backlex-admin.kinyasfurkan.workers.dev";

interface Args {
  host: string;
  markers: string[];
  waitSec: number;
}

const parseArgs = (argv: string[]): Args => {
  const out: Args = { host: DEFAULT_HOST, markers: [], waitSec: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--host" && next) { out.host = next.replace(/\/+$/, ""); i++; }
    else if (a === "--marker" && next) { out.markers.push(next); i++; }
    else if (a === "--wait" && next) { out.waitSec = Number(next) || 0; i++; }
    else if (a === "--help" || a === "-h") {
      console.log("bun scripts/verify-deploy.ts [--host URL] [--marker STR]... [--wait SECONDS]");
      process.exit(0);
    }
  }
  return out;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 200 is not proof a file exists — the SPA fallback serves index.html for
 *  any unknown path. Content-type is what tells them apart. */
const fetchAsset = async (url: string): Promise<string | null> => {
  const res = await fetch(url);
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("javascript")) return null;
  return res.text();
};

const checkHealth = async (host: string): Promise<Record<string, unknown> | null> => {
  try {
    // `/health`, NOT `/api/health` — see the header comment.
    const res = await fetch(`${host}/health`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Stop expanding after this many chunks — a runaway guard, not a budget. */
const MAX_CHUNKS = 600;

/**
 * Every JS asset the SPA can reach, followed **transitively** from the entries
 * named in `index.html`.
 *
 * This used to walk exactly two levels: the entries, then the chunk names
 * appearing inside them. That held only while `index.html` pointed at a bundle
 * that itself named every page chunk. It stopped holding — the entry is now a
 * ~700-byte preload shim whose only import is `main-<hash>.js`, so the page
 * chunks sit at level THREE and were never fetched. The script kept reporting
 * "the live bundle predates them" for markers that were sitting in the
 * deployed bundle the whole time, which is worse than no check at all: a false
 * FAIL here reads as a broken deploy and invites a re-push or a rollback.
 *
 * So: expand to a fixpoint. Bundlers are free to add another layer of
 * indirection tomorrow and this keeps working.
 */
const collectChunks = async (host: string): Promise<Map<string, string>> => {
  const bodies = new Map<string, string>();
  const index = await (await fetch(`${host}/`)).text();

  let frontier = [...new Set(index.match(/\/assets\/[A-Za-z0-9._-]+\.js/g) ?? [])];

  while (frontier.length > 0 && bodies.size < MAX_CHUNKS) {
    const next = new Set<string>();
    for (const path of frontier) {
      if (bodies.has(path)) continue;
      const body = await fetchAsset(`${host}${path}`);
      if (!body) continue;
      bodies.set(path, body);
      // Chunk names appear as bare hashed filenames, whether they are static
      // imports or the string literal in a dynamic one.
      for (const name of body.match(/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js/g) ?? []) {
        const child = `/assets/${name}`;
        if (!bodies.has(child)) next.add(child);
      }
    }
    frontier = [...next];
  }

  return bodies;
};

const main = async () => {
  const { host, markers, waitSec } = parseArgs(process.argv.slice(2));
  console.log(`host    ${host}`);

  const deadline = Date.now() + waitSec * 1000;
  let health = await checkHealth(host);
  // Retry a couple of times even with no --wait. A deploy that is mid-roll
  // drops the occasional connection, and treating the first blip as "the
  // Worker is down" reports a healthy deploy as a failure — which is exactly
  // what happened the first time this script was run.
  for (let attempt = 0; !health && (attempt < 2 || Date.now() < deadline); attempt++) {
    console.log("        health not answering yet, retrying in 10s…");
    await sleep(10_000);
    health = await checkHealth(host);
  }
  if (!health) {
    console.error(`FAIL    ${host}/health did not answer`);
    process.exit(1);
  }
  console.log(`health  ${JSON.stringify(health)}`);

  if (markers.length === 0) {
    console.log("\nNo --marker given, so this only proves the Worker is up.");
    console.log("Pass a string that exists ONLY in the commit you just shipped");
    console.log("(a new provider id, a brand hex, a fresh route path) to prove WHICH");
    console.log("bundle is live — `wrangler deployments list` will not tell you.");
    return;
  }

  let chunks = await collectChunks(host);
  let missing = markers.filter((m) => ![...chunks.values()].some((b) => b.includes(m)));

  // A deploy that is still rolling serves the old bundle with a 200, so retry
  // the whole sweep rather than treating the first miss as a verdict.
  while (missing.length > 0 && Date.now() < deadline) {
    console.log(`        ${missing.length} marker(s) absent, re-checking in 20s…`);
    await sleep(20_000);
    chunks = await collectChunks(host);
    missing = markers.filter((m) => ![...chunks.values()].some((b) => b.includes(m)));
  }

  console.log(`assets  ${chunks.size} JS chunk(s) fetched`);
  for (const marker of markers) {
    const hit = [...chunks.entries()].find(([, body]) => body.includes(marker));
    console.log(hit ? `  ✓ ${marker} — ${hit[0]}` : `  ✗ ${marker} — NOT FOUND`);
  }

  if (missing.length > 0) {
    console.error(`\nFAIL    ${missing.length} marker(s) missing — the live bundle predates them`);
    process.exit(1);
  }
  console.log("\nOK      the live bundle carries every marker");
};

await main();
