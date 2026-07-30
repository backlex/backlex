import { defineProvider, type FetchLike } from "../provider";

/**
 * BigQuery — mirror a collection into a dataset.
 *
 * Unlike every other provider here, BigQuery has no API key: access is a
 * service-account key file, signed into a JWT and exchanged for an hour-long
 * access token. That exchange is the bulk of this file.
 *
 * Rows go through the streaming `insertAll` endpoint with the row's own primary
 * key as `insertId`. That is what makes a re-sent batch safe — BigQuery
 * de-duplicates on it. The de-duplication is best-effort and time-bounded by
 * Google (minutes, not days), so a retry after a long outage can duplicate; the
 * docs say so rather than implying a guarantee that is not there.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/bigquery.insertdata";

/**
 * Cached access tokens. Re-minting per batch would hit Google's token rate
 * limit on a large first load; the worst case of a cold isolate is one extra
 * exchange.
 *
 * Keyed by the credential PAIR, not by the email. A service-account address is
 * not a secret — it appears in IAM policies and error messages — so keying on
 * it alone would let one workspace that knows another's address collect a token
 * minted from the other's private key. Including the key means the cache can
 * only ever return a token to whoever could have minted it.
 */
const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

const cacheKeyFor = async (clientEmail: string, privateKeyPem: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${clientEmail}\0${privateKeyPem}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** PEM (PKCS#8) → DER. Google ships the key with literal `\n` escapes when it
 *  has been through a JSON field or an env var, so both forms are accepted. */
const pemToDer = (pem: string): Uint8Array => {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Mint (or reuse) an access token for the service account. Exported for the
 *  test that pins the cache key to the credential pair. */
export const accessTokenFor = async (
  clientEmail: string,
  privateKeyPem: string,
  doFetch: FetchLike,
  nowMs: number,
): Promise<string> => {
  const cacheKey = await cacheKeyFor(clientEmail, privateKeyPem);
  const cached = tokenCache.get(cacheKey);
  // A minute of headroom: a token that expires mid-request is an opaque 401.
  if (cached && cached.expiresAtMs - 60_000 > nowMs) return cached.token;

  const iat = Math.floor(nowMs / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(
    new TextEncoder().encode(
      JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
    ),
  );
  const signingInput = `${header}.${claims}`;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(privateKeyPem).slice().buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    // A mangled key is a configuration error, and the underlying WebCrypto
    // message ("invalid key data") tells an operator nothing about which field.
    throw new Error("BigQuery private key could not be read — paste the whole PEM block");
  }
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${b64url(new Uint8Array(sig))}`;

  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) {
    // Google's error body echoes the assertion back; only the status is safe.
    throw new Error(`BigQuery token exchange returned ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("BigQuery token exchange returned no access token");

  tokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAtMs: nowMs + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
};

/** backlex field type → BigQuery column type, for the DDL an operator runs. */
const BQ_TYPES: Record<string, string> = {
  text: "STRING",
  longtext: "STRING",
  uuid: "STRING",
  relation: "STRING",
  integer: "INT64",
  number: "FLOAT64",
  boolean: "BOOL",
  timestamp: "TIMESTAMP",
  json: "JSON",
  relation_many: "JSON",
};

/** The DDL to run once. Not executed here — see the note in the ClickHouse
 *  provider; creating tables needs privileges an insert-only key should not
 *  have, and partitioning is the cluster owner's decision. */
export const bigqueryEnsureSql = (
  dataset: string,
  table: string,
  columns: Record<string, string>,
): string => {
  const cols = Object.entries(columns)
    .map(([name, type]) => `  \`${name}\` ${BQ_TYPES[type] ?? "STRING"}`)
    .join(",\n");
  return `CREATE TABLE IF NOT EXISTS \`${dataset}.${table}\` (\n${cols}\n);`;
};

export const bigquery = defineProvider({
  id: "bigquery",
  label: "Google BigQuery",
  category: "warehouse",
  capabilities: ["destination"],
  configFields: [
    { key: "projectId", label: "Project ID", placeholder: "my-project-123456" },
    {
      key: "clientEmail",
      label: "Service account email",
      placeholder: "backlex@my-project.iam.gserviceaccount.com",
    },
    {
      key: "privateKey",
      label: "Service account private key",
      placeholder: "-----BEGIN PRIVATE KEY-----…",
      secret: true,
    },
  ],
  destination: {
    settingFields: [
      { key: "dataset", label: "Dataset", placeholder: "analytics" },
      { key: "table", label: "Target table", placeholder: "leads" },
    ],
    async push(ctx) {
      const projectId = ctx.str("projectId");
      const clientEmail = ctx.str("clientEmail");
      const privateKey = ctx.str("privateKey");
      const dataset = ctx.setting("dataset");
      const table = ctx.setting("table");
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error("BigQuery destination is missing its service-account credentials");
      }
      if (!dataset || !table) throw new Error("BigQuery destination is missing its dataset or table");

      const token = await accessTokenFor(clientEmail, privateKey, ctx.fetch, Date.now());
      const url =
        `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}` +
        `/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}/insertAll`;

      const res = await ctx.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: ctx.rows.map((row) => ({
            // The row's own key. This is what makes a re-sent batch safe.
            insertId: String(row.id ?? ""),
            json: row,
          })),
        }),
      });
      if (!res.ok) throw new Error(`BigQuery responded ${res.status}`);

      // insertAll answers 200 even when individual rows were rejected, so the
      // body has to be read. Treating a 200 as success is how a mirror silently
      // loses every row with a type mismatch.
      const body = (await res.json()) as {
        insertErrors?: { index?: number; errors?: { message?: string }[] }[];
      };
      const failures = body.insertErrors ?? [];
      if (failures.length > 0) {
        const first = failures[0]?.errors?.[0]?.message ?? "unknown";
        throw new Error(`BigQuery rejected ${failures.length} row(s): ${first}`);
      }
    },
  },
});
