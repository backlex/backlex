import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { OPERATION_TYPES, type Operation } from "@backlex/core";
import { TEMPLATES } from "../src/server/templates/catalog";
import type { SchemaTemplate } from "../src/server/templates/types";
import { applyTemplateDefinition } from "../src/server/services/templates";
import { isFormEligible } from "../src/server/services/forms";
import type { DbCtx } from "../src/server/services/seed";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * What a template bundles besides tables — and whether applying it produces a
 * workspace that actually runs.
 *
 * Two halves, and they answer different questions:
 *
 *  1. A **catalog audit** over every built-in template, walking each bundled
 *     flow / document / form / agent against that template's own collections.
 *     None of this is a compile error: a flow naming a column that does not
 *     exist is a run that fails at 3am, and an agent naming a tool that does
 *     not exist is refused at write time and takes the whole apply with it.
 *  2. An **end-to-end apply** of a synthetic template that uses every bundle
 *     kind at once, plus the two server-maintained field specs the seeder has
 *     to handle specially (a `sequence` document number and two `rollup`
 *     totals). This is the half that would catch the seeder silently writing
 *     a sample's literal document number around the counter.
 */

/** Ops a bundled catalog flow may use: every one of them is self-contained.
 *  The excluded ones (`webhook`, `request`, `integration*`, `payment.*`) all
 *  address something outside the workspace, so a template shipping one hands
 *  every new workspace a flow that fails on its first run. */
const SELF_CONTAINED_OPS = new Set([
  "log",
  "notification",
  "push",
  "sms",
  "email",
  "condition",
  "foreach",
  "transform",
  "delay",
  "item.create",
  "item.update",
  "document.render",
  "document.sign",
  "report.deliver",
  "approval.request",
  "function",
  "run-script",
]);

/** Ops that need something an operator configures (a mail transport, a PDF
 *  renderer). A flow using one must ship switched off — a runs list full of
 *  failures on day one reads as "this feature is broken". */
const NEEDS_CONFIG_OPS = new Set([
  "email",
  "sms",
  "push",
  "document.render",
  "document.sign",
  "report.deliver",
]);

/** Every op in a tree, including nested branches. */
const walkOps = (ops: Operation[] | undefined): Operation[] => {
  const out: Operation[] = [];
  for (const op of ops ?? []) {
    out.push(op);
    const o = op as unknown as Record<string, Operation[] | undefined>;
    out.push(...walkOps(o.then), ...walkOps(o.else), ...walkOps(o.do));
    out.push(...walkOps(o.onSuccess), ...walkOps(o.onError));
  }
  return out;
};

