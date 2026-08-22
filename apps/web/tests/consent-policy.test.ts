/**
 * The consent policy, and the two decisions nothing may make for an operator.
 *
 * `undecided_behaviour` and `tracker_category` encode compliance postures where
 * both answers are defensible in some jurisdiction and wrong in another. The
 * whole design rests on them being IMPOSSIBLE to acquire by accident, so these
 * tests attack that from both ends: the service refuses to invent one, and the
 * column carries no DEFAULT so the refusal survives a writer that bypasses the
 * service entirely.
 *
 * A test that only asserted "saving works" would pass just as happily against a
 * schema with `DEFAULT 'allow'`, which is the exact bug this feature cannot
 * ship.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { getSiteById } from "../src/server/services/analytics";
import {
  CONSENT_CATEGORIES,
  OPTIONAL_CATEGORIES,
  TRACKER_CATEGORIES,
  UNDECIDED_BEHAVIOURS,
  getPolicy,
  getPolicyForSite,
  listPolicies,
  savePolicy,
  suggestedWording,
  deletePolicy,
} from "../src/server/services/consent";
import { CONSENT_CATEGORIES as TAG_MANAGER_CATEGORIES } from "../src/server/services/tag-templates";
import { TRACKER_JS } from "../src/server/services/analytics-tracker";

let h: TestHarness;
let db: never;
let SITE = "";
let TENANT: string | null = null;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const ctx = await buildContext(h.env);
  db = { db: ctx.db, dialect: ctx.dialect } as never;

  const created = await h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Consent", domain: "consent.example" }),
  });
  SITE = ((await created.json()) as any).data.id;

  // Derived, never assumed: the HTTP surface reads the tenant from the
  // session, so a spec that hardcodes null tests a different tenant than the
  // routes do and the two silently stop meeting.
  TENANT = (await getSiteById(db, SITE))!.tenantId;
});

afterAll(() => h.cleanup());

describe("the vocabulary", () => {
  test("is the same four strings the tag manager files tags under", () => {
    // A seam, not a coincidence. The tag manager declares its own copy of this
    // list so the consent surface stays usable on a deploy with no tags; that
    // only works while the two agree. A rename on either side has to fail
    // here rather than silently produce a category nothing gates on.
    expect([...CONSENT_CATEGORIES]).toEqual([
      "none",
      "functional",
      "analytics",
      "marketing",
    ]);

    // ...and this is the half that was missing. The assertion above pins only
    // THIS module's copy, so renaming the tag manager's alone failed nothing —
    // `tag-templates.test.ts` merely checks each template's categories are
    // members of that same local list, which stays true after a rename. The
    // sentence in `consent.ts`'s header claimed a guarantee no test provided.
    expect([...TAG_MANAGER_CATEGORIES]).toEqual([...CONSENT_CATEGORIES]);
  });

  test("and the same three strings the browser tag grants against", () => {
    // A THIRD copy, and the one that cannot be imported: the tag is a string
    // compiled into a template literal, so a rename here is invisible to the
    // type system in a way the other two are not. It is still a copy on
    // purpose — the tag ships to a customer's page and must not drag a server
    // module's imports along with it.
    //
    // Built from the exported list rather than written out, so this fails on a
    // rename instead of quietly describing whatever the tag happens to say.
    const literal = `var OPTIONAL = [${OPTIONAL_CATEGORIES.map((c) => `"${c}"`).join(", ")}];`;
    expect(TRACKER_JS).toContain(literal);

    // `none` is the fourth, and it is never in that array by definition — the
    // tag has to special-case it instead.
    expect(TRACKER_JS).toContain('category === "none"');
  });

  test("never offers `none` as a visitor choice", () => {
    // Strictly necessary is not a choice — offering it implies the visitor can
    // decline something the site cannot run without.
    expect([...OPTIONAL_CATEGORIES]).not.toContain("none");
    expect([...OPTIONAL_CATEGORIES]).toEqual(["functional", "analytics", "marketing"]);
  });
});

describe("the two decisions with no default", () => {
  test("a first save without `undecidedBehaviour` is refused", async () => {
    await expect(
      savePolicy(db, TENANT, SITE, { trackerCategory: "analytics" }),
    ).rejects.toThrow(/block|allow/i);
  });

  test("a first save without `trackerCategory` is refused", async () => {
    await expect(
      savePolicy(db, TENANT, SITE, { undecidedBehaviour: "block" }),
    ).rejects.toThrow(/strictly necessary|analytics/i);
  });

  test("the refusal explains the consequence, not just the field name", async () => {
    // The point of having no default is that an operator MAKES the choice. A
    // message reading "Required" would leave them guessing, so the text names
    // what each value does and that one of them is unlawful in the EU.
    let message = "";
    try {
      await savePolicy(db, TENANT, SITE, {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("GDPR");
    expect(message).toContain("not lawful in the EU");
  });

  test("the column itself carries no DEFAULT in either dialect", async () => {
    // The service's refusal is one layer. This is the other: a writer that
    // never goes through the service must still be unable to acquire a
    // posture by omission.
    const root = resolve(import.meta.dir, "..", "..", "..");
    for (const dialect of ["pg", "sqlite"]) {
      const sql = readFileSync(
        resolve(
          root,
          `packages/db/drizzle/${dialect}/20260819100000_consent_policies/migration.sql`,
        ),
        "utf8",
      );
      for (const col of ["undecided_behaviour", "tracker_category"]) {
        const line = sql
          .split("\n")
          // Skip the prose: the comment explaining why there is no default
          // says "NO DEFAULT", which would match the assertion below.
          .filter((l) => !l.trimStart().startsWith("--"))
          .find((l) => l.includes(`"${col}"`) || l.includes(`\`${col}\``));
        expect(line).toBeTruthy();
        expect(line!).toContain("NOT NULL");
        expect(line!.toUpperCase()).not.toContain("DEFAULT");
      }
    }
  });

  test("and the database enforces it — a bare INSERT is rejected", async () => {
    const ctx = await buildContext(h.env);
    let err: unknown = null;
    try {
      await (ctx.db as any).run(
        `INSERT INTO consent_policies (site_id, created_at, updated_at) VALUES ('bare', 1, 1)`,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    // Assert the REASON, not just that something threw. A typo in the table
    // name would also throw, and would let this pass while proving nothing.
    // Driver error text hides in different places per driver: bun:sqlite puts
    // it on `message`, D1 on `cause`.
    const text = `${(err as any)?.message ?? ""} ${(err as any)?.cause?.message ?? ""}`;
    expect(text).toContain("NOT NULL");
    expect(text).toContain("undecided_behaviour");
  });
});

describe("saving and reading back", () => {
  test("a complete first save round-trips", async () => {
    const saved = await savePolicy(db, TENANT, SITE, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      categoriesOffered: ["analytics", "marketing"],
      policyUrl: "https://consent.example/privacy",
      position: "corner",
      cookieMaxAgeDays: 180,
      enabled: true,
      wording: { en: { title: "Cookies", body: "We use them." } },
    });

    expect(saved.undecidedBehaviour).toBe("block");
    expect(saved.trackerCategory).toBe("none");
    expect(saved.enabled).toBe(true);
    expect(saved.position).toBe("corner");
    expect(saved.wording.en?.title).toBe("Cookies");

    const read = await getPolicy(db, TENANT, SITE);
    expect(read?.undecidedBehaviour).toBe("block");
    expect(read?.categoriesOffered).toEqual(["analytics", "marketing"]);
  });

  test("a later edit may omit the posture, and does not re-decide it", async () => {
    // An admin fixing a typo in the banner copy is not changing the site's
    // compliance posture. If omission reset it, every wording edit would be a
    // silent legal change.
    const saved = await savePolicy(db, TENANT, SITE, {
      wording: { en: { title: "Cookies on this site" } },
    });
    expect(saved.undecidedBehaviour).toBe("block");
    expect(saved.trackerCategory).toBe("none");
    expect(saved.wording.en?.title).toBe("Cookies on this site");
  });

  test("the upsert does not duplicate — one policy per site is the key", async () => {
    await savePolicy(db, TENANT, SITE, { enabled: false });
    const all = await listPolicies(db, TENANT);
    expect(all.filter((p) => p.siteId === SITE).length).toBe(1);
    expect(all.find((p) => p.siteId === SITE)?.enabled).toBe(false);
  });

  test("createdAt survives an update", async () => {
    const before = await getPolicy(db, TENANT, SITE);
    await savePolicy(db, TENANT, SITE, { enabled: true }, (before?.updatedAt ?? 0) + 10_000);
    const after = await getPolicy(db, TENANT, SITE);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt);
  });
});

describe("input is normalized, not trusted", () => {
  test("categories dedupe, drop unknowns, and land in a stable order", async () => {
    // The order matters beyond tidiness: the next phase hashes the compiled
    // artifact and uses it as an ETag, so a policy whose content did not
    // change must not produce a different hash because an admin ticked the
    // boxes in a different sequence.
    const saved = await savePolicy(db, TENANT, SITE, {
      categoriesOffered: ["marketing", "analytics", "marketing", "telepathy", 7],
    });
    expect(saved.categoriesOffered).toEqual(["analytics", "marketing"]);
  });

  test("a javascript: policy link is refused", async () => {
    // This value ends up in an `href` on somebody else's website. A
    // javascript: URL there is stored XSS on a page we do not own, reached
    // through an admin form.
    await expect(
      savePolicy(db, TENANT, SITE, { policyUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/http/i);
  });

  test("unknown wording keys are dropped rather than stored", async () => {
    const saved = await savePolicy(db, TENANT, SITE, {
      wording: { en: { title: "Hi", evil: "<script>", body: "Body" } },
    });
    expect(saved.wording.en).toEqual({ title: "Hi", body: "Body" });
  });

  test("a theme value that could close its CSS declaration is dropped", async () => {
    // These land inside a stylesheet the banner writes onto a page backlex does
    // not own. A value carrying `;` or `}` closes the declaration and
    // everything after it is attacker-authored CSS — enough to hide the reject
    // button while leaving accept visible.
    const saved = await savePolicy(db, TENANT, SITE, {
      theme: {
        background: "#111827",
        accent: "red; } body { display: none } .x {",
        border: "url(https://evil.example/track.png)",
        radius: "0.5rem",
      },
    });
    expect(saved.theme.background).toBe("#111827");
    expect(saved.theme.radius).toBe("0.5rem");
    expect(saved.theme.accent).toBeUndefined();
    expect(saved.theme.border).toBeUndefined();
  });

  test("cookie lifetime is clamped rather than trusted", async () => {
    const saved = await savePolicy(db, TENANT, SITE, { cookieMaxAgeDays: 99_999 });
    expect(saved.cookieMaxAgeDays).toBe(730);
  });
});

describe("suggested wording", () => {
  test("covers every key the banner reads, in both shipped locales", () => {
    const w = suggestedWording();
    for (const locale of ["en", "tr"]) {
      const block = w[locale]!;
      // A missing key renders as a blank button, which is worse than an
      // untranslated one.
      expect(Object.values(block).every((v) => typeof v === "string" && v.length > 0)).toBe(
        true,
      );
    }
  });

  test("is a suggestion — it is never applied on save", async () => {
    // Substituting text an operator never reviewed is the same mistake as
    // defaulting the posture: it publishes a legal statement nobody chose.
    await deletePolicy(db, TENANT, SITE);
    const saved = await savePolicy(db, TENANT, SITE, {
      undecidedBehaviour: "allow",
      trackerCategory: "analytics",
    });
    expect(saved.wording).toEqual({});
  });
});

describe("one tenant cannot squat another tenant's site", () => {
  test("a policy cannot be created for a site the caller does not own", async () => {
    // A site id is PUBLIC by design — it ships in the <script> snippet on the
    // customer's own page. `site_id` is the policy's primary key, and the
    // upsert's tenant guard only protects a row that ALREADY exists. Without
    // an ownership check on the insert, anyone could claim the key for a site
    // they can merely read the id of and lock its real owner out permanently.
    await expect(
      savePolicy(db, "some-other-tenant", SITE, {
        undecidedBehaviour: "allow",
        trackerCategory: "analytics",
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("and a site that does not exist at all is refused the same way", async () => {
    // Same answer either way, so the response never confirms whether somebody
    // else's site id is real.
    await expect(
      savePolicy(db, TENANT, "no-such-site", {
        undecidedBehaviour: "block",
        trackerCategory: "none",
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("the real owner is still able to save", async () => {
    // Guards the guard: an ownership check that rejected everyone would pass
    // both assertions above while breaking the feature.
    const ok = await savePolicy(db, TENANT, SITE, { enabled: true });
    expect(ok.enabled).toBe(true);
  });
});

describe("the site's lifecycle owns the policy's", () => {
  test("deleting a site removes its policy, and the banner stops", async () => {
    // No foreign key exists (D1 has them off), so nothing cascades on its own.
    // An orphan is not just untidy: it is keyed on `site_id`, so the admin
    // console — which iterates SITES — cannot see it or remove it, while the
    // customer's page still carries the snippet. An orphaned `enabled` policy
    // would keep serving a banner for a site that no longer exists.
    const created = await h.fetch("/api/admin/analytics/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Doomed", domain: "doomed.example" }),
    });
    const doomed = ((await created.json()) as any).data.id;
    await savePolicy(db, TENANT, doomed, {
      undecidedBehaviour: "block",
      trackerCategory: "none",
      enabled: true,
    });
    expect(await getPolicyForSite(db, doomed)).toBeTruthy();

    const gone = await h.fetch(
      `/api/admin/analytics/sites/${encodeURIComponent(doomed)}`,
      { method: "DELETE" },
    );
    expect(gone.status).toBe(200);

    expect(await getPolicyForSite(db, doomed)).toBeNull();
    expect(await getPolicy(db, TENANT, doomed)).toBeNull();
  });

  test("another tenant cannot delete an orphaned policy by guessing its id", async () => {
    // An orphan is inert, but a delete primitive that reaches across tenants
    // should not exist at all — and the tempting shape ("delete the site, then
    // check whether it is gone") creates exactly that, because a site_id with
    // no site row looks "gone" to every caller.
    const ctx3 = await buildContext(h.env);
    await (ctx3.db as any).run(
      `INSERT INTO consent_policies (site_id, tenant_id, undecided_behaviour, tracker_category, enabled, created_at, updated_at)
       VALUES ('orphan-guarded', 'someone-else', 'allow', 'none', 1, 1, 1)`,
    );
    const { deleteSite } = await import("../src/server/services/analytics");
    await deleteSite(db, TENANT, "orphan-guarded");
    const [still] = (await (ctx3.db as any).all?.(
      `SELECT site_id FROM consent_policies WHERE site_id = 'orphan-guarded'`,
    )) ?? [];
    expect(still).toBeTruthy();
  });

  test("the public read refuses an orphan even if one somehow exists", async () => {
    // Belt and braces for the rows a backfill or a direct write can leave
    // behind: the public path joins the site rather than trusting the key.
    const ctx2 = await buildContext(h.env);
    await (ctx2.db as any).run(
      `INSERT INTO consent_policies (site_id, tenant_id, undecided_behaviour, tracker_category, enabled, created_at, updated_at)
       VALUES ('orphan-site', NULL, 'allow', 'none', 1, 1, 1)`,
    );
    expect(await getPolicyForSite(db, "orphan-site")).toBeNull();
  });
});

describe("the public read", () => {
  test("resolves a site without a session and reports its tenant", async () => {
    // The banner carries a public site id and no credential, exactly like the
    // collect route, so this read is keyed on the primary key and derives the
    // tenant rather than being scoped by one.
    const row = await getPolicyForSite(db, SITE);
    expect(row?.siteId).toBe(SITE);
    expect(row).toHaveProperty("tenantId");
  });

  test("an unknown site id resolves to nothing rather than throwing", async () => {
    expect(await getPolicyForSite(db, "does-not-exist")).toBeNull();
  });
});

describe("the admin REST surface", () => {
  test("PUT reports the missing decision with a usable message", async () => {
    const site2 = await h.fetch("/api/admin/analytics/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second", domain: "second.example" }),
    });
    const id = ((await site2.json()) as any).data.id;

    const res = await h.fetch(`/api/admin/consent/policies/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body)).toContain("GDPR");
  });

  test("a full PUT then GET round-trips through HTTP", async () => {
    const res = await h.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "block",
        trackerCategory: "analytics",
        categoriesOffered: ["analytics"],
        enabled: true,
      }),
    });
    expect(res.status).toBe(200);

    const got = await h.fetch(`/api/admin/consent/policies/${SITE}`);
    const data = ((await got.json()) as any).data;
    expect(data.undecidedBehaviour).toBe("block");
    expect(data.trackerCategory).toBe("analytics");
    expect(data.enabled).toBe(true);
  });

  test("a site with no policy reads as null, not as an error", async () => {
    const got = await h.fetch("/api/admin/consent/policies/never-configured");
    expect(got.status).toBe(200);
    expect(((await got.json()) as any).data).toBeNull();
  });

  test("the operator's change is written to activity, with the posture", async () => {
    // "Who moved this site from block to allow, and when" is the first
    // question after a complaint, and the current row cannot answer it.
    const res = await h.fetch("/api/activity?action=consent.");
    const rows = ((await res.json()) as any).data as any[];
    const row = rows.find((r) => r.action === "consent.update");
    expect(row).toBeTruthy();
    expect(JSON.stringify(row.payload ?? {})).toContain("undecidedBehaviour");
  });
});

describe("the enumerations the API exposes", () => {
  test("are exactly the two values each, so the admin can render a dropdown", () => {
    expect([...UNDECIDED_BEHAVIOURS]).toEqual(["block", "allow"]);
    expect([...TRACKER_CATEGORIES]).toEqual(["none", "analytics"]);
  });
});
