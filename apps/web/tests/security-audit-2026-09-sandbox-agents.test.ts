/**
 * Phase 5 of the 2026-09 pre-prod audit — the sandbox, the RPC bridge back out
 * of it, and the agent approval gate.
 *
 * Three defects that all reduce to the same question: **who is this running
 * as, and who said so?**
 *
 *   · `/api/_internal/sandbox-rpc` read the subject out of the request BODY,
 *     with a shared bearer token as the only thing behind it. The token is
 *     handed to an executor that runs user-authored code in-process, so a
 *     function author could read it off the executor's own next callback and
 *     replay it naming any workspace. `email.send`, `push.send` and
 *     `ai.generate` have no second check — no permission resolve, no
 *     membership lookup — so that named workspace's mail transport, devices
 *     and AI budget were all reachable. The subject now travels signed.
 *
 *   · The bun-worker provider was selected automatically on any Bun self-host,
 *     and it is not a sandbox: `import("node:process")` returns the API host's
 *     env, `import("node:fs")` reads any file, `globalThis.Bun.spawnSync` runs
 *     commands. None of it is closable from inside — `Bun` is defined
 *     `configurable: false, writable: false` — and function authoring is gated
 *     on the self-serve `admin` role. It is now opt-in.
 *
 *   · `callFingerprint` keyed an approval on
 *     `JSON.stringify(args, Object.keys(args).sort())`, and a replacer array
 *     filters at EVERY level, so nested arguments serialised as `{}`.
 *     Approving one `collections.batch` approved every other one in the
 *     thread. That half lives in `agent-tool-approval.test.ts`, next to the
 *     fingerprint's other properties.
 *
 * Both directions everywhere: a clamp that refuses everything passes a
 * one-directional test. Each guard was verified by breaking it — see
 * [[verify-a-guard-by-breaking-it]].
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  signSandboxGrant,
  signStorageUrl,
  type SandboxGrantPayload,
} from "../src/server/lib/crypto";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const J = { "content-type": "application/json" };
const RPC_PATH = "/api/_internal/sandbox-rpc";
const TOKEN = "faz5-sandbox-rpc-token";

const soon = (): number => Math.floor(Date.now() / 1000) + 120;

const grantFor = (
  claims: Partial<SandboxGrantPayload>,
  secret = TOKEN,
): Promise<string> =>
  signSandboxGrant(
    { u: null, e: null, r: [], t: null, exp: soon(), ...claims },
    secret,
  );

const rpc = (
  h: TestHarness,
  bearer: string,
  body: unknown,
): Promise<Response> =>
  h.fetch(RPC_PATH, {
    method: "POST",
    headers: { ...J, authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });

const reply = async (
  res: Response,
): Promise<{ ok: boolean; value?: unknown; error?: string }> =>
  (await res.json()) as { ok: boolean; value?: unknown; error?: string };

/** The `[email] …` line the console transport prints while `fn` runs. Returns
 *  null when nothing was sent, which is the assertion in half these cases. */
const captureEmail = async (fn: () => Promise<void>): Promise<string | null> => {
  const real = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines.find((l) => l.startsWith("[email]")) ?? null;
};