describe("bundled artifacts are consistent with their own template", () => {
  const withBundles = TEMPLATES.filter(
    (t) =>
      (t.flows ?? []).length ||
      (t.documents ?? []).length ||
      (t.forms ?? []).length ||
      (t.agents ?? []).length ||
      (t.flags ?? []).length ||
      (t.channels ?? []).length,
  );

  test("every bundled flow uses known, self-contained operations", () => {
    for (const tpl of withBundles) {
      const slugs = new Set(tpl.collections.map((c) => c.slug));
      for (const flow of tpl.flows ?? []) {
        const where = `${tpl.id}/${flow.name}`;
        expect(flow.operations.length).toBeGreaterThan(0);
        let needsConfig = false;
        for (const op of walkOps(flow.operations)) {
          expect(OPERATION_TYPES, `${where}: unknown op "${op.type}"`).toContain(op.type);
          expect(SELF_CONTAINED_OPS, `${where}: op "${op.type}" reaches outside the workspace`).toContain(
            op.type,
          );
          if (NEEDS_CONFIG_OPS.has(op.type)) needsConfig = true;
          // A flow that writes to a collection the template does not create
          // silently does nothing at all.
          const target = (op as unknown as { collection?: string }).collection;
          if (target) {
            expect(slugs, `${where}: op targets unknown collection "${target}"`).toContain(target);
          }
        }
        if (needsConfig) {
          expect(flow.active, `${where}: needs a transport/renderer, so it must ship inactive`).toBe(
            false,
          );
        }
      }
    }
  });

  test("what a flow writes is a real column, holding a real value", () => {
    // The op names its collection, so the previous test catches a bad slug —
    // but a bad KEY inside `data` is dropped by the write path and the flow
    // reports success having written nothing. Same for a status string that is
    // not one of the field's choices: the row is refused at run time, hours
    // after anybody was watching.
    let checked = 0;
    for (const tpl of withBundles) {
      const bySlug = new Map(tpl.collections.map((c) => [c.slug, c]));
      for (const flow of tpl.flows ?? []) {
        for (const op of walkOps(flow.operations)) {
          if (op.type !== "item.create" && op.type !== "item.update") continue;
          checked++;
          const o = op as unknown as { collection: string; data?: unknown };
          const col = bySlug.get(o.collection);
          if (!col || !o.data || typeof o.data !== "object") continue;
          for (const [key, value] of Object.entries(o.data as Record<string, unknown>)) {
            const where = `${tpl.id}/${flow.name} → ${o.collection}.${key}`;
            const def = col.fields.find((f) => f.name === key);
            expect(def, `${where}: not a column of ${o.collection}`).toBeTruthy();
            if (!def) continue;
            expect(
              !def.computed && !def.rollup && !def.sequence,
              `${where}: the server owns this column — a write to it is refused`,
            ).toBe(true);
            // A literal written into a dropdown has to be one of its choices.
            const choices = def.options?.choices?.map((c) => c.value);
            if (
              choices?.length &&
              typeof value === "string" &&
              !value.includes("{{")
            ) {
              expect(choices, `${where}: "${value}" is not a declared choice`).toContain(value);
            }
          }
        }
      }
    }
    // A catalog whose flows stopped writing rows would make every assertion
    // above vacuous while the test stayed green.
    expect(checked, "no item.create/item.update op was checked").toBeGreaterThan(0);
  });

  test("every bundled flow's trigger names a collection the template creates", () => {
    for (const tpl of withBundles) {
      const slugs = new Set(tpl.collections.map((c) => c.slug));
      for (const flow of tpl.flows ?? []) {
        const where = `${tpl.id}/${flow.name}`;
        const t = flow.trigger;
        expect(
          t === "manual:" || /^(event|cron|schedule):/.test(t),
          `${where}: unrecognised trigger "${t}"`,
        ).toBe(true);
        if (t.startsWith("event:items:")) {
          const slug = t.split(":")[2] ?? "";
          if (slug !== "*") {
            expect(slugs, `${where}: trigger names unknown collection "${slug}"`).toContain(slug);
          }
        }
        if (t.startsWith("schedule:")) {
          const spec = JSON.parse(t.slice("schedule:".length)) as {
            collection: string;
            field: string;
          };
          const col = tpl.collections.find((c) => c.slug === spec.collection);
          expect(col, `${where}: schedule names unknown collection "${spec.collection}"`).toBeTruthy();
          const field = col?.fields.find((f) => f.name === spec.field);
          expect(field?.type, `${where}: schedule field "${spec.field}" must be a timestamp`).toBe(
            "timestamp",
          );
        }
      }
    }
  });

  test("bundled document keys are unique and their variables are real columns", () => {
    for (const tpl of withBundles) {
      const keys = (tpl.documents ?? []).map((d) => d.key);
      expect(new Set(keys).size, `${tpl.id}: duplicate document key`).toBe(keys.length);
      const allFields = new Set(tpl.collections.flatMap((c) => c.fields.map((f) => f.name)));
      for (const doc of tpl.documents ?? []) {
        expect(doc.bodyHtml.length, `${tpl.id}/${doc.key}: empty body`).toBeGreaterThan(0);
        for (const v of doc.variables ?? []) {
          expect(allFields, `${tpl.id}/${doc.key}: variable "${v}" is not a column anywhere`).toContain(
            v,
          );
        }
      }
    }
  });

  test("bundled forms expose real, form-eligible fields of a real collection", () => {
    for (const tpl of withBundles) {
      for (const form of tpl.forms ?? []) {
        const where = `${tpl.id}/${form.name}`;
        const col = tpl.collections.find((c) => c.slug === form.collection);
        expect(col, `${where}: unknown collection "${form.collection}"`).toBeTruthy();
        if (!col) continue;
        const exposed = new Set(form.fields.map((f) => f.name));
        expect(exposed.size, `${where}: duplicate field`).toBe(form.fields.length);
        for (const f of form.fields) {
          const def = col.fields.find((x) => x.name === f.name);
          expect(def, `${where}: field "${f.name}" is not on ${col.slug}`).toBeTruthy();
          if (def) {
            expect(isFormEligible(def), `${where}: field "${f.name}" is not form-eligible`).toBe(true);
          }
        }
        // The create path forces every schema-required eligible field onto the
        // form, so a template that omits one cannot be applied at all.
        for (const def of col.fields) {
          if (def.required && isFormEligible(def)) {
            expect(exposed, `${where}: required field "${def.name}" must be on the form`).toContain(
              def.name,
            );
          }
        }
      }
    }
  });

  test("bundled agents name real MCP tools", async () => {
    const { allTools } = await import("../src/server/mcp/tools/index");
    const known = new Set(allTools.map((t: { name: string }) => t.name));
    for (const tpl of withBundles) {
      for (const agent of tpl.agents ?? []) {
        expect(agent.systemPrompt.length, `${tpl.id}/${agent.name}: empty prompt`).toBeGreaterThan(0);
        for (const tool of agent.tools) {
          expect(known, `${tpl.id}/${agent.name}: unknown tool "${tool}"`).toContain(tool);
        }
      }
    }
  });

  test("a flow naming a bundled dashboard names one the template ships", () => {
    for (const tpl of withBundles) {
      const names = new Set((tpl.dashboards ?? []).map((d) => d.name));
      for (const flow of tpl.flows ?? []) {
        for (const op of walkOps(flow.operations)) {
          const id = (op as unknown as { dashboardId?: string }).dashboardId;
          if (!id?.startsWith("@dashboard:")) continue;
          expect(names, `${tpl.id}/${flow.name}: no bundled dashboard "${id}"`).toContain(
            id.slice("@dashboard:".length),
          );
        }
      }
    }
  });

  test("a declared Kanban board groups by a real dropdown of its own collection", () => {
    // Naming the field is the whole point of declaring it — left null the admin
    // auto-detects, and auto-detect picks the first dropdown, which on an order
    // is the payment status rather than the fulfillment one anybody arranges a
    // board around. A name that does not resolve is worse than no name: the
    // board silently falls back to the guess it was written to override.
    let checked = 0;
    for (const tpl of TEMPLATES) {
      for (const col of tpl.collections) {
        const by = col.kanbanGroupBy;
        if (!by) continue;
        checked++;
        const where = `${tpl.id}/${col.slug}`;
        if (by === "_status") {
          expect(col.versioned, `${where}: _status needs a versioned collection`).toBe(true);
          continue;
        }
        const def = col.fields.find((f) => f.name === by);
        expect(def, `${where}: kanbanGroupBy "${by}" is not a column`).toBeTruthy();
        expect(
          (def?.options?.choices?.length ?? 0) > 0,
          `${where}: kanbanGroupBy "${by}" has no choices — a board needs columns`,
        ).toBe(true);
      }
    }
    expect(checked, "no collection declared a board").toBeGreaterThan(0);
  });

  test("a conditional field keys off a real sibling and a real value", () => {
    // `required` here is enforced server-side, so a rule pointing at a column
    // that does not exist — or at a status value the dropdown never offers —
    // is not a stricter form, it is one that can never fire. That failure is
    // invisible: the field simply behaves as if the condition were not there.
    let checked = 0;
    for (const tpl of TEMPLATES) {
      for (const col of tpl.collections) {
        const byName = new Map(col.fields.map((f) => [f.name, f]));
        for (const f of col.fields) {
          for (const cond of f.conditions ?? []) {
            checked++;
            const where = `${tpl.id}/${col.slug}.${f.name}`;
            for (const [sibling, cmp] of Object.entries(
              cond.rule as Record<string, Record<string, unknown>>,
            )) {
              const def = byName.get(sibling);
              expect(def, `${where}: condition names "${sibling}", not a column here`).toBeTruthy();
              const choices = def?.options?.choices?.map((c) => c.value);
              if (!choices?.length) continue;
              for (const value of Object.values(cmp ?? {}).flat()) {
                if (typeof value !== "string" || value.startsWith("$")) continue;
                expect(
                  choices,
                  `${where}: "${value}" is not a value "${sibling}" offers`,
                ).toContain(value);
              }
            }
          }
        }
      }
    }
    expect(checked, "no conditional field was checked").toBeGreaterThan(0);
  });

  test("two templates cannot collide on a bundle's natural key", () => {
    // Every bundle is skipped by name or key, and a workspace may apply more
    // than one template. So a name shared by two verticals does not produce a
    // conflict anybody sees — it produces a workspace holding ONE of them,
    // pointing at the other vertical's collection, which is the shape of bug
    // that gets reported as "the form saves to the wrong place".
    const seen = new Map<string, string[]>();
    const claim = (kind: string, key: string, tpl: string): void => {
      const k = `${kind} "${key}"`;
      seen.set(k, [...(seen.get(k) ?? []), tpl]);
    };
    for (const tpl of TEMPLATES) {
      for (const d of tpl.documents ?? []) claim("document key", d.key, tpl.id);
      for (const f of tpl.flows ?? []) claim("flow name", f.name, tpl.id);
      for (const f of tpl.forms ?? []) claim("form name", f.name, tpl.id);
      for (const a of tpl.agents ?? []) claim("agent name", a.name, tpl.id);
      for (const f of tpl.flags ?? []) claim("flag key", f.key, tpl.id);
      for (const c of tpl.channels ?? []) claim("channel pattern", c.pattern, tpl.id);
    }
    const clashes = [...seen].filter(([, v]) => v.length > 1);
    expect(
      clashes.map(([k, v]) => `${k} in ${v.join(" + ")}`),
      "two templates share a bundle key",
    ).toEqual([]);
    expect(seen.size, "no bundle keys were collected").toBeGreaterThan(0);
  });

  test("no sample writes a column the server owns", () => {
    // A literal in one of these is dropped by the seeder, so it is not a bug
    // that shows up — it is a line of the catalog that reads as if it does
    // something and does not. Both classes are caught here rather than left to
    // whoever next wonders why the demo invoice is numbered differently.
    for (const tpl of TEMPLATES) {
      for (const col of tpl.collections) {
        const owned = col.fields.filter((f) => f.sequence || f.rollup).map((f) => f.name);
        if (owned.length === 0) continue;
        for (const [i, sample] of (col.samples ?? []).entries()) {
          for (const name of owned) {
            expect(
              name in sample,
              `${tpl.id}/${col.slug} sample ${i}: "${name}" is maintained by the server`,
            ).toBe(false);
          }
        }
      }
    }
  });

  test("bundled KPI alerts and pins are complete", () => {
    for (const tpl of TEMPLATES) {
      for (const kpi of tpl.kpis ?? []) {
        const where = `${tpl.id}/${kpi.slug}`;
        // Both halves or neither — the API enforces this and the seeder
        // inserts straight past it.
        expect(
          (kpi.alertOperator === undefined) === (kpi.alertValue === undefined),
          `${where}: an alert needs both an operator and a threshold`,
        ).toBe(true);
        expect(
          (kpi.pinTo === undefined) === (kpi.pinField === undefined),
          `${where}: a pin needs both a collection and a relation field`,
        ).toBe(true);
        if (kpi.pinTo) {
          expect(
            tpl.collections.some((c) => c.slug === kpi.pinTo),
            `${where}: pinTo "${kpi.pinTo}" is not a collection of this template`,
          ).toBe(true);
          const own = tpl.collections.find((c) => c.slug === kpi.collection);
          const rel = own?.fields.find((f) => f.name === kpi.pinField);
          expect(rel?.type, `${where}: pinField "${kpi.pinField}" must be a relation on ${kpi.collection}`).toBe(
            "relation",
          );
          expect(rel?.to, `${where}: pinField must point at ${kpi.pinTo}`).toBe(kpi.pinTo);
        }
      }
    }
  });
});

