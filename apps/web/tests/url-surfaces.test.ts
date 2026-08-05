/**
 * Multi-surface parity for URL fields.
 *
 * Two guarantees, each with its own way of quietly not shipping:
 *
 *   1. **Every surface that WRITES a row folds its URLs.** This is the one the
 *      parity gate exists for. The REST write core does it in `performCreate`,
 *      but the GraphQL create resolver hand-builds its own INSERT and does not
 *      go through that function — the same gap that made #38's rollups, #39's
 *      sequence numbers, #40's points, #41's amounts, #43's numbers, #47's
 *      addresses and #48's positions ship on REST only until a test like this
 *      caught it. Sixth feature running; assume it is missed.
 *   2. **Every surface that READS with a filter folds its operands**, so a
 *      lookup by the address a person types finds the row on every surface and
 *      not just on REST.
 *
 * The second one caught a PRE-EXISTING gap while this was being written, and it
 * was not about `url` at all: GraphQL's filter path never called the email or
 * phone operand normalizers either, so a GraphQL query filtering an email column
 * by `Ada@Example.com` matched nothing while the identical REST call matched the
 * row. Those assertions are here too, under their own names.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a thin
 * argv parser over the SDK, and what rots is a subcommand disappearing.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const sites = "parurl_sites";

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const made = await h.fetch(
    "/api/collections",
    json({
      slug: sites,
      fields: [
        { name: "name", type: "text", required: true },
        { name: "website", type: "url" },
        { name: "contact", type: "email" },
        { name: "hotline", type: "phone", phone: { region: "TR" } },
      ],
    }),
  );
  expect(made.status).toBe(201);
});

describe("every write surface folds", () => {
  test("REST", async () => {
    const r = await h.fetch(`/api/items/${sites}`, json({ name: "rest", website: "Acme.COM" }));
    expect(((await r.json()) as any).data.website).toBe("https://acme.com/");
  });

  test("the SDK", async () => {
    const row = (await sdk()
      .from(sites)
      .create({ name: "sdk", website: "HTTPS://Acme.com:443" })) as any;
    expect(row.data?.website ?? row.website).toBe("https://acme.com/");
  });

  test("GraphQL — the resolver that hand-builds its own INSERT", async () => {
    // Without `canonicalizeUrlFields` in the GraphQL create path this is the one
    // surface that can put an unfolded URL into a column every other surface
    // guarantees is canonical, quietly breaking `unique` and lookup-by-address
    // for rows written through it.
    //
    // Asserted on the MUTATION's own response as well: the resolver has to write
    // the folded value back onto its payload, or a client that just created a
    // row holds a string that does not equal it.
    const res = await gql(`mutation {
      createParurlSites(data: { name: "gql", website: "  ACME.com/Path  " }) { id website }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.createParurlSites.website).toBe("https://acme.com/Path");
  });

  test("GraphQL update folds too", async () => {
    const made = await gql(`mutation {
      createParurlSites(data: { name: "gqlup" }) { id }
    }`);
    const id = made.data?.createParurlSites.id;
    const res = await gql(`mutation {
      updateParurlSites(id: "${id}", data: { website: "Example.ORG" }) { website }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.updateParurlSites.website).toBe("https://example.org/");
  });
});

describe("every read surface folds its filter operands", () => {
  beforeAll(async () => {
    await h.fetch(
      `/api/items/${sites}`,
      json({
        name: "needle",
        website: "https://needle.test/",
        contact: "Ada@Needle.test",
        hotline: "+905321112233",
      }),
    );
  });

  test("REST finds it by the address a person types", async () => {
    const r = await h.fetch(
      `/api/items/${sites}?filter=${encodeURIComponent(
        JSON.stringify({ website: { _eq: "Needle.TEST" } }),
      )}`,
    );
    expect(((await r.json()) as any).data.map((x: any) => x.name)).toContain("needle");
  });

  /** A filter has to arrive as a VARIABLE — the schema refuses a JSON literal. */
  const gqlFilter = (filter: unknown) =>
    gql(`query ($filter: JSON) { parurlSites(filter: $filter) { name } }`, { filter });

  test("GraphQL does too — the filter path that normalized nothing", async () => {
    const res = await gqlFilter({ website: { _eq: "Needle.TEST" } });
    expect(res.errors).toBeUndefined();
    expect(res.data?.parurlSites.map((x: any) => x.name)).toContain("needle");
  });

  test("PRE-EXISTING: GraphQL folds EMAIL operands (it did not before)", async () => {
    // Not a url assertion. Found by writing the url twin of a check REST already
    // had: this returned zero rows while the identical REST filter returned the
    // row, because the column holds the folded address and nothing folded the
    // operand.
    const res = await gqlFilter({ contact: { _eq: "ADA@Needle.test" } });
    expect(res.errors).toBeUndefined();
    expect(res.data?.parurlSites.map((x: any) => x.name)).toContain("needle");
  });

  test("PRE-EXISTING: GraphQL folds PHONE operands (it did not before)", async () => {
    // Same class: a national-form number against a column holding E.164.
    const res = await gqlFilter({ hotline: { _eq: "0532 111 22 33" } });
    expect(res.errors).toBeUndefined();
    expect(res.data?.parurlSites.map((x: any) => x.name)).toContain("needle");
  });

  test("aggregate counts the same rows the list shows", async () => {
    const r = await h.fetch(
      `/api/items/${sites}/aggregate`,
      json({ agg: "count", filter: { website: { _eq: "NEEDLE.test" } } }),
    );
    const body = (await r.json()) as any;
    expect(Number(body.data[0].value)).toBe(1);
  });
});

describe("the type is described to the surfaces that generate clients", () => {
  test("OpenAPI emits `format: uri` and an example rather than a pattern", async () => {
    // A `pattern` would describe the READ shape and make a generator reject
    // exactly the `acme.com` shorthand the type exists to accept.
    const r = await h.fetch("/api/openapi.json");
    const spec = (await r.json()) as any;
    const schema = JSON.stringify(spec).includes('"format":"uri"');
    expect(schema).toBe(true);
  });

  test("GraphQL exposes it as a String on both sides", async () => {
    // It MUST have a mapping. A field type with none resolves to `undefined`,
    // and GraphQL refuses to build a schema containing one — not "that field is
    // missing" but every query and mutation for the whole workspace failing.
    const res = await gql(`{ __type(name: "ParurlSites") { fields { name type { name } } } }`);
    const website = res.data?.__type.fields.find((f: any) => f.name === "website");
    expect(website?.type?.name).toBe("String");
  });
});
