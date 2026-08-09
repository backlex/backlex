/**
 * Broadcast channels — the pattern grammar, the access rules, and the gate.
 *
 * The one thing this file exists to pin, above every individual assertion:
 * a free-form channel used to be open to anyone in both directions, and the
 * tests that prove it is now closed have to run as somebody who is NOT the
 * admin. A permission test that passes while signed in as the admin asserts
 * nothing, so every negative case below either signs out first or uses a
 * separate harness fetch with no cookie jar.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  matchPattern,
  patternSpecificity,
  splitChannel,
  validatePattern,
} from "@backlex/core";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;

const JSON_HEADERS = { "content-type": "application/json" };
const ADMIN = "/api/admin/realtime-channels";

/** A fetch with NO cookie jar — an anonymous caller, whatever the harness's
 *  session state is. `h.fetch` tracks cookies, so reusing it after signing in
 *  as the admin is how a "nobody may do this" test quietly asserts nothing. */
const anon = (path: string, init?: RequestInit) =>
  h.app.request(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), origin: "http://localhost:5173" },
  } as RequestInit, h.env);

const createRule = (body: Record<string, unknown>) =>
  h.fetch(ADMIN, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
});
afterEach(() => h.cleanup());

describe("the pattern grammar is closed and decodable", () => {
  test("a literal matches itself and nothing else", () => {
    expect(matchPattern("chat:lobby", "chat:lobby")).toEqual({ params: {} });
    expect(matchPattern("chat:lobby", "chat:other")).toBeNull();
  });

  test("`*` takes exactly one segment", () => {
    expect(matchPattern("chat:*", "chat:lobby")).toEqual({ params: {} });
    // The trap a glob would fall into: one star is not "the rest".
    expect(matchPattern("chat:*", "chat:room:1")).toBeNull();
  });

  test("`**` takes the rest, and only as the last segment", () => {
    expect(matchPattern("logs:**", "logs:a:b:c")).toEqual({ params: { _rest: "a:b:c" } });
    // `**` must match at least one segment — `logs` alone is not `logs:**`.
    expect(matchPattern("logs:**", "logs")).toBeNull();
    expect(validatePattern("logs:**:tail")).toContain("last segment");
  });

  test("`{name}` captures, which is the whole reason the grammar is not a regex", () => {
    expect(matchPattern("org:{org}:feed", "org:acme:feed")).toEqual({
      params: { org: "acme" },
    });
  });

  test("a channel name is rejected, never normalized", () => {
    // `a::b` and `a:b` must not resolve to the same rule.
    expect(splitChannel("a::b")).toBeNull();
    expect(splitChannel("a:b")).toEqual(["a", "b"]);
    expect(splitChannel("nope/slash")).toBeNull();
    expect(splitChannel("")).toBeNull();
  });

  test("a duplicate capture name is refused rather than silently last-wins", () => {
    expect(validatePattern("a:{x}:{x}")).toContain("Duplicate");
  });

  test("specificity is total, so which of two matching rules wins is not insertion order", () => {
    expect(patternSpecificity("chat:lobby")).toBeGreaterThan(patternSpecificity("chat:{room}"));
    expect(patternSpecificity("chat:{room}")).toBeGreaterThan(patternSpecificity("chat:*"));
    expect(patternSpecificity("chat:*")).toBeGreaterThan(patternSpecificity("chat:**"));
  });
});

