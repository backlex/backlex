/**
 * A site setting that cannot match is refused where it is typed.
 *
 * All three of these fields used to be checked for length and nothing else, and
 * all three fail SILENTLY when they hold something unusable — which is the
 * reason they need a check at all:
 *
 *   - `domain` is compared against the request's real origin host whenever
 *     `require_known_origin` is on, and it is on by default. A domain a browser
 *     can never send (`my site`, a pasted sentence) drops every event with a
 *     202 and no error on any surface.
 *   - `excludedPaths` is matched by `pathExcluded`, which compares against
 *     `location.pathname` with the query already stripped and treats an entry
 *     with no `*` as an EXACT comparison. `admin` and `/search?q=x` are not
 *     narrow rules; they are rules that never fire.
 *   - `ignoredIps` is an exact `includes` against the request IP, so a label or
 *     a CIDR range never matches anything.
 *
 * The refusals live in `services/analytics.ts`, which is the single writer
 * behind REST and GraphQL alike, so both surfaces inherit them. The admin form
 * mirrors the same predicates in `client/admin/lib/site-input.ts` to say which
 * entry is wrong before the request — these tests pin the authority, not the
 * mirror.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const create = (body: Record<string, unknown>) =>
  h.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const message = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error?: { message?: string } };
  return body.error?.message ?? "";
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
});

afterAll(() => h.cleanup());

test("the forms a domain legitimately arrives in are all accepted", async () => {
  const cases: [string, string][] = [
    ["example.com", "example.com"],
    // Operators paste all three of these.
    ["https://example.com/pricing", "example.com"],
    ["EXAMPLE.com:8080", "example.com"],
    // A host, even without a dot — this is what a self-hosted admin measures.
    ["localhost", "localhost"],
    ["192.168.1.10", "192.168.1.10"],
    // Punycoded rather than refused: it is stored the way the origin header
    // will arrive.
    ["köşe.com", "xn--ke-fka43b.com"],
  ];
  for (const [input, stored] of cases) {
    const res = await create({ name: `ok ${input}`, domain: input });
    expect(`${input} → ${res.status}`).toBe(`${input} → 201`);
    expect((await res.json()).data.domain).toBe(stored);
  }
});

test("a domain a browser could never send is refused, not stored", async () => {
  for (const bad of ["my site.com", "not a domain", "<script>alert(1)</script>"]) {
    const res = await create({ name: "bad", domain: bad });
    expect(`${bad} → ${res.status}`).toBe(`${bad} → 422`);
    // The refusal names the value, so the operator can see which field it is.
    expect(await message(res)).toContain("is not a domain");
  }
});

test("an exclusion pattern that can never fire is refused", async () => {
  // No leading slash: `pathExcluded` compares against a pathname, which always
  // has one.
  const noSlash = await create({
    name: "p1",
    domain: "p1.example",
    excludedPaths: ["admin"],
  });
  expect(noSlash.status).toBe(422);
  expect(await message(noSlash)).toContain("a path starts with /");

  // A query string: it is stripped before the comparison.
  const query = await create({
    name: "p2",
    domain: "p2.example",
    excludedPaths: ["/search?q=x"],
  });
  expect(query.status).toBe(422);
  expect(await message(query)).toContain("without the query string");

  // A bare `*` is `p.includes("")` — every page, i.e. measurement off.
  const everything = await create({
    name: "p3",
    domain: "p3.example",
    excludedPaths: ["*"],
  });
  expect(everything.status).toBe(422);
  expect(await message(everything)).toContain("would exclude every page");
});

test("the wildcard forms the matcher actually supports are accepted", async () => {
  const res = await create({
    name: "wild",
    domain: "wild.example",
    excludedPaths: ["/admin/*", "*.json", "*preview*", "/health"],
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.excludedPaths).toEqual([
    "/admin/*",
    "*.json",
    "*preview*",
    "/health",
  ]);
});

test("an ignored address that is not an address is refused", async () => {
  const label = await create({
    name: "i1",
    domain: "i1.example",
    ignoredIps: ["office"],
  });
  expect(label.status).toBe(422);
  expect(await message(label)).toContain("is not an IP address");

  // The plausible mistake: the matcher has no CIDR support, so a range is a
  // filter that never fires.
  const range = await create({
    name: "i2",
    domain: "i2.example",
    ignoredIps: ["203.0.113.0/24"],
  });
  expect(range.status).toBe(422);
  expect(await message(range)).toContain("looks like a range");

  // …and an octet that cannot exist.
  const octet = await create({
    name: "i3",
    domain: "i3.example",
    ignoredIps: ["256.1.1.1"],
  });
  expect(octet.status).toBe(422);
});

test("both address families are accepted", async () => {
  const res = await create({
    name: "ips",
    domain: "ips.example",
    ignoredIps: ["203.0.113.4", "2001:db8::1", "::1"],
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.ignoredIps).toEqual([
    "203.0.113.4",
    "2001:db8::1",
    "::1",
  ]);
});

test("the admin form's mirror answers the way this route does", async () => {
  // The mirror exists so the dialog can name a bad entry before the request;
  // if the two drift, the form either blocks something the server takes or
  // waves through something it refuses — and the second lands as a 422 over a
  // dialog that has already closed optimistically.
  const { domainProblem, ipProblem, pathProblem } = await import(
    "../src/client/admin/lib/site-input"
  );

  const domains = [
    "example.com",
    "https://example.com/pricing",
    "localhost",
    "192.168.1.10",
    "köşe.com",
    "my site.com",
    "not a domain",
    "..",
    "<script>",
  ];
  for (const [i, domain] of domains.entries()) {
    const res = await create({ name: `parity ${i}`, domain });
    const serverTook = res.status === 201;
    const mirrorTook = domainProblem(domain) === null;
    expect(`${domain}: server=${serverTook} mirror=${mirrorTook}`).toBe(
      `${domain}: server=${serverTook} mirror=${serverTook}`,
    );
  }

  const paths = [["/admin/*"], ["*.json"], ["/health"], ["admin"], ["/s?q=x"], ["*"]];
  for (const [i, excludedPaths] of paths.entries()) {
    const res = await create({
      name: `parity path ${i}`,
      domain: `pp${i}.example`,
      excludedPaths,
    });
    const serverTook = res.status === 201;
    expect(`${excludedPaths[0]}: ${pathProblem(excludedPaths) === null}`).toBe(
      `${excludedPaths[0]}: ${serverTook}`,
    );
  }

  const ips = [["203.0.113.4"], ["::1"], ["office"], ["10.0.0.0/8"], ["256.1.1.1"]];
  for (const [i, ignoredIps] of ips.entries()) {
    const res = await create({
      name: `parity ip ${i}`,
      domain: `pi${i}.example`,
      ignoredIps,
    });
    const serverTook = res.status === 201;
    expect(`${ignoredIps[0]}: ${ipProblem(ignoredIps) === null}`).toBe(
      `${ignoredIps[0]}: ${serverTook}`,
    );
  }
});

test("the same refusals apply on update, not only on create", async () => {
  const created = await create({ name: "patch me", domain: "patch.example" });
  expect(created.status).toBe(201);
  const id = (await created.json()).data.id as string;

  const patch = (body: Record<string, unknown>) =>
    h.fetch(`/api/admin/analytics/sites/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  expect((await patch({ domain: "not a host" })).status).toBe(422);
  expect((await patch({ excludedPaths: ["admin"] })).status).toBe(422);
  expect((await patch({ ignoredIps: ["office"] })).status).toBe(422);

  // …and the row is untouched by any of them.
  const after = await h.fetch(`/api/admin/analytics/sites`);
  const row = ((await after.json()) as any).data.find((s: any) => s.id === id);
  expect(row.domain).toBe("patch.example");
  expect(row.excludedPaths).toEqual([]);
  expect(row.ignoredIps).toEqual([]);

  // A valid patch still goes through.
  const ok = await patch({ domain: "https://moved.example/x", excludedPaths: ["/admin/*"] });
  expect(ok.status).toBe(200);
  expect((await ok.json()).data.domain).toBe("moved.example");
});
