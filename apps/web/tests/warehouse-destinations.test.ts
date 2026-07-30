/**
 * Warehouse destination providers.
 *
 * The engine that feeds them is covered in `integration-syncs.test.ts`; this is
 * about what each provider does with a batch once it has one. Two properties
 * matter and neither is visible from the happy path:
 *
 *   - a re-sent batch must not double-count, so the row key has to reach the
 *     provider's own de-duplication mechanism
 *   - a 200 is not success everywhere: BigQuery reports per-row rejections in
 *     the body of an otherwise fine response
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { accessTokenFor, bigqueryEnsureSql } from "../../../packages/integrations/src/providers/bigquery";
import { clickhouseEnsureSql } from "../../../packages/integrations/src/providers/clickhouse";
import { PROVIDERS, pushToDestination } from "../../../packages/integrations/src/index";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spy = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return Object.assign(fn, { calls });
};

const ROWS = [
  { id: "r1", customer_name: "Ada" },
  { id: "r2", customer_name: "Grace" },
];

describe("ClickHouse", () => {
  const CONFIG = { url: "https://ch.test:8443", username: "u", password: "p", database: "analytics" };

  test("rows go as JSONEachRow and credentials stay out of the URL", async () => {
    const f = spy(() => new Response("", { status: 200 }));
    await pushToDestination(
      "clickhouse",
      { config: CONFIG, settings: { table: "leads" }, rows: ROWS, columns: {} },
      f,
    );
    const call = f.calls[0]!;
    const url = new URL(call.url);
    expect(url.searchParams.get("query")).toBe("INSERT INTO `leads` FORMAT JSONEachRow");
    expect(url.searchParams.get("database")).toBe("analytics");
    // ClickHouse accepts credentials as query parameters, and its own query log
    // would then keep them. Headers do not end up there.
    expect(call.url).not.toContain("password");
    expect((call.init!.headers as Record<string, string>)["X-ClickHouse-Key"]).toBe("p");

    const lines = String(call.init!.body).split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ id: "r1", customer_name: "Ada" });
  });

  test("a table or database name that is not a plain identifier is refused", async () => {
    const f = spy(() => new Response("", { status: 200 }));
    for (const settings of [{ table: "leads`; DROP TABLE x --" }, { table: "ok" }]) {
      const config = settings.table === "ok" ? { ...CONFIG, database: "a`b" } : CONFIG;
      await expect(
        pushToDestination("clickhouse", { config, settings, rows: ROWS, columns: {} }, f),
      ).rejects.toThrow(/not a plain identifier/);
    }
    // Nothing may have been sent on either attempt.
    expect(f.calls).toHaveLength(0);
  });

  test("the error body is carried through, because it names the problem", async () => {
    const f = spy(() => new Response("Code: 16. No such column `customer_name`", { status: 400 }));
    await expect(
      pushToDestination(
        "clickhouse",
        { config: CONFIG, settings: { table: "leads" }, rows: ROWS, columns: {} },
        f,
      ),
    ).rejects.toThrow(/No such column/);
  });

  test("the suggested DDL uses a table engine that collapses re-sent rows", () => {
    const sql = clickhouseEnsureSql("leads", { id: "text", amount: "number", at: "timestamp" });
    // ClickHouse has no upsert. Idempotency comes from the engine, so a plain
    // MergeTree here would double-count every retry.
    expect(sql).toContain("ReplacingMergeTree");
    expect(sql).toContain("ORDER BY `id`");
    expect(sql).toContain("`amount` Nullable(Float64)");
  });
});

/** A throwaway PKCS#8 key, generated per run so nothing real is committed. */
const generatePem = async (): Promise<string> => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let raw = "";
  for (const b of pkcs8) raw += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(raw).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
};

