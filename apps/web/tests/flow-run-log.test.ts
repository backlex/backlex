/**
 * A flow's `log` operation wrote nowhere you could read.
 *
 * `docs/flows.md` demonstrates `{ "type": "log", "message": "…" }` twice — at
 * :489 in the REST example and :505 in the SDK one — as the introductory
 * operation. It is what a person reaches for to answer "did my interpolation
 * resolve?". It called `console.log` and nothing else, so on a managed tenant,
 * whose operator cannot open the account's Worker observability, the one
 * operation designed for looking produced nothing to find.
 *
 * Searched, on a live tenant, with a distinctive substring of the RENDERED
 * output against every observable surface: `/api/activity` (0 hits),
 * `/api/notifications` (0), `/api/jobs` (0). The positive control on the same
 * responses: the flow's NAME was present, and a `notification` op's rendered
 * body WAS readable — so the search worked and the pipeline ran. Only the log
 * was absent. `/api/activity?action=flow.run` recorded the run as
 * `{"response":{"ok":true,"error":null},"durationMs":0}` — no per-op result —
 * and the whole flow surface is three routes, so there was no run history to
 * look in either.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("a flow run records what its log ops rendered", () => {
  let h: TestHarness;
  const ts = Date.now();
  const dealers = `fl_dealers_${ts}`;

  // `POST /api/flows/:id/run` takes the flow's `data` payload DIRECTLY — not
  // wrapped in `{ data: … }`. Wrapping it is why an earlier probe in this
  // session saw `{{ data.number }}` render empty and briefly read as a bug.
  const post = async (path: string, body: unknown, expected = 201) => {
    const r = await h.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    expect(r.status).toBe(expected);
    return (await r.json()) as any;
  };

  /** The newest `flow.run` activity row's recorded response. */
  const lastRun = async (): Promise<{ ok: boolean; error: string | null; log?: string[] }> => {
    const r = await h.fetch("/api/activity?action=flow.run&limit=1");
    const b = (await r.json()) as { data: { response: any }[] };
    return b.data[0]?.response;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await post("/api/collections", {
      slug: dealers,
      fields: [
        { name: "name", type: "text" },
        { name: "tier", type: "text" },
      ],
    });
  });

  test("the rendered message is readable through the API, not only in Worker logs", async () => {
    const flow = await post("/api/flows", {
      name: "log probe",
      trigger: "manual:",
      active: true,
      operations: [{ type: "log", message: "dealer={{ data.name }} tier={{ data.tier }}" }],
    });
    const id = flow.data?.id ?? flow.id;

    const r = await h.fetch(`/api/flows/${id}/run`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Ege Yapı", tier: "gold" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; log?: string[] };
    expect(body.ok).toBe(true);
    // The run's own response carries it…
    expect(body.log).toEqual(["dealer=Ege Yapı tier=gold"]);
    // …and so does the activity row, which is where runs were already
    // observable and where someone debugging after the fact will look.
    const recorded = await lastRun();
    expect(recorded.log).toEqual(["dealer=Ege Yapı tier=gold"]);
  });

  test("several log ops keep their order", async () => {
    const flow = await post("/api/flows", {
      name: "ordered log probe",
      trigger: "manual:",
      active: true,
      operations: [
        { type: "log", message: "first" },
        { type: "log", message: "second" },
        { type: "log", message: "third" },
      ],
    });
    await h.fetch(`/api/flows/${(flow.data?.id ?? flow.id)}/run`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect((await lastRun()).log).toEqual(["first", "second", "third"]);
  });

  test("a flow with no log op records no log key at all", async () => {
    // Not `[]` — the field is absent, so an existing consumer of the run
    // response sees exactly the shape it saw before.
    const flow = await post("/api/flows", {
      name: "silent probe",
      trigger: "manual:",
      active: true,
      operations: [{ type: "notification", title: "hi", body: "there", userId: null }],
    });
    const r = await h.fetch(`/api/flows/${(flow.data?.id ?? flow.id)}/run`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    const body = (await r.json()) as Record<string, unknown>;
    expect("log" in body).toBe(false);
  });

  test("the collector is bounded — a loop cannot turn one run into a write amplifier", async () => {
    // A `log` inside a `foreach` over a large collection would otherwise put a
    // line per row into an activity payload.
    for (let i = 0; i < 60; i++) {
      await post(`/api/items/${dealers}`, { name: `d${i}`, tier: "bronze" });
    }
    const flow = await post("/api/flows", {
      name: "loop log probe",
      trigger: "manual:",
      active: true,
      operations: [
        {
          type: "foreach",
          collection: dealers,
          do: [{ type: "log", message: "row {{ $item.name }}" }],
        },
      ],
    });
    const r = await h.fetch(`/api/flows/${(flow.data?.id ?? flow.id)}/run`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    const body = (await r.json()) as { log?: string[] };
    expect(body.log!.length).toBeLessThanOrEqual(51);
    expect(body.log!.at(-1)).toContain("truncated");
  });
});
