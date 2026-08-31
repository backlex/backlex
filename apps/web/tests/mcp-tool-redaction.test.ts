/**
 * MCP tool results must not carry bearer credentials.
 *
 * An agent's tool result is transcript. It gets summarised, forwarded, pasted
 * into a ticket and stored in a conversation log — so a token in a result is a
 * token in every one of those places. `mcp/tools/booking.ts` knows this and
 * says so at length: `booking.create_resource` mints the public page token,
 * `booking.book` mints a manage link, and both are stripped by `withoutTokens`
 * before the result is built.
 *
 * Nothing tested it. `booking.create_resource` / `booking.book` /
 * `booking.reschedule` were three of the thirty-six registered MCP tools that
 * no spec invoked at all, and a redaction nobody calls is a comment.
 *
 * The assertions here are negative, which means they are worthless unless the
 * credential would otherwise be present — a `not.toContain("token")` over a
 * result whose endpoint returned none passes for the wrong reason. So each test
 * first proves the REST surface really does hand back the field, through the
 * same app instance the tool proxies into, and only then asserts the tool's
 * result is free of it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/booking";

let h: TestHarness;

interface RpcResponse {
  result?: { structuredContent?: unknown; content?: { text?: string }[] };
  error?: { code: number; message: string };
}

const callTool = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await h.fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const rpc = (await res.json()) as RpcResponse;
  if (rpc.error) throw new Error(`${name}: ${rpc.error.message}`);
  return rpc.result!;
};

/** Everything the tool actually hands the model, as one string. */
const transcriptOf = (result: {
  structuredContent?: unknown;
  content?: { text?: string }[];
}): string =>
  JSON.stringify(result.structuredContent ?? null) +
  (result.content ?? []).map((c) => c.text ?? "").join("");

const rest = async (method: string, path: string, body?: unknown) => {
  const res = await h.fetch(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown> } };
};

/** Every weekday, all day, so any slot this file asks for is on the grid. */
const OPEN_ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  kind: "open" as const,
  weekday,
  startMinute: 0,
  endMinute: 1440,
}));

/** The fields `withoutTokens` exists to remove. */
const CREDENTIAL_FIELDS = ["token", "manageToken", "manageUrl", "url"];

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
});
afterAll(() => h.cleanup());

describe("booking.create_resource strips the page token", () => {
  /** Keys the REST create returns — captured so the MCP result can be compared
   *  against the real envelope rather than against a hand-written list. */
  let restKeys: string[] = [];

  test("the REST surface really does mint a credential", async () => {
    const r = await rest("POST", "/resources", {
      key: "rest-canary",
      name: "REST canary",
      timeZone: "UTC",
      slotMinutes: 30,
      rules: OPEN_ALWAYS,
    });
    expect(r.status).toBe(201);
    restKeys = Object.keys(r.json.data ?? {});
    // The liveness half. If creating a resource ever stops returning a token,
    // every redaction assertion below goes vacuous on the same day, and this
    // is the test that says so.
    expect(restKeys.filter((k) => CREDENTIAL_FIELDS.includes(k)).sort()).toEqual(
      ["token", "url"],
    );
  });

  test("the tool returns the same envelope MINUS the credentials", async () => {
    const result = await callTool("booking.create_resource", {
      key: "mcp-canary",
      name: "MCP canary",
      timeZone: "UTC",
      slotMinutes: 30,
      rules: OPEN_ALWAYS,
    });
    const text = transcriptOf(result);
    // It has to have worked — a tool that errored ships no token either.
    expect(text).toContain("mcp-canary");

    // Compared as a SET rather than as four `not.toContain`s: a credential
    // re-issued under a new field name passes every name check and still
    // appears here, as a key the REST envelope has that the strip list does
    // not cover.
    const data = (result.structuredContent as { data?: Record<string, unknown> })?.data ?? {};
    const expected = restKeys.filter((k) => !CREDENTIAL_FIELDS.includes(k)).sort();
    expect(Object.keys(data).sort()).toEqual(expected);
    // The token is stored hashed, so its plaintext exists only in the response
    // that mints it — there is nothing to read back and compare. The key-set
    // check above is what stands in for that.
  });
});

describe("booking.book strips the manage link", () => {
  const START = new Date(Date.now() + 3 * 86_400_000).toISOString();

  test("the REST surface hands back a manage credential", async () => {
    await rest("POST", "/resources", {
      key: "book-canary",
      name: "Book canary",
      timeZone: "UTC",
      slotMinutes: 30,
      rules: OPEN_ALWAYS,
    });
    const r = await rest("POST", "/bookings", {
      resource: "book-canary",
      start: START,
      name: "Rest Caller",
      email: "rest@example.test",
    });
    expect(r.status).toBeLessThan(300);
    const keys = Object.keys(r.json.data ?? {});
    expect(`manage credential present: ${keys.some((k) => CREDENTIAL_FIELDS.includes(k))}`).toBe(
      "manage credential present: true",
    );
  });

  test("the tool's result names the booking but not the link", async () => {
    const start = new Date(Date.now() + 4 * 86_400_000).toISOString();
    const result = await callTool("booking.book", {
      resource: "book-canary",
      start,
      name: "Agent Caller",
      email: "agent@example.test",
    });
    const text = transcriptOf(result);

    expect(text).toContain("Agent Caller");
    for (const field of CREDENTIAL_FIELDS) {
      expect(`${field} in transcript: ${new RegExp(`"${field}"`).test(text)}`).toBe(
        `${field} in transcript: false`,
      );
    }
  });
});

describe("the redaction is keyed on names, so the list has to stay honest", () => {
  test("every field `withoutTokens` drops is one the booking surface can return", async () => {
    // `withoutTokens` destructures a fixed list of field NAMES rather than
    // pattern-matching values — deliberately, so a new credential field has to
    // be added on purpose. The risk in that design is the opposite drift: the
    // list naming fields the API stopped returning, which reads as protection
    // while protecting nothing.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../src/server/mcp/tools/booking.ts", import.meta.url),
      "utf8",
    );
    const listed = /const \{ ([^}]+)\} = value as Record<string, unknown>;/.exec(src)?.[1] ?? "";
    const names = listed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("..."));
    expect(`fields stripped: ${names.length}`).toBe("fields stripped: 4");

    // Collect every key the two CREATE paths return — the reads never carry a
    // credential (the token is stored hashed and the manage link is minted
    // once), so scanning a read-back would report the whole list as dead and
    // this test would fail for the wrong reason.
    const madeResource = await rest("POST", "/resources", {
      key: `census-${Date.now()}`,
      name: "Census",
      timeZone: "UTC",
      slotMinutes: 30,
      rules: OPEN_ALWAYS,
    });
    const madeBooking = await rest("POST", "/bookings", {
      resource: "book-canary",
      start: new Date(Date.now() + 9 * 86_400_000).toISOString(),
      name: "Census Caller",
      email: "census@example.test",
    });
    expect(madeResource.status).toBe(201);
    expect(madeBooking.status).toBeLessThan(300);

    const returned = new Set([
      ...Object.keys(madeResource.json.data ?? {}),
      ...Object.keys(madeBooking.json.data ?? {}),
    ]);
    const dead = names.filter((n) => !returned.has(n));
    expect(dead).toEqual([]);
  });
});
