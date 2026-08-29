/**
 * Multi-surface parity for WORKSPACE membership — the control-plane half of
 * "who belongs here", as opposed to `app-orgs-surfaces.test.ts`, which pins the
 * same shape one plane down.
 *
 * REST is pinned by the phase's own route tests. What this file pins is
 * everything built beside them: the MCP tools an agent reaches for, and the
 * `backlex tenants` command a human types. Both are proxies onto the same
 * routes, so the assertions here are deliberately about REACHABILITY and about
 * the guards surviving the trip — an agent must not be able to demote the last
 * owner just because it asked over JSON-RPC instead of HTTP.
 *
 * Three defects are pinned by name, because each was reachable before this
 * phase and none of them had a test:
 *
 *   1. `tenants.switch` had NEVER worked. It posted `{tenantId}` while
 *      `SwitchInput` requires `{tenant}`, so `defaultHook` answered 422 to
 *      every call the tool ever made. Nothing noticed because the old handler
 *      rethrew the upstream message as a bare Error, which reads to an agent
 *      like the workspace was simply unavailable. `the switch tool actually
 *      switches` below is the pin.
 *   2. Membership was READ-ONLY on every surface but the browser: no role
 *      change, no ownership transfer, no invite lifecycle. An operator who
 *      invited a colleague with the wrong role had SQL as the only remedy.
 *   3. Removal reached one table. The MCP/CLI tools now drive the same route
 *      the admin UI does, so whichever surface an operator uses, an eviction
 *      means the same thing.
 *
 * The cast is `buildTwoPlaneCast()`, which is what makes the rank assertions
 * possible at all: workspace A has TWO administrators (ownerA as `owner`,
 * adminA as `admin`), so "an admin may not act on an owner" and "the last owner
 * may not be demoted" can each be driven from the side that should be refused
 * AND the side that should succeed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HELP } from "../../../packages/cli/src/help";
import { buildTwoPlaneCast, json, type Caller, type TwoPlaneCast } from "./fixtures/two-plane-cast";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

interface Member {
  id: string;
  userId: string | null;
  email: string;
  role: string;
  status: string;
}

interface ToolCall {
  result?: { structuredContent?: any; isError?: boolean };
  error?: { message: string };
}

describe("workspace membership — MCP surface", () => {
  let cast: TwoPlaneCast;
  let rpcId = 1;

  /** Drive a tool exactly as an MCP client would: one JSON-RPC `tools/call`
   *  over `/mcp`, carrying the caller's own session. */
  const callTool = async (who: Caller, name: string, args: unknown): Promise<ToolCall> => {
    const res = await who(
      "/mcp",
      json("POST", {
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
    return (await res.json()) as ToolCall;
  };

  /** The error code the upstream route produced, as the agent sees it. */
  const errorCode = (r: ToolCall): string | undefined =>
    r.result?.structuredContent?.error?.code as string | undefined;

  const membersOf = async (who: Caller, tenantId: string): Promise<Member[]> => {
    const r = await callTool(who, "tenants.members", { id: tenantId });
    expect(r.result?.isError, JSON.stringify(r)).toBeFalsy();
    return r.result?.structuredContent?.data as Member[];
  };

  const memberByEmail = async (
    who: Caller,
    tenantId: string,
    email: string,
  ): Promise<Member> => {
    const found = (await membersOf(who, tenantId)).find((m) => m.email === email);
    expect(found, `no membership row for ${email}`).toBeDefined();
    return found!;
  };

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
  });
  afterAll(() => cast.cleanup());

  test("a non-member cannot read another workspace's member list", async () => {
    // The containment assertion first, before anything below has moved a
    // cookie: ownerB has no membership in A and is not the instance operator.
    const r = await callTool(cast.ownerB.fetch, "tenants.members", { id: cast.tenantA.id });
    expect(r.result?.isError).toBe(true);
    expect(errorCode(r)).toBe("FORBIDDEN");
  });

  test("the switch tool actually switches (it posted the wrong key and 422'd)", async () => {
    const switched = await callTool(cast.ownerA.fetch, "tenants.switch", {
      tenant: cast.tenantA.slug,
    });
    expect(
      switched.result?.isError,
      "tenants.switch must reach the route with `tenant`; a 422 here is the original defect",
    ).toBeFalsy();
    expect(switched.result?.structuredContent?.data?.id).toBe(cast.tenantA.id);

    // The other half of the pin, and the one that proves the arguments reached
    // the route's own logic rather than dying at the validator: a workspace the
    // caller does not belong to comes back NOT_FOUND — the deliberate
    // existence-oracle answer — not VALIDATION. While the tool posted the wrong
    // key BOTH calls were a 422, so this is what tells a fixed tool from a
    // regressed one.
    const foreign = await callTool(cast.ownerA.fetch, "tenants.switch", {
      tenant: cast.tenantB.slug,
    });
    expect(foreign.result?.isError).toBe(true);
    expect(errorCode(foreign)).toBe("NOT_FOUND");
  });

  test("members lists both administrators and never an invite token", async () => {
    const rows = await membersOf(cast.ownerA.fetch, cast.tenantA.id);
    const byEmail = Object.fromEntries(rows.map((m) => [m.email, m.role]));
    expect(byEmail[cast.ownerA.email]).toBe("owner");
    expect(byEmail[cast.adminA.email]).toBe("admin");
    // The projection is the whole defence here: a `select()` would hand every
    // agent a live credential for every pending invite.
    expect(JSON.stringify(rows)).not.toContain("inviteToken");
    expect(JSON.stringify(rows)).not.toContain("invite_token");
  });

  test("invite → resend → revoke is a complete lifecycle over MCP", async () => {
    const email = `mcp-invitee-${Date.now()}@example.test`;
    const invited = await callTool(cast.ownerA.fetch, "tenants.invite", {
      id: cast.tenantA.id,
      email,
      role: "member",
    });
    expect(invited.result?.isError, JSON.stringify(invited)).toBeFalsy();
    const first = invited.result?.structuredContent?.data as { id: string; url: string };
    expect(first.url).toContain("/invite?token=");

    const pending = await memberByEmail(cast.ownerA.fetch, cast.tenantA.id, email);
    expect(pending.status).toBe("invited");
    expect(pending.userId).toBeNull();

    const resent = await callTool(cast.ownerA.fetch, "tenants.resend_invite", {
      id: cast.tenantA.id,
      memberId: first.id,
    });
    expect(resent.result?.isError, JSON.stringify(resent)).toBeFalsy();
    const second = resent.result?.structuredContent?.data as { url: string };
    // A resend mints a NEW token. If the old one still worked, "the link
    // leaked" would have no remedy short of deleting the invite.
    expect(second.url).not.toBe(first.url);

    const revoked = await callTool(cast.ownerA.fetch, "tenants.revoke_invite", {
      id: cast.tenantA.id,
      memberId: first.id,
    });
    expect(revoked.result?.isError, JSON.stringify(revoked)).toBeFalsy();
    const after = await membersOf(cast.ownerA.fetch, cast.tenantA.id);
    expect(after.some((m) => m.email === email)).toBe(false);
  });

  test("the rank ladder and the last-owner guard survive the JSON-RPC trip", async () => {
    const owner = await memberByEmail(cast.ownerA.fetch, cast.tenantA.id, cast.ownerA.email);
    const admin = await memberByEmail(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);

    // An admin acting on an owner: equal-or-higher rank is refused.
    const upward = await callTool(cast.adminA.fetch, "tenants.update_member", {
      id: cast.tenantA.id,
      memberId: owner.id,
      role: "member",
    });
    expect(upward.result?.isError).toBe(true);
    expect(errorCode(upward)).toBe("FORBIDDEN");

    // An admin minting an owner: outranks the target, does not hold the grant.
    const grant = await callTool(cast.adminA.fetch, "tenants.update_member", {
      id: cast.tenantA.id,
      memberId: admin.id,
      role: "owner",
    });
    expect(grant.result?.isError).toBe(true);
    expect(errorCode(grant)).toBe("FORBIDDEN");

    // The owner demoting THEMSELVES is allowed by rank and refused by the
    // count: there is nobody else to be in charge.
    const lastOwner = await callTool(cast.ownerA.fetch, "tenants.update_member", {
      id: cast.tenantA.id,
      memberId: owner.id,
      role: "member",
    });
    expect(lastOwner.result?.isError).toBe(true);
    expect(errorCode(lastOwner)).toBe("VALIDATION");

    // Nothing above was allowed to take effect.
    const rows = await membersOf(cast.ownerA.fetch, cast.tenantA.id);
    expect(rows.find((m) => m.id === owner.id)?.role).toBe("owner");
    expect(rows.find((m) => m.id === admin.id)?.role).toBe("admin");
  });

  test("an owner can change a member's role — the capability that did not exist", async () => {
    const admin = await memberByEmail(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);

    const demoted = await callTool(cast.ownerA.fetch, "tenants.update_member", {
      id: cast.tenantA.id,
      memberId: admin.id,
      role: "member",
    });
    expect(demoted.result?.isError, JSON.stringify(demoted)).toBeFalsy();
    expect(demoted.result?.structuredContent?.data?.role).toBe("member");

    // …and back, so the rest of the file still has two administrators.
    const restored = await callTool(cast.ownerA.fetch, "tenants.update_member", {
      id: cast.tenantA.id,
      memberId: admin.id,
      role: "admin",
    });
    expect(restored.result?.isError, JSON.stringify(restored)).toBeFalsy();
    expect(
      (await memberByEmail(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email)).role,
    ).toBe("admin");
  });

  test("ownership transfer moves the workspace in one step", async () => {
    const admin = await memberByEmail(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
    const transferred = await callTool(cast.ownerA.fetch, "tenants.transfer_ownership", {
      id: cast.tenantA.id,
      memberId: admin.id,
    });
    expect(transferred.result?.isError, JSON.stringify(transferred)).toBeFalsy();

    // Both sides move together — the point of a single route rather than a
    // promote-then-demote pair an operator can stop halfway through.
    const rows = await membersOf(cast.adminA.fetch, cast.tenantA.id);
    const byEmail = Object.fromEntries(rows.map((m) => [m.email, m.role]));
    expect(byEmail[cast.adminA.email]).toBe("owner");
    expect(byEmail[cast.ownerA.email]).toBe("admin");
  });

  test("removal evicts, and the last owner cannot evict themselves", async () => {
    // adminA holds the workspace now (previous test), so they are the actor.
    const nowOwner = await memberByEmail(cast.adminA.fetch, cast.tenantA.id, cast.adminA.email);
    const selfRemoval = await callTool(cast.adminA.fetch, "tenants.remove_member", {
      id: cast.tenantA.id,
      memberId: nowOwner.id,
    });
    expect(selfRemoval.result?.isError).toBe(true);
    expect(errorCode(selfRemoval)).toBe("VALIDATION");

    const demotedFounder = await memberByEmail(
      cast.adminA.fetch,
      cast.tenantA.id,
      cast.ownerA.email,
    );
    const removed = await callTool(cast.adminA.fetch, "tenants.remove_member", {
      id: cast.tenantA.id,
      memberId: demotedFounder.id,
    });
    expect(removed.result?.isError, JSON.stringify(removed)).toBeFalsy();

    const rows = await membersOf(cast.adminA.fetch, cast.tenantA.id);
    expect(rows.some((m) => m.email === cast.ownerA.email)).toBe(false);

    // And the eviction holds from the evicted side: the workspace is gone from
    // their own listing, which is the assertion that would have stayed green
    // while the old one-statement removal left every role binding in place.
    const theirs = await callTool(cast.ownerA.fetch, "tenants.list", {});
    const mine = theirs.result?.structuredContent?.data as { id: string }[];
    expect(mine.some((t) => t.id === cast.tenantA.id)).toBe(false);
  });

  test("tools/list advertises the membership tools with honest annotations", async () => {
    const res = await cast.ownerA.fetch(
      "/mcp",
      json("POST", { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} }),
    );
    const body = (await res.json()) as {
      result: { tools: { name: string; annotations?: Record<string, boolean> }[] };
    };
    const byName = Object.fromEntries(body.result.tools.map((t) => [t.name, t]));
    for (const name of [
      "tenants-members",
      "tenants-invite",
      "tenants-update_member",
      "tenants-transfer_ownership",
      "tenants-resend_invite",
      "tenants-revoke_invite",
      "tenants-remove_member",
    ]) {
      expect(byName[name], `${name} should be advertised`).toBeDefined();
    }
    // `members` reads and `remove_member` destroys; the name heuristic gets
    // both wrong (it defaults unknown verbs to `write`), so the tools carry an
    // explicit kind and these annotations are what proves it took effect.
    expect(byName["tenants-members"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["tenants-remove_member"]?.annotations?.destructiveHint).toBe(true);
  });
});

