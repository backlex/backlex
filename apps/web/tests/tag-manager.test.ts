/**
 * Tag manager — drafts, compile, publish, rollback.
 *
 * The compile step is where this feature's safety actually lives, so most of
 * this spec is about what compile REFUSES to emit rather than what it emits.
 * Three failures in particular:
 *
 *  1. **A gate that only guards the write path.** `allow_custom_code` has to be
 *     re-checked at compile, or turning it off leaves existing custom tags
 *     firing on a customer's site forever.
 *  2. **A publish that fails wholesale.** One malformed tag must not stop an
 *     operator shipping the other nine — it gets dropped and reported.
 *  3. **A rollback that re-derives.** What goes live again must be the document
 *     that WAS live, not what today's compiler makes of today's rows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { getSiteById } from "../src/server/services/analytics";
import {
  compileContainer,
  createTag,
  createTrigger,
  createVariable,
  deleteTrigger,
  getPublishedArtifact,
  listVersions,
  publishContainer,
  rollbackContainer,
  updateTag,
} from "../src/server/services/tag-manager";

let h: TestHarness;
let db: any;
let SITE = "";
let TENANT: string | null = null;

const makeSite = async (name: string, domain: string): Promise<string> => {
  const r = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, domain }),
  });
  return ((await r.json()) as any).data.id;
};

/** Turn the per-site custom-code gate on or off, straight in the database —
 *  there is no admin route for it yet, and the point of these tests is compile
 *  behaviour rather than how the flag gets set. */
const setAllowCustomCode = async (siteId: string, allow: boolean) => {
  const ctx = await buildContext(h.env);
  const sqliteSchema = await import("@backlex/db/sqlite");
  await (ctx.db as any)
    .update(sqliteSchema.schema.analyticsSites)
    .set({ allowCustomCode: allow })
    .where((await import("drizzle-orm")).eq(sqliteSchema.schema.analyticsSites.id, siteId));
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect };
  SITE = await makeSite("Marketing", "tags.example");
  TENANT = (await getSiteById(db, SITE))!.tenantId;
});

afterAll(() => h.cleanup());

describe("compile", () => {
  test("a template tag on a pageview trigger compiles and publishes", async () => {
    const trigger = await createTrigger(db, TENANT, SITE, { name: "All pages", type: "pageview" });
    await createTag(
      db,
      TENANT,
      SITE,
      {
        name: "Meta Pixel",
        kind: "template",
        templateId: "meta_pixel",
        params: { pixelId: "1234567890" },
        triggerIds: [trigger.id],
      },
      "u1",
    );

    const { artifact, dropped } = await compileContainer(db, TENANT, SITE);
    expect(dropped).toEqual([]);
    expect(artifact.v).toBe(1);
    expect(artifact.site).toBe(SITE);
    expect(artifact.tags).toHaveLength(1);
    expect(artifact.tags[0]?.template).toBe("meta_pixel");
    expect(artifact.tags[0]?.params).toEqual({ pixelId: "1234567890" });
    expect(artifact.triggers[0]?.type).toBe("pageview");

    const { version } = await publishContainer(db, TENANT, SITE, { note: "first" }, "u1");
    expect(version.version).toBe(1);
    expect(version.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the hash is stable across two compiles of unchanged rows", async () => {
    // An unstable hash would make every publish look like a change and defeat
    // the ETag the container endpoint serves.
    const a = await compileContainer(db, TENANT, SITE);
    const b = await compileContainer(db, TENANT, SITE);
    expect(JSON.stringify(a.artifact)).toBe(JSON.stringify(b.artifact));
  });

  test("a disabled tag is left out entirely, and is not reported as dropped", async () => {
    // Disabled is an operator's deliberate choice, not a fault — surfacing it
    // as a problem would train them to ignore the list that matters.
    const site = await makeSite("Disabled", "disabled.example");
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    await createTag(
      db,
      TENANT,
      site,
      { name: "Off", kind: "template", templateId: "snap_pixel", params: { pixelId: "abc" }, triggerIds: [tr.id], enabled: false },
      "u1",
    );
    const { artifact, dropped } = await compileContainer(db, TENANT, site);
    expect(artifact.tags).toHaveLength(0);
    expect(dropped).toEqual([]);
  });

  test("a tag whose only trigger stopped existing is dropped, with a reason", async () => {
    // Emitting it would put a dead entry in every visitor's download and make
    // the admin's "published" state a lie.
    const site = await makeSite("Orphan", "orphan.example");
    const tr = await createTrigger(db, TENANT, site, { name: "Gone", type: "pageview" });
    await createTag(
      db,
      TENANT,
      site,
      { name: "Orphaned", kind: "template", templateId: "snap_pixel", params: { pixelId: "abc" }, triggerIds: [tr.id] },
      "u1",
    );
    await deleteTrigger(db, TENANT, tr.id);

    const { artifact, dropped } = await compileContainer(db, TENANT, site);
    expect(artifact.tags).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.kind).toBe("tag");
    expect(dropped[0]?.reason).toContain("trigger");
  });

  test("one broken tag does not stop the others publishing", async () => {
    const site = await makeSite("Mixed", "mixed.example");
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    const good = await createTag(
      db,
      TENANT,
      site,
      { name: "Good", kind: "template", templateId: "snap_pixel", params: { pixelId: "ok" }, triggerIds: [tr.id] },
      "u1",
    );
    const bad = await createTag(
      db,
      TENANT,
      site,
      { name: "Bad", kind: "template", templateId: "snap_pixel", params: { pixelId: "ok" }, triggerIds: [tr.id] },
      "u1",
    );
    // Break one the way reality would: a template tightened, or a row was
    // edited around the API. Simulated by clearing the required parameter.
    await updateTag(db, TENANT, bad.id, { params: {} }, "u1").catch(() => {});
    const ctx = await buildContext(h.env);
    const s = await import("@backlex/db/sqlite");
    const { eq } = await import("drizzle-orm");
    await (ctx.db as any)
      .update(s.schema.tagDefinitions)
      .set({ params: {} })
      .where(eq(s.schema.tagDefinitions.id, bad.id));

    const { artifact, dropped } = await compileContainer(db, TENANT, site);
    expect(artifact.tags.map((t) => t.id)).toEqual([good.id]);
    expect(dropped.map((d) => d.id)).toEqual([bad.id]);
  });
});

