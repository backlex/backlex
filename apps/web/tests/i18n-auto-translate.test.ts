/**
 * AI auto-translate — the mocked HAPPY path of
 * `services/i18n-translate.ts::autoTranslateBatch` through
 * `POST /api/admin/i18n/_auto-translate`.
 *
 * The service now generates through the shared `callClaude` path (AI SDK), so
 * with a direct-Anthropic workspace key the OUTBOUND request is the AI SDK's
 * POST to `https://api.anthropic.com/v1/messages` on the GLOBAL fetch. The
 * harness's `h.fetch` invokes the Hono app in-process (`app.fetch`), so it never
 * touches `globalThis.fetch` — only that outbound call hits the mock installed
 * here. The mock passes any other URL through to the real fetch and is restored
 * in a `finally` on every test.
 *
 * The no-AI-config error path is covered in i18n-admin-catalog.test.ts and is
 * deliberately NOT asserted here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BYO_KEY = "sk-ant-test-byo-key";

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

interface AnthropicCall {
  headers: Record<string, string>;
  body: {
    model: string;
    /** The AI SDK sends `system` as an array of text blocks; the raw API also
     *  accepts a plain string. Normalized by {@link systemText}. */
    system: string | { type: string; text?: string }[];
    messages: { role: string; content: string | { type: string; text?: string }[] }[];
  };
}

/** Flatten a system field that may be a string or an array of text blocks. */
const systemText = (body: AnthropicCall["body"]): string =>
  typeof body.system === "string"
    ? body.system
    : body.system.map((b) => b.text ?? "").join("\n");

/** Flatten the first user message's content (string or content-part array). */
const userText = (body: AnthropicCall["body"]): string => {
  const c = body.messages[0]?.content;
  if (typeof c === "string") return c;
  return (c ?? []).map((p) => p.text ?? "").join("\n");
};

/** A complete Anthropic Messages response — the AI SDK validates the envelope,
 *  so a bare `{content:[…]}` would fail parsing before our code ever sees it. */
const anthropicReply = (text: string): Response =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/**
 * Intercept ONLY calls to api.anthropic.com on the global fetch; everything
 * else falls through to the real fetch. Returns the recorded calls and a
 * restore handle (call it in `finally`).
 */
const installAnthropicMock = (
  respond: (call: AnthropicCall) => Response,
): { calls: AnthropicCall[]; restore: () => void } => {
  const real = globalThis.fetch;
  const calls: AnthropicCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.anthropic.com/")) {
      const call: AnthropicCall = {
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)) as AnthropicCall["body"],
      };
      calls.push(call);
      return respond(call);
    }
    return real(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
};

/**
 * A canned "model" that reads the numbered source strings out of the request's
 * user message and answers `{"1": …, "2": …}` from a source→translation dict —
 * robust to whatever order the route enumerates keys in.
 */
const translatorRespond =
  (dict: Record<string, string>, wrap: (json: string) => string = (j) => j) =>
  (call: AnthropicCall): Response => {
    const user = userText(call.body);
    const out: Record<string, string> = {};
    for (const line of user.split("\n")) {
      const m = line.match(/^(\d+)\. (".*")$/);
      if (!m) continue;
      const src = JSON.parse(m[2] as string) as string;
      out[m[1] as string] = dict[src] ?? `UNTRANSLATED:${src}`;
    }
    return anthropicReply(wrap(JSON.stringify(out)));
  };

interface I18nListResponse {
  data: { id: string; key: string; locale: string; value: string }[];
}

const listRows = async (h: TestHarness) =>
  ((await (await h.fetch("/api/admin/i18n")).json()) as I18nListResponse).data;