/**
 * Two templates in one workspace.
 *
 * The "Add from template" dialog is additive by design and says so, so this is
 * an ordinary thing for an operator to do — and it is where a bundle's
 * skip-by-name turns from a safety property into a hazard. Every bundle is
 * skipped when something already holds its name or key, which is right for a
 * RE-apply of the same template and wrong across two different ones: the second
 * template would silently keep the first's form, still pointing at the first's
 * collection. A static check refuses colliding names in the catalog; this is
 * the runtime half, and it is what would catch a collision arriving through
 * `applyCustomTemplate` where no static check runs.
 */
describe("two templates land side by side without eating each other", () => {
  let h: TestHarness;

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const apply = async (id: string) => {
    const r = await h.fetch("/api/admin/templates/apply", json({ templateId: id }));
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: Record<string, string[]> }).data;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("each template installs its own bundle in full", async () => {
    const a = await apply("invoicing");
    const b = await apply("crm");
    for (const [id, res] of [
      ["invoicing", a],
      ["crm", b],
    ] as const) {
      const tpl = TEMPLATES.find((t) => t.id === id)!;
      expect(res.flows, `${id} flows`).toEqual((tpl.flows ?? []).map((f) => f.name));
      expect(res.documents, `${id} documents`).toEqual((tpl.documents ?? []).map((d) => d.key));
      expect(res.forms, `${id} forms`).toEqual((tpl.forms ?? []).map((f) => f.name));
      expect(res.agents, `${id} agents`).toEqual((tpl.agents ?? []).map((x) => x.name));
    }
  });

  test("each seeded form still points at its own template's collection", async () => {
    // The failure this exists for does not raise anything: the second apply
    // reports the form as skipped-because-it-exists, and the workspace keeps a
    // form writing into the wrong vertical.
    const forms = (
      (await (await h.fetch("/api/admin/forms")).json()) as {
        data: { name: string; collection: string }[];
      }
    ).data;
    const expected = new Map<string, string>();
    for (const id of ["invoicing", "crm"]) {
      for (const f of TEMPLATES.find((t) => t.id === id)!.forms ?? []) {
        expected.set(f.name, f.collection);
      }
    }
    expect(expected.size).toBeGreaterThan(1);
    for (const [name, collection] of expected) {
      const row = forms.find((f) => f.name === name);
      expect(row, `form "${name}" is missing`).toBeTruthy();
      expect(row?.collection, `form "${name}" points at the wrong collection`).toBe(collection);
    }
  });

  test("both document templates survive, under their own keys", async () => {
    const docs = (
      (await (await h.fetch("/api/admin/documents/templates")).json()) as {
        data: { key: string }[];
      }
    ).data.map((d) => d.key);
    for (const id of ["invoicing", "crm"]) {
      for (const d of TEMPLATES.find((t) => t.id === id)!.documents ?? []) {
        expect(docs, `document "${d.key}"`).toContain(d.key);
      }
    }
  });
});

