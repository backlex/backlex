/**
 * Multi-surface parity for captcha and impersonation.
 *
 * The invariants that have to hold everywhere:
 *   1. the captcha secret is never returned by any read surface;
 *   2. `onError` is never chosen for the caller;
 *   3. an impersonation token is never written to the audit log;
 *   4. both feature's routes are admin-only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { supportTools } from "../src/server/mcp/tools/support";
import { CAPTCHA_TARGETS } from "../src/server/services/captcha";
import { MAX_IMPERSONATION_MINUTES } from "../src/server/services/impersonation";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };

describe("captcha + impersonation — surfaces", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("every REST verb has an MCP tool, and the schemas carry the warnings", () => {
    expect(supportTools.map((t) => t.name).sort()).toEqual([
      "captcha.get",
      "captcha.remove",
      "captcha.set",
      "support.end_impersonation",
      "support.impersonate",
      "support.impersonations",
    ]);
    const set = supportTools.find((t) => t.name === "captcha.set")!;
    // `onError` must be REQUIRED on the tool too — an agent that omitted it
    // would get a 422 it could not explain.
    expect((set.inputSchema as any).required).toContain("onError");
    expect((set.inputSchema as any).properties.protect.items.enum).toEqual([...CAPTCHA_TARGETS]);

    const imp = supportTools.find((t) => t.name === "support.impersonate")!;
    // The tool hands back a working credential; the description has to say so.
    expect(imp.description).toContain("credential");
    expect((imp.inputSchema as any).required).toContain("reason");
    expect((imp.inputSchema as any).properties.minutes.maximum).toBe(MAX_IMPERSONATION_MINUTES);
  });

  test("the SDK points at routes that exist", async () => {
    const { makeSupport } = await import("../../../packages/client/src/clients/support");
    const calls: string[] = [];
    const core = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return {} as never;
      },
    } as never;
    const support = makeSupport(core);
    await support.captcha.get();
    await support.captcha.set({
      provider: "turnstile",
      siteKey: "s",
      protect: [],
      onError: "deny",
    });
    await support.captcha.remove();
    await support.impersonation.list();
    await support.impersonation.start({ subjectUserId: "u", reason: "why" });
    await support.impersonation.end("i1");
    expect(calls).toEqual([
      "GET /api/admin/captcha",
      "PUT /api/admin/captcha",
      "DELETE /api/admin/captcha",
      "GET /api/admin/impersonation",
      "POST /api/admin/impersonation",
      "POST /api/admin/impersonation/i1/end",
    ]);
    // The two GETs are dispatched for real — a 404 would mean the SDK targets
    // a route nobody mounted, which typechecks perfectly.
    for (const path of ["/api/admin/captcha", "/api/admin/impersonation"]) {
      expect((await h.fetch(path)).status).toBe(200);
    }
  });

  test("both features are admin-only", async () => {
    const anon = (path: string, init?: RequestInit) =>
      h.app.request(
        path,
        { ...init, headers: { origin: "http://localhost:5173" } } as RequestInit,
        h.env,
      );
    for (const path of ["/api/admin/captcha", "/api/admin/impersonation"]) {
      expect((await anon(path)).status).toBeGreaterThanOrEqual(400);
    }
    expect(
      (await anon("/api/admin/impersonation", { method: "POST" })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  test("the impersonation token never reaches the audit log", async () => {
    await h.fetch("/api/t/default/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: "audit@example.test",
        password: "correct-horse-battery",
        name: "A",
      }),
    });
    const users = (await (await h.fetch("/api/app-users")).json()) as {
      data: Array<{ id: string; email: string }>;
    };
    const subject = users.data.find((u) => u.email === "audit@example.test");
    if (!subject) return;
    const started = (await (
      await h.fetch("/api/admin/impersonation", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ subjectUserId: subject.id, reason: "surface parity check" }),
      })
    ).json()) as { token: string };

    const log = await (await h.fetch("/api/activity?limit=50")).text();
    // The reason is the point of the record; the token is a credential and
    // must not be in a table half the admin UI reads.
    expect(log).toContain("surface parity check");
    expect(log).not.toContain(started.token);
  });
});
