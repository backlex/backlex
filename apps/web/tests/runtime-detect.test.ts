import { describe, expect, test } from "bun:test";
import { isXataPgUrl } from "../src/server/lib/runtime";

describe("isXataPgUrl", () => {
  test("detects Xata workspace URLs", () => {
    expect(
      isXataPgUrl(
        "postgres://ws-id:apikey@ws-id.us-east-1.xata.sh:5432/mydb:main?sslmode=require",
      ),
    ).toBe(true);
    expect(
      isXataPgUrl(
        "postgresql://ws-id:apikey@ws-id.eu-west-1.xata.sh/mydb:main",
      ),
    ).toBe(true);
  });

  test("does not match Supabase / Neon / self-host", () => {
    expect(
      isXataPgUrl(
        "postgres://postgres.ref:pwd@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      ),
    ).toBe(false);
    expect(
      isXataPgUrl(
        "postgres://user:pwd@ep-abc-pooler.us-east-1.aws.neon.tech/db?sslmode=require",
      ),
    ).toBe(false);
    expect(isXataPgUrl("postgres://user:pass@localhost:5432/workeros")).toBe(false);
  });

  test("handles undefined / empty", () => {
    expect(isXataPgUrl(undefined)).toBe(false);
    expect(isXataPgUrl("")).toBe(false);
  });

  test("does not match a database literally named 'xata.sh'", () => {
    expect(isXataPgUrl("postgres://user:pwd@localhost:5432/xata.sh")).toBe(false);
  });
});
