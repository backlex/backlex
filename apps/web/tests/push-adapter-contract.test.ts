/**
 * One conformance suite, run against every push backend — and against the
 * aggregator that fans out to them.
 *
 * `PushAdapter.send()` answers `{ sent, failed, invalidTokens }`, and each of
 * those numbers is acted on: the messaging service reports sent/failed to the
 * operator, and `invalidTokens` is the ONLY path by which a device token that
 * has been uninstalled leaves the `device_tokens` table. An adapter that never
 * reports one makes that table grow forever, and every future send re-attempts
 * a device that will never answer.
 *
 * Three of the five backends filter by platform (`t.platform === "fcm"` and so
 * on), which makes the accounting rule platform-relative: an adapter must
 * account for its OWN tokens and leave the others completely alone. Counting a
 * sibling's token as failed is the specific mistake that would make `multi`
 * report failures that never happened.
 *
 * **What is and is not exercised.** `multi` and `console` run for real —
 * `multi` against fake leaves, which is the honest way to test an aggregator.
 * `fcm`, `apns` and `web-push` each sign a JWT or a VAPID header with a real
 * private key before they reach the network, so constructing one here means
 * shipping a key or re-implementing the signing; they are named in the census
 * test below rather than skipped in silence.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { PushAdapter, PushMessage, PushSendResult, PushToken } from "@backlex/core/adapters";
import { multiPush } from "../src/server/adapters/push.multi";
import { consolePush } from "../src/server/adapters/push.console";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const tok = (platform: PushToken["platform"], n: number): PushToken => ({
  platform,
  token: `${platform}-token-${n}`,
  ...(platform === "web-push" ? { keys: { p256dh: "p", auth: "a" } } : {}),
});

const MSG = (tokens: PushToken[]): PushMessage => ({
  tokens,
  title: "Order shipped",
  body: "Your order is on its way.",
});

const accounted = (r: PushSendResult) => r.sent + r.failed;

/** A leaf that owns one platform and answers however the test needs. */
const fakeLeaf = (
  platform: PushToken["platform"],
  behaviour: "ok" | "fail" | "invalid" | "throw",
): PushAdapter => ({
  async send(msg) {
    const mine = msg.tokens.filter((t) => t.platform === platform);
    if (behaviour === "throw") throw new Error(`${platform} leaf exploded`);
    if (behaviour === "fail") return { sent: 0, failed: mine.length, invalidTokens: [] };
    if (behaviour === "invalid") {
      return { sent: 0, failed: mine.length, invalidTokens: mine.map((t) => t.token) };
    }
    return { sent: mine.length, failed: 0, invalidTokens: [] };
  },
});

describe("PushAdapter conformance — console", () => {
  test("accounts for every token and reports none invalid", async () => {
    const tokens = [tok("fcm", 1), tok("apns", 1), tok("web-push", 1)];
    const r = await consolePush().send(MSG(tokens));
    expect(`accounted ${accounted(r)} of ${tokens.length}`).toBe(
      `accounted ${tokens.length} of ${tokens.length}`,
    );
    expect(r.invalidTokens).toEqual([]);
  });

  test("an empty token list is zeros, not a crash", async () => {
    // The realistic case: a workspace with push configured and nobody
    // subscribed yet. Every send goes through this path first.
    const r = await consolePush().send(MSG([]));
    expect(r).toEqual({ sent: 0, failed: 0, invalidTokens: [] });
  });
});

