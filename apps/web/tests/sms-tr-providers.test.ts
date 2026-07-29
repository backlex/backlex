/**
 * NetGSM + İleti Merkezi SMS adapters.
 *
 * The edges that matter here are not "does a happy send work" but:
 *  - a provider-level rejection must be counted as `failed`, never thrown —
 *    a throw would abort the whole fan-out (`sendSmsToUsers`) mid-batch;
 *  - only *number-level* rejections may land in `invalidNumbers`, because that
 *    array is what deactivates rows in `phone_numbers`. Mapping an account-level
 *    code (bad password, unapproved sender header, no balance) into it would
 *    silently wipe a workspace's phone book on one config mistake;
 *  - the credential must be encrypted at rest and never come back out of the
 *    read route, while still decrypting into the real outgoing request.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { iletimerkeziSms } from "../src/server/adapters/sms.iletimerkezi";
import { netgsmSms } from "../src/server/adapters/sms.netgsm";
import { selectSmsSpec } from "../src/server/lib/sms-select";
import type { Env } from "../src/server/env";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

/** Stub `fetch`, recording every call and answering with `reply(callIndex)`. */
const stubFetch = (reply: (i: number, url: string) => Response): Captured[] => {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body == null ? null : String(init.body),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return reply(calls.length - 1, url);
  }) as typeof fetch;
  return calls;
};

const text = (body: string, status = 200) => new Response(body, { status });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NETGSM = { usercode: "8501234567", password: "panel-pw", msgheader: "MYCOMPANY" };
const ILETI = { key: "api-key", hash: "api-hash", sender: "MYCOMPANY" };

const ok = (body: unknown) => ({
  response: { status: { code: 200, message: "İşlem başarılı" }, order: { id: "1" }, echo: body },
});

describe("netgsm SMS adapter", () => {
  test("sends one GET per recipient with the documented query params", async () => {
    const calls = stubFetch(() => text("00 1234567"));
    const res = await netgsmSms(NETGSM).send({
      to: ["+905321234567", "+905331234567"],
      body: "merhaba",
    });

    expect(res).toEqual({ sent: 2, failed: 0, invalidNumbers: [] });
    expect(calls).toHaveLength(2);
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://api.netgsm.com.tr/sms/send/get");
    expect(u.searchParams.get("usercode")).toBe("8501234567");
    expect(u.searchParams.get("password")).toBe("panel-pw");
    expect(u.searchParams.get("msgheader")).toBe("MYCOMPANY");
    expect(u.searchParams.get("message")).toBe("merhaba");
    // E.164 "+" is stripped — NetGSM wants the bare msisdn.
    expect(u.searchParams.get("gsmno")).toBe("905321234567");
    expect(new URL(calls[1]!.url).searchParams.get("gsmno")).toBe("905331234567");
  });

  test("`from` overrides the configured message header", async () => {
    const calls = stubFetch(() => text("00 1"));
    await netgsmSms(NETGSM).send({ to: ["+905321234567"], body: "x", from: "OTHERHDR" });
    expect(new URL(calls[0]!.url).searchParams.get("msgheader")).toBe("OTHERHDR");
  });

  test("an account-level error code counts as failed and does NOT prune the number", async () => {
    // 30 = bad credentials / API access denied, 40 = unknown msgheader,
    // 50 = IYS restriction, 85 = duplicate-send limit, 100 = system error.
    for (const code of ["20", "30", "40", "50", "51", "80", "85", "100"]) {
      stubFetch(() => text(code));
      const res = await netgsmSms(NETGSM).send({ to: ["+905321234567"], body: "x" });
      expect(res).toEqual({ sent: 0, failed: 1, invalidNumbers: [] });
    }
  });

  test("code 70 marks that one number invalid, leaving its siblings alone", async () => {
    stubFetch((i) => text(i === 1 ? "70" : "00 1234567"));
    const res = await netgsmSms(NETGSM).send({
      to: ["+905321234567", "+900000000000", "+905331234567"],
      body: "x",
    });
    expect(res.sent).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.invalidNumbers).toEqual(["+900000000000"]);
  });

  test("HTTP 200 with an unrecognised body is a failure, not a success", async () => {
    // NetGSM answers 200 even for errors, so the status code alone must never
    // be treated as delivery.
    stubFetch(() => text("<html>maintenance</html>"));
    const res = await netgsmSms(NETGSM).send({ to: ["+905321234567"], body: "x" });
    expect(res).toEqual({ sent: 0, failed: 1, invalidNumbers: [] });
  });

  test("a non-2xx response and a network throw both resolve as failed", async () => {
    stubFetch(() => text("bad gateway", 502));
    expect(await netgsmSms(NETGSM).send({ to: ["+905321234567"], body: "x" })).toEqual({
      sent: 0,
      failed: 1,
      invalidNumbers: [],
    });

    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    // Must resolve, not reject: one dead socket may not abort the whole batch.
    expect(await netgsmSms(NETGSM).send({ to: ["+905321234567"], body: "x" })).toEqual({
      sent: 0,
      failed: 1,
      invalidNumbers: [],
    });
  });

  test("an empty recipient list makes no request at all", async () => {
    const calls = stubFetch(() => text("00 1"));
    expect(await netgsmSms(NETGSM).send({ to: [], body: "x" })).toEqual({
      sent: 0,
      failed: 0,
      invalidNumbers: [],
    });
    expect(calls).toHaveLength(0);
  });
});

