/**
 * Nothing writes a workspace colour that the theme migration would overwrite.
 *
 * `20260520190000_workspace_theme_colors` reseeds `tenants.color` for every row
 * where `color IS NULL OR color NOT LIKE 'var(--%'`, and its comment states the
 * premise: "pre-theme rows hold static oklch() literals" — a HISTORICAL
 * population, replaced once.
 *
 * The premise was false. `routes/tenants.ts` (workspace create) used theme
 * tokens, but `services/seed.ts` (`ensureDefaultTenant` — the default workspace
 * every provisioned instance gets) used raw `oklch(…)` literals, so the
 * population was regenerated on every provision. #329 asked for a measurement
 * expecting zero; the live D1s answered four of five, all holding
 * `oklch(0.7 0.16 28)`, which is the seeder's value for the slug `default`.
 *
 * The migration file is released and immutable — both ledgers key on its
 * sha256 — so the fix is on the WRITE side, and this is the guard for it.
 *
 * The predicate is the migration's own `WHERE`, restated in
 * `wouldBeReseededByThemeMigration`, rather than a hand-written list of good
 * strings. A list would be correct today and stale the moment the palette
 * grows, which is the shape that let the two palettes drift apart in the first
 * place.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  TENANT_TILE_PALETTE,
  tenantColorFor,
  wouldBeReseededByThemeMigration,
} from "../src/server/lib/tenant-palette";

const MIGRATION = join(
  import.meta.dir,
  "../../../packages/db/drizzle/sqlite/20260520190000_workspace_theme_colors/migration.sql",
);

describe("the workspace tile palette", () => {
  test("the predicate really is the migration's own WHERE", () => {
    // The whole file rests on this restatement being faithful. Read the SQL and
    // check the clause is still the one being modelled — if the migration is
    // ever superseded by one with a different rule, this goes red rather than
    // quietly guarding the wrong thing.
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("color IS NULL OR color NOT LIKE 'var(--%'");
  });

  test("every palette entry survives the migration", () => {
    expect(TENANT_TILE_PALETTE.length).toBeGreaterThan(1);
    for (const c of TENANT_TILE_PALETTE) {
      expect({ c, reseeded: wouldBeReseededByThemeMigration(c) }).toEqual({ c, reseeded: false });
    }
  });

  test("the predicate is not vacuously false", () => {
    // Without this, a `wouldBeReseededByThemeMigration` that always answered
    // `false` would make every assertion here pass. These are the values the
    // seeder used to write, and NULL.
    for (const c of ["oklch(0.7 0.16 28)", "oklch(0.78 0.16 95)", "#ff0000", "", null]) {
      expect({ c, reseeded: wouldBeReseededByThemeMigration(c) }).toEqual({ c, reseeded: true });
    }
  });

  test("the seeder's colour is stable per slug and survives the migration", () => {
    // Stability matters: a random pick would give the default workspace a
    // different tile on every fresh provision of the same instance.
    expect(tenantColorFor("default")).toBe(tenantColorFor("default"));
    for (const slug of ["default", "acme", "anadolu-toptan", "emr", "ecommerce", "canary"]) {
      expect({ slug, reseeded: wouldBeReseededByThemeMigration(tenantColorFor(slug)) }).toEqual({
        slug,
        reseeded: false,
      });
    }
  });
});

describe("a workspace created through the product", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("the SEEDED default workspace is born with a theme token", async () => {
    // The row `ensureDefaultTenant` writes — the one four of five live D1s had
    // wrong. Read it back through the API rather than trusting `colorFor`,
    // because the defect was that the seeder called a different palette.
    const res = await h.fetch("/api/tenants");
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: { slug: string; color: string | null }[] }).data;
    const def = rows.find((r) => r.slug === "default");
    expect(def).toBeDefined();
    expect({ color: def!.color, reseeded: wouldBeReseededByThemeMigration(def!.color) }).toEqual({
      color: def!.color,
      reseeded: false,
    });
  });

  test("a workspace created through the API is too", async () => {
    const made = await h.fetch("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Palette Probe" }),
    });
    expect([200, 201]).toContain(made.status);

    const res = await h.fetch("/api/tenants");
    const rows = ((await res.json()) as { data: { name: string; color: string | null }[] }).data;
    const probe = rows.find((r) => r.name === "Palette Probe");
    expect(probe).toBeDefined();
    expect({ color: probe!.color, reseeded: wouldBeReseededByThemeMigration(probe!.color) }).toEqual(
      { color: probe!.color, reseeded: false },
    );
  });
});
