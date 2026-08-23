/**
 * Tag manager — the admin REST surface.
 *
 * A tag is JavaScript that runs on a public website, so the first thing this
 * spec checks is who is allowed to create one. The rest walks the loop an
 * operator actually performs: configure, see what would publish, publish, then
 * get the snippet and the Content-Security-Policy their own site will need.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let SITE = "";

const api = (path: string, init?: RequestInit) =>
  h.fetch(`/api/admin/tag-manager${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

const json = async (res: Response) => (await res.json()) as any;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const site = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Shop", domain: "shop.example" }),
  });
  SITE = (await json(site)).data.id;
});

afterAll(() => h.cleanup());

describe("who may manage tags", () => {
  test("an anonymous caller is refused", async () => {
    const anon = makeHarness();
    const res = await anon.fetch("/api/admin/tag-manager/vocabulary");
    expect([401, 403]).toContain(res.status);
    anon.cleanup();
  });
});

describe("the vocabulary the admin builds its forms from", () => {
  test("templates, trigger types and fields are served rather than duplicated", async () => {
    // A client that hardcoded any of this would go stale the first time a
    // vendor is added, and the staleness would look like a broken tag.
    const data = (await json(await api("/vocabulary"))).data;
    expect(data.templates.length).toBeGreaterThan(10);
    expect(data.triggerTypes).toContain("pageview");
    expect(data.fields).toContain("pagePath");
    expect(data.tagKinds).toContain("custom_js");
    // Each template carries whether the VENDOR documents its id format, so the
    // admin can say so instead of implying a rule that does not exist.
    const meta = data.templates.find((t: any) => t.id === "meta_pixel");
    expect(meta.params[0].formatDocumented).toBe(false);
  });
});

describe("the loop an operator walks", () => {
  let triggerId = "";
  let tagId = "";

  test("create a trigger", async () => {
    const res = await api(`/sites/${SITE}/triggers`, {
      method: "POST",
      body: JSON.stringify({ name: "All pages", type: "pageview" }),
    });
    expect(res.status).toBe(201);
    triggerId = (await json(res)).data.id;
  });

  test("create a tag on it", async () => {
    const res = await api(`/sites/${SITE}/tags`, {
      method: "POST",
      body: JSON.stringify({
        name: "Meta Pixel",
        kind: "template",
        templateId: "meta_pixel",
        params: { pixelId: "1234509876" },
        triggerIds: [triggerId],
      }),
    });
    expect(res.status).toBe(201);
    tagId = (await json(res)).data.id;
  });

  test("a custom-code tag is refused while the site's gate is shut", async () => {
    // The site flag defaults to off, and the message has to point at the flag —
    // "forbidden" alone would send an operator hunting through roles.
    const res = await api(`/sites/${SITE}/tags`, {
      method: "POST",
      body: JSON.stringify({
        name: "Custom",
        kind: "custom_js",
        params: { code: "console.log(1)" },
        triggerIds: [triggerId],
      }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await json(res)).toLowerCase()).toContain("custom code");
  });

  test("compile shows what would publish, and writes nothing", async () => {
    const before = await json(await api(`/sites/${SITE}/versions`));
    const compiled = (await json(await api(`/sites/${SITE}/compile`))).data;
    expect(compiled.artifact.tags).toHaveLength(1);
    expect(compiled.dropped).toEqual([]);
    const after = await json(await api(`/sites/${SITE}/versions`));
    expect(after.data.length).toBe(before.data.length);
  });

  test("publish, and the version is listed", async () => {
    const res = await api(`/sites/${SITE}/publish`, {
      method: "POST",
      body: JSON.stringify({ note: "first" }),
    });
    expect(res.status).toBe(201);
    const published = (await json(res)).data;
    expect(published.version.version).toBe(1);

    const versions = (await json(await api(`/sites/${SITE}/versions`))).data;
    expect(versions[0].version).toBe(1);
    expect(versions[0].note).toBe("first");
  });

  test("editing after a publish leaves what visitors receive alone", async () => {
    await api(`/tags/${tagId}`, {
      method: "PATCH",
      body: JSON.stringify({ params: { pixelId: "5555555555" } }),
    });
    const live = await h.fetch(`/api/analytics/tm/${SITE}.js`);
    expect(await live.text()).toContain("1234509876");
  });

  test("publish again, then roll back to the first", async () => {
    await api(`/sites/${SITE}/publish`, { method: "POST", body: JSON.stringify({}) });
    const v2 = await h.fetch(`/api/analytics/tm/${SITE}.js`);
    expect(await v2.text()).toContain("5555555555");

    const res = await api(`/sites/${SITE}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(res.status).toBe(200);
    const versions = (await json(await api(`/sites/${SITE}/versions`))).data;
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);

    // And what visitors receive goes back with it. Publishing and rolling back
    // both drop the per-isolate memo in front of the container endpoint —
    // without that an operator publishes, opens their site, sees the old
    // container, and reasonably concludes the publish failed.
    const rolled = await h.fetch(`/api/analytics/tm/${SITE}.js`);
    const body = await rolled.text();
    expect(body).toContain("1234509876");
    expect(body).not.toContain("5555555555");
  });

  test("install gives the snippet and the CSP the customer's own site needs", async () => {
    const data = (await json(await api(`/sites/${SITE}/install`))).data;
    // The CANONICAL path. What an operator is told to paste is the one path
    // whose name matches what it serves — a site's whole script, not the tag
    // manager's alone. `/api/analytics/tm/` keeps answering forever for pages
    // that already pasted it, but nothing is handed it fresh.
    expect(data.snippet).toContain(`/api/site/${SITE}.js`);
    expect(data.snippet).not.toContain("/api/analytics/tm/");
    expect(data.snippet).toContain("defer");
    // Generated from the templates THIS container holds — a site running one
    // pixel should not be told to allow four origins.
    expect(data.csp.script).toEqual(["https://connect.facebook.net"]);
    expect(data.csp.script).not.toContain("https://sc-static.net");
  });

  test("deleting the trigger leaves the tag with nothing to fire on", async () => {
    await api(`/triggers/${triggerId}`, { method: "DELETE" });
    const compiled = (await json(await api(`/sites/${SITE}/compile`))).data;
    expect(compiled.artifact.tags).toHaveLength(0);
    expect(compiled.dropped[0].kind).toBe("tag");
  });
});
