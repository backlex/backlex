/**
 * The event-pattern syntax, checked against the documentation that teaches it.
 *
 * `matchesPattern` splits on `:` and compares against `` `${channel}:${event}` ``
 * — and a collection's channel is itself `items:<slug>`, so a create on `posts`
 * is `items:posts:created`. Every example in `docs/webhooks.md` and
 * `docs/sdk-and-cli.md` spelled it with dots, which is a SINGLE segment and can
 * never match anything.
 *
 * That combination is the worst one available: the hook is created (201), it
 * reads `active: true` in the list, and pressing **Test** succeeds — the test
 * send skips matching on purpose, because the operator picked the hook
 * directly. So the one check anybody runs passes, and the hook never fires.
 * Measured on a live workspace: three dotted hooks and one colon hook on the
 * same collection, one insert, exactly one delivery.
 *
 * This test reads the examples out of the docs rather than restating them, so
 * the prose cannot drift away from the matcher again.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchesPattern } from "../src/server/services/webhooks";

const docPath = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe("matchesPattern", () => {
  test("a collection create is matched by its full pattern, a prefix, or a wildcard", () => {
    for (const p of ["items:posts:created", "items:*:created", "items:posts", "items"]) {
      expect(matchesPattern(p, "items:posts", "created")).toBe(true);
    }
  });

  test("it does not match another collection, another event, or a dotted spelling", () => {
    expect(matchesPattern("items:orders:created", "items:posts", "created")).toBe(false);
    expect(matchesPattern("items:posts:deleted", "items:posts", "created")).toBe(false);
    // The shape every doc used to give.
    expect(matchesPattern("items.posts.created", "items:posts", "created")).toBe(false);
  });

  test("an event name containing a dot is still one segment", () => {
    // `test:webhook.test` is a real target — the dot lives INSIDE the event.
    expect(matchesPattern("test:webhook.test", "test", "webhook.test")).toBe(true);
    expect(matchesPattern("test", "test", "webhook.test")).toBe(true);
  });
});

describe("the documented examples actually match", () => {
  /** Every `items…created`-shaped literal the docs hand a reader. */
  const patternsIn = (file: string): string[] => {
    const text = readFileSync(docPath(file), "utf8");
    return [...text.matchAll(/items[.:][a-z_*]+[.:](?:created|updated|deleted)/g)].map((m) => m[0]);
  };

  test.each([["../../../docs/webhooks.md"], ["../../../docs/sdk-and-cli.md"]])(
    "%s",
    (file) => {
      const found = patternsIn(file);
      // A doc that stopped carrying examples would pass vacuously.
      expect(found.length).toBeGreaterThan(0);
      for (const p of found) {
        const [, slug, event] = p.split(/[.:]/);
        const collection = slug === "*" ? "anything" : (slug as string);
        expect({ p, matches: matchesPattern(p, `items:${collection}`, event as string) })
          .toEqual({ p, matches: true });
      }
    },
  );
});
