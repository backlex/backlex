import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Survey-shaped forms: scale / NPS question blocks, the multi-select
 * distribution (which needs the aggregate engine to explode a JSON array), and
 * the results summary those two feed.
 *
 * The point of the results assertions is arithmetic, not plumbing: a bucket
 * that counts the whole array instead of its elements, or an NPS that averages
 * instead of scoring, still returns a well-shaped payload full of wrong
 * numbers — which is the failure mode a summary panel cannot survive.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("form results", () => {
  let h: TestHarness;
  const slug = `survey_${Date.now()}`;
  let formId = "";
  let token = "";

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  const submit = async (data: Record<string, unknown>) =>
    publicFetch(`/api/public/forms/${token}/submit`, json({ data }));

  interface ResultBlock {
    name: string;
    kind: string;
    answered: number;
    average: number | null;
    nps: { promoters: number; passives: number; detractors: number; score: number } | null;
    buckets: { value: string; label: string; count: number }[] | null;
  }

  const results = async (): Promise<{ rows: number; blocks: ResultBlock[]; truncated: number }> => {
    const res = await h.fetch(`/api/admin/forms/${formId}/results`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { rows: number; blocks: ResultBlock[]; truncated: number } })
      .data;
  };

  const block = (blocks: ResultBlock[], name: string): ResultBlock => {
    const b = blocks.find((x) => x.name === name);
    expect(b).toBeDefined();
    return b!;
  };

  const bucket = (b: ResultBlock, value: string): number =>
    b.buckets?.find((k) => k.value === value)?.count ?? -1;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const created = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "recommend", type: "integer", label: "How likely to recommend" },
          { name: "ease", type: "integer" },
          {
            name: "channels",
            type: "json",
            label: "Where did you hear about us",
            options: {
              choices: [
                { value: "search", label: "Search" },
                { value: "friend", label: "A friend" },
                { value: "ads" },
              ],
            },
          },
          {
            name: "plan",
            type: "text",
            options: { choices: [{ value: "free" }, { value: "pro" }] },
          },
          { name: "subscribed", type: "boolean" },
          { name: "comment", type: "longtext" },
        ],
      }),
    );
    expect(created.status).toBe(201);

    const form = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Customer survey",
        collection: slug,
        fields: [
          {
            name: "recommend",
            label: "Would you recommend us?",
            scale: { min: 0, max: 10, style: "nps", minLabel: "Not at all", maxLabel: "Definitely" },
          },
          { name: "ease", scale: { min: 1, max: 5, style: "stars" } },
          { name: "channels" },
          { name: "plan" },
          { name: "subscribed" },
          { name: "comment" },
        ],
      }),
    );
    expect(form.status).toBe(201);
    const body = (await form.json()) as { data: { form: { id: string }; token: string } };
    formId = body.data.form.id;
    token = body.data.token;
  });

  afterAll(() => {
    h.cleanup();
  });

  test("the public definition carries the scale, and stars keep the legacy flag", async () => {
    const res = await publicFetch(`/api/public/forms/${token}`);
    expect(res.status).toBe(200);
    const blocks = (
      (await res.json()) as {
        data: {
          blocks: {
            name?: string;
            rating: boolean;
            scale: { min: number; max: number; style: string; minLabel?: string } | null;
          }[];
        };
      }
    ).data.blocks;

    const nps = blocks.find((b) => b.name === "recommend")!;
    expect(nps.scale).toEqual({
      min: 0,
      max: 10,
      style: "nps",
      minLabel: "Not at all",
      maxLabel: "Definitely",
    });
    // A page bundle cached from before `scale` existed reads `rating` — which
    // must stay false here, or an NPS row would render as five stars.
    expect(nps.rating).toBe(false);

    const stars = blocks.find((b) => b.name === "ease")!;
    expect(stars.scale?.style).toBe("stars");
    expect(stars.rating).toBe(true);
  });

  test("a legacy rating:true block still resolves to the 1–5 star scale", async () => {
    const res = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Legacy",
        collection: slug,
        fields: [{ name: "ease", rating: true }],
      }),
    );
    expect(res.status).toBe(201);
    const legacyToken = ((await res.json()) as { data: { token: string } }).data.token;
    const def = await publicFetch(`/api/public/forms/${legacyToken}`);
    const blocks = (
      (await def.json()) as { data: { blocks: { scale: { min: number; max: number; style: string } | null }[] } }
    ).data.blocks;
    expect(blocks[0]?.scale).toEqual({ min: 1, max: 5, style: "stars" });
  });

  test("a scale wider than 11 points is refused at design time", async () => {
    const res = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Too wide",
        collection: slug,
        fields: [{ name: "ease", scale: { min: 1, max: 100, style: "number" } }],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("11 points");
  });

  test("a scale on a non-integer field is refused at design time", async () => {
    const res = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Wrong column",
        collection: slug,
        fields: [{ name: "comment", scale: { min: 1, max: 5, style: "stars" } }],
      }),
    );
    expect(res.status).toBe(422);
  });

  test("submits land, and an answer off the scale is refused", async () => {
    // Six responses. Recommend: 10, 9 (promoters), 8 (passive), 6, 3 (detractors),
    // and one who skipped it.
    const rows: Record<string, unknown>[] = [
      { recommend: 10, ease: 5, channels: ["search", "friend"], plan: "pro", subscribed: true, comment: "Great" },
      { recommend: 9, ease: 4, channels: ["search"], plan: "pro", subscribed: true },
      { recommend: 8, ease: 4, channels: ["friend", "ads"], plan: "free", subscribed: false },
      { recommend: 6, ease: 2, channels: ["search", "ads"], plan: "free", subscribed: false, comment: "Slow" },
      { recommend: 3, ease: 1, channels: [], plan: "free", subscribed: false },
      { ease: 3, plan: "pro", subscribed: true },
    ];
    for (const data of rows) {
      const res = await submit(data);
      expect(res.status).toBe(201);
    }

    const off = await submit({ recommend: 47, ease: 3 });
    expect(off.status).toBe(422);
    const body = (await off.json()) as { error: { message: string } };
    expect(body.error.message).toContain("between 0 and 10");

    // …and one below the floor, which a `min` of 0 makes easy to get wrong.
    const under = await submit({ recommend: -1, ease: 3 });
    expect(under.status).toBe(422);

    const fraction = await submit({ recommend: 7.5, ease: 3 });
    expect(fraction.status).toBe(422);
  });

  test("an NPS block is scored, not averaged", async () => {
    const { blocks } = await results();
    const nps = block(blocks, "recommend");
    expect(nps.kind).toBe("scale");
    expect(nps.answered).toBe(5);
    // 2 promoters, 1 passive, 2 detractors over 5 answers → 40 − 40 = 0.
    expect(nps.nps).toEqual({ promoters: 2, passives: 1, detractors: 2, score: 0 });
    expect(nps.average).toBe(7.2);
    // Every point of the row gets a bucket, in order, including the empty ones —
    // a histogram with holes in it is not a histogram.
    expect(nps.buckets?.map((b) => b.value)).toEqual([
      "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    ]);
    expect(bucket(nps, "10")).toBe(1);
    expect(bucket(nps, "3")).toBe(1);
    expect(bucket(nps, "5")).toBe(0);
  });

  test("a star scale gets its mean and every point", async () => {
    const { blocks } = await results();
    const ease = block(blocks, "ease");
    expect(ease.answered).toBe(6);
    expect(ease.average).toBe(3.17); // (5+4+4+2+1+3)/6
    expect(ease.nps).toBeNull();
    expect(ease.buckets?.map((b) => b.value)).toEqual(["1", "2", "3", "4", "5"]);
    expect(bucket(ease, "4")).toBe(2);
  });

  test("a multi-select counts each chosen value, not each array", async () => {
    const { blocks } = await results();
    const channels = block(blocks, "channels");
    expect(channels.kind).toBe("multi_choice");
    // search 3, friend 2, ads 2 — nine picks across four people who picked at
    // all (the empty array and the skipped row are not answers).
    expect(bucket(channels, "search")).toBe(3);
    expect(bucket(channels, "friend")).toBe(2);
    expect(bucket(channels, "ads")).toBe(2);
    // `answered` counts PEOPLE, so it must not be the sum of the buckets.
    expect(channels.answered).toBe(5);
    // Choice labels come from the schema, and the order is the schema's.
    expect(channels.buckets?.map((b) => b.label)).toEqual(["Search", "A friend", "ads"]);
  });

  test("choice and boolean questions keep their schema order", async () => {
    const { blocks } = await results();
    const plan = block(blocks, "plan");
    expect(plan.kind).toBe("choice");
    expect(plan.buckets?.map((b) => b.value)).toEqual(["free", "pro"]);
    expect(bucket(plan, "pro")).toBe(3);
    expect(bucket(plan, "free")).toBe(3);
    expect(plan.answered).toBe(6);

    const subscribed = block(blocks, "subscribed");
    expect(subscribed.kind).toBe("boolean");
    // Dialect-independent: sqlite stores 0/1 and Postgres true/false.
    expect(subscribed.buckets?.map((b) => b.value)).toEqual(["true", "false"]);
    expect(bucket(subscribed, "true")).toBe(3);
    expect(bucket(subscribed, "false")).toBe(3);
  });

  test("free-text answers are counted, never quoted", async () => {
    const { rows, blocks } = await results();
    expect(rows).toBe(6);
    const comment = block(blocks, "comment");
    expect(comment.kind).toBe("text");
    expect(comment.answered).toBe(2);
    expect(comment.buckets).toBeNull();
    // The words themselves must not travel through this endpoint.
    expect(JSON.stringify(comment)).not.toContain("Great");
    expect(JSON.stringify(comment)).not.toContain("Slow");
  });

  test("the aggregate endpoint itself explodes a multi-select groupBy", async () => {
    // The results panel is one caller; a dashboard panel grouping by the same
    // column must get the same per-choice counts.
    const res = await h.fetch(
      `/api/items/${slug}/aggregate`,
      json({ agg: "count", groupBy: "channels" }),
    );
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { label: string; value: number }[] }).data;
    const byLabel = new Map(data.map((r) => [r.label, Number(r.value)]));
    expect(byLabel.get("search")).toBe(3);
    expect(byLabel.get("friend")).toBe(2);
    expect(byLabel.get("ads")).toBe(2);
    // The raw array must never surface as a bucket of its own.
    expect([...byLabel.keys()].some((k) => k.includes("["))).toBe(false);
  });

  test("an avg grouped by a multi-select answers per choice", async () => {
    const res = await h.fetch(
      `/api/items/${slug}/aggregate`,
      json({ agg: "avg", field: "ease", groupBy: "channels" }),
    );
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { label: string; value: number }[] }).data;
    const byLabel = new Map(data.map((r) => [r.label, Number(r.value)]));
    // People who picked "friend" rated ease 5 and 4.
    expect(byLabel.get("friend")).toBeCloseTo(4.5, 5);
    // Those who picked "search": 5, 4, 2.
    expect(byLabel.get("search")).toBeCloseTo(11 / 3, 5);
  });

  test("results 404 for an unknown form", async () => {
    const res = await h.fetch(`/api/admin/forms/does-not-exist/results`);
    expect(res.status).toBe(404);
  });
});
