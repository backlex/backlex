import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/** Zero-touch: the cloud-selected SEED_TEMPLATE seeds collections into the
 *  default workspace when the first (cloud-seeded admin) user signs up. */
describe("SEED_TEMPLATE zero-touch", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness({ SEED_TEMPLATE: "blog" });
    await seedAdmin(h); // first user → onUserCreated → default tenant + applyTemplate
  });
  afterAll(() => h.cleanup());

  test("first user's default workspace has the template's collections", async () => {
    const list = await h.fetch("/api/collections");
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: { slug: string }[] };
    const slugs = listed.data.map((c) => c.slug);
    expect(slugs).toContain("posts");
    expect(slugs).toContain("categories");
    expect(slugs).toContain("authors");
  });
});
