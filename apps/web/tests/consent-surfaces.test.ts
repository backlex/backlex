/**
 * Cookie consent — the cross-surface gate.
 *
 * REST, SDK, GraphQL, MCP and CLI all reach the same `services/consent`, and
 * the thing that must hold on every one of them is the refusal: a first save
 * that does not name a compliance posture is rejected, in the same terms,
 * wherever it comes from.
 *
 * That is the whole reason this file exists rather than trusting the REST spec.
 * A surface that quietly supplied its own default — a GraphQL non-null with a
 * schema default, an SDK convenience, a CLI flag falling back to `block` —
 * would look correct in isolation and would have routed around the one rule the
 * feature is built on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { createClient } from "../../../packages/client/src/index";
import {
  OPTIONAL_CATEGORIES,
  TRACKER_CATEGORIES,
  UNDECIDED_BEHAVIOURS,
} from "../src/server/services/consent";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

let h: TestHarness;
let SITE = "";

const makeSite = async (harness: TestHarness, domain: string): Promise<string> => {
  const res = await harness.fetch("/api/admin/analytics/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: domain, domain }),
  });
  if (!res.ok) throw new Error(`site create failed: ${res.status}`);
  return ((await res.json()) as any).data.id;
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  SITE = await makeSite(h, "surfaces.example");
});

afterAll(() => h.cleanup());

describe("REST", () => {
  test("refuses a first save with no posture, and says why", async () => {
    const res = await h.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("not lawful in the EU");
  });

  test("accepts one that names both, and reads back", async () => {
    const put = await h.fetch(`/api/admin/consent/policies/${SITE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "block",
        trackerCategory: "none",
        categoriesOffered: ["analytics"],
        enabled: true,
      }),
    });
    expect(put.status).toBe(200);

    const list = await h.fetch("/api/admin/consent/policies");
    const rows = ((await list.json()) as any).data as any[];
    expect(rows.find((p) => p.siteId === SITE)?.undecidedBehaviour).toBe("block");
  });
});

describe("SDK surface", () => {
  let sdk: TestHarness;
  let client: ReturnType<typeof createClient>;
  let site = "";

  beforeAll(async () => {
    sdk = makeHarness();
    await seedAdmin(sdk);
    client = createClient({ url: "", fetch: sdk.fetch as unknown as typeof fetch });
    site = await makeSite(sdk, "sdk-consent.example");
  });
  afterAll(() => sdk.cleanup());

  test("a policy round-trips through the client", async () => {
    expect((await client.consent.policy(site)).data).toBeNull();

    const saved = await client.consent.savePolicy(site, {
      undecidedBehaviour: "allow",
      trackerCategory: "analytics",
      categoriesOffered: ["marketing", "functional"],
      policyUrl: "https://sdk-consent.example/privacy",
      enabled: true,
    });
    expect(saved.data.undecidedBehaviour).toBe("allow");
    expect(saved.data.categoriesOffered).toEqual(["functional", "marketing"]);

    const listed = await client.consent.policies();
    expect(listed.data.some((p) => p.siteId === site)).toBe(true);
  });

  test("versions reaches the archive, and dedupes a no-op save", async () => {
    const first = await client.consent.versions(site);
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof first.data[0]!.createdAt).toBe("number");

    // Saving identical content adds nothing — the property that makes this an
    // archive of distinct artifacts rather than a log of clicks.
    await client.consent.savePolicy(site, {});
    expect((await client.consent.versions(site)).data.length).toBe(first.data.length);

    // A real content change does add one, which is also what makes the `limit`
    // assertion below non-vacuous: with a single artifact on file, `limit: 1`
    // returns one whether or not the parameter ever reached the server.
    await client.consent.savePolicy(site, { policyUrl: "https://sdk-consent.example/v2" });
    const all = await client.consent.versions(site);
    expect(all.data.length).toBe(first.data.length + 1);
    expect(all.data.length).toBeGreaterThan(1);

    expect((await client.consent.versions(site, { limit: 1 })).data.length).toBe(1);
  });

  test("the SDK adds no default of its own", async () => {
    // The one thing a convenience layer is tempted to do. If this ever starts
    // succeeding, a caller acquired a compliance posture from a TypeScript
    // default rather than from a decision.
    const fresh = await makeSite(sdk, "sdk-fresh.example");
    await expect(client.consent.savePolicy(fresh, { enabled: true })).rejects.toThrow();
  });

  test("an edit carries the stored posture forward", async () => {
    const after = await client.consent.savePolicy(site, { enabled: false });
    expect(after.data.undecidedBehaviour).toBe("allow");
    expect(after.data.trackerCategory).toBe("analytics");
    expect(after.data.enabled).toBe(false);
  });

  test("suggested wording is offered, not applied", async () => {
    const suggested = await client.consent.suggestedWording();
    expect(suggested.data.en?.acceptAll).toBeTruthy();
    // The site above was saved without wording and must still have none.
    expect((await client.consent.policy(site)).data?.wording).toEqual({});
  });

  test("deleting the policy leaves the site alone", async () => {
    expect((await client.consent.deletePolicy(site)).ok).toBe(true);
    expect((await client.consent.policy(site)).data).toBeNull();
    const sites = await client.analytics.sites.list();
    expect(sites.data.some((s) => s.id === site)).toBe(true);
  });
});

describe("GraphQL surface", () => {
  const gql = async (query: string, variables?: Record<string, unknown>) => {
    const res = await h.fetch("/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as any;
  };

  test("reads the same policy REST wrote", async () => {
    const out = await gql(
      `query($s: ID!) { consentPolicy(siteId: $s) { siteId undecidedBehaviour trackerCategory enabled } }`,
      { s: SITE },
    );
    expect(out.errors).toBeUndefined();
    expect(out.data.consentPolicy.undecidedBehaviour).toBe("block");
    expect(out.data.consentPolicy.trackerCategory).toBe("none");
  });

  test("the mutation refuses a postureless first save too", async () => {
    const fresh = await makeSite(h, "gql-consent.example");
    const out = await gql(
      `mutation($s: ID!, $i: ConsentPolicyInput!) { consentSavePolicy(siteId: $s, input: $i) { siteId } }`,
      { s: fresh, i: { enabled: true } },
    );
    // The schema deliberately leaves these nullable so the SERVICE answers with
    // its explanation rather than GraphQL answering "expected non-null".
    expect(out.errors?.[0]?.message ?? "").toContain("GDPR");
  });

  test("and accepts one that names both", async () => {
    const fresh = await makeSite(h, "gql-ok.example");
    const out = await gql(
      `mutation($s: ID!, $i: ConsentPolicyInput!) { consentSavePolicy(siteId: $s, input: $i) { siteId undecidedBehaviour } }`,
      { s: fresh, i: { undecidedBehaviour: "block", trackerCategory: "analytics" } },
    );
    expect(out.errors).toBeUndefined();
    expect(out.data.consentSavePolicy.undecidedBehaviour).toBe("block");
  });

  test("timestamps survive serialization at all — epoch ms is not an Int32", async () => {
    // A regression, and it was live: these fields were `GraphQLInt`, so
    // graphql-js threw "Int cannot represent non 32-bit signed integer value"
    // and selecting either one errored the WHOLE query. Every other timestamp
    // in this schema layer already used Float.
    const out = await gql(
      `query($s: ID!) { consentPolicy(siteId: $s) { createdAt updatedAt } }`,
      { s: SITE },
    );
    expect(out.errors).toBeUndefined();
    // Past the Int32 ceiling, which is what makes the assertion meaningful
    // rather than "a number came back".
    expect(out.data.consentPolicy.createdAt).toBeGreaterThan(2_147_483_647);
  });

  test("consentVersions reaches the same archive REST does", async () => {
    const out = await gql(
      `query($s: ID!) { consentVersions(siteId: $s) { id hash createdAt } }`,
      { s: SITE },
    );
    expect(out.errors).toBeUndefined();
    expect(out.data.consentVersions.length).toBeGreaterThan(0);
    expect(out.data.consentVersions[0].hash).toMatch(/^[0-9a-f]{64}$/);

    const rest = await h.fetch(`/api/admin/consent/policies/${SITE}/versions`);
    const restRows = ((await rest.json()) as any).data as any[];
    expect(out.data.consentVersions.map((v: any) => v.hash)).toEqual(
      restRows.map((v) => v.hash),
    );
  });

  test("consentPolicies lists what REST sees", async () => {
    const out = await gql(`{ consentPolicies { siteId enabled } }`);
    expect(out.errors).toBeUndefined();
    expect(out.data.consentPolicies.some((p: any) => p.siteId === SITE)).toBe(true);
  });
});

describe("MCP surface", () => {
  const MCP = read("apps/web/src/server/mcp/tools/consent.ts");

  test("every tool is registered in the exported list", () => {
    // A tool defined and never pushed into `consentTools` is dead code that
    // reads as shipped: it exists, it is exported, and no agent can call it.
    const consts = [...MCP.matchAll(/export const (\w+): McpTool(?!\[)/g)].map(
      (m) => m[1] as string,
    );
    expect(consts.length).toBeGreaterThan(3);
    const open = MCP.indexOf("= [", MCP.indexOf("export const consentTools")) + 2;
    const entries = MCP.slice(open + 1, MCP.indexOf("]", open))
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    expect([...entries].sort()).toEqual([...consts].sort());
  });

  test("and reaches the shared registry", () => {
    const index = read("apps/web/src/server/mcp/tools/index.ts");
    expect(index).toContain("...consentTools");
  });

  test("the write tool's schema explains the postures rather than just naming them", () => {
    // An agent that only sees `enum: ["block","allow"]` will retry a refusal
    // with a guess. Naming the consequence is what makes it ask instead.
    //
    // Asserted on POLICY_PROPS rather than on the tool: that block is what
    // `consentSavePolicy` spreads into its inputSchema, so it is literally the
    // per-field text an agent reads.
    const props = MCP.slice(
      MCP.indexOf("const POLICY_PROPS"),
      MCP.indexOf("export const consentPolicies"),
    );
    expect(props.length).toBeGreaterThan(500);
    expect(props.toLowerCase()).toContain("not lawful in the eu");
    expect(props).toContain("no default");
    expect(props).toContain("ask the operator");
    // …and the tool really does use it, or the assertion above is decoration.
    const save = MCP.slice(MCP.indexOf("consentSavePolicy: McpTool"));
    expect(save.slice(0, save.indexOf("handler"))).toContain("...POLICY_PROPS");
  });

  test("reads are `kind: \"read\"`, so a read-only key is not wrongly blocked", () => {
    for (const name of [
      "consent.policies",
      "consent.policy",
      "consent.suggested_wording",
      "consent.versions",
    ]) {
      const at = MCP.indexOf(`name: "${name}"`);
      expect(at).toBeGreaterThan(-1);
      expect(MCP.slice(at, at + 120)).toContain('kind: "read"');
    }
  });
});

describe("CLI surface", () => {
  const CLI = read("packages/cli/src/consent.ts");

  test("every documented subcommand has a case", () => {
    for (const sub of ["policies", "policy", "versions", "set", "rm", "wording"]) {
      expect(CLI).toContain(`case "${sub}"`);
      // The help text is a second registration point: a subcommand missing
      // from it is invisible to anyone who runs --help instead of reading the
      // source.
      expect(CLI.slice(CLI.indexOf("const HELP"), CLI.indexOf("const BASE"))).toContain(
        sub,
      );
    }
  });

  test("is dispatched from the binary", () => {
    const bin = read("packages/cli/bin/backlex.ts");
    expect(bin).toContain('case "consent":');
    expect(bin).toContain("runConsent");
  });

  test("supplies no default for the two decisions", () => {
    // A `?? "block"` here would be the CLI quietly answering a legal question
    // on the operator's behalf — the exact failure the server-side rule exists
    // to prevent, reintroduced one layer up.
    const set = CLI.slice(CLI.indexOf('case "set"'), CLI.indexOf('case "rm"'));
    expect(set).not.toContain('?? "block"');
    expect(set).not.toContain('?? "allow"');
    expect(set).not.toContain('?? "none"');
    expect(set).not.toContain('?? "analytics"');
    // …and the assertion is not vacuous: the flags really are read here.
    expect(set).toContain('flag(rest, "--undecided")');
    expect(set).toContain('flag(rest, "--tracker")');
  });

  test("the help text states the consequence of each value", () => {
    expect(CLI).toContain("NOT lawful in the EU");
    expect(CLI).toContain("Required under GDPR");
  });
});

describe("the obligation the banner phase inherits", () => {
  // `parseWording` deliberately stores operator text UNESCAPED — a lawyer
  // reviews a cookie notice, not `&amp;`. The entire safety argument therefore
  // rests on the renderer using `textContent`, and right now that is a comment
  // rather than a mechanism. This is the mechanism, armed in advance.
  const BANNER_DIR = resolve(ROOT, "apps/web/src/client/consent-banner");

  test("the wording contract is written down where the next author will read it", () => {
    // Not decoration: if this sentence is deleted, the check below loses the
    // only thing telling someone WHY it exists.
    const svc = read("apps/web/src/server/services/consent.ts");
    expect(svc).toContain("textContent");
    expect(svc).toContain("NOT escaped here");
  });

  test("and no banner source may reach for innerHTML", () => {
    // DORMANT until the banner phase creates that directory — and it says so,
    // rather than passing quietly and reading as coverage it does not have.
    if (!existsSync(BANNER_DIR)) {
      expect(existsSync(BANNER_DIR)).toBe(false);
      return;
    }
    const files = readdirSync(BANNER_DIR, { recursive: true }) as string[];
    const sources = files.filter((f) => /\.(ts|tsx|js)$/.test(f));
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) {
      const src = readFileSync(resolve(BANNER_DIR, f), "utf8");
      expect(`${f} uses innerHTML: ${src.includes("innerHTML")}`).toBe(
        `${f} uses innerHTML: false`,
      );
    }
  });
});

describe("the vocabulary is one list, spelled the same everywhere", () => {
  // Two kinds of surface, and the distinction is real rather than cosmetic.
  //
  // REST lives in the same process as the service, so it IMPORTS the constants
  // and cannot drift at all — that is the ideal and the test asserts it stays
  // that way. The other four restate the values as literals because they
  // cannot import: the SDK and CLI are separate packages that speak HTTP, the
  // MCP schema is JSON Schema, and GraphQL needs its own enum types. For those
  // four a rename that misses one produces a value nothing gates on, which
  // fails OPEN — so they are checked character by character.
  test("REST imports the vocabulary rather than restating it", () => {
    const rest = read("apps/web/src/server/routes/consent.ts");
    const imports = rest.slice(0, rest.indexOf("const TAGS"));
    for (const name of [
      "OPTIONAL_CATEGORIES",
      "UNDECIDED_BEHAVIOURS",
      "TRACKER_CATEGORIES",
      "BANNER_POSITIONS",
    ]) {
      expect(imports).toContain(name);
    }
    // And really uses them, rather than importing and then hardcoding anyway.
    expect(rest).toContain("z.enum(UNDECIDED_BEHAVIOURS)");
    expect(rest).toContain("z.enum(TRACKER_CATEGORIES)");
  });

  test("the four surfaces that must restate it spell it identically", () => {
    const sources: [string, string][] = [
      ["SDK", read("packages/client/src/clients/consent.ts")],
      ["CLI", read("packages/cli/src/consent.ts")],
      ["MCP", read("apps/web/src/server/mcp/tools/consent.ts")],
      ["GraphQL", read("apps/web/src/server/services/graphql/consent.ts")],
    ];
    for (const [name, src] of sources) {
      for (const v of [
        ...UNDECIDED_BEHAVIOURS,
        ...TRACKER_CATEGORIES,
        ...OPTIONAL_CATEGORIES,
      ]) {
        expect(`${name} knows \`${v}\`: ${src.includes(v)}`).toBe(
          `${name} knows \`${v}\`: true`,
        );
      }
    }
  });
});
