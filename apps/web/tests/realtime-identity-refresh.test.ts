/**
 * Realtime subscriptions re-resolve WHO is subscribed, on the heartbeat.
 *
 * `routes/realtime.ts` used to gate a subscription exactly once, at subscribe
 * time, and freeze the answer into the subscription's `meta`. Every event was
 * then filtered against that frozen `authSubject` — including `$org.id`,
 * `$org.role` and `$user.orgs`, which `packages/db/src/permission.ts` resolves
 * straight out of it. The only timers on a held stream were heartbeats.
 *
 * So offboarding a B2B customer did not offboard them: removing an end-user
 * from an organization, demoting them, or revoking the role that granted the
 * read left an already-open SSE stream delivering that org's rows. The REST
 * path is stale for at most 30s (the permission cache's TTL); this one was
 * stale for as long as the tab stayed open, which for a dashboard is hours.
 *
 * These specs drive the whole journey through the public API — two end-users in
 * one organization, a permission rule scoped to `$org.id`, two live SSE
 * subscriptions — and then offboard one of them. What they pin:
 *
 *   1. the removed member stops receiving that org's rows within one heartbeat;
 *   2. the OTHER member keeps receiving them, so the spec cannot pass by
 *      breaking realtime altogether;
 *   3. a subscriber who loses the read permission outright has the stream
 *      CLOSED with a `revoked` frame, rather than being left on a silent feed
 *      that is indistinguishable from an idle one.
 *
 * The heartbeat is 25s in production, which no spec can wait for, so
 * `__setRealtimeHeartbeatMs` shortens it here. That the refresh rides the
 * heartbeat at all is the design: it is the timer a held stream already has,
 * and coupling to it keeps the refresh cadence and the liveness cadence from
 * drifting apart.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { __setRealtimeHeartbeatMs } from "../src/server/routes/realtime";

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Short enough that a spec can watch two of them go by; long enough that the
 *  refresh's own DB work finishes inside one on a loaded CI box. */
const TEST_HEARTBEAT_MS = 120;
/** How long to let the stream prove something arrived (or did not). Several
 *  heartbeats, so a negative assertion is about the gate and not about timing. */
const OBSERVE_MS = 1_500;

interface SSEFrame {
  event: string;
  data: string;
}

/**
 * A live SSE subscription, read by a background pump into a buffer.
 *
 * Deliberately NOT the race-a-generator-against-a-timeout shape the older
 * realtime specs use: that shape leaves the losing `for await` running, so it
 * can swallow the very frame a later negative assertion is about. Buffering
 * every frame instead means "nothing arrived" is a statement about the buffer,
 * and the frame that would have falsified it cannot go missing.
 */
class Subscription {
  readonly frames: SSEFrame[] = [];
  /** Set when the server closed the stream (as opposed to the client aborting). */
  closed = false;

  private constructor(
    private readonly res: Response,
    private readonly ac: AbortController,
    readonly label: string,
  ) {}

