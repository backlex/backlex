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
  THEME_KEYS,
  SIGNAL_HANDLING,
  TRACKER_CATEGORIES,
  UNDECIDED_BEHAVIOURS,
  WORDING_KEYS,
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

  test("records reaches the visitor decisions, and never the IP digest", async () => {
    const { recordConsent } = await import("../src/server/services/consent-records");
    const { buildContext } = await import("../src/server/context");
    const { getSiteById } = await import("../src/server/services/analytics");
    const ctx = await buildContext(sdk.env);
    const db = { db: ctx.db, dialect: ctx.dialect } as never;
    const tenant = (await getSiteById(db, site))!.tenantId;

    await recordConsent(db, {
      siteId: site,
      tenantId: tenant,
      subjectId: "sdk-visitor-aaaaaaaa",
      policyHash: null,
      currentHash: null,
      offered: ["marketing"],
      grants: { marketing: true },
      source: "banner",
      locale: "en",
      country: null,
      // A real digest, so the negative assertion below is not vacuous.
      ipHash: "f".repeat(64),
      userAgent: "probe",
    });

    const rows = await client.consent.records(site);
    expect(rows.data.length).toBeGreaterThan(0);
    expect(rows.data[0]!.decision).toBe("granted");
    expect(rows.data[0]!.subjectId).toBe("sdk-visitor-aaaaaaaa");
    // The digest exists so two records can be correlated in an investigation,
    // not so it travels to a client and into a screenshot.
    expect(JSON.stringify(rows.data)).not.toContain("f".repeat(64));
    expect(Object.keys(rows.data[0]!)).not.toContain("ipHash");

    // The subject filter narrows rather than being ignored.
    expect(
      (await client.consent.records(site, { subjectId: "nobody-aaaaaaaaaaaaa" })).data.length,
    ).toBe(0);
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

  test("consentRecords reaches the same rows REST does", async () => {
    const out = await gql(
      `query($s: ID!) { consentRecords(siteId: $s) { id subjectId decision hashGrade createdAt } }`,
      { s: SITE },
    );
    expect(out.errors).toBeUndefined();
    expect(Array.isArray(out.data.consentRecords)).toBe(true);

    const rest = await h.fetch(`/api/admin/consent/policies/${SITE}/records`);
    const restRows = ((await rest.json()) as any).data as any[];
    expect(out.data.consentRecords.map((r: any) => r.id)).toEqual(restRows.map((r) => r.id));
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
      "consent.records",
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
    for (const sub of ["policies", "policy", "versions", "records", "set", "rm", "wording"]) {
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

  test("…and the newer vocabulary, checked as QUOTED literals", () => {
    // `SIGNAL_HANDLING` cannot use the substring check below and the difference
    // is not pedantic: its values are `tracker`, `all` and `off`, and a file
    // that merely says "the tracker" or "all of them" would satisfy
    // `src.includes("all")` while knowing nothing about the enum. Every one of
    // these four surfaces would pass vacuously. So the literal has to be
    // matched in the form it is actually written in: quoted.
    // Three surfaces write the vocabulary as quoted literals — a TS union, a
    // JSON-Schema enum, a GraphQL enum value.
    const quotedSources: [string, string][] = [
      ["SDK", read("packages/client/src/clients/consent.ts")],
      ["MCP", read("apps/web/src/server/mcp/tools/consent.ts")],
      ["GraphQL", read("apps/web/src/server/services/graphql/consent.ts")],
    ];
    for (const [name, src] of quotedSources) {
      for (const v of SIGNAL_HANDLING) {
        const quoted = src.includes(`"${v}"`) || src.includes(`'${v}'`);
        expect(`${name} spells ${v}: ${quoted}`).toBe(`${name} spells ${v}: true`);
      }
    }

    // The CLI deliberately does not restate the enum in code — it forwards the
    // flag and lets the server's rejection explain the values, which is written
    // down where the flag is parsed. What it DOES own is the usage line, and
    // that is a real spelling that can drift, so it is checked in the form it
    // is actually written: pipe-joined inside angle brackets.
    expect(read("packages/cli/src/consent.ts")).toContain(
      `<${SIGNAL_HANDLING.join("|")}>`,
    );
    // REST imports the constant, so it cannot drift at all.
    expect(read("apps/web/src/server/routes/consent.ts")).toContain(
      "z.enum(SIGNAL_HANDLING)",
    );
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

describe("the admin form can write every key the policy stores", () => {
  test("WORDING_KEYS and the consent tab's fields are the same list", () => {
    // `WORDING_KEYS` is a CLOSED list specifically so the form can be generated
    // from it instead of drifting from it. Both directions matter and they fail
    // differently: a key with no field is a string an operator can never set,
    // and a field writing a key the policy drops is one they type, save, and
    // silently lose.
    const tab = read("apps/web/src/client/admin/pages/observability/consent.tsx");
    // `\s*` on purpose: one entry is wrapped across lines by the formatter,
    // and a regex that assumed one line would silently miss it — reporting a
    // missing field for one that is right there.
    const fields = [...tab.matchAll(/key: "([a-zA-Z]+)",\s*label:/g)].map((m) => m[1]);
    const wordingFields = fields.filter((f) => (WORDING_KEYS as readonly string[]).includes(f!));

    for (const key of WORDING_KEYS) {
      expect(`${key} has a field: ${fields.includes(key)}`).toBe(`${key} has a field: true`);
    }
    expect(wordingFields.length).toBe(WORDING_KEYS.length);
  });

  test("and every theme token has one too", () => {
    const tab = read("apps/web/src/client/admin/pages/observability/consent.tsx");
    for (const key of THEME_KEYS) {
      expect(`${key} has a field: ${tab.includes(`key: "${key}"`)}`).toBe(
        `${key} has a field: true`,
      );
    }
  });
});

/**
 * The banner's own delivery must not write to the device.
 *
 * Prior blocking is this feature's central claim, and it is undermined by
 * anything backlex itself stores on a visitor before they answer. The tenant
 * middleware was pinning a 30-day `backlex-tenant` cookie on every anonymous
 * fetch of the per-site file — the file that CARRIES the banner — because it
 * resolves a default workspace for callers with no session.
 *
 * Found by reading the response headers of a real cross-origin load, not by a
 * test: the in-process harness has no browser to store a cookie in, so nothing
 * would have failed. Pinned here so it cannot come back.
 */
describe("nothing is stored on a visitor before they decide", () => {
  const PUBLIC = [
    "/api/analytics/script.js",
    "/api/analytics/collect",
    "/api/consent/config",
    "/api/consent/record",
  ];

  test("no public subresource sets the workspace cookie", async () => {
    for (const path of PUBLIC) {
      const res = await h.app.fetch(
        new Request(`${h.env.APP_URL}${path}`, {
          headers: { Origin: "https://customer.example" },
        }),
      );
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(`${path} sets backlex-tenant: ${setCookie.includes("backlex-tenant")}`).toBe(
        `${path} sets backlex-tenant: false`,
      );
    }
  });

  test("…including the per-site file, which is the one that carries the banner", async () => {
    const res = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/analytics/tm/${SITE}.js`, {
        headers: { Origin: "https://customer.example" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("backlex-tenant");
    // A Set-Cookie on a `public, max-age=900` response is also what makes a
    // shared cache refuse to store it, so this is a caching assertion too.
    expect(res.headers.get("cache-control") ?? "").toContain("max-age");
  });

  test("an authenticated admin request still gets it, so the fix is scoped", async () => {
    // Negative control. Without this, deleting the cookie everywhere would pass
    // the two tests above and break workspace routing for the whole admin.
    const res = await h.fetch("/api/collections");
    expect(res.headers.get("set-cookie") ?? "").toContain("backlex-tenant");
  });
});

/**
 * A site can run a banner without running a tag manager.
 *
 * The per-site file checked for a published CONTAINER first and answered an
 * empty 200 when there was none — before it ever looked for a consent policy.
 * So an operator who turned the cookie banner on and never opened the tag
 * manager was served nothing, and no banner appeared. Every existing test seeds
 * a container, which is why nothing failed.
 */
describe("the banner reaches a site with no tag container", () => {
  test("the per-site file boots it anyway", async () => {
    const site = await makeSite(h, "banner-only.example");
    // Deliberately no tag container: this is the whole case.
    const off = await h.app.fetch(new Request(`${h.env.APP_URL}/api/analytics/tm/${site}.js`));
    expect(off.status).toBe(200);
    // A registered site is served the tracker even with nothing configured —
    // one script tag, pasted once. What it must NOT yet contain is the banner.
    const before = await off.text();
    expect(before).toContain("__backlexTrackerInit({");
    expect(before).not.toContain("__backlexConsentBanner(");

    const put = await h.fetch(`/api/admin/consent/policies/${site}`, {
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

    const on = await h.app.fetch(new Request(`${h.env.APP_URL}/api/analytics/tm/${site}.js`));
    const body = await on.text();
    expect(on.status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("__backlexConsentBanner(");
    // The tracker comes with it — it owns `backlex.consent()`, which is the
    // seam the banner writes the grant map through.
    expect(body).toContain("__backlexTrackerInit(");
    // …and nothing to interpret, because there is no container.
    expect(body).not.toContain("__backlexTM(");
  });

  test("an unknown site id is still silent", async () => {
    const res = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/analytics/tm/00000000-0000-4000-8000-000000000000.js`),
    );
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(0);
  });
});

/**
 * The GPC / Do Not Track switch.
 *
 * Its load-bearing property is not that it saves — it is that it saves WITHOUT
 * touching the artifact. `getPublishedConsentConfig` recompiles and re-hashes
 * the document on every read rather than serving a stored body, so a field
 * added to `ConsentConfig` changes the hash of every policy the instant it
 * deploys: every recorded decision flips from `hash_grade: "current"` to
 * `"archived"`, and every visitor holding a cookie is asked again, worldwide,
 * about a change none of them was shown. So the switch rides the per-site
 * container, which nothing hashes, and this is what says so.
 */
describe("what GPC and Do Not Track govern", () => {
  test("it defaults to the behaviour already live, and round-trips", async () => {
    const site = await makeSite(h, "signals.example");
    await h.fetch(`/api/admin/consent/policies/${site}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "block",
        trackerCategory: "analytics",
        categoriesOffered: ["analytics", "marketing"],
        enabled: true,
      }),
    });
    const first = await h.fetch(`/api/admin/consent/policies/${site}`);
    expect(((await first.json()) as any).data.signalHandling).toBe("tracker");

    const put = await h.fetch(`/api/admin/consent/policies/${site}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signalHandling: "all" }),
    });
    expect(((await put.json()) as any).data.signalHandling).toBe("all");
    // …and carried forward when a later save omits it, like the two postures.
    const later = await h.fetch(`/api/admin/consent/policies/${site}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: "top" }),
    });
    expect(((await later.json()) as any).data.signalHandling).toBe("all");
  });

  test("changing it mints NO new artifact, because it is not in the artifact", async () => {
    const { listConsentVersions } = await import("../src/server/services/consent");
    const { buildContext } = await import("../src/server/context");
    const { getSiteById } = await import("../src/server/services/analytics");
    const ctx = await buildContext(h.env);
    const db = { db: ctx.db, dialect: ctx.dialect } as never;

    const site = await makeSite(h, "hash-stability.example");
    const save = (body: unknown) =>
      h.fetch(`/api/admin/consent/policies/${site}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await save({
      undecidedBehaviour: "block",
      trackerCategory: "analytics",
      categoriesOffered: ["analytics"],
      enabled: true,
    });
    const tenant = (await getSiteById(db, site))!.tenantId;
    const before = await listConsentVersions(db, tenant, site);
    expect(before.length).toBe(1);

    await save({ signalHandling: "all" });
    const after = await listConsentVersions(db, tenant, site);
    expect(after.length).toBe(1);
    expect(after[0]!.hash).toBe(before[0]!.hash);

    // Non-vacuous: a field that IS in the artifact still mints one, so the
    // assertion above is about this field and not about a dead code path.
    await save({ position: "top" });
    const moved = await listConsentVersions(db, tenant, site);
    expect(moved.length).toBe(2);
  });

  test("the per-site file carries it, and the tracker's own category, to the browser", async () => {
    const site = await makeSite(h, "delivery.example");
    await h.fetch(`/api/admin/consent/policies/${site}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "block",
        trackerCategory: "none",
        signalHandling: "all",
        categoriesOffered: ["marketing"],
        enabled: true,
      }),
    });
    const res = await h.app.fetch(new Request(`${h.env.APP_URL}/api/analytics/tm/${site}.js`));
    const body = await res.text();
    const init = body.match(/__backlexTrackerInit\((\{.*?\})\);/);
    expect(init).toBeTruthy();
    const cfg = JSON.parse(init![1]!);
    expect(cfg.t).toBe("none");
    expect(cfg.g).toBe("all");

    // And NOT in the artifact the banner is handed — that is the whole point.
    const banner = body.match(/__backlexConsentBanner\((\{.*\})\);/);
    expect(banner).toBeTruthy();
    expect(JSON.stringify(JSON.parse(banner![1]!).cfg)).not.toContain("signalHandling");
  });

  test("a site with no consent policy sends neither, so the tag keeps its defaults", async () => {
    // The tracker falls back to `analytics` + `tracker` when these are absent,
    // which is what every install without a policy has always done. Omitting
    // them is the same thing; sending a WRONG value would not be.
    const site = await makeSite(h, "no-policy.example");
    const res = await h.app.fetch(new Request(`${h.env.APP_URL}/api/analytics/tm/${site}.js`));
    const body = await res.text();
    const init = body.match(/__backlexTrackerInit\((\{.*?\})\);/);
    expect(init).toBeTruthy();
    const cfg = JSON.parse(init![1]!);
    expect(cfg.t).toBeUndefined();
    expect(cfg.g).toBeUndefined();
    expect(cfg.s).toBe(site);
  });
});

/**
 * The two tag-side settings do not depend on the banner being shown.
 *
 * `getPublishedConsentConfig` answers null for a disabled policy — correctly,
 * because `enabled` decides whether a banner appears. Deriving `trackerCategory`
 * and `signalHandling` from that read would make both silently inert on a site
 * that runs tags and no banner, which is the shape a compliance bug takes here:
 * a setting that saves, reads back correctly, and does nothing.
 */
describe("tag settings reach the browser without a banner", () => {
  test("a disabled policy still files the tracker and still governs the signals", async () => {
    const site = await makeSite(h, "no-banner.example");
    await h.fetch(`/api/admin/consent/policies/${site}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "block",
        trackerCategory: "none",
        signalHandling: "all",
        categoriesOffered: ["marketing"],
        enabled: false,
      }),
    });

    const body = await (
      await h.app.fetch(new Request(`${h.env.APP_URL}/api/analytics/tm/${site}.js`))
    ).text();
    const init = body.match(/__backlexTrackerInit\((\{.*?\})\);/);
    expect(init).toBeTruthy();
    const cfg = JSON.parse(init![1]!);
    expect(cfg.t).toBe("none");
    expect(cfg.g).toBe("all");

    // …and no banner, which is what `enabled: false` is actually for. This is
    // the assertion that makes the two above about the SETTINGS rather than
    // about the policy being served wholesale.
    expect(body).not.toContain("__backlexConsentBanner(");
  });
});

