/**
 * The admin resolved its page from the first path segment and fell back to
 * `initialNav` whenever that segment matched no nav id. So an unknown URL
 * rendered Overview while the address bar kept the path that was asked for:
 *
 *   /roles                 → Overview, URL stays /roles
 *   /definitely-not-a-page → Overview, URL stays /definitely-not-a-page
 *
 * `/roles` is the realistic case rather than a contrived one — the REST API has
 * `/api/roles`, so guessing it in the admin is natural, and the guess was
 * answered with a page that has nothing to do with roles.
 *
 * The codebase already knew this shape: the `/analytics/sites` redirect carries
 * a comment describing exactly it, one level down ("the unknown `segs[1]` falls
 * back to overview, and the address bar keeps saying /analytics/sites while
 * Overview renders"). That was fixed per-URL; this is the general case.
 */
import { describe, expect, test } from "bun:test";
import { LEGACY_NAV_REDIRECTS, isUnknownRoute } from "../../src/client/admin/config";

const NAV = new Set(["overview", "collections", "logs", "settings", "ext:acme:panel"]);
const ask = (firstSegment: string | undefined, extensionsPending = false) =>
  isUnknownRoute({ firstSegment, navIds: NAV, extensionsPending });

describe("isUnknownRoute", () => {
  test("a segment that matches no nav id is a miss", () => {
    expect(ask("roles")).toBe(true);
    expect(ask("definitely-not-a-page")).toBe(true);
    expect(ask("zzz")).toBe(true);
  });

  test("the root is not a miss", () => {
    expect(ask(undefined)).toBe(false);
    expect(ask("")).toBe(false);
  });

  test("every real nav id resolves", () => {
    for (const id of NAV) expect(ask(id)).toBe(false);
  });

  test("a legacy segment the redirect effect rewrites is never a miss", () => {
    // Otherwise /activity flashes "not found" for one frame on its way to /logs.
    // A Map, so each entry is [segment, destination]. Both halves matter:
    // a segment with no destination is a redirect that never happens, and
    // that is the case this gate would otherwise wave through as "not a
    // miss" while the fallback page renders under the original URL.
    for (const [id, to] of LEGACY_NAV_REDIRECTS) {
      expect(ask(id)).toBe(false);
      expect(to.startsWith("/")).toBe(true);
    }
    expect(ask("activity")).toBe(false);
  });

  test("nothing is a miss while the extensions query is still pending", () => {
    // `navIds` gains the ext:* panel ids only once that query resolves, so
    // answering early would flash "not found" over a good extension deep link
    // on every cold load. This is the assertion that keeps the gate honest.
    expect(ask("ext:not-yet-loaded:panel", true)).toBe(false);
    expect(ask("roles", true)).toBe(false);
    // …and once it has resolved, the same unknown segment IS a miss.
    expect(ask("ext:not-yet-loaded:panel", false)).toBe(true);
  });

  test("an extension panel id resolves once it is in the set", () => {
    expect(ask("ext:acme:panel")).toBe(false);
  });
});