describe("PushAdapter conformance — multi (the aggregator)", () => {
  const tokens = [tok("fcm", 1), tok("fcm", 2), tok("apns", 1), tok("web-push", 1)];

  test("sums its leaves rather than reporting one of them", async () => {
    const multi = multiPush([
      fakeLeaf("fcm", "ok"),
      fakeLeaf("apns", "ok"),
      fakeLeaf("web-push", "ok"),
    ]);
    const r = await multi.send(MSG(tokens));
    expect(`accounted ${accounted(r)} of ${tokens.length}`).toBe(
      `accounted ${tokens.length} of ${tokens.length}`,
    );
    expect(`sent ${r.sent}`).toBe(`sent ${tokens.length}`);
  });

  test("a platform with no leaf is not silently counted as sent", async () => {
    // Only fcm is configured. The two other tokens belong to nobody, and the
    // honest answer is that they were not sent — reporting them as delivered
    // is the shape that makes an operator stop looking for the bug.
    const multi = multiPush([fakeLeaf("fcm", "ok")]);
    const r = await multi.send(MSG(tokens));
    expect(`sent ${r.sent}`).toBe("sent 2");
    expect(`accounted ${accounted(r)}`).toBe("accounted 2");
  });

  test("invalid tokens from every leaf reach the caller for pruning", async () => {
    // Concatenated, not replaced. A reducer that overwrote instead of
    // appending would prune only the last platform's dead devices, and the
    // others would be retried on every send for the life of the workspace.
    const multi = multiPush([
      fakeLeaf("fcm", "invalid"),
      fakeLeaf("apns", "invalid"),
      fakeLeaf("web-push", "invalid"),
    ]);
    const r = await multi.send(MSG(tokens));
    expect(r.invalidTokens.sort()).toEqual(tokens.map((t) => t.token).sort());
  });

  test("one leaf failing does not discard the leaves that succeeded", async () => {
    const multi = multiPush([
      fakeLeaf("fcm", "ok"),
      fakeLeaf("apns", "fail"),
      fakeLeaf("web-push", "ok"),
    ]);
    const r = await multi.send(MSG(tokens));
    expect(`sent ${r.sent}`).toBe("sent 3");
    expect(`failed ${r.failed}`).toBe("failed 1");
  });

  test("one leaf THROWING does not discard the leaves that succeeded", async () => {
    // The sharp case, and the reason this file exists. `multi` USED to run its
    // leaves under `Promise.all`, so a leaf that threw for any unforeseen
    // reason — a bug, a null deref, a provider SDK raising instead of
    // returning — rejected the whole fan-out. The fcm and web-push pushes have
    // already gone out at that point; the caller saw an exception, recorded a
    // total failure for a partly-delivered send, and a retry re-notified every
    // device that already got it. Found by this suite; `allSettled` now.
    const multi = multiPush([
      fakeLeaf("fcm", "ok"),
      fakeLeaf("apns", "throw"),
      fakeLeaf("web-push", "ok"),
    ]);
    const r = await multi.send(MSG(tokens));
    // The two healthy platforms are still reported. That is the whole claim:
    // the send did not become an exception, and what actually went out is
    // still visible to the caller.
    expect(`sent ${r.sent}`).toBe("sent 3");
    // The throwing leaf contributes nothing rather than a guessed failure
    // count — `multi` does not know which platform a leaf owns, so it cannot
    // say how many tokens went unanswered, and inventing the number would be
    // worse than leaving it unaccounted. Same treatment as a token whose
    // platform has no leaf, asserted above.
    expect(`failed ${r.failed}`).toBe("failed 0");
    expect(`accounted ${accounted(r)}`).toBe("accounted 3");
  });

  test("no leaves at all is zeros rather than a crash", async () => {
    const r = await multiPush([]).send(MSG(tokens));
    expect(r).toEqual({ sent: 0, failed: 0, invalidTokens: [] });
  });
});

describe("the suite covers the backends that exist", () => {
  test("every push adapter file is either exercised or named as absent", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../src/server/adapters", import.meta.url))
      .filter((f) => /^push\..*\.ts$/.test(f))
      .map((f) => f.replace(/^push\.|\.ts$/g, ""))
      .sort();
    expect(files).toEqual(["apns", "cloud", "console", "fcm", "multi", "web-push"]);

    // Every file is either exercised or carries a reason. Asserted as a
    // partition of the census above, so a NEW adapter appearing beside these
    // six fails here — an earlier draft compared a literal to itself, which is
    // a test that can never fail and reports coverage it does not have.
    const EXERCISED = ["console", "multi"];
    const NOT_EXERCISED: Record<string, string> = {
      fcm: "signs a service-account JWT with a real private key before the network",
      apns: "signs an ES256 token with a real .p8 key before the network",
      "web-push": "signs a VAPID header with a real key pair before the network",
      cloud: "proxies to the managed control plane, whose conformance is its own",
    };
    expect([...EXERCISED, ...Object.keys(NOT_EXERCISED)].sort()).toEqual(files);
    // A reason has to be a reason, not a shrug.
    for (const [name, why] of Object.entries(NOT_EXERCISED)) {
      expect(`${name}: ${why.length > 40}`).toBe(`${name}: true`);
    }
  });
});