/**
 * Changing the switch has to REACH a browser — eventually, and at all.
 *
 * The switch is invisible to the artifact hash by construction: it is not in
 * the artifact, so `consent.hash` cannot move when it changes. Without the ETag
 * carrying it, a browser holding the old file revalidates, is told 304, and
 * that 304 refreshes its freshness — so it keeps the old behaviour for as long
 * as it keeps asking. That is unbounded staleness, and it is the failure where
 * an operator turns GPC enforcement on and it silently never arrives.
 *
 * **What this does NOT claim**, because a real browser was used to check and it
 * does not hold: that the change lands immediately. `Cache-Control: public,
 * max-age=900` with no `must-revalidate` — deliberate, see the route — means a
 * warm browser cache does not ask at all for fifteen minutes. Measured: after
 * flipping the switch, a page reloaded with the cache warm still ran the old
 * one. So the bound is the container's own TTL, the same as any tag change, and
 * what the ETag buys is that the bound EXISTS.
 */
describe("a change to the switch invalidates what a browser holds", () => {
  test("the ETag moves, so a revalidating browser is given the new file", async () => {
    const site = await makeSite(h, "etag-signals.example");
    const save = (body: unknown) =>
      h.fetch(`/api/admin/consent/policies/${site}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await save({
      undecidedBehaviour: "block",
      trackerCategory: "analytics",
      categoriesOffered: ["marketing"],
      enabled: true,
    });

    const url = `${h.env.APP_URL}/api/analytics/tm/${site}.js`;
    const first = await h.app.fetch(new Request(url));
    const etag1 = first.headers.get("etag");
    expect(etag1).toBeTruthy();
    expect(await first.text()).toContain('"g":"tracker"');

    // The same request twice is the same ETag — otherwise the assertion below
    // would pass for any two requests at all.
    const again = await h.app.fetch(new Request(url));
    expect(again.headers.get("etag")).toBe(etag1);

    await save({ signalHandling: "all" });
    const after = await h.app.fetch(new Request(url));
    expect(after.headers.get("etag")).not.toBe(etag1);
    expect(await after.text()).toContain('"g":"all"');

    // The exchange a browser makes once `max-age` HAS expired: it offers the
    // ETag it holds and must be given the new file rather than a 304. This is
    // the assertion that bounds the staleness; it does not remove it.
    const conditional = await h.app.fetch(
      new Request(url, { headers: { "If-None-Match": etag1! } }),
    );
    expect(conditional.status).toBe(200);
  });
});

/**
 * Posture presets are OFFERED, never applied.
 *
 * The whole feature rests on `savePolicy` refusing a first save that does not
 * name a posture — "neither answer is safe to choose for an operator". A preset
 * that wrote to the row would be that same acquisition-by-omission wearing a
 * friendlier name, so there is deliberately no endpoint that applies one and
 * these specs are what stop somebody adding it.
 */
describe("posture presets", () => {
  test("every preset is a valid `savePolicy` input, field for field", async () => {
    const { suggestedPostures, POSTURE_PRESETS } = await import(
      "../src/server/services/consent"
    );
    const presets = suggestedPostures();
    expect(presets.map((p) => p.id).sort()).toEqual([...POSTURE_PRESETS].sort());

    for (const p of presets) {
      // Every value passes the SAME allow-lists the writer uses. A preset that
      // named a value `savePolicy` silently drops would look applied and be
      // ignored — the worst of both.
      expect(`${p.id} undecided: ${UNDECIDED_BEHAVIOURS.includes(p.policy.undecidedBehaviour)}`)
        .toBe(`${p.id} undecided: true`);
      expect(`${p.id} tracker: ${TRACKER_CATEGORIES.includes(p.policy.trackerCategory)}`)
        .toBe(`${p.id} tracker: true`);
      expect(`${p.id} signals: ${SIGNAL_HANDLING.includes(p.policy.signalHandling)}`)
        .toBe(`${p.id} signals: true`);
      for (const c of p.policy.categoriesOffered) {
        expect(`${p.id} category ${c}: ${OPTIONAL_CATEGORIES.includes(c)}`).toBe(
          `${p.id} category ${c}: true`,
        );
      }
      // Prose an operator reads. The caveat is not optional decoration: a
      // preset shown without its cost is an advertisement.
      expect(p.appliesTo.length).toBeGreaterThan(20);
      expect(p.caveat.length).toBeGreaterThan(20);
    }

    // The CCPA preset must say the thing that gets an operator sued if it is
    // missing, and must not pretend to know a US state.
    const ccpa = presets.find((p) => p.id === "ccpa")!;
    expect(ccpa.policy.undecidedBehaviour).toBe("allow");
    expect(ccpa.policy.signalHandling).toBe("all");
    // Case-insensitive: the sentence emphasises NOT, and pinning the casing
    // would make this a test of a typography choice rather than of the warning.
    expect(ccpa.caveat.toLowerCase()).toContain("not lawful in the eu");
    expect(ccpa.caveat.toLowerCase()).toContain("never their state");
  });

  test("no preset carries a field the writer does not accept", async () => {
    const { suggestedPostures } = await import("../src/server/services/consent");
    // The input type is structural, so a stray key would typecheck as a subset
    // of nothing and fail only at runtime, silently.
    const ACCEPTED = [
      "undecidedBehaviour",
      "trackerCategory",
      "signalHandling",
      "defaultLocale",
      "categoriesOffered",
    ];
    for (const p of suggestedPostures()) {
      for (const k of Object.keys(p.policy)) {
        expect(`${p.id} names ${k}: ${ACCEPTED.includes(k)}`).toBe(`${p.id} names ${k}: true`);
      }
    }
  });

  test("the route has no write path at all", () => {
    // Break-verified and found VACUOUS first time round: the behavioural test
    // below cannot see an apply endpoint that writes a DIFFERENT site, and a
    // route that merely returned altered presets left it green. So the check
    // is structural as well — the preset handler must not so much as mention
    // the only writer.
    const src = read("apps/web/src/server/routes/consent.ts");
    const at = src.indexOf('path: "/postures/suggested"');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at);
    expect(handler).toContain("suggestedPostures()");
    expect(`the preset handler calls savePolicy: ${handler.includes("savePolicy")}`).toBe(
      "the preset handler calls savePolicy: false",
    );
    // Nor may any other surface offer one. `apply` is the word this feature
    // must not acquire.
    for (const f of [
      "packages/client/src/clients/consent.ts",
      "apps/web/src/server/mcp/tools/consent.ts",
      "apps/web/src/server/services/graphql/consent.ts",
    ]) {
      const s2 = read(f);
      expect(`${f} offers applyPosture: ${/applyPosture|apply_posture|consentApplyPosture/.test(s2)}`)
        .toBe(`${f} offers applyPosture: false`);
    }
  });

  test("reading a preset does not touch a stored policy", async () => {
    // The load-bearing one. Save a posture the presets DISAGREE with, read the
    // presets, and prove the row did not move.
    const site = await makeSite(h, "presets-readonly.example");
    await h.fetch(`/api/admin/consent/policies/${site}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "allow",
        trackerCategory: "analytics",
        signalHandling: "off",
        enabled: true,
      }),
    });

    const res = await h.fetch("/api/admin/consent/postures/suggested");
    expect(res.status).toBe(200);
    const presets = ((await res.json()) as any).data as any[];
    // The premise: the gdpr preset really does disagree with what is stored, so
    // "unchanged" below is not unchanged-by-coincidence.
    expect(presets.find((p) => p.id === "gdpr").policy.undecidedBehaviour).toBe("block");

    const after = await h.fetch(`/api/admin/consent/policies/${site}`);
    const policy = ((await after.json()) as any).data;
    expect(policy.undecidedBehaviour).toBe("allow");
    expect(policy.signalHandling).toBe("off");
  });

  test("…and mints no artifact version either", async () => {
    const { listConsentVersions } = await import("../src/server/services/consent");
    const { buildContext } = await import("../src/server/context");
    const { getSiteById } = await import("../src/server/services/analytics");
    const ctx = await buildContext(h.env);
    const db = { db: ctx.db, dialect: ctx.dialect } as never;

    const site = await makeSite(h, "presets-no-version.example");
    await h.fetch(`/api/admin/consent/policies/${site}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        undecidedBehaviour: "block",
        trackerCategory: "analytics",
        enabled: true,
      }),
    });
    const tenant = (await getSiteById(db, site))!.tenantId;
    const before = await listConsentVersions(db, tenant, site);
    await h.fetch("/api/admin/consent/postures/suggested");
    expect((await listConsentVersions(db, tenant, site)).length).toBe(before.length);
  });

  test("the presets reach all six surfaces", () => {
    // `suggestedWording`'s footprint is the template; a preset endpoint the SDK
    // or the CLI cannot reach is one an operator cannot use from where they work.
    //
    // SIX, and the count is not pedantry. The house phrase is "all five
    // surfaces" (REST + SDK + GraphQL + MCP + CLI) and this title said so while
    // the list below already carried the admin — the surface a preset exists
    // FOR, since nothing else fills a form. A title that undercounts its own
    // array is how the admin gets dropped from the next feature's parity list
    // by someone reading the title and copying the phrase.
    const pairs: [string, string, string][] = [
      ["REST", "apps/web/src/server/routes/consent.ts", "/postures/suggested"],
      ["SDK", "packages/client/src/clients/consent.ts", "suggestedPostures"],
      ["GraphQL", "apps/web/src/server/services/graphql/consent.ts", "consentSuggestedPostures"],
      ["MCP", "apps/web/src/server/mcp/tools/consent.ts", "consent.suggested_postures"],
      ["CLI", "packages/cli/src/consent.ts", "postures/suggested"],
      ["admin", "apps/web/src/client/admin/api/observability.ts", "postures/suggested"],
    ];
    for (const [name, file, needle] of pairs) {
      expect(`${name} reaches presets: ${read(file).includes(needle)}`).toBe(
        `${name} reaches presets: true`,
      );
    }
    // And the MCP tool must be REGISTERED, not merely defined — an exported
    // const nothing lists is a tool no agent can call.
    expect(read("apps/web/src/server/mcp/tools/consent.ts")).toContain(
      "consentSuggestedPostures,\n  consentVersions",
    );
  });
});