describe("workspace membership — CLI surface", () => {
  let h: TestHarness;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let apiKey: string;
  let tenantId: string;
  let tmpDir: string;
  let cfgPath: string;
  const T = 30_000; // every test spawns a subprocess

  const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
  const CLI_BIN = resolve(REPO_ROOT, "packages/cli/bin/backlex.ts");

  /** Run the real binary against the real listener — the CLI is only a surface
   *  if it is exercised as one, and importing `runTenants` would skip argv
   *  parsing, the help text and the exit codes, which is most of what it is. */
  const runCli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Never let the developer's real BACKLEX_* leak into the subprocess.
      if (v !== undefined && !k.startsWith("BACKLEX_")) env[k] = v;
    }
    env.BACKLEX_CONFIG = cfgPath;
    env.BACKLEX_URL = baseUrl;
    env.BACKLEX_API_KEY = apiKey;
    const proc = Bun.spawn(["bun", CLI_BIN, ...args], {
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };

  beforeAll(async () => {
    h = makeHarness();
    server = Bun.serve({ port: 0, fetch: (req) => h.app.fetch(req) });
    baseUrl = `http://127.0.0.1:${server.port}`;
    await seedAdmin(h);

    const keyRes = await h.fetch("/api/api-keys", json("POST", { name: "tenants-cli" }));
    expect(keyRes.status).toBe(201);
    apiKey = ((await keyRes.json()) as { data: { secret: string } }).data.secret;

    const listed = (await (await h.fetch("/api/tenants")).json()) as {
      data: { id: string; slug: string }[];
    };
    tenantId = listed.data.find((t) => t.slug === "default")!.id;

    tmpDir = mkdtempSync(join(tmpdir(), "backlex-tenants-cli-"));
    cfgPath = join(tmpDir, "config.json");
  });

  afterAll(() => {
    server?.stop(true);
    h?.cleanup();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("the command is reachable and documents the rules it enforces", async () => {
    const r = await runCli(["tenants"]);
    expect(r.code).toBe(0);
    for (const sub of ["members", "invite", "set-role", "transfer", "remove", "revoke-invite"]) {
      expect(r.stdout).toContain(sub);
    }
    // The two refusals people meet first are stated up front rather than
    // discovered as a 422.
    expect(r.stdout).toContain("outrank");
    expect(r.stdout).toContain("MEMBERSHIP id");
  }, T);

  test("list marks the active workspace and members reads the roster", async () => {
    const listed = await runCli(["tenants", "list", "--json"]);
    expect(listed.code).toBe(0);
    const tenants = JSON.parse(listed.stdout) as { data: { id: string }[]; active: string | null };
    expect(tenants.data.some((t) => t.id === tenantId)).toBe(true);

    const members = await runCli(["tenants", "members", tenantId, "--json"]);
    expect(members.code).toBe(0);
    const rows = JSON.parse(members.stdout) as Member[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => typeof m.role === "string")).toBe(true);
  }, T);

  test("invite → set-role → revoke-invite round-trips through the binary", async () => {
    const email = `cli-invitee-${Date.now()}@example.test`;
    const invited = await runCli(["tenants", "invite", tenantId, email, "--role", "member", "--json"]);
    expect(invited.code, invited.stderr).toBe(0);
    const invite = JSON.parse(invited.stdout) as { id: string; url: string };
    expect(invite.url).toContain("/invite?token=");

    const promoted = await runCli([
      "tenants",
      "set-role",
      tenantId,
      invite.id,
      "--role",
      "admin",
      "--json",
    ]);
    expect(promoted.code, promoted.stderr).toBe(0);
    expect((JSON.parse(promoted.stdout) as Member).role).toBe("admin");

    const revoked = await runCli(["tenants", "revoke-invite", tenantId, invite.id, "--json"]);
    expect(revoked.code, revoked.stderr).toBe(0);

    const after = await runCli(["tenants", "members", tenantId, "--json"]);
    expect((JSON.parse(after.stdout) as Member[]).some((m) => m.email === email)).toBe(false);
  }, T);

  test("the irreversible verbs refuse to run without --confirm", async () => {
    for (const verb of ["transfer", "remove"]) {
      const r = await runCli(["tenants", verb, tenantId, "some-member-id"]);
      expect(r.code, `${verb} without --confirm should exit non-zero`).toBe(1);
      // "refusing to" rather than just "--confirm": the top-level help text
      // mentions `--confirm` too, so an unrecognised command would satisfy the
      // looser assertion and this test would pass with the command unwired.
      expect(r.stderr).toContain("refusing to");
      expect(r.stderr).toContain("--confirm");
      // A refusal is a decision, not a crash.
      expect(r.stderr).not.toContain("\n    at ");
    }
  }, T);

  test("a bad --role is rejected before a request is made", async () => {
    const r = await runCli(["tenants", "set-role", tenantId, "some-member-id", "--role", "editor"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--role must be one of: owner, admin, member");
  }, T);
});

describe("workspace membership — release bookkeeping", () => {
  /**
   * `cli-release-drift.test.ts` fails when the published command list moves
   * without a version bump. This asserts the same contract from the other end:
   * that `tenants` really is a NEW top-level command in the help text (the
   * shape that guard reads), so the bump it demands is owed to this phase and
   * not to a formatting accident.
   */
  test("`tenants` is offered as a top-level command", () => {
    const commands = [...HELP.matchAll(/^ {2}backlex ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
    expect(commands).toContain("tenants");
    // `orgs` is the app-plane neighbour and must still be there — the two are
    // different populations and one is not a replacement for the other.
    expect(commands).toContain("orgs");
  });
});
