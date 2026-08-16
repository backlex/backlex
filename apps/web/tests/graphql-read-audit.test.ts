/**
 * A GraphQL read of an audited collection leaves a trace.
 *
 * It did not. `auditRead` needs a Hono `Context` and GraphQL has none, so every
 * `access.read` row in the product came from `/api/items/*` — and a workspace
 * could switch `auditReads` on for its patient records, watch the log fill up
 * from the admin UI, and have every read through `/api/graphql` recorded
 * nowhere. The failure shape is the bad one: the feature looks like it works,
 * and the surface that bypasses it is the one an integration would use.
 *
 * The case that matters most is the third test. A nested selection
 * (`{ visits { patient } }`) loads the sensitive rows through a DataLoader that
 * never reaches the by-id resolver — so hooking the two obvious entry points
 * and stopping would leave exactly the bulk read an auditor cares about
 * recording nothing at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface AccessRow {
  action: string;
  collection: string | null;
  itemId: string | null;
  payload: Record<string, unknown> | null;
}

const gql = (h: TestHarness, query: string, variables?: Record<string, unknown>) =>
  h.fetch("/api/graphql", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ query, variables }),
  });

/** Read auditing is fire-and-forget, so a single read can race the insert. */
const waitForAccess = async (
  h: TestHarness,
  predicate: (rows: AccessRow[]) => boolean,
  tries = 30,
): Promise<AccessRow[]> => {
  let last: AccessRow[] = [];
  for (let i = 0; i < tries; i++) {
    const res = await h.fetch("/api/activity?action=access&limit=200");
    last = ((await res.json()) as { data: AccessRow[] }).data;
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out; last saw ${JSON.stringify(last.slice(0, 5))}`);
};

describe("graphql — sensitive-read auditing", () => {
  let h: TestHarness;
  const patients = "gql_audit_patients";
  const visits = "gql_audit_visits";
  // The schema camelCases a slug: `gql_audit_patients` → `gqlAuditPatients`
  // (list) / `gqlAuditPatient` (by id). Named here rather than inline so a
  // rename breaks in one place.
  const gqlPatients = "gqlAuditPatients";
  const gqlPatient = "gqlAuditPatient";
  const gqlVisits = "gqlAuditVisits";
  let patientId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    // The audited collection, and an un-audited one that points at it — the
    // shape a clinic template actually has.
    const mk = (slug: string, body: Record<string, unknown>) =>
      h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug, ownerScoped: false, ...body }),
      });

    expect(
      (
        await mk(patients, {
          auditReads: true,
          fields: [
            { name: "name", type: "text", required: true },
            { name: "diagnosis", type: "text" },
          ],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await mk(visits, {
          auditReads: false,
          fields: [
            { name: "note", type: "text" },
            { name: "patient", type: "relation", to: patients },
          ],
        })
      ).status,
    ).toBe(201);

    const p = await h.fetch(`/api/items/${patients}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Ada", diagnosis: "private" }),
    });
    expect(p.status).toBe(201);
    patientId = ((await p.json()) as any).data.id;

    const v = await h.fetch(`/api/items/${visits}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ note: "checkup", patient: patientId }),
    });
    expect(v.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("a GraphQL list records what was read, and says which surface read it", async () => {
    const res = await gql(h, `{ ${gqlPatients} { id name } }`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data[gqlPatients]).toHaveLength(1);

    const rows = await waitForAccess(h, (r) =>
      r.some((x) => x.collection === patients && x.payload?.surface === "graphql"),
    );
    const row = rows.find(
      (x) => x.collection === patients && (x.payload as any)?.count !== undefined,
    );
    expect(row?.action).toBe("access.read");
    expect((row!.payload as any).count).toBe(1);
    expect((row!.payload as any).ids).toEqual([patientId]);
    // Metadata only. The whole point of the feature is defeated if the audit
    // re-stores what it was auditing — in a table with a longer reach than the
    // collection's own permissions.
    expect(JSON.stringify(row!.payload)).not.toContain("private");
    expect(JSON.stringify(row!.payload)).not.toContain("Ada");
  });

  test("a GraphQL by-id read records the row it returned", async () => {
    const res = await gql(h, `{ ${gqlPatient}(id: "${patientId}") { id name } }`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // The singular field name is derived; if the schema names it otherwise this
    // assertion tells us, rather than the test silently proving nothing.
    expect(body.errors).toBeUndefined();

    const rows = await waitForAccess(h, (r) =>
      r.some((x) => x.collection === patients && x.itemId === patientId),
    );
    const row = rows.find((x) => x.itemId === patientId)!;
    expect(row.action).toBe("access.read");
    expect((row.payload as any).fields).toContain("name");
    expect(JSON.stringify(row.payload)).not.toContain("private");
  });

  test("a NESTED relation read is audited — the loader path, not the resolver", async () => {
    // `{ visits { patient } }` loads patient rows through the batch loader,
    // which never reaches the by-id resolver. Auditing only the two top-level
    // entry points would leave this — a bulk read of the sensitive collection,
    // through the un-audited one — recorded nowhere.
    const before = ((await (await h.fetch("/api/activity?action=access&limit=200")).json()) as {
      data: AccessRow[];
    }).data.length;

    const res = await gql(h, `{ ${gqlVisits} { id note patient { id name } } }`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.errors).toBeUndefined();
    expect(body.data[gqlVisits][0].patient.name).toBe("Ada");

    const rows = await waitForAccess(
      h,
      (r) => r.length > before && r.some((x) => (x.payload as any)?.relation === true),
    );
    const row = rows.find((x) => (x.payload as any)?.relation === true)!;
    expect(row.collection).toBe(patients);
    expect(row.action).toBe("access.read");
    // One row for the batch, because one `WHERE id IN (…)` is what happened.
    expect((row.payload as any).count).toBe(1);
    expect((row.payload as any).ids).toEqual([patientId]);
    // And the un-audited parent recorded nothing of its own.
    expect(rows.some((x) => x.collection === visits)).toBe(false);
  });

  test("a collection that did not opt in records nothing, on either surface", async () => {
    const before = ((await (await h.fetch("/api/activity?action=access&limit=200")).json()) as {
      data: AccessRow[];
    }).data.filter((r) => r.collection === visits).length;
    expect(before).toBe(0);

    await gql(h, `{ ${gqlVisits} { id note } }`);
    await h.fetch(`/api/items/${visits}`);
    await new Promise((r) => setTimeout(r, 150));

    const after = ((await (await h.fetch("/api/activity?action=access&limit=200")).json()) as {
      data: AccessRow[];
    }).data.filter((r) => r.collection === visits).length;
    expect(after).toBe(0);
  });

  test("an aggregate is audited on BOTH surfaces, not just the new one", async () => {
    // REST's `/aggregate` recorded nothing either. Closing the gap on GraphQL
    // alone would have moved the blind spot rather than removed it — a COUNT
    // over a patient table still tells you about patients.
    const rest = await h.fetch(`/api/items/${patients}/aggregate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agg: "count" }),
    });
    expect(rest.status).toBe(200);
    const restRows = await waitForAccess(h, (r) =>
      r.some((x) => x.collection === patients && (x.payload as any)?.aggregate === "count"),
    );
    const restRow = restRows.find((x) => (x.payload as any)?.aggregate === "count")!;
    expect((restRow.payload as any).surface).toBeUndefined();

    const gqlRes = await gql(h, `{ ${gqlPatients}Aggregate(agg: "count") }`);
    expect(gqlRes.status).toBe(200);
    const gqlRows = await waitForAccess(h, (r) =>
      r.some(
        (x) =>
          x.collection === patients &&
          (x.payload as any)?.aggregate === "count" &&
          (x.payload as any)?.surface === "graphql",
      ),
    );
    expect(
      gqlRows.filter((x) => (x.payload as any)?.aggregate === "count").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
