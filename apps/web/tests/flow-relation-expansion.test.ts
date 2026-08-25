/**
 * `{{ data.customer.name }}` in a flow used to render nothing.
 *
 * A flow's `data` is the raw row, where a relation is a bare foreign key — so
 * dereferencing one resolved to `undefined` and interpolated to an empty
 * string, leaving the notification the `field-service` template ships reading
 * "WO-00031 for , normal priority." with the customer set. Nothing failed; the
 * dangling punctuation was the only evidence.
 *
 * That dereference is not a mistake by template authors: `docs/flows.md`
 * documents it as the way to write a flow, and the catalog uses it 267 times
 * across 25 of the 27 templates. The payload was what was wrong.
 *
 * The compatibility half matters as much as the fix. A bare `{{ data.customer }}`
 * has always rendered the foreign key and flows depend on that, so expansion
 * only happens for relations a flow reads THROUGH (`data.<rel>.<something>`),
 * and the expanded value still stringifies to the id.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("flow relation expansion", () => {
  let h: TestHarness;
  const ts = Date.now();
  const customers = `fx_customers_${ts}`;
  const jobs = `fx_jobs_${ts}`;
  const audit = `fx_audit_${ts}`;
  let customerId: string;

  const post = async (path: string, body: unknown, expected = 201) => {
    const r = await h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    expect(r.status).toBe(expected);
    return (await r.json()) as { data?: { id: string } };
  };

  /** Everything a flow wrote, newest first. */
  const auditRows = async (): Promise<Record<string, string>[]> => {
    const r = await h.fetch(`/api/items/${audit}?limit=50`);
    const b = (await r.json()) as { data: Record<string, string>[] };
    return b.data;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    await post("/api/collections", {
      slug: customers,
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "email" },
      ],
    });
    await post("/api/collections", {
      slug: audit,
      fields: [
        { name: "note", type: "text" },
        { name: "raw", type: "text" },
      ],
    });
    await post("/api/collections", {
      slug: jobs,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "customer", type: "relation", to: customers },
        { name: "watchers", type: "relation_many", to: customers },
      ],
    });

    const c = await post(`/api/items/${customers}`, {
      name: "Riverside Apartments",
      email: "site@riverside.example",
    });
    customerId = c.data?.id as string;
  });

  test("a dereferenced relation resolves — and the bare form still gives the id", async () => {
    await post("/api/flows", {
      name: `expand_${ts}`,
      trigger: `items:${jobs}:created`,
      operations: [
        {
          type: "item.create",
          collection: audit,
          data: {
            // The pattern every template uses, and the one that rendered empty.
            note: "{{ data.title }} for {{ data.customer.name }} <{{ data.customer.email }}>",
            // In the SAME flow: the bare form must keep meaning the foreign key,
            // or fixing the first breaks every flow that relied on the second.
            raw: "{{ data.customer }}",
          },
        },
      ],
    });

    await post(`/api/items/${jobs}`, { title: "AC not cooling", customer: customerId });
    await new Promise((r) => setTimeout(r, 250));

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toBe("AC not cooling for Riverside Apartments <site@riverside.example>");
    expect(rows[0]?.raw).toBe(customerId);
  });

  test("a relation nobody reads through is left as the foreign key", async () => {
    // No `data.customer.<field>` anywhere in this flow, so there is nothing to
    // resolve and no lookup to pay for — the id must survive untouched.
    await post("/api/flows", {
      name: `bare_${ts}`,
      trigger: `items:${jobs}:updated`,
      operations: [{ type: "item.create", collection: audit, data: { note: "{{ data.customer }}" } }],
    });

    const job = await post(`/api/items/${jobs}`, { title: "bare probe", customer: customerId });
    await h.fetch(`/api/items/${jobs}/${job.data?.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "bare probe touched" }),
    });
    await new Promise((r) => setTimeout(r, 250));

    const rows = await auditRows();
    expect(rows.some((r) => r.note === customerId)).toBe(true);
  });

  test("a foreign key whose row is gone leaves the id and does not fail the run", async () => {
    // A relation target cannot be invented — the API validates it on write — so
    // the honest way to produce a dangling key is to delete the row afterwards,
    // which is also how it happens in production.
    const doomed = await post(`/api/items/${customers}`, { name: "Closed Account" });
    const job = await post(`/api/items/${jobs}`, { title: "orphan", customer: doomed.data?.id });
    const del = await h.fetch(`/api/items/${customers}/${doomed.data?.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    await post("/api/flows", {
      name: `dangling_${ts}`,
      trigger: `items:${jobs}:updated`,
      operations: [
        { type: "item.create", collection: audit, data: { note: "[{{ data.customer.name }}]", raw: "ran" } },
      ],
    });
    await h.fetch(`/api/items/${jobs}/${job.data?.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "orphan touched" }),
    });
    await new Promise((r) => setTimeout(r, 250));

    const ran = (await auditRows()).filter((r) => r.raw === "ran");
    expect(ran.length).toBeGreaterThan(0);
    // Empty, not a crash: there is genuinely no name left to print.
    expect(ran.some((r) => r.note === "[]")).toBe(true);
  });
});