describe("POST /api/admin/i18n/_auto-translate (mocked Anthropic)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    // No ANTHROPIC_API_KEY in env — the key comes from the workspace BYO AI
    // config (Settings → AI), exercising the resolveAiOverride path.
    h = makeHarness();
    await seedAdmin(h);
    const cfg = await h.fetch("/api/admin/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        secrets: { anthropicKey: BYO_KEY },
      }),
    });
    expect(cfg.status).toBe(200);

    // Seed the source catalog: two untranslated keys + one that already has a
    // German value (must be skipped by the default onlyMissing:true).
    const bulk = await h.fetch("/api/admin/i18n/_bulk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { key: "nav.home", locale: "en", value: "Home" },
        { key: "nav.save", locale: "en", value: "Save" },
        { key: "nav.cancel", locale: "en", value: "Cancel" },
        { key: "nav.cancel", locale: "de", value: "Abbrechen" },
      ]),
    });
    expect(bulk.status).toBe(200);
  });
  afterEach(() => h.cleanup());

  test("translates missing keys and upserts them into the catalog with the right key/locale mapping", async () => {
    const mock = installAnthropicMock(
      translatorRespond({ Home: "Startseite", Save: "Speichern" }),
    );
    try {
      const res = await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        translated: number;
        remaining?: number;
        rows: { key: string; locale: string; value: string }[];
      };
      expect(body.ok).toBe(true);
      // nav.cancel already has a de value → onlyMissing skips it.
      expect(body.translated).toBe(2);
      expect(body.remaining).toBe(0);
      const byKey = Object.fromEntries(body.rows.map((r) => [r.key, r]));
      expect(byKey["nav.home"]).toMatchObject({ locale: "de", value: "Startseite" });
      expect(byKey["nav.save"]).toMatchObject({ locale: "de", value: "Speichern" });

      // Exactly one outbound model call, authorized with the BYO key
      // (decrypted from the ai-config row, NOT the env).
      expect(mock.calls.length).toBe(1);
      const call = mock.calls[0] as AnthropicCall;
      expect(call.headers["x-api-key"]).toBe(BYO_KEY);
      expect(call.headers["anthropic-version"]).toBe("2023-06-01");
      expect(call.body.model).toBe("claude-haiku-4-5-20251001");
      expect(systemText(call.body)).toContain("from en to de");

      // The translations actually landed in the catalog.
      const rows = await listRows(h);
      const de = rows.filter((r) => r.locale === "de");
      expect(de.find((r) => r.key === "nav.home")?.value).toBe("Startseite");
      expect(de.find((r) => r.key === "nav.save")?.value).toBe("Speichern");
      // The pre-existing translation was left untouched.
      expect(de.find((r) => r.key === "nav.cancel")?.value).toBe("Abbrechen");
    } finally {
      mock.restore();
    }
  });

  test("a fully-translated target locale is a no-op — no model call at all", async () => {
    const first = installAnthropicMock(
      translatorRespond({ Home: "Startseite", Save: "Speichern" }),
    );
    try {
      await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(first.calls.length).toBe(1);

      // Second top-up run: everything already has a de value.
      const res = await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; translated: number; rows: unknown[] };
      expect(body.ok).toBe(true);
      expect(body.translated).toBe(0);
      expect(body.rows).toEqual([]);
      expect(first.calls.length).toBe(1); // still just the first call
    } finally {
      first.restore();
    }
  });

  test("tolerates a code-fenced JSON model response", async () => {
    const mock = installAnthropicMock(
      translatorRespond(
        { Home: "Startseite", Save: "Speichern" },
        (j) => "```json\n" + j + "\n```",
      ),
    );
    try {
      const res = await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { translated: number };
      expect(body.translated).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("a malformed (non-JSON) model response fails cleanly and writes nothing", async () => {
    const mock = installAnthropicMock(() =>
      anthropicReply("Sure! Here are the translations: Startseite …"),
    );
    try {
      const res = await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INTERNAL");
      expect(body.error.message).toContain("malformed JSON");

      // Nothing was upserted.
      const rows = await listRows(h);
      const de = rows.filter((r) => r.locale === "de").map((r) => r.key);
      expect(de).toEqual(["nav.cancel"]);
    } finally {
      mock.restore();
    }
  });

  test("slots the model omits are dropped — never written as source text — and retried next run", async () => {
    // The model answers only the "Home" slot and silently omits "Save".
    // Regression: the old fallback filled omitted slots with the SOURCE value,
    // so the English string got upserted as the German "translation" and
    // onlyMissing never retried it.
    const partial = installAnthropicMock((call) => {
      const user = userText(call.body);
      const out: Record<string, string> = {};
      for (const line of user.split("\n")) {
        const m = line.match(/^(\d+)\. (".*")$/);
        if (!m) continue;
        if ((JSON.parse(m[2] as string) as string) === "Home") {
          out[m[1] as string] = "Startseite";
        }
      }
      return anthropicReply(JSON.stringify(out));
    });
    try {
      const res = await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { translated: number; rows: { key: string }[] };
      expect(body.translated).toBe(1);
      expect(body.rows.map((r) => r.key)).toEqual(["nav.home"]);

      // nav.save has NO de row at all — in particular not the English "Save".
      const de = (await listRows(h)).filter((r) => r.locale === "de");
      expect(de.find((r) => r.key === "nav.save")).toBeUndefined();
      expect(de.find((r) => r.key === "nav.home")?.value).toBe("Startseite");
    } finally {
      partial.restore();
    }

    // A follow-up run with a model that answers everything picks the key up.
    const full = installAnthropicMock(translatorRespond({ Save: "Speichern" }));
    try {
      const res = await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { translated: number }).translated).toBe(1);
      const de = (await listRows(h)).filter((r) => r.locale === "de");
      expect(de.find((r) => r.key === "nav.save")?.value).toBe("Speichern");
    } finally {
      full.restore();
    }
  });

  test("valid JSON that isn't an object (null) is rejected as malformed, not a TypeError", async () => {
    const mock = installAnthropicMock(() => anthropicReply("null"));
    try {
      const res = await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INTERNAL");
      expect(body.error.message).toContain("malformed JSON");
    } finally {
      mock.restore();
    }
  });

  test("a provider HTTP error surfaces as a clean 503 AppError, not a crash", async () => {
    // 401 rather than 429: the AI SDK retries retryable statuses with backoff,
    // which would blow the test timeout without testing anything extra.
    const mock = installAnthropicMock(
      () =>
        new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const res = await h.fetch(
        "/api/admin/i18n/_auto-translate",
        postJson({ targetLocale: "de", sourceLocale: "en" }),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("UNAVAILABLE");
      expect(body.error.message).toContain("AI provider call failed (anthropic");
    } finally {
      mock.restore();
    }
  });
});
