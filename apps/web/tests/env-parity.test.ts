/**
 * Env-mapping parity guard. The non-Worker entries (bun/node/vercel/netlify/
 * deno/gcp/lambda/azure) build their `Env` through `envFromSource`, which maps
 * exactly `STRING_ENV_KEYS`. Historically each entry hand-listed ~34 of ~100
 * fields, so SMTP/SES/push/SMS/OWNER_EMAIL/SSRF/AI-gateway/embedding/retention/
 * job/upload knobs were silently dropped off every runtime except Workers.
 *
 * This test fails if a new string field is added to the `Env` interface but not
 * to `STRING_ENV_KEYS` — i.e. it would silently no-op off Workers again. It
 * parses the interface source so it can't drift from the type.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STRING_ENV_KEYS, envFromSource } from "../src/server/env";

// Cloudflare binding object types — fields of these types are injected by the
// Workers runtime, NOT read from an env-var source, so they're excluded.
const BINDING_TYPES = [
  "D1Database",
  "R2Bucket",
  "Fetcher",
  "VectorizeIndex",
  "Hyperdrive",
  "DurableObjectNamespace",
  "Ai",
];

/** Extract `{ name, type }` for every field declared in the `Env` interface. */
const parseEnvInterfaceFields = (): Array<{ name: string; type: string }> => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/server/env.ts", import.meta.url)),
    "utf8",
  );
  const start = src.indexOf("export interface Env {");
  expect(start).toBeGreaterThan(-1);
  // The interface closes at the first line that is exactly `}` after `start`.
  const body = src.slice(start);
  const end = body.indexOf("\n}");
  const interfaceBody = body.slice(0, end);

  const fields: Array<{ name: string; type: string }> = [];
  for (const line of interfaceBody.split("\n")) {
    // Skip comment / decorator lines; match `NAME?: type;` or `NAME: type;`.
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:\s*([^;]+);/.exec(line);
    if (m?.[1] && m[2]) fields.push({ name: m[1], type: m[2].trim() });
  }
  return fields;
};

describe("env-mapping parity", () => {
  const fields = parseEnvInterfaceFields();

  test("the interface parser actually found the fields", () => {
    // Sanity: a representative spread of fields must be present, or the parser
    // regressed and every assertion below is vacuously true.
    const names = fields.map((f) => f.name);
    expect(names).toContain("APP_URL");
    expect(names).toContain("SMTP_HOST");
    expect(names).toContain("D1");
    expect(fields.length).toBeGreaterThan(80);
  });

  test("every string Env field is in STRING_ENV_KEYS", () => {
    const isBinding = (type: string) =>
      BINDING_TYPES.some((b) => new RegExp(`\\b${b}\\b`).test(type));
    const stringFields = fields.filter((f) => !isBinding(f.type)).map((f) => f.name);
    const mapped = new Set<string>(STRING_ENV_KEYS);
    const missing = stringFields.filter((n) => !mapped.has(n));
    expect(missing).toEqual([]);
  });

  test("STRING_ENV_KEYS has no stale entries (all are real Env fields)", () => {
    const fieldNames = new Set(fields.map((f) => f.name));
    const stale = STRING_ENV_KEYS.filter((k) => !fieldNames.has(k));
    expect(stale).toEqual([]);
  });

  test("the binding fields are correctly excluded from STRING_ENV_KEYS", () => {
    const mapped = new Set<string>(STRING_ENV_KEYS);
    for (const b of ["D1", "R2", "AI", "REALTIME", "VECTORIZE_OPENAI", "ASSETS"]) {
      expect(mapped.has(b)).toBe(false);
    }
  });

  test("envFromSource maps the fields the old hand-lists dropped", () => {
    const src: Record<string, string> = {
      OWNER_EMAIL: "owner@example.com",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      FCM_PROJECT_ID: "fcm-proj",
      APNS_KEY_ID: "apns-key",
      TWILIO_ACCOUNT_SID: "ACxxxx",
      SMS_AWS_REGION: "us-east-1",
      BLOCK_PRIVATE_FETCH_HOSTS: "1",
      AI_GATEWAY_API_KEY: "gw-key",
      ANTHROPIC_API_KEY: "ant-key",
      EMBEDDING_HTTP_URL: "http://embed.local",
      DATABASE_REPLICA_URL: "postgres://replica",
      EXTRA_TRUSTED_ORIGINS: "https://app.example.com",
    };
    const env = envFromSource(src);
    for (const [k, v] of Object.entries(src)) {
      expect((env as Record<string, unknown>)[k]).toBe(v);
    }
  });

  test("envFromSource leaves unset keys undefined (no empty pollution)", () => {
    const env = envFromSource({ APP_URL: "http://x" });
    expect(env.APP_URL).toBe("http://x");
    expect(env.SMTP_HOST).toBeUndefined();
    expect((env as Record<string, unknown>).D1).toBeUndefined();
  });
});
