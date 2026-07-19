import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for the extension system (#13). REST is covered in
 * extensions.test.ts; this pins GraphQL (`extensions`/`installExtension`/…),
 * the SDK (`client.extensions.*`) and MCP (`extensions.*` tools) to the same
 * `/api/extensions` semantics via the ONE shared service.
 */

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const filesFor = (name: string): Record<string, string> => ({
  "backlex-extension.json": JSON.stringify({
    name,
    version: "2.0.0",
    title: "Fixture",
    contributes: {
      hooks: [{ id: "echo", trigger: "manual", entry: "echo.js" }],
    },
  }),
  "echo.js": "return { echo: ctx.data.msg };",
});

describe("extensions — GraphQL surface", () => {
  let h: TestHarness;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("uploadExtension → extensions → setEnabled → invoke → uninstall round-trips", async () => {
    const up = await gql(
      `mutation($f:JSON!){ uploadExtension(files:$f){ id name version source enabled manifest } }`,
      { f: filesFor("gql-ext") },
    );
    expect(up.errors).toBeUndefined();
    expect(up.data?.uploadExtension.name).toBe("gql-ext");
    expect(up.data?.uploadExtension.enabled).toBe(true);

    const one = await gql(`query($n:String!){ extension(name:$n){ name version } }`, {
      n: "gql-ext",
    });
    expect(one.data?.extension.version).toBe("2.0.0");

    const list = await gql(`{ extensions { name enabled } }`);
    expect(list.data?.extensions.some((e: any) => e.name === "gql-ext")).toBe(true);

    const run = await gql(
      `mutation($n:String!,$h:String!,$i:JSON){ invokeExtensionHook(name:$n, hookId:$h, input:$i){ ok value durationMs } }`,
      { n: "gql-ext", h: "echo", i: { msg: "hi" } },
    );
    expect(run.errors).toBeUndefined();
    expect(run.data?.invokeExtensionHook.ok).toBe(true);
    expect(run.data?.invokeExtensionHook.value).toEqual({ echo: "hi" });

    const off = await gql(
      `mutation($n:String!){ setExtensionEnabled(name:$n, enabled:false){ enabled } }`,
      { n: "gql-ext" },
    );
    expect(off.data?.setExtensionEnabled.enabled).toBe(false);

    // Disabled extensions refuse hook invocation — same gate as REST.
    const blocked = await gql(
      `mutation($n:String!,$h:String!){ invokeExtensionHook(name:$n, hookId:$h){ ok } }`,
      { n: "gql-ext", h: "echo" },
    );
    expect(blocked.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

    const del = await gql(`mutation($n:String!){ uninstallExtension(name:$n) }`, {
      n: "gql-ext",
    });
    expect(del.data?.uninstallExtension).toBe(true);

    const gone = await gql(`query($n:String!){ extension(name:$n){ id } }`, {
      n: "gql-ext",
    });
    expect(gone.data?.extension).toBeNull();
  });

  test("installExtension rejects an invalid npm package name with VALIDATION", async () => {
    const res = await gql(
      `mutation{ installExtension(package:"Not A Package!!"){ id } }`,
    );
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("uploadExtension rejects a non-map files payload with VALIDATION", async () => {
    const res = await gql(
      `mutation($f:JSON!){ uploadExtension(files:$f){ id } }`,
      { f: ["not", "a", "map"] },
    );
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("extensions — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("upload → list → enabled → invokeHook → setEnabled → uninstall round-trips", async () => {
    const created = await client.extensions.upload(filesFor("sdk-ext"));
    expect(created.data.name).toBe("sdk-ext");
    expect(created.data.enabled).toBe(true);

    const list = await client.extensions.list();
    expect(list.data.some((e) => e.name === "sdk-ext")).toBe(true);

    const enabled = await client.extensions.enabled();
    expect(enabled.data.some((e) => e.name === "sdk-ext")).toBe(true);

    const run = await client.extensions.invokeHook("sdk-ext", "echo", {
      msg: "yo",
    });
    expect(run.ok).toBe(true);
    expect(run.value).toEqual({ echo: "yo" });

    const off = await client.extensions.setEnabled("sdk-ext", false);
    expect(off.data.enabled).toBe(false);
    expect(
      (await client.extensions.enabled()).data.some((e) => e.name === "sdk-ext"),
    ).toBe(false);

    const del = await client.extensions.uninstall("sdk-ext");
    expect(del.ok).toBe(true);
    expect(
      (await client.extensions.list()).data.some((e) => e.name === "sdk-ext"),
    ).toBe(false);
  });
});

describe("extensions — MCP surface", () => {
  let h: TestHarness;

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result?: { structuredContent?: any; isError?: boolean };
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/extensions/upload", json({ files: filesFor("mcp-ext") }));
  });
  afterAll(() => h.cleanup());

  test("extensions tools are advertised in tools/list", async () => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name.replaceAll("-", "."));
    for (const t of [
      "extensions.list",
      "extensions.install",
      "extensions.set_enabled",
      "extensions.uninstall",
      "extensions.invoke_hook",
    ]) {
      expect(names).toContain(t);
    }
  });

  test("extensions.list → invoke_hook → set_enabled → uninstall round-trips", async () => {
    const list = await callTool("extensions.list");
    const rows = list?.structuredContent?.extensions as any[];
    const mine = rows.find((e) => e.name === "mcp-ext");
    expect(mine).toBeDefined();
    expect(mine.hooks).toEqual([{ id: "echo", trigger: "manual", pattern: null }]);

    const run = await callTool("extensions.invoke_hook", {
      name: "mcp-ext",
      hookId: "echo",
      input: { msg: "mcp" },
    });
    expect(run?.isError).toBeFalsy();
    expect(run?.structuredContent?.value).toEqual({ echo: "mcp" });

    const off = await callTool("extensions.set_enabled", {
      name: "mcp-ext",
      enabled: false,
    });
    expect(off?.structuredContent?.data?.enabled).toBe(false);

    const gone = await callTool("extensions.uninstall", { name: "mcp-ext" });
    expect(gone?.structuredContent?.ok).toBe(true);
    const after = await callTool("extensions.list");
    expect(
      (after?.structuredContent?.extensions as any[]).some(
        (e) => e.name === "mcp-ext",
      ),
    ).toBe(false);
  });
});