describe("BigQuery", () => {
  let PEM = "";
  beforeAll(async () => {
    PEM = await generatePem();
  });

  const CONFIG = () => ({
    projectId: "proj",
    clientEmail: "bl@proj.iam.gserviceaccount.com",
    privateKey: PEM,
  });
  const SETTINGS = { dataset: "analytics", table: "leads" };

  const respond = (insertErrors?: unknown[]) =>
    spy((url) =>
      url.includes("oauth2")
        ? json({ access_token: "ya29.token", expires_in: 3600 })
        : json(insertErrors ? { insertErrors } : {}),
    );

  test("the row key becomes the insertId, which is what makes a retry safe", async () => {
    const f = respond();
    await pushToDestination("bigquery", { config: CONFIG(), settings: SETTINGS, rows: ROWS, columns: {} }, f);
    const insert = f.calls.find((c) => c.url.includes("insertAll"))!;
    const body = JSON.parse(String(insert.init!.body)) as { rows: { insertId: string; json: unknown }[] };
    expect(body.rows.map((r) => r.insertId)).toEqual(["r1", "r2"]);
    expect(body.rows[0]!.json).toEqual({ id: "r1", customer_name: "Ada" });
  });

  test("a 200 carrying per-row rejections is a failure, not a success", async () => {
    // insertAll answers 200 even when rows were rejected. Treating that as
    // success is how a mirror silently loses every row with a type mismatch.
    const f = respond([{ index: 0, errors: [{ message: "no such field: customer_name" }] }]);
    await expect(
      pushToDestination("bigquery", { config: CONFIG(), settings: SETTINGS, rows: ROWS, columns: {} }, f),
    ).rejects.toThrow(/no such field/);
  });

  test("a mangled private key says which field to look at", async () => {
    const f = respond();
    await expect(
      pushToDestination(
        "bigquery",
        { config: { ...CONFIG(), privateKey: "not a pem" }, settings: SETTINGS, rows: ROWS, columns: {} },
        f,
      ),
      // WebCrypto's own "invalid key data" tells an operator nothing.
    ).rejects.toThrow(/private key could not be read/);
  });

  test("the token exchange failure reports only the status", async () => {
    // A distinct address so this misses the cache the earlier tests warmed —
    // otherwise the exchange never runs and the test passes vacuously.
    const config = { ...CONFIG(), clientEmail: `fail-${Math.random()}@proj.iam.gserviceaccount.com` };
    const f = spy((url) =>
      url.includes("oauth2")
        // Google's error body echoes the signed assertion back.
        ? json({ error: "invalid_grant", assertion: "eyJ...SECRET" }, 400)
        : json({}),
    );
    let message = "";
    try {
      await pushToDestination("bigquery", { config, settings: SETTINGS, rows: ROWS, columns: {} }, f);
      throw new Error("should have rejected");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/token exchange returned 400/);
    // Nothing from the body may travel: it is stored as `last_error` and shown
    // in the admin, and the assertion is a bearer credential for an hour.
    expect(message).not.toContain("SECRET");
  });

  test("the token cache is keyed by the credential pair, not by the address", async () => {
    // A service-account address is not a secret — it shows up in IAM policies
    // and error messages. Keying on it alone would hand one workspace a token
    // minted from another's private key.
    const first = spy(() => json({ access_token: "token-A", expires_in: 3600 }));
    const t1 = await accessTokenFor("shared@proj.iam.gserviceaccount.com", PEM, first, Date.now());
    expect(t1).toBe("token-A");

    const OTHER_PEM = await generatePem();

    const second = spy(() => json({ access_token: "token-B", expires_in: 3600 }));
    const t2 = await accessTokenFor("shared@proj.iam.gserviceaccount.com", OTHER_PEM, second, Date.now());
    expect(t2).toBe("token-B");
    // It really minted a new one rather than serving the cached token.
    expect(second.calls).toHaveLength(1);
  });

  test("the same credentials reuse the cached token", async () => {
    const email = `cached-${Math.random()}@proj.iam.gserviceaccount.com`;
    const f = spy(() => json({ access_token: "token-C", expires_in: 3600 }));
    const now = Date.now();
    await accessTokenFor(email, PEM, f, now);
    await accessTokenFor(email, PEM, f, now + 1000);
    // Re-minting per batch would hit Google's token rate limit on a first load.
    expect(f.calls).toHaveLength(1);
  });

  test("the suggested DDL maps field types rather than dumping strings", () => {
    const sql = bigqueryEnsureSql("analytics", "leads", { id: "text", amount: "number", at: "timestamp" });
    expect(sql).toContain("`amount` FLOAT64");
    expect(sql).toContain("`at` TIMESTAMP");
  });
});

describe("registration", () => {
  test("both are destinations and neither claims to be a source", () => {
    for (const kind of ["clickhouse", "bigquery"] as const) {
      expect(PROVIDERS[kind].capabilities).toEqual(["destination"]);
      expect(PROVIDERS[kind].source).toBeUndefined();
      expect(typeof PROVIDERS[kind].destination?.push).toBe("function");
    }
  });

  test("an empty batch never reaches the provider", async () => {
    const f = spy(() => new Response("", { status: 200 }));
    await pushToDestination("clickhouse", { config: {}, settings: {}, rows: [], columns: {} }, f);
    // A zero-row INSERT is a wasted request and, for BigQuery, a rejected one.
    expect(f.calls).toHaveLength(0);
  });
});