describe("iletimerkezi SMS adapter", () => {
  test("posts the documented JSON envelope, one order per recipient", async () => {
    const calls = stubFetch(() => json(ok(null)));
    const res = await iletimerkeziSms(ILETI).send({
      to: ["+905321234567", "+905331234567"],
      body: "merhaba",
    });

    expect(res).toEqual({ sent: 2, failed: 0, invalidNumbers: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.iletimerkezi.com/v1/send-sms/json");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");

    const sent = JSON.parse(calls[0]!.body!) as any;
    expect(sent.request.authentication).toEqual({ key: "api-key", hash: "api-hash" });
    expect(sent.request.order.sender).toBe("MYCOMPANY");
    expect(sent.request.order.message.text).toBe("merhaba");
    // The API's own (misspelled) recipient key — regressing it would silently
    // drop every recipient.
    expect(sent.request.order.message.receipents.number).toEqual(["905321234567"]);
    expect(
      (JSON.parse(calls[1]!.body!) as any).request.order.message.receipents.number,
    ).toEqual(["905331234567"]);
  });

  test("`from` overrides the configured sender title", async () => {
    const calls = stubFetch(() => json(ok(null)));
    await iletimerkeziSms(ILETI).send({ to: ["+905321234567"], body: "x", from: "OTHER" });
    expect((JSON.parse(calls[0]!.body!) as any).request.order.sender).toBe("OTHER");
  });

  test("account-level status codes count as failed without pruning the number", async () => {
    // 401/402 credentials, 403 no balance, 404 unapproved sender, 410 blocked.
    for (const code of [400, 401, 402, 403, 404, 406, 407, 410]) {
      stubFetch(() => json({ response: { status: { code, message: "hata" } } }));
      const res = await iletimerkeziSms(ILETI).send({ to: ["+905321234567"], body: "x" });
      expect(res).toEqual({ sent: 0, failed: 1, invalidNumbers: [] });
    }
  });

  test("status 405 marks only that recipient invalid", async () => {
    stubFetch((_i, _url) => json({ response: { status: { code: 405 } } }));
    const res = await iletimerkeziSms(ILETI).send({ to: ["+900000000000"], body: "x" });
    expect(res).toEqual({ sent: 0, failed: 1, invalidNumbers: ["+900000000000"] });
  });

  test("a string status code is accepted (the API is loose about types)", async () => {
    stubFetch(() => json({ response: { status: { code: "200" } } }));
    expect((await iletimerkeziSms(ILETI).send({ to: ["+905321234567"], body: "x" })).sent).toBe(1);
  });

  test("HTTP 200 carrying a non-200 status code is not a success", async () => {
    stubFetch(() => json({ response: { status: { code: 401 } } }, 200));
    expect(await iletimerkeziSms(ILETI).send({ to: ["+905321234567"], body: "x" })).toEqual({
      sent: 0,
      failed: 1,
      invalidNumbers: [],
    });
  });

  test("unparsable body and network throw both resolve as failed", async () => {
    stubFetch(() => text("not json", 500));
    expect(await iletimerkeziSms(ILETI).send({ to: ["+905321234567"], body: "x" })).toEqual({
      sent: 0,
      failed: 1,
      invalidNumbers: [],
    });

    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    expect(await iletimerkeziSms(ILETI).send({ to: ["+905321234567"], body: "x" })).toEqual({
      sent: 0,
      failed: 1,
      invalidNumbers: [],
    });
  });

  test("an empty recipient list makes no request at all", async () => {
    const calls = stubFetch(() => json(ok(null)));
    expect(await iletimerkeziSms(ILETI).send({ to: [], body: "x" })).toEqual({
      sent: 0,
      failed: 0,
      invalidNumbers: [],
    });
    expect(calls).toHaveLength(0);
  });
});

describe("deployment-env selection", () => {
  const base = { APP_URL: "http://x", AUTH_SECRET: "s" } as unknown as Env;

  test("SMS_PROVIDER=netgsm picks it up from env", () => {
    const spec = selectSmsSpec({
      ...base,
      SMS_PROVIDER: "netgsm",
      NETGSM_USERCODE: "u",
      NETGSM_PASSWORD: "p",
      NETGSM_MSGHEADER: "H",
    });
    expect(spec).toEqual({ provider: "netgsm", usercode: "u", password: "p", msgheader: "H" });
  });

  test("a forced provider with incomplete credentials degrades to console", () => {
    const spec = selectSmsSpec({
      ...base,
      SMS_PROVIDER: "iletimerkezi",
      ILETIMERKEZI_KEY: "k",
      // hash + sender missing
    });
    expect(spec).toEqual({ provider: "console" });
  });

  test("auto-detect falls through to the TR providers when twilio/sns are unset", () => {
    expect(
      selectSmsSpec({
        ...base,
        ILETIMERKEZI_KEY: "k",
        ILETIMERKEZI_HASH: "h",
        ILETIMERKEZI_SENDER: "S",
      }),
    ).toEqual({ provider: "iletimerkezi", key: "k", hash: "h", sender: "S" });
  });
});

describe("workspace sms_config for the TR providers", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const put = (body: unknown) =>
    h.fetch("/api/admin/sms-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("netgsm credentials are encrypted at rest and masked on read", async () => {
    expect(
      (
        await put({
          provider: "netgsm",
          config: { usercode: "8501234567", msgheader: "MYCOMPANY" },
          secrets: { password: "panel-pw-plaintext" },
        })
      ).status,
    ).toBe(200);

    // Masked on read: only a boolean "is it set", never the value or ciphertext.
    const cfg = (await (await h.fetch("/api/admin/sms-config")).json()) as {
      data: { provider: string; config: Record<string, unknown>; secretsSet: Record<string, boolean> };
    };
    expect(cfg.data.provider).toBe("netgsm");
    expect(cfg.data.config.usercode).toBe("8501234567");
    expect(cfg.data.secretsSet.password).toBe(true);
    expect(JSON.stringify(cfg.data)).not.toContain("panel-pw-plaintext");

    // Encrypted at rest: the raw column must not hold the plaintext either.
    const raw = new Database(h.env.SQLITE_PATH!, { readonly: true });
    try {
      const row = raw.query("SELECT provider, config, secrets FROM sms_config").get() as {
        provider: string;
        config: string;
        secrets: string;
      };
      expect(row.provider).toBe("netgsm");
      expect(row.secrets).not.toContain("panel-pw-plaintext");
      expect(JSON.parse(row.secrets).password).toBeTruthy();
      // …and the plaintext must not have leaked into the non-secret blob.
      expect(row.config).not.toContain("panel-pw-plaintext");
    } finally {
      raw.close();
    }
  });

  test("iletimerkezi hash is encrypted at rest and masked on read", async () => {
    await put({
      provider: "iletimerkezi",
      config: { key: "api-key", sender: "MYCOMPANY" },
      secrets: { hash: "api-hash-plaintext" },
    });
    const cfg = (await (await h.fetch("/api/admin/sms-config")).json()) as {
      data: { secretsSet: Record<string, boolean> };
    };
    expect(cfg.data.secretsSet.hash).toBe(true);
    expect(JSON.stringify(cfg.data)).not.toContain("api-hash-plaintext");

    const raw = new Database(h.env.SQLITE_PATH!, { readonly: true });
    try {
      const row = raw.query("SELECT secrets FROM sms_config").get() as { secrets: string };
      expect(row.secrets).not.toContain("api-hash-plaintext");
    } finally {
      raw.close();
    }
  });

  test("the stored secret decrypts back into the real outgoing request", async () => {
    await put({
      provider: "netgsm",
      config: { usercode: "8501234567", msgheader: "MYCOMPANY" },
      secrets: { password: "panel-pw-plaintext" },
    });

    const calls = stubFetch(() => text("00 1234567"));
    const res = await h.fetch("/api/admin/sms-config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+905321234567" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ ok: true, sent: 1 });

    const netgsmCall = calls.find((c) => c.url.startsWith("https://api.netgsm.com.tr/"));
    expect(netgsmCall).toBeTruthy();
    const u = new URL(netgsmCall!.url);
    expect(u.searchParams.get("password")).toBe("panel-pw-plaintext");
    expect(u.searchParams.get("usercode")).toBe("8501234567");
  });

  test("an incomplete stored config falls back instead of failing the send", async () => {
    // msgheader missing → `specFromRow` returns null → deployment default
    // (console here), so the send still succeeds rather than 500-ing.
    await put({
      provider: "netgsm",
      config: { usercode: "8501234567" },
      secrets: { password: "pw" },
    });
    const calls = stubFetch(() => text("00 1"));
    const res = await h.fetch("/api/admin/sms-config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "+905321234567" }),
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.includes("netgsm.com.tr"))).toBe(false);
  });

  test("an unknown provider id is rejected by the PUT schema", async () => {
    expect((await put({ provider: "netgsm-typo", config: {} })).status).toBe(422);
  });

  test("a non-admin cannot read or write the TR provider credentials", async () => {
    const anon = makeHarness();
    try {
      expect((await anon.fetch("/api/admin/sms-config")).status).toBe(401);
      expect(
        (
          await anon.fetch("/api/admin/sms-config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "netgsm", secrets: { password: "x" } }),
          })
        ).status,
      ).toBe(401);
    } finally {
      anon.cleanup();
    }
  });
});