/**
 * The invoicing vertical, applied for real through the REST route.
 *
 * The synthetic fixture below proves the seeder; this proves the CATALOG — that
 * a template an operator can actually pick arrives with its document numbers
 * issued by the server and its counter left standing, so the first invoice they
 * raise does not collide with a demo row.
 */
describe("a catalog template arrives with its numbering already running", () => {
  let h: TestHarness;
  let result: Record<string, string[]>;

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const applied = await h.fetch("/api/admin/templates/apply", json({ templateId: "invoicing" }));
    expect(applied.status).toBe(201);
    result = ((await applied.json()) as { data: Record<string, string[]> }).data;
  });

  afterAll(() => h.cleanup());

  test("every bundle the template declares actually lands", () => {
    // Each seeder is best-effort — a throw is caught and logged so a bundle
    // failure cannot fail an apply that already created collections. Which is
    // right, and is exactly why it has to be asserted: without this, a seeder
    // that broke would show up as a quieter log line and an empty page.
    const invoicing = TEMPLATES.find((t) => t.id === "invoicing")!;
    expect(result.flows).toEqual((invoicing.flows ?? []).map((f) => f.name));
    expect(result.documents).toEqual((invoicing.documents ?? []).map((d) => d.key));
    expect(result.forms).toEqual((invoicing.forms ?? []).map((f) => f.name));
    expect(result.agents).toEqual((invoicing.agents ?? []).map((a) => a.name));
    expect(result.kpis).toEqual((invoicing.kpis ?? []).map((k) => k.slug));
  });

  test("the seeded invoices are numbered by the counter, and the next one follows", async () => {
    const seeded = (
      (await (await h.fetch("/api/items/invoices?sort=number")).json()) as {
        data: { number: string }[];
      }
    ).data;
    expect(seeded.length).toBe(2);
    // The year comes from the clock, so the shape is what is pinned.
    expect(seeded[0]!.number).toMatch(/^INV-\d{4}-0001$/);
    expect(seeded[1]!.number).toMatch(/^INV-\d{4}-0002$/);

    // A real create takes the next one — the whole point of allocating rather
    // than copying a literal out of the sample.
    // Dates supplied so the row is realistic; the template's cross-field rule
    // no longer objects to their absence either (see field-validation.test.ts).
    const created = await h.fetch(
      "/api/items/invoices",
      json({
        status: "draft",
        currency: "USD",
        issue_date: 1_760_000_000_000,
        due_date: 1_762_000_000_000,
      }),
    );
    expect(created.status).toBe(201);
    const row = ((await created.json()) as { data: { number: string } }).data;
    expect(row.number).toMatch(/^INV-\d{4}-0003$/);
  });

  test("a seeded flow actually runs when its event fires", async () => {
    // Everything else here proves the bundle was STORED. This is the one that
    // proves it works: raise an invoice and the flow the template shipped
    // fires, completes, and leaves the notification it promised. A flow that
    // stores cleanly and then throws at run time is the failure this whole
    // feature is most likely to have.
    const before = (
      (await (await h.fetch("/api/notifications?limit=100")).json()) as {
        data: { title: string }[];
      }
    ).data.length;

    const created = await h.fetch(
      "/api/items/invoices",
      json({
        status: "draft",
        currency: "USD",
        issue_date: 1_760_000_000_000,
        due_date: 1_762_000_000_000,
      }),
    );
    expect(created.status).toBe(201);
    const number = ((await created.json()) as { data: { number: string } }).data.number;

    // `publishEvent` dispatches flows fire-and-forget, so poll rather than
    // assume the write and the run are ordered.
    let run: { response?: unknown } | undefined;
    let notice: { title: string } | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const acts = (
        (await (await h.fetch("/api/activity?limit=50&collection=system_flows")).json()) as {
          data: { action: string; response?: unknown }[];
        }
      ).data;
      run = acts.find((r) => r.action.includes("run"));
      const notices = (
        (await (await h.fetch("/api/notifications?limit=100")).json()) as {
          data: { title: string }[];
        }
      ).data;
      notice = notices.find((n) => n.title.includes(number));
      if (run && notice) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(run, "the flow never ran").toBeTruthy();
    expect((run?.response as { ok?: boolean } | null)?.ok, "the run failed").toBe(true);
    // …and the templated title resolved against the real row, rather than
    // rendering `{{ data.number }}` as literal text.
    expect(notice?.title).toBe(`Invoice ${number} created`);
    expect(
      (
        (await (await h.fetch("/api/notifications?limit=100")).json()) as { data: unknown[] }
      ).data.length,
    ).toBeGreaterThan(before);
  });

  test("a client cannot write the number itself", async () => {
    const res = await h.fetch(
      "/api/items/invoices",
      json({
        status: "draft",
        currency: "USD",
        issue_date: 1_760_000_000_000,
        due_date: 1_762_000_000_000,
        number: "INV-2026-0001",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    // …and refused for the right reason, not for the dates.
    expect(body.error.message).toContain("sequence");
  });
});

/**
 * The seeder, exercised against a template that uses everything at once.
 *
 * Applied through `applyTemplateDefinition` directly rather than the REST
 * route, because the route's custom-template body is deliberately
 * collections-only — bundles ride with catalog templates, not with an
 * arbitrary payload an admin can post.
 */
describe("applying a template seeds its whole bundle", () => {
  let h: TestHarness;
  let client: Database;
  let ctx: DbCtx;
  let tenantId = "";

  const NOW = 1_760_000_000_000;

  const template: SchemaTemplate = {
    id: "bundle-fixture",
    label: "Bundle fixture",
    description: "Every bundle kind at once.",
    groups: ["Sales"],
    collections: [
      {
        slug: "bt_orders",
        group: "Sales",
        fields: [
          { name: "title", type: "text", required: true },
          {
            name: "number",
            type: "text",
            required: true,
            unique: true,
            sequence: { pattern: "ORD-{####}" },
          },
          { name: "due_at", type: "timestamp", interface: "date" },
          {
            name: "status",
            type: "text",
            interface: "dropdown",
            options: { choices: [{ value: "open" }, { value: "done" }] },
            default: "open",
          },
          { name: "line_count", type: "integer", rollup: { from: "bt_lines", via: "order", fn: "count" } },
          {
            name: "qty_total",
            type: "number",
            rollup: { from: "bt_lines", via: "order", fn: "sum", field: "qty" },
          },
        ],
        kanbanGroupBy: "status",
        samples: [
          // The literal here is deliberate: a sample must NEVER write a
          // sequence column, and this is what proves the skip rather than
          // assuming it.
          { title: "First order", number: "SHOULD-BE-IGNORED", due_at: NOW, status: "open" },
          { title: "Second order", due_at: NOW, status: "open" },
        ],
      },
      {
        slug: "bt_lines",
        group: "Sales",
        fields: [
          { name: "order", type: "relation", to: "bt_orders", interface: "relation", indexed: true },
          { name: "sku", type: "text", required: true },
          { name: "qty", type: "number", default: 1 },
        ],
        samples: [
          { order: { ref: "bt_orders:0" }, sku: "A-1", qty: 2 },
          { order: { ref: "bt_orders:0" }, sku: "A-2", qty: 3 },
          { order: { ref: "bt_orders:1" }, sku: "B-1", qty: 7 },
        ],
      },
    ],
    dashboards: [
      {
        name: "Bundle overview",
        panels: [
          {
            name: "Orders",
            kind: "items-aggregate",
            viz: "counter",
            config: { collection: "bt_orders", func: "count" },
          },
        ],
      },
    ],
    kpis: [
      {
        slug: "open-bt-orders",
        name: "Open orders",
        collection: "bt_orders",
        agg: "count",
        filter: { status: { _eq: "open" } },
        direction: "down",
        alertOperator: "above",
        alertValue: 5,
      },
    ],
    flows: [
      {
        name: "Notify on a new order",
        trigger: "event:items:bt_orders:created",
        operations: [
          { type: "notification", title: "New order", body: "Order {{ data.number }} landed." },
        ],
      },
      {
        name: "Monthly order report (needs a PDF renderer)",
        trigger: "cron:0 8 1 * *",
        active: false,
        operations: [{ type: "report.deliver", dashboardId: "@dashboard:Bundle overview" }],
      },
    ],
    documents: [
      {
        key: "bt_order",
        name: "Order sheet",
        bodyHtml: "<html><body><h1>Order {{ data.number }}</h1></body></html>",
        filename: "order-{{ data.number }}",
        variables: ["number"],
      },
    ],
    forms: [
      {
        name: "Request an order",
        collection: "bt_orders",
        fields: [{ name: "title", label: "What do you need?" }],
      },
    ],
    agents: [
      {
        name: "Order assistant",
        systemPrompt: "Answer questions about orders. Be brief.",
        tools: ["collections.list", "collections.read"],
      },
    ],
    flags: [{ key: "bt-new-checkout", enabled: true, value: { variant: "A" } }],
    channels: [
      {
        name: "Order feed",
        pattern: "bt_orders:{order}:feed",
        subscribe: { access: "authenticated" },
        publish: { access: "roles", roles: ["admin"] },
      },
    ],
  };

  const rows = <T>(sqlText: string): T[] => client.query(sqlText).all() as T[];

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = new Database(h.env.SQLITE_PATH!);
    ctx = { db: drizzle({ client }), dialect: "sqlite" } as unknown as DbCtx;
    tenantId = (client.query("SELECT id FROM tenants WHERE slug = 'default'").get() as {
      id: string;
    }).id;
  });

  afterAll(() => {
    client.close();
    h.cleanup();
  });

  test("the apply reports every kind it installed", async () => {
    const res = await applyTemplateDefinition(ctx, tenantId, template);
    expect(res.created.sort()).toEqual(["bt_lines", "bt_orders"]);
    expect(res.seeded).toBe(5);
    expect(res.dashboards).toEqual(["Bundle overview"]);
    expect(res.kpis).toEqual(["open-bt-orders"]);
    expect(res.flows).toEqual([
      "Notify on a new order",
      "Monthly order report (needs a PDF renderer)",
    ]);
    expect(res.documents).toEqual(["bt_order"]);
    expect(res.forms).toEqual(["Request an order"]);
    expect(res.agents).toEqual(["Order assistant"]);
    expect(res.flags).toEqual(["bt-new-checkout"]);
    expect(res.channels).toEqual(["bt_orders:{order}:feed"]);
  });

  test("a form's one-time token never leaves the seeder", async () => {
    // Non-vacuous: the row really does hold a hash, so there IS a secret that
    // could have been reported. The apply result is written verbatim into the
    // activity log, which is why it must not be.
    const form = rows<{ token_hash: string }>(
      "SELECT token_hash FROM forms WHERE name = 'Request an order'",
    )[0];
    expect(form?.token_hash?.length).toBeGreaterThan(0);
    const res = await applyTemplateDefinition(ctx, tenantId, template);
    expect(JSON.stringify(res)).not.toContain(form!.token_hash);
    expect(JSON.stringify(res)).not.toContain("frm_");
  });

  test("document numbers are allocated, not copied from the samples", () => {
    const seeded = rows<{ number: string }>(
      `SELECT number FROM ${`c_${tenantId.replace(/-/g, "").slice(0, 12)}_bt_orders`} ORDER BY number`,
    );
    expect(seeded.map((r) => r.number)).toEqual(["ORD-0001", "ORD-0002"]);
    // …and the counter is standing after them, so the next real order does not
    // collide with a seeded one.
    const counter = rows<{ last_value: number }>(
      "SELECT last_value FROM sequences WHERE collection = 'bt_orders' AND field = 'number'",
    )[0];
    expect(counter?.last_value).toBe(2);
  });

  test("rollup totals are restated from the seeded children", () => {
    const table = `c_${tenantId.replace(/-/g, "").slice(0, 12)}_bt_orders`;
    const seeded = rows<{ title: string; line_count: number; qty_total: number }>(
      `SELECT title, line_count, qty_total FROM ${table} ORDER BY title`,
    );
    // Distinct totals on purpose: two rows that happen to agree would pass a
    // refresh that credited every parent with the same number.
    expect(seeded).toEqual([
      { title: "First order", line_count: 2, qty_total: 5 },
      { title: "Second order", line_count: 1, qty_total: 7 },
    ]);
  });

  test("re-applying duplicates nothing", () => {
    const counts = {
      flows: rows<{ n: number }>("SELECT COUNT(*) AS n FROM flows")[0]!.n,
      documents: rows<{ n: number }>("SELECT COUNT(*) AS n FROM document_templates")[0]!.n,
      forms: rows<{ n: number }>("SELECT COUNT(*) AS n FROM forms")[0]!.n,
      agents: rows<{ n: number }>("SELECT COUNT(*) AS n FROM agents")[0]!.n,
      flags: rows<{ n: number }>("SELECT COUNT(*) AS n FROM feature_flags")[0]!.n,
      channels: rows<{ n: number }>("SELECT COUNT(*) AS n FROM broadcast_channels")[0]!.n,
    };
    // The apply above already ran twice (the token test re-applied).
    expect(counts).toEqual({
      flows: 2,
      documents: 1,
      forms: 1,
      agents: 1,
      flags: 1,
      channels: 1,
    });
  });

  test("a report flow is bound to the dashboard the template shipped", () => {
    const dash = rows<{ id: string }>(
      "SELECT id FROM dashboards WHERE name = 'Bundle overview'",
    )[0];
    const flow = rows<{ operations: string }>(
      "SELECT operations FROM flows WHERE name LIKE 'Monthly order report%'",
    )[0];
    expect(dash?.id).toBeTruthy();
    // The catalog wrote a name; what landed is the real id.
    expect(flow!.operations).toContain(dash!.id);
    expect(flow!.operations).not.toContain("@dashboard:");
  });

  test("the channel's access gates are stored as JSON the reader can parse", () => {
    const ch = rows<{ subscribe: string; publish: string }>(
      "SELECT subscribe, publish FROM broadcast_channels",
    )[0];
    expect(JSON.parse(ch!.subscribe)).toEqual({ access: "authenticated" });
    expect(JSON.parse(ch!.publish)).toEqual({ access: "roles", roles: ["admin"] });
  });

  test("the KPI arrives already watched", () => {
    const kpi = rows<{ alert_operator: string; alert_value: number }>(
      "SELECT alert_operator, alert_value FROM kpis WHERE slug = 'open-bt-orders'",
    )[0];
    expect(kpi?.alert_operator).toBe("above");
    expect(kpi?.alert_value).toBe(5);
  });

  test("the collection knows which field its board groups by", () => {
    const col = rows<{ kanban_group_by: string }>(
      "SELECT kanban_group_by FROM collections WHERE slug = 'bt_orders'",
    )[0];
    expect(col?.kanban_group_by).toBe("status");
  });
});