describe("the custom-code gate", () => {
  test("a custom tag is refused while the site flag is off", async () => {
    const site = await makeSite("Locked", "locked.example");
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    await expect(
      createTag(
        db,
        TENANT,
        site,
        { name: "Custom", kind: "custom_js", params: { code: "console.log(1)" }, triggerIds: [tr.id] },
        "u1",
      ),
    ).rejects.toThrow();
  });

  test("turning the flag OFF disables custom tags that already exist", async () => {
    // The whole reason the gate is re-checked at compile. Enforcing it only on
    // write would leave these firing on a customer's site forever.
    const site = await makeSite("Revoked", "revoked.example");
    await setAllowCustomCode(site, true);
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    await createTag(
      db,
      TENANT,
      site,
      { name: "Custom", kind: "custom_js", params: { code: "console.log(1)" }, triggerIds: [tr.id] },
      "u1",
    );
    expect((await compileContainer(db, TENANT, site)).artifact.tags).toHaveLength(1);

    await setAllowCustomCode(site, false);
    const after = await compileContainer(db, TENANT, site);
    expect(after.artifact.tags).toHaveLength(0);
    expect(after.dropped[0]?.reason.toLowerCase()).toContain("custom code");
  });

  test("a js_expression variable rides the same gate, not a looser one", async () => {
    const site = await makeSite("Expr", "expr.example");
    await setAllowCustomCode(site, true);
    await createVariable(db, TENANT, site, {
      key: "page_type",
      kind: "js_expression",
      config: { code: "document.body.dataset.type" },
    });
    expect((await compileContainer(db, TENANT, site)).artifact.variables).toHaveLength(1);

    await setAllowCustomCode(site, false);
    const after = await compileContainer(db, TENANT, site);
    expect(after.artifact.variables).toHaveLength(0);
    expect(after.dropped[0]?.kind).toBe("variable");
  });
});

