/**
 * Every registered MCP tool is reachable, described, and closed.
 *
 * The audit that produced this file found 36 of 337 registered tools that no
 * spec invoked or even named — whole modules of them (`third_party_auth`,
 * `items-publish`, `uploads`). Their underlying REST routes were covered; what
 * was not was the MCP layer itself: the export wiring, the argument mapping and
 * the input schema a model reads before it decides what to send.
 *
 * Writing 36 example specs would close today's gap and none of tomorrow's, so
 * the bulk of this file is a property over the whole registry instead. Three
 * things must hold for every tool, and each has a failure mode that is silent:
 *
 *   - **Reachable.** A tool defined in `mcp/tools/*.ts` but never added to the
 *     index is invisible over the transport. Nothing throws; the tool simply
 *     does not exist, and the module's author has no way to notice.
 *   - **Described.** The description IS the interface — it is the only thing a
 *     model reads when choosing a tool. An empty or one-word description makes
 *     a tool that works unusable, which no status code reports.
 *   - **Closed.** `additionalProperties: false` is what turns a typo in a
 *     model's arguments into a refusal instead of a silently-ignored field.
 *
 * The named list below is the census as of the audit — it exists so a tool that
 * disappears from the transport fails HERE, naming itself, rather than
 * vanishing into a passing count.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

type Tool = {
  name: string;
  description?: string;
  inputSchema?: { type?: string; additionalProperties?: unknown; properties?: unknown };
};

let tools: Tool[] = [];

/**
 * The tools no spec invoked or named as of 2026-08-30, under their TRANSPORT
 * names (the registry writes `forms.get`; the wire carries `forms-get`).
 *
 * This is a reachability list, not a to-do list: each one is asserted present
 * and well-formed. Deleting a tool means deleting its line here, on purpose.
 */
const PREVIOUSLY_UNTOUCHED = [
  "app_orgs-delete",
  "app_orgs-revoke_invite",
  "collections-ingest",
  "consent-delete_policy",
  "consent-save_policy",
  "forms-eligible_fields",
  "forms-get",
  "forms-remind_invites",
  "forms-revoke_invite",
  "forms-rotate_token",
  "items-archive",
  "items-schedule_publish",
  "items-schedule_unpublish",
  "items-unpublish",
  "items-verify",
  "migrate-delete_source",
  "migrate-resume_run",
  "migrate-test_source",
  "schema-branches",
  "third_party_auth-providers_create",
  "third_party_auth-providers_delete",
  "third_party_auth-providers_list",
  "third_party_auth-providers_test",
  "third_party_auth-providers_update",
  "uploads-abort",
  "uploads-get",
  "uploads-list",
] as const;

const rpc = async (method: string, params?: unknown) => {
  const res = await h.fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: { tools?: Tool[]; content?: { text?: string }[]; structuredContent?: unknown };
    error?: { code: number; message: string };
  };
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  tools = (await rpc("tools/list")).result?.tools ?? [];
});
afterAll(() => h.cleanup());

