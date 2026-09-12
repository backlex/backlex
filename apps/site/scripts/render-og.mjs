/**
 * Renders apps/site/scripts/og-card.html to apps/site/public/og.png (1200x630).
 *
 *     bun apps/site/scripts/render-og.mjs
 *
 * Deliberately dependency-free: it drives a headless Chrome that is already on
 * the machine via `--screenshot`, rather than adding puppeteer to a static
 * marketing site that has no other use for it. Point CHROME_PATH at a binary to
 * override the search.
 *
 * The card needs the network: og-card.html pulls Lexend and JetBrains Mono from
 * Google Fonts, and without them the PNG renders in the fallback face. That is
 * why the output is COMMITTED — the deploy never renders it.
 *
 * `--screenshot` exits 0 and writes a valid PNG even when the page failed to
 * load, so this script verifies what came out instead of trusting the exit
 * code. A missing source file produced a perfectly well-formed 1200x630 PNG of
 * Chrome's error page (15 KB) once; that is what MIN_BYTES catches.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 1200;
const HEIGHT = 630;
/** The real card is ~330 KB; Chrome's error page is ~16 KB. */
const MIN_BYTES = 120_000;

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "og-card.html");
const target = resolve(here, "..", "public", "og.png");

/** Every Chrome this repo might find, cheapest guess first. */
function* candidates() {
  if (process.env.CHROME_PATH) yield process.env.CHROME_PATH;

  // Whatever puppeteer or playwright downloaded for some other tool.
  const caches = [
    join(homedir(), ".cache/puppeteer/chrome"),
    join(homedir(), "Library/Caches/ms-playwright"),
  ];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache).sort().reverse()) {
      for (const suffix of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-linux64/chrome",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-linux/chrome",
      ]) {
        yield join(cache, entry, suffix);
      }
    }
  }

  yield "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  yield "/usr/bin/google-chrome";
  yield "/usr/bin/chromium";
}

function findChrome() {
  for (const path of candidates()) {
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // not this one
    }
  }
  return null;
}

/** Reads width/height straight out of the PNG IHDR chunk. */
function pngSize(path) {
  const head = readFileSync(path).subarray(0, 24);
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

const chrome = findChrome();
if (!chrome) {
  console.error(
    "render-og: no Chrome found. Install one, or set CHROME_PATH to a binary.",
  );
  process.exit(1);
}

const run = spawnSync(
  chrome,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${WIDTH},${HEIGHT}`,
    // Let the webfonts arrive before the shutter; virtual time, not wall clock.
    "--virtual-time-budget=12000",
    `--screenshot=${target}`,
    `file://${source}`,
  ],
  { encoding: "utf8" },
);

if (run.error) {
  console.error(`render-og: could not run ${chrome}: ${run.error.message}`);
  process.exit(1);
}

if (!existsSync(target)) {
  console.error(`render-og: ${chrome} wrote nothing to ${target}`);
  if (run.stderr) console.error(run.stderr.trim());
  process.exit(1);
}

const bytes = statSync(target).size;
const size = pngSize(target);

if (!size || size.width !== WIDTH || size.height !== HEIGHT) {
  console.error(
    `render-og: expected a ${WIDTH}x${HEIGHT} PNG, got ${size ? `${size.width}x${size.height}` : "something that is not a PNG"}`,
  );
  process.exit(1);
}

if (bytes < MIN_BYTES) {
  console.error(
    `render-og: ${target} is only ${bytes} bytes, under the ${MIN_BYTES} floor.\n` +
      "That is the shape of a render that failed while still exiting 0 — most\n" +
      "likely the page did not load. Open it in a browser and look:\n" +
      `  file://${source}`,
  );
  process.exit(1);
}

console.log(`render-og: ${target} — ${size.width}x${size.height}, ${bytes} bytes`);
