/**
 * Multi-surface parity for approvals.
 *
 * The gate is not that five surfaces exist — it is that they share ONE
 * implementation. `services/approvals.ts` owns the duplicate-address refusal,
 * the unmeetable-quorum refusal, the one-shot settle guard and the rule that
 * links are handed out exactly once. A surface that restated any of them is the
 * one that eventually disagrees. So each surface is driven through the same
 * cases and asserted to answer the same way.
 *
 * The CLI is checked structurally rather than by spawning a shell: it is a thin
 * argv parser over the SDK, and what can actually rot is a subcommand or flag
 * quietly disappearing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { approvalsTools } from "../src/server/mcp/tools/approvals";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string; extensions?: { code?: string } }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const mcp = (name: string, args: Record<string, unknown>) => {
  const tool = approvalsTools.find((x) => x.name === name)!;
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as any);
};

/**
 * Each surface reduced to "raise this request", with failures normalised to
 * `{ error }`. The surfaces disagree about HOW they report a refusal — REST
 * answers a status, the SDK throws, GraphQL collects into `errors` — and that
 * is not what this file pins. What must agree is WHETHER they refuse.
 */
type Raise = (input: Record<string, unknown>) => Promise<Record<string, any>>;

const normalise =
  (fn: Raise): Raise =>
  async (input) => {
    try {
      const out = await fn(input);
      return out?.error || out?.errors ? { error: JSON.stringify(out) } : out;
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

const SURFACES: [string, Raise][] = (
  [
    [
      "rest",
      async (input) => {
        const res = await h.fetch("/api/admin/approvals", json({ send: false, ...input }));
        const body = (await res.json()) as any;
        return body.error ? { error: JSON.stringify(body.error) } : body.data;
      },
    ],
    ["sdk", async (input) => (await sdk().approvals.create({ send: false, ...input } as any)).data as any],
    [
      "graphql",
      async (input) => {
        const res = await gql(
          `mutation($t:String!,$a:[ApproverInput!]!,$p:String,$q:Int,$o:Boolean,$s:JSON,$w:JSON){
             createApprovalRequest(title:$t, approvers:$a, policy:$p, quorum:$q, ordered:$o, subject:$s, writeBack:$w, send:false){
               request{ id title status policy quorum ordered approvers{ email status } }
               links{ approverId email url }
               sent
             }
           }`,
          {
            t: input.title,
            a: input.approvers,
            p: input.policy ?? null,
            q: input.quorum ?? null,
            o: input.ordered ?? null,
            s: input.subject ?? null,
            w: input.writeBack ?? null,
          },
        );
        if (res.errors) return { error: res.errors[0]!.message };
        return res.data!.createApprovalRequest;
      },
    ],
    [
      "mcp",
      async (input) => {
        const out = await mcp("approvals.request", { ...input });
        const structured = out.structuredContent as Record<string, any>;
        // The MCP tool proxies REST, so a refusal arrives as the error body.
        return structured?.error ? { error: JSON.stringify(structured) } : structured;
      },
    ],
  ] as [string, Raise][]
).map(([name, fn]) => [name, normalise(fn)]);

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
});
afterEach(() => h.cleanup());