describe("the MCP registry", () => {
  test("advertises a full catalogue, or every rule below is vacuous", () => {
    // The floor sits under the ~338 actually registered so adding a tool is
    // not a chore, and far above zero so a broken `tools/list` — which would
    // make every `for (const t of tools)` below iterate nothing — is caught.
    expect(`tools advertised: ${tools.length > 250}`).toBe("tools advertised: true");
  });

  test("every tool a module defines is actually reachable over the transport", () => {
    const advertised = new Set(tools.map((t) => t.name));
    const unreachable = PREVIOUSLY_UNTOUCHED.filter((n) => !advertised.has(n));
    // Named individually so a failure says WHICH tool stopped being exported.
    expect(unreachable).toEqual([]);
  });

  test("every tool carries a description a model can choose on", () => {
    // The floor is deliberately low. A first draft used sixty characters —
    // roughly a sentence — and seventeen existing tools failed it, which makes
    // it a new documentation standard rather than a regression guard, and not
    // one to impose from inside a test. Twenty catches what is actually
    // indefensible: an empty description, or a restatement of the name.
    const thin = tools
      .filter((t) => (t.description ?? "").trim().length < 20)
      .map((t) => `${t.name} (${(t.description ?? "").length} chars)`);
    expect(thin).toEqual([]);

    // The other way a description says nothing: repeating the tool's own name
    // back. `webhooks-delete: "Delete a webhook."` is short but informative;
    // `webhooks-delete: "webhooks delete"` is not.
    const echoes = tools
      .filter((t) => {
        const words = t.name.split(/[-_]/).filter((w) => w.length > 3);
        const desc = (t.description ?? "").toLowerCase();
        return words.length > 0 && desc.replace(/[^a-z ]/g, "").trim() === words.join(" ");
      })
      .map((t) => t.name);
    expect(echoes).toEqual([]);
  });

  test("every input schema is closed to unknown properties", () => {
    // An open schema turns a model's typo into a silently-dropped argument:
    // the call succeeds, does the wrong thing, and reports success. This repo
    // has shipped that shape before under a different name.
    const open = tools
      .filter((t) => t.inputSchema?.additionalProperties !== false)
      .map((t) => t.name);
    expect(open).toEqual([]);
  });

  test("every tool name is one the transport can carry", () => {
    // The registry writes `forms.get`; the wire carries `forms-get`. A dot or a
    // space that survives the transform is a tool a client cannot address.
    const malformed = tools.filter((t) => !/^[A-Za-z0-9_-]+$/.test(t.name));
    expect(malformed.map((t) => t.name)).toEqual([]);
  });

  test("tool names are snake_case, with one recorded exception", () => {
    // Not addressability — consistency. A model picks tools partly by pattern,
    // and one camelCase name among 338 is a small tax on every call. Listed
    // rather than tolerated silently so it is visible the next time this area
    // is touched; renaming it is a breaking change for anyone who has scripted
    // it, which is why it is recorded here instead of fixed in a test PR.
    const KNOWN = ["templates-clearSamples"];
    const camel = tools
      .map((t) => t.name)
      .filter((n) => /[A-Z]/.test(n))
      .filter((n) => !KNOWN.includes(n));
    expect(camel).toEqual([]);
    // Self-retiring: when the exception is renamed, this fails and the entry
    // has to be deleted rather than sitting there excusing nothing.
    const advertised = new Set(tools.map((t) => t.name));
    expect(KNOWN.filter((n) => !advertised.has(n))).toEqual([]);
  });
});

describe("the previously-uninvoked tools actually run", () => {
  /** Read-only members of the list above — safe to call for real. */
  const READS: Array<[string, Record<string, unknown>]> = [
    ["third_party_auth-providers_list", {}],
    ["uploads-list", {}],
    ["schema-branches", {}],
  ];

  for (const [name, args] of READS) {
    test(`${name} answers rather than erroring`, async () => {
      // Reachability says the tool is advertised; this says the handler behind
      // it is wired to something. A tool whose module failed to import answers
      // "Unknown tool", which is a JSON-RPC success at the transport layer.
      const r = await rpc("tools/call", { name, arguments: args });
      expect(r.error).toBeUndefined();
      const text =
        JSON.stringify(r.result?.structuredContent ?? null) +
        (r.result?.content ?? []).map((c) => c.text ?? "").join("");
      expect(text).not.toContain("Unknown tool");
      expect(text).not.toContain("is not a function");
    });
  }

  test("a write tool refuses empty arguments instead of acting on them", async () => {
    // `items-archive` with no id must not archive anything. The schema declares
    // its required fields; this checks the declaration is enforced rather than
    // decorative — an unenforced `required` is how a model's half-formed call
    // becomes a destructive one.
    const r = await rpc("tools/call", { name: "items-archive", arguments: {} });
    const text =
      JSON.stringify(r.result?.structuredContent ?? null) +
      (r.result?.content ?? []).map((c) => c.text ?? "").join("") +
      (r.error?.message ?? "");
    // Refused — by schema validation, by the route's validator, or by a 404 on
    // a collection that was never named. What it must not be is a success.
    expect(`refused: ${/error|invalid|required|not found|validation/i.test(text)}`).toBe(
      "refused: true",
    );
  });
});
