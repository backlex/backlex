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
 * The invoicing vertical, applied for real through the REST route.
 *
 * The synthetic fixture below proves the seeder; this proves the CATALOG — that
 * a template an operator can actually pick arrives with its document numbers
 * issued by the server and its counter left standing, so the first invoice they
 * raise does not collide with a demo row.
 */
describe("a catalog template arrives with its numbering already running", () => {
  let h: TestHarness;

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
  });

  afterAll(() => h.cleanup());

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
    // Both dates supplied: the template's own cross-field rule compares them,
    // and it fires when they are absent as well as when they are out of order.
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
