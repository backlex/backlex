import { describe, expect, test } from "bun:test";
import * as sqlite from "@backlex/db/sqlite";
import { eq } from "drizzle-orm";
import { buildContext } from "../src/server/context";
import { createAppUserInvite } from "../src/server/services/app-user-invites";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * `POST /api/t/:slug/auth/invite/accept` must not become a password reset.
 *
 * The endpoint is PUBLIC and authenticates nothing but possession of an invite
 * token. It used to write whatever password it was handed onto the account the
 * token names — including an account that had already finished signing up and
 * had a working credential. Anyone holding a live token could therefore take
 * over that account without ever proving they knew its password: an invite
 * link is forwarded, screenshotted, left in a mailbox, and read out of a
 * backup, so "holds the token" is a much wider set than "is the invitee".
 *
 * The accept PAGE guards this — its `existing` mode verifies the current
 * password before submitting — but that check runs in a browser an attacker
 * simply does not use. So the property is pinned here, at the endpoint.
 *
 * Reaching the state needs a second live token for an already-active row.
 * Nothing in the product mints one TODAY (`inviteAppUser` refuses a duplicate
 * address, and accept consumes the token it used), which is exactly why this
 * is worth a test rather than a comment: the conflict reason `already_invited`
 * that this branch added is documented as "re-send it", so the first resend
 * surface built on top of it makes the state reachable in production. The test
 * calls `createAppUserInvite` directly to stand where that surface will.
 */

const JSON_HEADERS = { "content-type": "application/json" };

const ORIGINAL = "original-password-1";
const ATTACKER = "attacker-password-9";

const inviteVia = async (h: TestHarness, email: string) => {
  const res = await h.fetch("/api/app-users/invite", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    data: { id: string; email: string; token: string };
  };
  return body.data;
};

const accept = (h: TestHarness, token: string, password: string) =>
  h.app.request("/api/t/default/auth/invite/accept", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, password }),
  });

const signIn = (h: TestHarness, email: string, password: string) =>
  h.app.request("/api/t/default/auth/sign-in/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password }),
  });

describe("invite accept is not a password reset", () => {
  test("a second live token cannot overwrite a credential the account already has", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const inv = await inviteVia(h, "ada@x.test");

      // 1. The invitee accepts honestly and now has a working credential.
      expect((await accept(h, inv.token, ORIGINAL)).status).toBe(200);
      expect((await signIn(h, "ada@x.test", ORIGINAL)).status).toBe(200);

      // 2. A second token is minted for that same, now-active row — the state
      //    a resend surface produces.
      const built = await buildContext(h.env);
      const dbCtx = { db: built.db, dialect: built.dialect };
      const rows = (await (built.db as any)
        .select({ id: sqlite.schema.tenants.id })
        .from(sqlite.schema.tenants)
        .where(eq(sqlite.schema.tenants.slug, "default"))
        .limit(1)) as Array<{ id: string }>;
      const tenantId = rows[0]!.id;
      const second = await createAppUserInvite(
        dbCtx,
        tenantId,
        inv.id,
        "ada@x.test",
      );
      expect(second.token).not.toBe(inv.token);

      // 3. Whoever holds it may complete the invitation — that is what an
      //    invitation is for — but the credential is NOT theirs to set.
      const res = await accept(h, second.token, ATTACKER);
      expect(res.status).toBe(200);

      // 4. The proof is behavioural, not a field read: the original password
      //    still signs in, and the one just submitted does not. A 2xx that
      //    quietly did the wrong thing is this codebase's signature bug, so
      //    the assertion goes through the real sign-in path.
      expect((await signIn(h, "ada@x.test", ORIGINAL)).status).toBe(200);
      expect((await signIn(h, "ada@x.test", ATTACKER)).status).not.toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("a first-time invitee still sets their own password", async () => {
    // The guard above must not be so wide that it breaks the flow it protects:
    // an `invited` row has no credential yet, and accept is the only place one
    // gets written. Without this, a guard that refused every write would look
    // green on the test above while making every invitation unusable.
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const inv = await inviteVia(h, "bob@x.test");
      expect((await accept(h, inv.token, ORIGINAL)).status).toBe(200);
      expect((await signIn(h, "bob@x.test", ORIGINAL)).status).toBe(200);
    } finally {
      h.cleanup();
    }
  });
});