describe("sandbox RPC — the subject is signed by the main app, not stated by the executor", () => {
  let h: TestHarness;
  let tenantA = "";
  let adminId = "";
  const slug = `faz5_notes_${`${Date.now()}`.slice(-6)}`;

  beforeAll(async () => {
    h = makeHarness({ SANDBOX_RPC_TOKEN: TOKEN });
    await seedAdmin(h);

    const mk = await h.fetch("/api/collections", {
      method: "POST",
      headers: J,
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(mk.status).toBe(201);
    const item = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: J,
      body: JSON.stringify({ title: "only-in-workspace-a" }),
    });
    expect(item.status).toBe(201);

    const client = new Database(h.env.SQLITE_PATH as string);
    try {
      tenantA = (
        client.query("SELECT id FROM tenants WHERE slug = 'default'").get() as {
          id: string;
        }
      ).id;
      adminId = (
        client.query("SELECT id FROM users LIMIT 1").get() as { id: string }
      ).id;
    } finally {
      client.close();
    }
  });
  afterAll(() => h.cleanup());

  test("a grant's workspace wins over the one the body claims", async () => {
    // The executor runs user code, so `body.auth` is attacker-controlled. Here
    // it names a workspace that is not the grant's — and a workspace whose
    // collection list would answer differently — and it is ignored outright.
    const grant = await grantFor({ u: adminId, r: ["admin"], t: tenantA });
    const res = await rpc(h, grant, {
      op: "db.list",
      args: { slug },
      auth: {
        userId: null,
        email: null,
        roles: ["admin"],
        tenantId: "00000000-0000-4000-8000-000000000000",
      },
    });
    expect(res.status).toBe(200);
    const body = await reply(res);
    expect(body.ok).toBe(true);
    expect(body.value).toHaveLength(1);

    // The other direction: a grant that really does name the bogus workspace
    // finds nothing, so the row above came from the grant and not from some
    // fallback that ignores tenancy altogether.
    const elsewhere = await grantFor({
      u: adminId,
      r: ["admin"],
      t: "00000000-0000-4000-8000-000000000000",
    });
    const miss = await reply(
      await rpc(h, elsewhere, {
        op: "db.list",
        args: { slug },
        auth: { userId: adminId, email: null, roles: ["admin"], tenantId: tenantA },
      }),
    );
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain("not found");
  });

  test("a grant this deployment did not mint is not a credential", async () => {
    const good = await grantFor({ u: adminId, r: ["admin"], t: tenantA });
    const body = {
      op: "db.list",
      args: { slug },
      auth: { userId: adminId, email: null, roles: ["admin"], tenantId: tenantA },
    };

    // Signed with someone else's secret.
    const foreign = await grantFor(
      { u: adminId, r: ["admin"], t: tenantA },
      "a-different-deployments-secret",
    );
    expect((await rpc(h, foreign, body)).status).toBe(401);

    // Payload edited, signature left alone — the classic "just change the
    // tenant id" attempt on a token that looks structured.
    const [payload, sig] = good.split(".") as [string, string];
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as SandboxGrantPayload;
    claims.t = "00000000-0000-4000-8000-000000000000";
    const tampered = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
    expect((await rpc(h, tampered, body)).status).toBe(401);

    // Expired.
    const stale = await grantFor({
      u: adminId,
      r: ["admin"],
      t: tenantA,
      exp: Math.floor(Date.now() / 1000) - 5,
    });
    expect((await rpc(h, stale, body)).status).toBe(401);

    // A storage signed-URL token minted with the SAME secret. Both are
    // `<payload>.<sig>` HMACs off SANDBOX_RPC_TOKEN.
    const storage = await signStorageUrl(
      { k: "x", t: tenantA, exp: soon() },
      TOKEN,
    );
    expect((await rpc(h, storage, body)).status).toBe(401);

    // …and that one is refused on SHAPE (a storage payload has no `r`), which
    // is not the property worth pinning — it evaporates the moment the two
    // payloads have a field in common. So here is the same crossover with a
    // payload deliberately built to satisfy BOTH shape checks: `{u,e,r,t,exp}`
    // for a grant and `{k,t,exp}` for a storage URL, in one object. Nothing is
    // left to refuse it except the domain-separation string in the key
    // derivation, and it must still be refused.
    const bothShapes = {
      u: adminId,
      e: null,
      r: ["admin"],
      t: tenantA,
      exp: soon(),
      k: "some/object/key",
    };
    const crossSigned = await signStorageUrl(
      bothShapes as unknown as Parameters<typeof signStorageUrl>[0],
      TOKEN,
    );
    expect((await rpc(h, crossSigned, body)).status).toBe(401);
    // The same payload signed as a GRANT does authenticate, so the refusal
    // above is about which key signed it and not about the payload.
    const properlySigned = await signSandboxGrant(
      bothShapes as unknown as SandboxGrantPayload,
      TOKEN,
    );
    expect((await reply(await rpc(h, properlySigned, body))).ok).toBe(true);

    // And the grant that IS this deployment's still works, so the four
    // refusals above are about the credential rather than about the request.
    expect((await reply(await rpc(h, good, body))).ok).toBe(true);
  });

  test("the raw shared secret cannot send mail, push, or spend the AI budget", async () => {
    // These three have nothing behind them but the subject — no permission
    // resolve, no membership lookup — so they are the reason the subject has to
    // be signed. On the legacy path the subject is unverifiable, so they refuse.
    for (const op of ["email.send", "push.send", "ai.generate"]) {
      const line = await captureEmail(async () => {
        const body = await reply(
          await rpc(h, TOKEN, {
            op,
            args: {
              to: "victim@example.test",
              subject: "forged",
              text: "forged",
              title: "forged",
              body: "forged",
              userIds: [adminId],
              prompt: "forged",
            },
            auth: {
              userId: null,
              email: null,
              roles: [],
              tenantId: tenantA,
            },
          }),
        );
        expect(body.ok).toBe(false);
        expect(body.error).toContain("rpcToken");
      });
      // Nothing went out while that was refused — the refusal is before the
      // transport, not a message the guest sees after the mail is away.
      expect(line).toBeNull();
    }

    // The neighbouring case that must still work: the legacy path keeps `db.*`,
    // which re-resolves permissions from the database for the named subject.
    const ok = await reply(
      await rpc(h, TOKEN, {
        op: "db.list",
        args: { slug },
        auth: { userId: adminId, email: null, roles: ["admin"], tenantId: tenantA },
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.value).toHaveLength(1);
  });

  test("a grant CAN send mail — the workspace it names is the one that sends", async () => {
    const grant = await grantFor({ u: adminId, r: ["admin"], t: tenantA });
    const line = await captureEmail(async () => {
      const body = await reply(
        await rpc(h, grant, {
          op: "email.send",
          args: {
            to: "recipient@example.test",
            subject: "from a signed grant",
            text: "hello",
          },
          auth: { userId: null, email: null, roles: [], tenantId: null },
        }),
      );
      expect(body.ok).toBe(true);
    });
    expect(line).toContain("recipient@example.test");
  });

  test("no workspace means no send — on every op, in the service", async () => {
    // The clamp lives in `dispatchRpc`, not on the route, because
    // `providers/bun-worker.ts` reaches the dispatcher in-process and never
    // passes through the route at all. `emailFor(null)` resolves the
    // DEPLOYMENT's own transport, so this is the difference between "a
    // workspace sent it" and "the instance sent it".
    const grant = await grantFor({ u: adminId, r: ["admin"], t: null });
    for (const [op, args] of [
      ["email.send", { to: "a@b.test", subject: "s", text: "t" }],
      ["push.send", { userIds: [adminId], title: "t", body: "b" }],
      ["ai.generate", { prompt: "hello" }],
    ] as const) {
      const line = await captureEmail(async () => {
        const body = await reply(
          await rpc(h, grant, {
            op,
            args,
            auth: { userId: null, email: null, roles: [], tenantId: null },
          }),
        );
        expect(body.ok).toBe(false);
        expect(body.error).toContain("workspace-scoped run");
      });
      expect(line).toBeNull();
    }
  });
});

describe("the in-process Bun sandbox is opt-in, and is not isolation", () => {
  const code = 'return { bun: typeof globalThis.Bun };';
  const mk = async (
    overrides: Record<string, string> = {},
  ): Promise<{ h: TestHarness; run: (src: string) => Promise<{ ok: boolean; value?: unknown; error?: string }> }> => {
    const h = makeHarness(overrides as never);
    await seedAdmin(h);
    const run = async (src: string) => {
      const name = `probe_${`${Math.random()}`.slice(2, 8)}`;
      const created = await h.fetch("/api/functions", {
        method: "POST",
        headers: J,
        body: JSON.stringify({ name, trigger: "http", timeoutMs: 3000, code: src }),
      });
      expect(created.status).toBe(201);
      const res = await h.fetch(`/api/functions/${name}/invoke`, {
        method: "POST",
        headers: J,
        body: JSON.stringify({}),
      });
      return (await res.json()) as { ok: boolean; value?: unknown; error?: string };
    };
    return { h, run };
  };

  test("the default on a Bun host is the QuickJS isolate, where there is no Bun to reach", async () => {
    // This whole suite runs on Bun, so before the fix this deployment shape
    // selected bun-worker automatically and `globalThis.Bun` was an object —
    // meaning `Bun.spawnSync` was one property access away for anyone holding
    // the self-serve `admin` role.
    const { h, run } = await mk();
    try {
      const out = await run(code);
      expect(out.ok).toBe(true);
      expect(out.value).toEqual({ bun: "undefined" });

      // And with no host bridge, `ctx.*` refuses in a way that names the fix
      // rather than reading as a typo in the author's own code. (No `await`:
      // the QuickJS provider evaluates synchronously, so `await` is a parse
      // error there — the thrower fires on the call itself.)
      const io = await run('return ctx.db.list("anything");');
      expect(io.ok).toBe(false);
      expect(io.error).toContain("FUNCTIONS_EXEC_URL");
      expect(io.error).toContain("FUNCTIONS_SANDBOX=bun-worker");
    } finally {
      h.cleanup();
    }
  });

  test("FUNCTIONS_SANDBOX=bun-worker opts in, and what it opts into is the host", async () => {
    // Pinned deliberately as a CAPABILITY, not as a leak to be fixed later:
    // this provider shares the process and cannot be closed from inside, which
    // is exactly why it stopped being the default. If a future change makes
    // this assertion fail because the worker got hardened, read
    // `worker-entry.ts` first — the last three attempts at hardening it were
    // measured and none of them hold.
    const { h, run } = await mk({ FUNCTIONS_SANDBOX: "bun-worker" });
    try {
      const out = await run(code);
      expect(out.ok).toBe(true);
      expect(out.value).toEqual({ bun: "object" });
    } finally {
      h.cleanup();
    }
  });

  test("an unrecognised value reads as `auto` rather than as an error", async () => {
    // A typo in an env var must not take functions down, and must not fall
    // through to the soft sandbox either.
    const { h, run } = await mk({ FUNCTIONS_SANDBOX: "bunworker" });
    try {
      const out = await run(code);
      expect(out.ok).toBe(true);
      expect(out.value).toEqual({ bun: "undefined" });
    } finally {
      h.cleanup();
    }
  });
});