  static async open(
    h: TestHarness,
    channel: string,
    token: string,
    label: string,
  ): Promise<Subscription> {
    const ac = new AbortController();
    const res = await h.app.fetch(
      new Request(`http://localhost:5173/api/realtime/${channel}/subscribe`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ac.signal,
      }),
    );
    if (res.status !== 200) {
      throw new Error(
        `subscribe as ${label} failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
    const sub = new Subscription(res, ac, label);
    void sub.pump();
    const ready = await sub.waitFor((f) => f.event === "ready", OBSERVE_MS);
    if (!ready) {
      sub.abort();
      throw new Error(`no ready frame for ${label}`);
    }
    return sub;
  }

  private async pump(): Promise<void> {
    if (!this.res.body) throw new Error("response has no body");
    const reader = this.res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // `: ping` comment frames carry no event — skip them, but they are
          // proof the heartbeat (and therefore the refresh) is running.
          if (!block || block.startsWith(":")) continue;
          let event = "message";
          let data = "";
          for (const raw of block.split("\n")) {
            if (raw.startsWith("event:")) event = raw.slice(6).trim();
            else if (raw.startsWith("data:")) {
              data += (data ? "\n" : "") + raw.slice(5).trimStart();
            }
          }
          this.frames.push({ event, data });
        }
      }
    } catch {
      // aborted by the client, or the socket went away — either way we're done.
    } finally {
      this.closed = true;
    }
  }

  /** Resolve as soon as some buffered frame matches, else after `ms`. */
  async waitFor(
    predicate: (f: SSEFrame) => boolean,
    ms: number,
  ): Promise<SSEFrame | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.frames.find(predicate);
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** Frames carrying an item event for `itemId`, whatever their kind. */
  messagesFor(itemId: string): SSEFrame[] {
    return this.frames.filter(
      (f) => f.event === "message" && f.data.includes(itemId),
    );
  }

  abort(): void {
    this.ac.abort();
  }
}

/** Admin-invite an end-user into the default workspace and accept, returning
 *  the app-plane bearer the SDK would hold. */
const makeEndUser = async (
  h: TestHarness,
  email: string,
): Promise<{ id: string; token: string }> => {
  const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
  expect(invited.status, `invite ${email}`).toBe(201);
  const { data } = (await invited.json()) as { data: { id: string; token: string } };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "refresh-pass-12345" }),
  );
  expect(accepted.status, `accept invite for ${email}`).toBe(200);
  const session = (await accepted.json()) as { token: string };
  return { id: data.id, token: session.token };
};

const roleIdByName = async (h: TestHarness, name: string): Promise<string> => {
  const res = await h.fetch("/api/roles");
  expect(res.status).toBe(200);
  const roles = ((await res.json()) as { data: { id: string; name: string }[] }).data;
  const role = roles.find((r) => r.name === name);
  expect(role, `role "${name}" should exist`).toBeDefined();
  return role!.id;
};

describe("realtime — a held subscription re-resolves its subscriber", () => {
  let h: TestHarness;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let acme: string;
  let permissionId: string;

  const slug = "tickets";
  const channel = `items:${slug}`;

  /** Insert a ticket belonging to `acme` as the workspace admin, and return
   *  its id. Publishing through the real write path is what puts the event on
   *  the channel. */
  const publishTicket = async (title: string): Promise<string> => {
    const res = await h.fetch(
      `/api/items/${slug}`,
      json("POST", { title, org_id: acme }),
    );
    expect(res.status, `create ticket "${title}"`).toBe(201);
    const { data } = (await res.json()) as { data: { id: unknown } };
    return String(data.id);
  };

  beforeAll(async () => {
    __setRealtimeHeartbeatMs(TEST_HEARTBEAT_MS);
    h = makeHarness();
    await seedAdmin(h);

    const created = await h.fetch(
      "/api/collections",
      json("POST", {
        slug,
        fields: [
          { name: "title", type: "text" },
          { name: "org_id", type: "text" },
        ],
      }),
    );
    expect(created.status).toBe(201);

    // Every end-user may read tickets — but only their ACTIVE org's. This is
    // the rule whose variables the frozen subject used to answer forever.
    const authRoleId = await roleIdByName(h, "authenticated");
    const granted = await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json("POST", {
        collection: slug,
        action: "read",
        condition: { org_id: { _eq: "$org.id" } },
      }),
    );
    expect(granted.status).toBeLessThan(300);
    permissionId = ((await granted.json()) as { data: { id: string } }).data.id;

    alice = await makeEndUser(h, "alice@refresh.test");
    bob = await makeEndUser(h, "bob@refresh.test");

    const org = await h.fetch(
      "/api/app-orgs",
      json("POST", { name: "Acme", ownerAppUserId: alice.id }),
    );
    expect(org.status).toBe(201);
    acme = ((await org.json()) as { data: { id: string } }).data.id;

    const added = await h.fetch(
      `/api/app-orgs/${acme}/members`,
      json("POST", { appUserId: bob.id, role: "member" }),
    );
    expect(added.status, "add bob to Acme").toBe(201);
  });

  afterAll(() => {
    __setRealtimeHeartbeatMs(null);
    h.cleanup();
  });

  test("removing a member stops their stream, and only theirs", async () => {
    const aliceSub = await Subscription.open(h, channel, alice.token, "alice");
    const bobSub = await Subscription.open(h, channel, bob.token, "bob");
    try {
      // ── the positive state, first ──────────────────────────────────────
      // Both hold exactly one org membership, so `$org.id` resolves to Acme
      // without any header, and the rule admits this row for both of them. If
      // this half ever stops holding, the negative half below is vacuous.
      const before = await publishTicket("visible to both");
      expect(
        await aliceSub.waitFor((f) => f.data.includes(before), OBSERVE_MS),
        "alice should receive an Acme ticket while she is in Acme",
      ).not.toBeNull();
      expect(
        await bobSub.waitFor((f) => f.data.includes(before), OBSERVE_MS),
        "bob should receive an Acme ticket while he is in Acme",
      ).not.toBeNull();

      // ── offboard bob ───────────────────────────────────────────────────
      const removed = await h.fetch(
        `/api/app-orgs/${acme}/members/${bob.id}`,
        json("DELETE"),
      );
      expect(removed.status, "remove bob from Acme").toBe(200);

      // Give the heartbeat a couple of beats to re-resolve. Nothing else on the
      // connection can do it — that is the whole point of the fix.
      await new Promise((r) => setTimeout(r, TEST_HEARTBEAT_MS * 4));

      const after = await publishTicket("acme only, after the removal");
      expect(
        await aliceSub.waitFor((f) => f.data.includes(after), OBSERVE_MS),
        "alice is still in Acme and must still receive its rows",
      ).not.toBeNull();

      // Bob's subject has been re-resolved to "member of no org", so `$org.id`
      // is null, the rule compiles to false, and the row is dropped for him.
      expect(bobSub.messagesFor(after)).toEqual([]);

      // He is still connected and still permitted on the channel — the read
      // grant itself was never revoked — so the honest outcome is an open
      // stream that delivers nothing, not a disconnect.
      expect(bobSub.frames.some((f) => f.event === "revoked")).toBe(false);
      expect(bobSub.closed).toBe(false);
    } finally {
      aliceSub.abort();
      bobSub.abort();
    }
  });

  test("losing the read permission closes the stream with a `revoked` frame", async () => {
    const sub = await Subscription.open(h, channel, alice.token, "alice");
    try {
      const before = await publishTicket("delivered while the grant stands");
      expect(
        await sub.waitFor((f) => f.data.includes(before), OBSERVE_MS),
        "the subscription must be delivering before the grant is revoked",
      ).not.toBeNull();

      const revoked = await h.fetch(`/api/permissions/${permissionId}`, {
        method: "DELETE",
      });
      expect(revoked.status, "revoke the read grant").toBe(200);

      // A subscriber who may no longer read the collection AT ALL is told so
      // and disconnected. Silently delivering nothing would look exactly like
      // an idle feed, and the client would sit on a dead subscription.
      const frame = await sub.waitFor((f) => f.event === "revoked", OBSERVE_MS);
      expect(frame, "the stream should announce the revocation").not.toBeNull();
      expect(frame!.data.length).toBeGreaterThan(0);

      const deadline = Date.now() + OBSERVE_MS;
      while (!sub.closed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(sub.closed, "the server should close the stream after revoking").toBe(true);
    } finally {
      sub.abort();
    }
  });
});
