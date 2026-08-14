/**
 * The admin and the SDK each name the data-plane signal transport, and they
 * must not drift.
 *
 * `admin/lib/signal.ts` declares its own `ItemsTransportKind` and builds the
 * `signal:items:<slug>` channel string by hand; `packages/client/src/signal.ts`
 * exports both. That looks like duplication to delete, and deleting it is the
 * wrong move: `apps/web` does not depend on the SDK package, and making it
 * depend on one to import a type and a template literal would create exactly
 * the edge that invites the next reader to route admin requests through the SDK
 * too — which silently breaks read-your-writes on D1 (see
 * `docs/architecture.md`, "Why the admin keeps its own client").
 *
 * So this is the same call `E164_PATTERN` / `E164_RE` got in #43: two twins
 * that span a dependency boundary get a TEST, not a merge. The cost of the
 * duplication is that they can disagree; this is what makes that a failing
 * build instead of a realtime channel nobody is listening on.
 *
 * A source scan rather than an import, because importing the admin module would
 * pull in `import.meta.env` and a dynamic `ably` import for no benefit — what
 * is being compared is the literal each file declares.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signalChannel } from "../../../../packages/client/src/signal";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const adminSignal = readFileSync(
  join(REPO, "apps", "web", "src", "client", "admin", "lib", "signal.ts"),
  "utf8",
);
const sdkSignal = readFileSync(
  join(REPO, "packages", "client", "src", "signal.ts"),
  "utf8",
);

/** The right-hand side of `export type ItemsTransportKind = …;`, normalized. */
const transportUnion = (src: string): string[] => {
  const m = src.match(/export type ItemsTransportKind =([^;]+);/);
  if (!m) throw new Error("no `ItemsTransportKind` declaration to read");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
};

describe("signal transport — the admin and the SDK agree", () => {
  test("both declare the same set of transports", () => {
    const admin = transportUnion(adminSignal);
    // Sanity: a regex that stopped matching would otherwise compare two empty
    // lists and pass.
    expect(admin.length).toBeGreaterThanOrEqual(3);
    expect(admin).toEqual(transportUnion(sdkSignal));
  });

  test("both address the same channel for a collection", () => {
    // The SDK's builder is the definition. Rather than compare it to a string
    // written here — which would only test the SDK against itself — the
    // admin's literal is turned back into a channel by substituting the slug,
    // and THAT is what is compared.
    const template = adminSignal.match(/`(signal:[^`$]*)\$\{(\w+)\}`/);
    expect(
      template,
      "the admin no longer builds a `signal:…` channel from a slug inline — re-point this test",
    ).not.toBeNull();

    const adminChannel = `${template![1]}orders`;
    expect(adminChannel).toBe(signalChannel("orders"));
  });

  test("the server publishes to that same channel", () => {
    // The third copy, and the one that decides whether either listener hears
    // anything at all.
    const server = readFileSync(
      join(REPO, "apps", "web", "src", "server", "services", "realtime-signal.ts"),
      "utf8",
    );
    expect(server).toContain("signal:items:");
  });
});
