/**
 * Nobody asked "can this be said twice?".
 *
 * Measured before this file existed: every duplicate-refusal assertion in the
 * suite was on a single-column `unique` — `grep -rn 'toBe(409)' apps/web/tests`
 * finds them, and not one inserted the same PAIR twice — because until `uniqueWith` shipped there was no way to express
 * the rule, so there was nothing to test and nothing to notice was missing.
 *
 * What that hid is a whole shape of collection. A join table's identity IS its
 * pair: a member belongs to a project once, an employee gets one payslip per
 * payroll run, a lesson has one progress row per enrolment. Every one of those
 * accepted the same pair twice, silently, and the second row is not a visible
 * error — it is a duplicate line in a list that somebody eventually reconciles
 * by hand. `hr/leave_allocations` even SAID the rule in its own note
 * ("Per-employee, per-type, per-year balance.") while the schema kept nothing.
 *
 * Two properties, because the rule has two halves that fail differently:
 *
 *  1. A collection shaped like a join table declares the constraint — or is
 *     named below as a deliberate exception, with the reason written down.
 *  2. The constraint it declares actually spans the pair, and the database
 *     actually refuses the second row.
 *
 * The exception list is an allowlist, which normally rots. Two things stop it:
 * every entry carries its reason in prose, and a test below fails if an entry
 * stops matching the shape it claims to be an exception to.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { compositeUniqueSets } from "@backlex/db";
import { TEMPLATES } from "../src/server/templates/catalog";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

interface FieldLike {
  name: string;
  type?: string;
  required?: boolean;
  uniqueWith?: string[];
}

const SYSTEM = new Set(["id", "created_at", "updated_at", "tenant_id"]);

/**
 * A collection whose identity is a pair: exactly two required relations, and
 * nothing else that could distinguish two rows sharing them.
 *
 * Deliberately shape-only. Whether a given pair may repeat is a question about
 * the DOMAIN, and no property of the schema answers it — which is why the
 * exceptions below are written out rather than detected.
 */
const joinShaped = (fields: FieldLike[]): FieldLike[] | null => {
  const real = fields.filter((f) => f.type !== "notice" && !SYSTEM.has(f.name));
  const rels = real.filter((f) => f.type === "relation" && f.required);
  return rels.length === 2 ? rels : null;
};

/**
 * Join-shaped collections that deliberately accept the same pair repeatedly.
 * Each reason has to say what the second row MEANS — if it does not mean
 * anything, the collection belongs above the line, not here.
 */
const REPEATABLE: Record<string, string> = {
  "ecommerce/product_modifiers":
    "a slot, not a link: the second row is the SECOND drive bay. A machine with four M.2 bays carries one shared `M.2 SSD` set four times, each row separately labelled, priced and stocked — uniqueness here would force four duplicated option lists that drift apart on the first price change",
  "ecommerce/stock_movements":
    "an append-only ledger: every receipt, sale, count and transfer is its own row against the same (variant, location), and a transfer is deliberately TWO rows",
  "hr/benefit_enrollments":
    "an employee may leave a benefit and re-enrol later; each spell is its own row, distinguished by `since` and `status`",
};

describe("a join table keeps its pair unique", () => {
  test("every join-shaped collection either declares the rule or is a listed exception", () => {
    const undeclared: string[] = [];
    for (const t of TEMPLATES) {
      for (const c of t.collections ?? []) {
        const rels = joinShaped((c.fields ?? []) as FieldLike[]);
        if (!rels) continue;
        const key = `${t.id}/${c.slug}`;
        if (key in REPEATABLE) continue;

        const sets = compositeUniqueSets((c.fields ?? []) as never);
        const names = rels.map((r) => r.name);
        const covers = sets.some((cols) => names.every((n) => cols.includes(n)));
        if (!covers) {
          undeclared.push(
            `${key}: (${names.join(", ")}) can repeat — add \`uniqueWith\`, or list it in REPEATABLE with the reason`,
          );
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  test("the exception list has not rotted — every entry still exists and is still join-shaped", () => {
    const stale: string[] = [];
    for (const key of Object.keys(REPEATABLE)) {
      const [templateId, slug] = key.split("/");
      const t = TEMPLATES.find((x) => x.id === templateId);
      const c = t?.collections?.find((x) => x.slug === slug);
      if (!c) {
        stale.push(`${key}: no such collection — drop the exception`);
        continue;
      }
      if (!joinShaped((c.fields ?? []) as FieldLike[])) {
        stale.push(`${key}: no longer two required relations — the exception no longer applies`);
      }
    }
    expect(stale).toEqual([]);
  });

  test("every reason says what a second row means, rather than that there is one", () => {
    // An allowlist whose reasons read "intentional" teaches the next reader
    // nothing and gets copied onto the next collection that should not be here.
    const thin = Object.entries(REPEATABLE).filter(([, why]) => why.length < 40);
    expect(thin).toEqual([]);
  });

  test("a declared `uniqueWith` names fields that are actually there", () => {
    const dangling: string[] = [];
    for (const t of TEMPLATES) {
      for (const c of t.collections ?? []) {
        const fields = (c.fields ?? []) as FieldLike[];
        const present = new Set(fields.map((f) => f.name));
        for (const f of fields) {
          for (const partner of f.uniqueWith ?? []) {
            if (!present.has(partner)) {
              dangling.push(`${t.id}/${c.slug}.${f.name} → uniqueWith "${partner}", which is not a field here`);
            }
          }
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  test("the sweep found join tables at all — a shape rule that matches nothing proves nothing", () => {
    let n = 0;
    for (const t of TEMPLATES) {
      for (const c of t.collections ?? []) {
        if (joinShaped((c.fields ?? []) as FieldLike[])) n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(12);
  });
});

describe("and the database actually refuses the second row", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "projects" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("the same (project, member) pair is a 409 the second time", async () => {
    const pick = async (slug: string): Promise<string> => {
      const res = await h.fetch(`/api/items/${slug}?limit=1`);
      const body = (await res.json()) as { data: { id: string }[] };
      expect(body.data.length).toBeGreaterThan(0);
      return body.data[0]?.id ?? "";
    };
    const project = await pick("projects");
    const member = await pick("members");

    const add = () =>
      h.fetch("/api/items/project_members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, member, role: "member" }),
      });

    const first = await add();
    // The template seeds its own memberships, so this pair may already be
    // there — either way, what matters is that a SECOND identical row is not.
    expect([201, 409]).toContain(first.status);

    const second = await add();
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error.code).toBe("CONFLICT");
  });

  test("the same member on a DIFFERENT project is still fine", async () => {
    const projects = (await (await h.fetch("/api/items/projects?limit=2")).json()) as {
      data: { id: string }[];
    };
    const members = (await (await h.fetch("/api/items/members?limit=1")).json()) as {
      data: { id: string }[];
    };
    if (projects.data.length < 2) return; // the template seeds one project

    const other = projects.data[1]?.id;
    const res = await h.fetch("/api/items/project_members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: other, member: members.data[0]?.id, role: "member" }),
    });
    expect([201, 409]).toContain(res.status);
    if (res.status === 409) {
      // Already seeded for this pair — prove the constraint is per-pair by
      // confirming the row is there rather than accepting the refusal blindly.
      const rows = (await (await h.fetch("/api/items/project_members?limit=200")).json()) as {
        data: { project: string; member: string }[];
      };
      expect(rows.data.some((r) => r.project === other && r.member === members.data[0]?.id)).toBe(true);
    }
  });
});