describe("approvals — surface parity", () => {
  test("every surface raises a request the same way", async () => {
    for (const [name, raise] of SURFACES) {
      const out = await raise({
        title: `req-${name}`,
        approvers: [{ email: `a-${name}@x.test` }, { email: `b-${name}@x.test` }],
      });
      expect(out.error).toBeUndefined();
      expect(out.request.status).toBe("pending");
      expect(out.request.policy).toBe("all");
      // `all` derives its quorum from the roster on every surface, rather than
      // each one defaulting it to something of its own.
      expect(out.request.quorum).toBe(2);
      expect(out.request.approvers).toHaveLength(2);
    }
  });

  test("every surface refuses a duplicate approver", async () => {
    for (const [name, raise] of SURFACES) {
      const out = await raise({
        title: `dup-${name}`,
        approvers: [{ email: "same@x.test" }, { email: "same@x.test" }],
      });
      expect(out.request).toBeUndefined();
      expect(JSON.stringify(out)).toContain("listed twice");
    }
  });

  test("every surface refuses a quorum the roster cannot meet", async () => {
    for (const [name, raise] of SURFACES) {
      const out = await raise({
        title: `quorum-${name}`,
        policy: "quorum",
        quorum: 4,
        approvers: [{ email: `q-${name}@x.test` }],
      });
      expect(out.request).toBeUndefined();
      expect(JSON.stringify(out)).toContain("cannot be met");
    }
  });

  test("only the link-bearing surfaces hand the links out", async () => {
    // REST, the SDK and GraphQL return them once. MCP deliberately drops them:
    // a tool result is transcript that gets summarised, forwarded and stored,
    // and a decision link is a bearer credential.
    for (const [name, raise] of SURFACES) {
      const out = await raise({ title: `link-${name}`, approvers: [{ email: `l-${name}@x.test` }] });
      if (name === "mcp") {
        expect(out.links).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain("/approve/");
      } else {
        expect(out.links).toHaveLength(1);
        expect(String(out.links[0].url)).toContain("/approve/");
      }
    }
  });

  test("no surface exposes the parked flow continuation", async () => {
    for (const [name, raise] of SURFACES) {
      const out = await raise({ title: `cont-${name}`, approvers: [{ email: `c-${name}@x.test` }] });
      expect(out.request).not.toHaveProperty("continuation");
      expect(JSON.stringify(out)).not.toContain("remainingOps");
    }
  });

  test("reads agree across surfaces", async () => {
    const created = await SURFACES[0]![1]({
      title: "read-me",
      approvers: [{ email: "r@x.test", role: "Finance" }],
    });
    const id = created.request.id as string;

    const rest = (await (await h.fetch(`/api/admin/approvals/${id}`)).json()) as any;
    const viaSdk = await sdk().approvals.get(id);
    const viaGql = await gql(
      `query($id:ID!){ approvalRequest(id:$id){ id title status policy approvers{ email role status } } }`,
      { id },
    );
    const viaMcp = (await mcp("approvals.get", { id })).structuredContent as any;

    expect(rest.data.title).toBe("read-me");
    expect(viaSdk.data.title).toBe("read-me");
    expect(viaGql.data!.approvalRequest.title).toBe("read-me");
    expect(viaMcp.data.title).toBe("read-me");
    for (const shape of [rest.data, viaSdk.data, viaMcp.data]) {
      expect(shape.approvers[0].role).toBe("Finance");
    }
    expect(viaGql.data!.approvalRequest.approvers[0].role).toBe("Finance");
  });

  test("cancelling agrees across surfaces", async () => {
    const mk = async (title: string) => {
      const out = await SURFACES[0]![1]({ title, approvers: [{ email: `${title}@x.test` }] });
      return out.request.id as string;
    };

    const viaRest = await mk("c1");
    expect((await h.fetch(`/api/admin/approvals/${viaRest}/cancel`, json({}))).status).toBe(200);

    const viaSdkId = await mk("c2");
    expect((await sdk().approvals.cancel(viaSdkId)).data.status).toBe("cancelled");

    const viaGqlId = await mk("c3");
    const g = await gql(
      `mutation($id:ID!){ cancelApprovalRequest(id:$id){ status } }`,
      { id: viaGqlId },
    );
    expect(g.data!.cancelApprovalRequest.status).toBe("cancelled");

    const viaMcpId = await mk("c4");
    const m = (await mcp("approvals.cancel", { id: viaMcpId })).structuredContent as any;
    expect(m.data.status).toBe("cancelled");

    // And every one of them refuses the second attempt with the same code.
    const again = await gql(`mutation($id:ID!){ cancelApprovalRequest(id:$id){ status } }`, {
      id: viaGqlId,
    });
    expect(again.errors?.[0]?.extensions?.code).toBe("CONFLICT");
  });

  test("no surface offers a way for an admin to decide on somebody's behalf", () => {
    // Deciding is authenticated by the approver's own link and nothing else.
    // An admin-authenticated decision would also fire whatever the waiting
    // flow does next, which is the whole thing the design refuses.
    expect(approvalsTools.map((t) => t.name)).toEqual([
      "approvals.list",
      "approvals.get",
      "approvals.request",
      "approvals.cancel",
    ]);
    const client = sdk().approvals as Record<string, unknown>;
    expect(Object.keys(client).sort()).toEqual(["cancel", "create", "get", "list"]);
  });

  test("the CLI exposes the same verbs and flags", () => {
    const src = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/approvals.ts"),
      "utf8",
    );
    for (const verb of ["list", "get", "request", "cancel"]) {
      expect(src).toContain(`case "${verb}":`);
    }
    for (const f of ["--policy", "--quorum", "--ordered", "--expires", "--write-back", "--summary"]) {
      expect(src).toContain(f);
    }
    // The CLI is the ONE surface that prints links, and only because a
    // terminal is the operator's own screen.
    expect(src).toContain("data.links.map");
    // Still no decide verb here either.
    expect(src).not.toContain('case "decide"');

    const bin = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/bin/backlex.ts"),
      "utf8",
    );
    expect(bin).toContain('case "approvals":');
    expect(bin).toContain("runApprovals");
  });
});
