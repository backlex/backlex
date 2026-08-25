/**
 * A release the SDK is owed has to be visible before a customer finds it.
 *
 * On 2026-08-26 npm held `backlex@0.2.0` from 3 July while `packages/client`
 * had moved 131 commits and 32 public namespaces past it — under the same
 * version number, so no dependency tool could see the gap. Fifteen doc pages
 * described namespaces the published client did not have.
 *
 * It was not neglect of a broken pipeline. The pipeline fired **51 times** in
 * that window — at `worker-v*`, the tag that reaches live cloud tenants.
 * `backlex-v*` and `cli-v*` both stopped on the same day. The reason is
 * structural: a feature commit ships `docs/<feature>.md`, its sidebar entry and
 * the SDK namespace **together**, so merging publishes the documentation and
 * the worker template while the npm package stays put — and nothing inside the
 * repo consumes the published artifact (the examples use `workspace:*`), so no
 * test, build or example could notice.
 *
 * This is the missing feedback loop, and it is deliberately about *intent*, not
 * about npm: it cannot reach the registry from CI, and it should not try. It
 * asserts only that a surface change is accompanied by a version bump, which is
 * what makes the owed release show up in the diff, in `package.json`, and to
 * the reviewer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../../../packages/client/src/index";

const CLIENT_DIR = join(import.meta.dir, "../../../packages/client");

const read = <T>(file: string): T => JSON.parse(readFileSync(join(CLIENT_DIR, file), "utf8")) as T;

describe("SDK release drift", () => {
  const pkg = read<{ version: string }>("package.json");
  const recorded = read<{ version: string; namespaces: string[] }>("published-surface.json");
  const live = Object.keys(createClient({ url: "" })).sort();

  test("a public-surface change comes with a version bump", () => {
    const added = live.filter((n) => !recorded.namespaces.includes(n));
    const removed = recorded.namespaces.filter((n) => !live.includes(n));
    if (added.length === 0 && removed.length === 0) return; // nothing to release

    // The surface moved. The version must say so — that is the whole check.
    const detail = [
      added.length ? `added: ${added.join(", ")}` : "",
      removed.length ? `REMOVED (breaking): ${removed.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    expect(
      pkg.version,
      `The SDK's public surface has moved since ${recorded.version} was published (${detail}), ` +
        "but packages/client/package.json still says the same version. Bump it — a minor for " +
        "added namespaces, a major for a removed one — then run " +
        "`bun run --cwd packages/client surface:record` to restate what the release covers. " +
        "Publishing is a separate step (push a `backlex-v<version>` tag); this only asks that " +
        "the owed release be visible in the diff, because the last time it was not, npm sat " +
        "eight weeks behind while fifteen doc pages described the newer client.",
    ).not.toBe(recorded.version);
  });

  test("the recorded surface is a real snapshot, not an empty placeholder", () => {
    // A manifest that drifted to `[]` would make the check above pass forever.
    expect(recorded.namespaces.length).toBeGreaterThan(5);
    expect(recorded.namespaces).toContain("auth");
    expect(recorded.namespaces).toContain("from");
    expect(/^\d+\.\d+\.\d+$/.test(recorded.version)).toBe(true);
  });

  test("the version only ever moves forward", () => {
    const n = (v: string) => v.split(".").map(Number);
    const [aM, am, ap] = n(pkg.version);
    const [bM, bm, bp] = n(recorded.version);
    const ahead =
      (aM ?? 0) > (bM ?? 0) ||
      ((aM ?? 0) === (bM ?? 0) && (am ?? 0) > (bm ?? 0)) ||
      ((aM ?? 0) === (bM ?? 0) && (am ?? 0) === (bm ?? 0) && (ap ?? 0) >= (bp ?? 0));
    expect(ahead, `package.json ${pkg.version} is behind the recorded ${recorded.version}`).toBe(true);
  });
});