describe("an image pixel is a URL, and only one kind of URL", () => {
  test("https is accepted, everything else is not", async () => {
    // This value becomes an `<img src>` on someone else's page, so a
    // `javascript:` or `data:` URL has to be impossible rather than unlikely.
    const site = await makeSite("Pixels", "pixels.example");
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    const ok = await createTag(
      db,
      TENANT,
      site,
      { name: "Px", kind: "image_pixel", params: { url: "https://example.test/p.gif" }, triggerIds: [tr.id] },
      "u1",
    );
    expect(ok.id).toBeTruthy();

    for (const url of ["javascript:alert(1)", "data:text/html,<script>", "http://example.test/p.gif", "not a url"]) {
      await expect(
        createTag(db, TENANT, site, { name: "Bad", kind: "image_pixel", params: { url }, triggerIds: [tr.id] }, "u1"),
      ).rejects.toThrow();
    }
  });
});

describe("publish and rollback", () => {
  test("rollback restores the artifact byte for byte, not a re-compile", async () => {
    const site = await makeSite("Versions", "versions.example");
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    const tag = await createTag(
      db,
      TENANT,
      site,
      { name: "V1", kind: "template", templateId: "snap_pixel", params: { pixelId: "one" }, triggerIds: [tr.id] },
      "u1",
    );
    await publishContainer(db, TENANT, site, { note: "v1" }, "u1");
    const v1 = await getPublishedArtifact(db, site);

    await updateTag(db, TENANT, tag.id, { params: { pixelId: "two" } }, "u1");
    await publishContainer(db, TENANT, site, { note: "v2" }, "u1");
    const v2 = await getPublishedArtifact(db, site);
    expect((v2!.artifact.tags[0]?.params as any).pixelId).toBe("two");
    expect(v2!.hash).not.toBe(v1!.hash);

    await rollbackContainer(db, TENANT, site, 1);
    const back = await getPublishedArtifact(db, site);
    expect(back!.version).toBe(1);
    expect(back!.hash).toBe(v1!.hash);
    expect(JSON.stringify(back!.artifact)).toBe(JSON.stringify(v1!.artifact));
    // The DRAFT still says "two" — rolling back what is served does not undo
    // an operator's edits.
    const draft = await compileContainer(db, TENANT, site);
    expect((draft.artifact.tags[0]?.params as any).pixelId).toBe("two");
  });

  test("editing a draft does not change what is served", async () => {
    const site = await makeSite("Draft", "draft.example");
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    const tag = await createTag(
      db,
      TENANT,
      site,
      { name: "T", kind: "template", templateId: "snap_pixel", params: { pixelId: "published" }, triggerIds: [tr.id] },
      "u1",
    );
    await publishContainer(db, TENANT, site, {}, "u1");
    await updateTag(db, TENANT, tag.id, { params: { pixelId: "edited" } }, "u1");

    const live = await getPublishedArtifact(db, site);
    expect((live!.artifact.tags[0]?.params as any).pixelId).toBe("published");
  });

  test("a site that has never published serves nothing", async () => {
    const site = await makeSite("Never", "never.example");
    expect(await getPublishedArtifact(db, site)).toBeNull();
  });

  test("version numbers are monotonic per site", async () => {
    const site = await makeSite("Counting", "counting.example");
    const tr = await createTrigger(db, TENANT, site, { name: "All", type: "pageview" });
    await createTag(
      db,
      TENANT,
      site,
      { name: "T", kind: "template", templateId: "snap_pixel", params: { pixelId: "x" }, triggerIds: [tr.id] },
      "u1",
    );
    for (let i = 0; i < 3; i++) await publishContainer(db, TENANT, site, {}, "u1");
    expect((await listVersions(db, TENANT, site)).map((v) => v.version)).toEqual([3, 2, 1]);
  });
});

describe("tenant scoping", () => {
  test("a foreign tenant cannot write against this workspace's site", async () => {
    // Every query is tenant-scoped, so a cross-tenant read is impossible. What
    // this stops is writing a row carrying your tenant id and someone else's
    // site id — orphaned rows that surface much later as "my tag does not fire".
    await expect(
      createTrigger(db, "some-other-tenant", SITE, { name: "Nope", type: "pageview" }),
    ).rejects.toThrow();
    await expect(compileContainer(db, "some-other-tenant", SITE)).rejects.toThrow();
  });

  test("a foreign tenant cannot roll back this workspace's container", async () => {
    await expect(rollbackContainer(db, "some-other-tenant", SITE, 1)).rejects.toThrow();
  });
});