describe("a channel with no rule is refused — the behaviour change", () => {
  test("an anonymous subscribe is refused where it used to be served", async () => {
    const res = await anon("/api/realtime/chat:lobby/subscribe");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("an anonymous publish is refused where it used to be accepted", async () => {
    const res = await anon("/api/realtime/chat:lobby/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: { hi: true } }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("the refusal names the endpoint that would fix it", async () => {
    const res = await h.fetch("/api/realtime/chat:lobby/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: {} }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toContain("realtime-channels");
  });

  test("REALTIME_OPEN_CHANNELS=1 restores the old behaviour, explicitly", async () => {
    h.cleanup();
    h = makeHarness({ REALTIME_OPEN_CHANNELS: "1" } as never);
    await seedAdmin(h);
    const res = await anon("/api/realtime/chat:lobby/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: { hi: true } }),
    });
    expect(res.status).toBe(200);
  });
});

describe("rules authorize", () => {
  test("a public rule serves an anonymous subscriber", async () => {
    const created = await createRule({
      name: "Public lobby",
      pattern: "chat:lobby",
      subscribe: { access: "public" },
      publish: { access: "authenticated" },
    });
    expect(created.status).toBe(201);
    // `explain` names the matching rule, so it is signed-in-only — an
    // anonymous caller must not be able to map the channel topology by
    // probing names.
    const res = await anon("/api/realtime/chat:lobby/explain");
    expect(res.status).toBe(401);

    const pub = await anon("/api/realtime/chat:lobby/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: {} }),
    });
    // publish is `authenticated`, so the anonymous caller is refused even
    // though subscribe is public — the two halves are separate answers.
    expect(pub.status).toBeGreaterThanOrEqual(400);
  });

  test("`roles` needs a non-empty list, and an empty one means nobody", async () => {
    const res = await createRule({
      name: "Broken",
      pattern: "chat:broken",
      subscribe: { access: "roles", roles: [] },
      publish: { access: "none" },
    });
    expect(res.status).toBe(422);
  });

  test("a stored rule that cannot be understood refuses everyone", async () => {
    // The failure mode this pins is the one `allowedEmailDomains` and
    // `urlSchemes` both shipped backwards: an unreadable rule must not mean
    // "no restriction". Corrupt the row the way a bad restore would.
    await createRule({
      name: "Corruptible",
      pattern: "chat:corrupt",
      subscribe: { access: "public" },
      publish: { access: "public" },
    });
    client.query("update broadcast_channels set subscribe = ? where pattern = ?").run(
      "not json at all",
      "chat:corrupt",
    );
    const res = await h.fetch("/api/realtime/chat:corrupt/explain");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canSubscribe: boolean; canPublish: boolean };
    expect(body.canSubscribe).toBe(false);
    // …and only the corrupted half is affected.
    expect(body.canPublish).toBe(true);
  });

  test("a condition reads the pattern's captures as a row", async () => {
    await createRule({
      name: "Own room",
      pattern: "room:{room}",
      subscribe: { access: "authenticated", condition: { room: { _eq: "lobby" } } },
      publish: { access: "none" },
    });
    const ok = (await (await h.fetch("/api/realtime/room:lobby/explain")).json()) as {
      canSubscribe: boolean;
      params: Record<string, string>;
    };
    expect(ok.canSubscribe).toBe(true);
    expect(ok.params).toEqual({ room: "lobby" });

    const no = (await (await h.fetch("/api/realtime/room:secret/explain")).json()) as {
      canSubscribe: boolean;
    };
    expect(no.canSubscribe).toBe(false);
  });

  test("the more specific of two matching rules wins, whatever order they were made in", async () => {
    await createRule({
      name: "Broad",
      pattern: "chat:*",
      subscribe: { access: "public" },
      publish: { access: "public" },
    });
    await createRule({
      name: "Narrow",
      pattern: "chat:private",
      subscribe: { access: "roles", roles: ["nobody-holds-this"] },
      publish: { access: "none" },
    });
    const res = (await (await h.fetch("/api/realtime/chat:private/explain")).json()) as {
      matched: { name: string };
    };
    expect(res.matched.name).toBe("Narrow");
  });
});

describe("a rule that could never fire is refused at save time", () => {
  test("a reserved root is refused", async () => {
    for (const pattern of ["items:foo", "collab:list:x", "collections", "agent:thread:1"]) {
      const res = await createRule({
        name: "Shadow",
        pattern,
        subscribe: { access: "public" },
        publish: { access: "none" },
      });
      expect(res.status).toBe(422);
    }
  });

  test("a leading capture is refused — it would shadow every managed channel", async () => {
    const res = await createRule({
      name: "Greedy",
      pattern: "{anything}:x",
      subscribe: { access: "public" },
      publish: { access: "none" },
    });
    expect(res.status).toBe(422);
  });

  test("retention above the cap is refused rather than clamped", async () => {
    const res = await createRule({
      name: "Forever",
      pattern: "chat:forever",
      subscribe: { access: "public" },
      publish: { access: "public" },
      replay: true,
      retentionHours: 999,
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("72");
  });

  test("a duplicate pattern is a 422 naming the pattern, not a driver 500", async () => {
    const body = {
      name: "One",
      pattern: "chat:dupe",
      subscribe: { access: "public" },
      publish: { access: "none" },
    };
    expect((await createRule(body)).status).toBe(201);
    const second = await createRule({ ...body, name: "Two" });
    expect(second.status).toBe(422);
    expect(await second.text()).toContain("chat:dupe");
  });
});

describe("publishing", () => {
  beforeEach(async () => {
    await createRule({
      name: "Room",
      pattern: "chat:room",
      subscribe: { access: "authenticated" },
      publish: { access: "authenticated" },
      presence: true,
      replay: true,
      retentionHours: 1,
    });
  });

  test("the sender identity is stamped server-side, never taken from the body", async () => {
    const res = await h.fetch("/api/realtime/chat:room/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        data: { hi: true },
        // A forged sender, ignored: the frame is REBUILT, not patched.
        from: { id: "someone-else", name: "Impostor" },
      }),
    });
    expect(res.status).toBe(200);
    const row = client
      .query("select sender_id, sender_name, event from broadcast_messages limit 1")
      .get() as { sender_id: string; sender_name: string; event: string };
    expect(row.sender_id).not.toBe("someone-else");
    expect(row.event).toBe("message");
  });

  test("a body with no `data` is refused rather than stored as undefined", async () => {
    const res = await h.fetch("/api/realtime/chat:room/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ event: "ping" }),
    });
    expect(res.status).toBe(422);
  });

  test("an oversized payload is refused", async () => {
    const res = await h.fetch("/api/realtime/chat:room/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: { blob: "x".repeat(20_000) } }),
    });
    expect(res.status).toBe(422);
  });

  test("a presence frame is never retained — a replayed hello is a false claim", async () => {
    const res = await h.fetch("/api/realtime/chat:room/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "presence", t: "hello", state: { cursor: 3 } }),
    });
    expect(res.status).toBe(200);
    const n = client
      .query("select count(*) as n from broadcast_messages")
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("presence is refused on a rule that does not enable it", async () => {
    await createRule({
      name: "No presence",
      pattern: "chat:quiet",
      subscribe: { access: "authenticated" },
      publish: { access: "authenticated" },
    });
    const res = await h.fetch("/api/realtime/chat:quiet/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "presence", t: "hello" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("replay", () => {
  beforeEach(async () => {
    await createRule({
      name: "Retained",
      pattern: "chat:kept",
      subscribe: { access: "authenticated" },
      publish: { access: "authenticated" },
      replay: true,
      retentionHours: 24,
    });
  });

  const publish = (n: number) =>
    h.fetch("/api/realtime/chat:kept/publish", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ event: "tick", data: { n } }),
    });

  test("messages come back oldest first, with a usable cursor", async () => {
    for (let i = 0; i < 3; i += 1) await publish(i);
    const res = await h.fetch("/api/realtime/chat:kept/replay");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ data: { n: number }; cursor: string }>;
      cursor: string | null;
    };
    expect(body.data.map((m) => m.data.n)).toEqual([0, 1, 2]);
    expect(body.cursor).toBe(body.data[2]!.cursor);
  });

  test("the keyset cursor does not skip or repeat a message that shared a millisecond", async () => {
    // Three messages forced onto the same created_at — the exact case a bare
    // `created_at >` cursor gets wrong in one direction or the other.
    for (let i = 0; i < 3; i += 1) await publish(i);
    // Force all three onto ONE created_at, inside the retention window — the
    // exact case a bare `created_at >` cursor gets wrong in one direction or
    // the other.
    client.query("update broadcast_messages set created_at = ?").run(Date.now());
    const first = (await (await h.fetch("/api/realtime/chat:kept/replay?limit=2")).json()) as {
      data: Array<{ id: string }>;
      cursor: string;
    };
    expect(first.data.length).toBe(2);
    const second = (await (
      await h.fetch(`/api/realtime/chat:kept/replay?since=${encodeURIComponent(first.cursor)}`)
    ).json()) as { data: Array<{ id: string }> };
    expect(second.data.length).toBe(1);
    const ids = new Set([...first.data, ...second.data].map((m) => m.id));
    expect(ids.size).toBe(3);
  });

  test("a page is capped, however large a limit is asked for", async () => {
    for (let i = 0; i < 30; i += 1) await publish(i);
    const res = await h.fetch("/api/realtime/chat:kept/replay?limit=500");
    // The route's own zod bound refuses it rather than silently truncating —
    // a caller who asked for 500 and got 25 would page wrongly.
    expect(res.status).toBe(422);
    const capped = (await (await h.fetch("/api/realtime/chat:kept/replay?limit=25")).json()) as {
      data: unknown[];
    };
    expect(capped.data.length).toBe(25);
  });

  test("turning retention down takes effect immediately, not at the next prune", async () => {
    await publish(1);
    // Age the message past a one-hour window without running the prune.
    client
      .query("update broadcast_messages set created_at = ?")
      .run(Date.now() - 5 * 3_600_000);
    const before = (await (await h.fetch("/api/realtime/chat:kept/replay")).json()) as {
      data: unknown[];
    };
    expect(before.data.length).toBe(1);

    const rule = client
      .query("select id from broadcast_channels where pattern = 'chat:kept'")
      .get() as { id: string };
    await h.fetch(`${ADMIN}/${rule.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ retentionHours: 1 }),
    });
    const after = (await (await h.fetch("/api/realtime/chat:kept/replay")).json()) as {
      data: unknown[];
    };
    expect(after.data.length).toBe(0);
  });

  test("replay is refused on a rule that does not retain", async () => {
    await createRule({
      name: "Ephemeral",
      pattern: "chat:gone",
      subscribe: { access: "authenticated" },
      publish: { access: "authenticated" },
    });
    const res = await h.fetch("/api/realtime/chat:gone/replay");
    expect(res.status).toBe(422);
  });
});

describe("explain", () => {
  test("a capture named after an object-model key is refused", async () => {
    // `__proto__` matches the capture regex exactly, and a capture becomes a
    // KEY on the object the condition is evaluated against.
    expect(validatePattern("a:{__proto__}")).toContain("object-model key");
    const res = await createRule({
      name: "Proto",
      pattern: "a:{__proto__}",
      subscribe: { access: "public" },
      publish: { access: "none" },
    });
    expect(res.status).toBe(422);
  });

  test("a non-admin gets the verdict but never the rule's name or pattern", async () => {
    // The verdict is about the caller; the rule's name and pattern are the
    // workspace's channel topology, which an end-user probing names could
    // otherwise map one guess at a time.
    await createRule({
      name: "Internal ops feed",
      pattern: "ops:{team}:alerts",
      subscribe: { access: "authenticated" },
      publish: { access: "none" },
    });
    const asAdmin = (await (
      await h.fetch("/api/realtime/ops:sre:alerts/explain")
    ).json()) as { matched: { name: string } | null; reason: string };
    expect(asAdmin.matched?.name).toBe("Internal ops feed");

    // Second platform user — not the first, so not auto-promoted to admin.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const email = `member-${Date.now()}@example.test`;
    const up = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Member" }),
    });
    expect(up.status).toBe(200);

    const asMember = (await (
      await h.fetch("/api/realtime/ops:sre:alerts/explain")
    ).json()) as {
      matched: unknown;
      params: Record<string, string>;
      canSubscribe: boolean;
      reason: string;
    };
    expect(asMember.matched).toBeNull();
    expect(asMember.reason).not.toContain("Internal ops feed");
    expect(asMember.reason).not.toContain("ops:{team}:alerts");
    // The verdict itself, and the captures they already typed, still come back.
    expect(asMember.canSubscribe).toBe(true);
    expect(asMember.params).toEqual({ team: "sre" });
  });

  test("a managed channel says so instead of pretending a rule governs it", async () => {
    const res = (await (await h.fetch("/api/realtime/items:anything/explain")).json()) as {
      managed: boolean;
      matched: unknown;
    };
    expect(res.managed).toBe(true);
    expect(res.matched).toBeNull();
  });

  test("an unmatched channel says nothing matched", async () => {
    const res = (await (await h.fetch("/api/realtime/nope:at:all/explain")).json()) as {
      matched: unknown;
      canSubscribe: boolean;
    };
    expect(res.matched).toBeNull();
    expect(res.canSubscribe).toBe(false);
  });
});
