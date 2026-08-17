/**
 * `templates extract` as a WORKSPACE transport, not just a schema one.
 *
 * `apply` could seed nine kinds of thing beyond collections — roles, dashboards,
 * KPIs, flows, documents, forms, agents, flags, channels — and `extract` emitted
 * none of them, so exporting a workspace and applying it somewhere else handed
 * over the tables and nothing that made them work. Worse, the write half
 * (`CustomTemplateInput`) is a plain `z.object`, so anything it does not name is
 * STRIPPED IN SILENCE: even a widened extract would have applied as bare tables.
 *
 * These tests drive the real round-trip — build a workspace, extract it, apply
 * the extract into a SECOND workspace, and look at what arrived. The four
 * collection knobs (`kanbanGroupBy`, `kanbanActionMap`, `stagedEdits`,
 * `portalLink`) are pinned the same way, because a catalog apply has always
 * seeded them and an extract has always dropped them.
 *
 * The other half of the design is `omissions`: everything the export CANNOT
 * carry — a form's one-way token, a raw-SQL panel, a permission on a collection
 * left behind — is named rather than vanishing. Borrowed from `rls.plan`, whose
 * own file says the omissions list "is not a footnote".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

interface Omission {
  resource: string;
  what: string;
  reason: string;
}
interface Extracted {
  collections: { slug: string; [k: string]: unknown }[];
  roles?: { name: string; permissions: { collection: string; action: string }[] }[];
  dashboards?: { name: string; panels: { name: string; kind: string }[] }[];
  kpis?: { slug: string; collection: string; [k: string]: unknown }[];
  flows?: { name: string; trigger: string; operations: Record<string, unknown>[]; active?: boolean }[];
  documents?: { key: string; name: string; bodyHtml: string }[];
  forms?: { name: string; collection: string; fields: { name: string }[] }[];
  agents?: { name: string; systemPrompt: string; tools: string[] }[];
  flags?: { key: string; enabled?: boolean }[];
  channels?: { name: string; pattern: string; subscribe: unknown; publish: unknown }[];
  omissions?: Omission[];
}

describe("templates extract — the bundle half", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const ok = async (res: Response) => {
    if (res.status >= 300) throw new Error(`${res.status} ${res.url} ${await res.text()}`);
    return res;
  };

  /** Build a workspace with one collection and one of each bundle kind. */
  const buildWorkspace = async () => {
    await ok(
      await h.fetch(
        "/api/collections",
        json({
          slug: "tickets",
          fields: [
            { name: "subject", type: "text", required: true },
            { name: "status", type: "text" },
            { name: "email", type: "email" },
          ],
        }),
      ),
    );
    // The four knobs a catalog apply seeds and an extract used to drop.
    await ok(
      await h.fetch(
        "/api/collections/tickets",
        json({ kanbanGroupBy: "status", kanbanActionMap: { done: "publish" }, stagedEdits: true }, "PATCH"),
      ),
    );
    await ok(await h.fetch("/api/roles", json({ name: "support", description: "Handles tickets" })));
    const roleId = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data.find((r) => r.name === "support")!.id;
    await ok(
      await h.fetch(
        `/api/roles/${roleId}/permissions`,
        json({ collection: "tickets", action: "read", fields: ["subject"] }),
      ),
    );
    await ok(
      await h.fetch(
        "/api/admin/kpis",
        json({ slug: "open-tickets", name: "Open tickets", collection: "tickets", agg: "count" }),
      ),
    );
    await ok(
      await h.fetch(
        "/api/flows",
        json({
          name: "Log a new ticket",
          trigger: "manual:",
          operations: [{ type: "log", message: "ticket {{ data.subject }}" }],
        }),
      ),
    );
    await ok(
      await h.fetch(
        "/api/admin/documents/templates/ticket-pdf",
        json({ name: "Ticket PDF", bodyHtml: "<h1>{{ data.subject }}</h1>" }, "PUT"),
      ),
    );
    await ok(
      await h.fetch(
        "/api/admin/forms",
        json({ name: "Report a problem", collection: "tickets", fields: [{ name: "subject" }] }),
      ),
    );
    await ok(
      await h.fetch(
        "/api/agents",
        json({ name: "Triage bot", systemPrompt: "You triage tickets.", tools: [] }),
      ),
    );
    await ok(
      await h.fetch("/api/admin/feature-flags/new_triage", json({ enabled: true }, "PUT")),
    );
    await ok(
      await h.fetch(
        "/api/admin/realtime-channels",
        json({
          name: "Ticket feed",
          pattern: "tickets:{id}",
          subscribe: { access: "roles", roles: ["support"] },
          publish: { access: "roles", roles: ["support"] },
        }),
      ),
    );
  };

  const extract = async (query = ""): Promise<Extracted> =>
    ((await (await ok(await h.fetch(`/api/admin/templates/extract${query}`))).json()) as {
      data: Extracted;
    }).data;

  test("every bundle kind the apply engine can seed now comes out of extract", async () => {
    await buildWorkspace();
    const t = await extract();

    expect(t.collections.map((c) => c.slug)).toEqual(["tickets"]);
    expect(t.roles?.map((r) => r.name)).toEqual(["support"]);
    // The system roles are excluded on purpose — every workspace already has
    // them before a template is applied, so exporting them emits three rows the
    // seeder is guaranteed to skip.
    expect(t.roles?.some((r) => ["admin", "authenticated", "public"].includes(r.name))).toBe(false);
    expect(t.roles?.[0]?.permissions).toEqual([
      expect.objectContaining({ collection: "tickets", action: "read" }),
    ]);
    expect(t.kpis?.map((k) => k.slug)).toEqual(["open-tickets"]);
    expect(t.flows?.map((f) => f.name)).toEqual(["Log a new ticket"]);
    expect(t.documents?.map((d) => d.key)).toEqual(["ticket-pdf"]);
    expect(t.forms?.map((f) => f.name)).toEqual(["Report a problem"]);
    expect(t.agents?.map((a) => a.name)).toEqual(["Triage bot"]);
    expect(t.flags?.map((f) => f.key)).toEqual(["new_triage"]);
    expect(t.channels?.map((c) => c.pattern)).toEqual(["tickets:{id}"]);
    // The channel's gates are TEXT columns holding JSON; emitting the raw
    // string would make the target store a string of a string.
    expect(t.channels?.[0]?.subscribe).toEqual({ access: "roles", roles: ["support"] });
  });

  test("the four collection knobs a catalog apply seeds now survive the export", async () => {
    await buildWorkspace();
    const t = await extract();
    const tickets = t.collections.find((c) => c.slug === "tickets")!;
    expect(tickets.kanbanGroupBy).toBe("status");
    expect(tickets.kanbanActionMap).toEqual({ done: "publish" });
    expect(tickets.stagedEdits).toBe(true);
  });

  test("runtime state and secrets never appear in the export", async () => {
    await buildWorkspace();
    const raw = JSON.stringify(await extract());
    // A form's token is a one-way hash; a KPI's alert state is another
    // workspace's alarm. Both are things a naive `SELECT *` would have carried.
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("token_hash");
    expect(raw).not.toContain("alertFiring");
    expect(raw).not.toContain("submissionCount");
    expect(raw).not.toContain("embedTokenHash");
  });

  test("a credential hiding in a flow step's headers does not ride out in the export", async () => {
    // Every COLUMN this export reads is secret-free, but a flow's operation
    // tree is free-form: `headers` on a `webhook`/`request` step is a
    // Record<string,string>, and putting a bearer token there is the normal way
    // to call an authenticated API. Without stripping them, the one document an
    // admin is most likely to commit to git carries a live credential.
    await buildWorkspace();
    await ok(
      await h.fetch(
        "/api/flows",
        json({
          name: "Notify the billing system",
          trigger: "manual:",
          operations: [
            {
              type: "webhook",
              url: "https://billing.example.com/hook",
              headers: { Authorization: "Bearer sk-live-DO-NOT-EXPORT" },
            },
          ],
        }),
      ),
    );
    const t = await extract();
    const raw = JSON.stringify(t);
    expect(raw).not.toContain("sk-live-DO-NOT-EXPORT");
    expect(raw).not.toContain("Bearer");
    // The step itself still travels — the URL and the shape are the useful
    // half — and the loss is named rather than left to be discovered by a 401.
    const flow = t.flows?.find((f) => f.name === "Notify the billing system");
    expect(flow?.operations?.[0]?.url).toBe("https://billing.example.com/hook");
    expect(
      t.omissions?.some(
        (o) => o.resource === "flow:Notify the billing system" && o.what.includes("Authorization"),
      ),
    ).toBe(true);
  });

  test("what could not travel is NAMED, not dropped in silence", async () => {
    await buildWorkspace();
    const t = await extract();
    const forForm = t.omissions?.filter((o) => o.resource === "form:Report a problem") ?? [];
    expect(forForm.length).toBe(1);
    expect(forForm[0]?.what).toContain("token");
    expect(forForm[0]?.reason).toContain("Rotate token");
  });

  test("a permission naming a collection left out of a narrowed export is refused and reported", async () => {
    await buildWorkspace();
    await ok(
      await h.fetch("/api/collections", json({ slug: "notes", fields: [{ name: "body", type: "text" }] })),
    );
    const roleId = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data.find((r) => r.name === "support")!.id;
    await ok(
      await h.fetch(`/api/roles/${roleId}/permissions`, json({ collection: "notes", action: "read" })),
    );

    // Narrow the export to `tickets` only — the grant on `notes` would apply
    // into a workspace where that slug is absent, or is somebody else's.
    const t = await extract("?collections=tickets");
    const grants = t.roles?.find((r) => r.name === "support")?.permissions ?? [];
    expect(grants.map((g) => g.collection)).toEqual(["tickets"]);
    expect(
      t.omissions?.some((o) => o.resource === "role:support" && o.what.includes("notes")),
    ).toBe(true);
  });

  describe("the round trip actually carries", () => {
    /** Apply an extracted document into a SECOND workspace and read it back. */
    const applyInto = async (doc: Extracted) => {
      const created = await ok(
        await h.fetch("/api/tenants", json({ name: "Target", slug: "target" })),
      );
      const { data } = (await created.json()) as { data: { id: string } };
      const as = (path: string, init?: RequestInit): Promise<Response> =>
        h.fetch(path, {
          ...(init ?? {}),
          headers: { ...(init?.headers ?? {}), "x-backlex-tenant": data.id },
        });
      await ok(
        await as(
          "/api/admin/templates/apply",
          json({ template: { ...doc, label: "Round trip" } }),
        ),
      );
      return as;
    };

    test("applying an extract into a fresh workspace brings the bundles with it", async () => {
      await buildWorkspace();
      const doc = await extract();
      const as = await applyInto(doc);

      const names = async (path: string, key = "name") =>
        ((await (await ok(await as(path))).json()) as { data: Record<string, unknown>[] }).data.map(
          (r) => r[key],
        );

      expect(await names("/api/collections", "slug")).toContain("tickets");
      expect(await names("/api/roles")).toContain("support");
      expect(await names("/api/flows")).toContain("Log a new ticket");
      expect(await names("/api/admin/kpis", "slug")).toContain("open-tickets");
      expect(await names("/api/admin/documents/templates", "key")).toContain("ticket-pdf");
      expect(await names("/api/admin/forms")).toContain("Report a problem");
      expect(await names("/api/agents")).toContain("Triage bot");
      expect(await names("/api/admin/feature-flags", "key")).toContain("new_triage");
      expect(await names("/api/admin/realtime-channels", "pattern")).toContain("tickets:{id}");
    });

    test("the Kanban configuration survives the trip — it used to be stripped in silence", async () => {
      // This is the regression the whole commit exists for. `CustomTemplateInput`
      // is a plain z.object, so before this change `kanbanGroupBy` was removed
      // from the payload with no error, and the target came up unconfigured.
      await buildWorkspace();
      const doc = await extract();
      const as = await applyInto(doc);
      const cols = ((await (await ok(await as("/api/collections"))).json()) as {
        data: { slug: string; kanbanGroupBy?: string; stagedEdits?: boolean }[];
      }).data;
      const tickets = cols.find((c) => c.slug === "tickets");
      expect(tickets?.kanbanGroupBy).toBe("status");
      expect(tickets?.stagedEdits).toBe(true);
    });

    test("re-applying the very document extract emitted does not fail on its own omissions key", async () => {
      // extract writes `omissions` so a human reading the file knows what did
      // not come with it. A schema that refused the key would make the exporter
      // produce a document its own importer rejects.
      await buildWorkspace();
      const doc = await extract();
      expect(doc.omissions?.length).toBeGreaterThan(0);
      const as = await applyInto(doc);
      expect(
        ((await (await ok(await as("/api/collections"))).json()) as { data: unknown[] }).data.length,
      ).toBeGreaterThan(0);
    });
  });
});
