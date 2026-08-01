/**
 * E-signature — the document, the people who sign it, and the evidence.
 *
 * The renderer is somebody else's browser, so what is pinned here is
 * everything around it. In rough order of how much it costs to get wrong:
 *
 * - the document is FROZEN at send time, so editing the template afterwards
 *   cannot change what a signer already read;
 * - a signature image is parsed rather than trusted — it ends up interpolated
 *   into HTML a browser is asked to render;
 * - the token is the only grant, so voiding and resending must actually
 *   invalidate the link rather than rely on a status check somewhere;
 * - signing is one-shot, and expiry happens by the clock rather than by
 *   something remembering to run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  buildSignedHtml,
  parseSignatureImage,
  effectiveStatus,
  type SignatureRequestRow,
  type SignatureSignerRow,
} from "../src/server/services/signatures";

const BASE = "/api/admin/signatures";
const PUBLIC = "/api/public/sign";
const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% fake\n");

/** A 1×1 transparent PNG — the smallest thing that survives the parser. */
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let h: TestHarness;
let client: Database;
let rendered: string[];
let emails: string[];
let restoreLog: typeof console.log;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await h.fetch(path, json(method, body));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  rendered = [];
  emails = [];
  restoreLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[email]")) emails.push(line);
  };
  // The dev context has no renderer, which is the correct default. Everything
  // under test needs one, so it is patched onto the shared (memoized) Ctx.
  const { buildContext } = await import("../src/server/context");
  const ctx = (await buildContext(h.env)) as any;
  ctx.pdf = {
    name: "stub",
    render: async (html: string) => {
      rendered.push(html);
      return FAKE_PDF;
    },
  };
});
afterEach(() => {
  console.log = restoreLog;
  h.cleanup();
});

const create = (body: Record<string, unknown> = {}) =>
  ok("POST", BASE, {
    title: "Rental agreement",
    html: "<html><body><h1>Agreement for {{ data.tenant }}</h1></body></html>",
    vars: { data: { tenant: "Ayşe Yılmaz" } },
    signers: [{ email: "tenant@example.com", name: "Ayşe Yılmaz", role: "Tenant" }],
    ...body,
  });

describe("creating a request", () => {
  test("freezes the interpolated document and returns one link per signer", async () => {
    const { data } = await create();
    expect(data.request.status).toBe("pending");
    expect(data.links).toHaveLength(1);
    expect(data.links[0].url).toContain("/sign/sig_");
    expect(data.sent).toBe(true);

    // The unsigned PDF is rendered up front, from the INTERPOLATED body.
    expect(rendered[0]).toContain("Agreement for Ayşe Yılmaz");
    expect(data.request.documentKey).toMatch(/^documents\//);

    const full = await ok("GET", `${BASE}/${data.request.id}`);
    expect(full.data.bodyHtml).toContain("Ayşe Yılmaz");
    // The template's `{{ … }}` must not survive into the frozen copy — a
    // placeholder still in the snapshot is a document that renders differently
    // later.
    expect(full.data.bodyHtml).not.toContain("{{");
  });

  test("only the token HASH is stored", async () => {
    const { data } = await create();
    const token = data.links[0].url.split("/sign/")[1];
    const row = client
      .query("select token_hash as h from signature_signers where request_id = ?")
      .get(data.request.id) as { h: string };
    expect(row.h).not.toBe(token);
    expect(row.h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a later edit to the template does not change what was sent", async () => {
    await ok("PUT", "/api/admin/documents/templates/lease", {
      bodyHtml: "<html><body>v1 for {{ data.tenant }}</body></html>",
    });
    const { data } = await create({ templateKey: "lease", html: undefined });
    await ok("PUT", "/api/admin/documents/templates/lease", {
      bodyHtml: "<html><body>v2 — different terms</body></html>",
    });

    const full = await ok("GET", `${BASE}/${data.request.id}`);
    expect(full.data.bodyHtml).toContain("v1 for Ayşe Yılmaz");
    expect(full.data.bodyHtml).not.toContain("v2");
  });

  test("refuses both a template and inline html", async () => {
    const res = await h.fetch(
      BASE,
      json("POST", {
        templateKey: "lease",
        html: "<html>x</html>",
        signers: [{ email: "a@example.com" }],
      }),
    );
    expect(res.status).toBe(422);
  });

  test("refuses the same address twice", async () => {
    // Two links to one person is one signature counted twice, and an ordered
    // request would deadlock on a turn that already passed.
    const res = await h.fetch(
      BASE,
      json("POST", {
        html: "<html>x</html>",
        signers: [{ email: "a@example.com" }, { email: "A@example.com" }],
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/twice/i);
  });

  test("refuses an address that is not one", async () => {
    const res = await h.fetch(
      BASE,
      json("POST", { html: "<html>x</html>", signers: [{ email: "not-an-email" }] }),
    );
    expect(res.status).toBe(422);
  });

  test("with no renderer configured it refuses BEFORE anything is stored", async () => {
    // Discovering it after the signer has drawn their name is the worst moment
    // available; discovered here it is a message on a form.
    const { buildContext } = await import("../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    ctx.pdf = undefined;
    const res = await h.fetch(
      BASE,
      json("POST", { html: "<html>x</html>", signers: [{ email: "a@example.com" }] }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/PDF_CF_ACCOUNT_ID|PDF_GOTENBERG_URL/);
    expect(client.query("select count(*) as n from signature_requests").get()).toMatchObject({ n: 0 });
  });
});

describe("the signer's view", () => {
  const openLink = async () => {
    const { data } = await create();
    const token = data.links[0].url.split("/sign/")[1];
    return { token, id: data.request.id };
  };

  test("resolves the document and marks the link viewed", async () => {
    const { token, id } = await openLink();
    const { data } = await ok("GET", `${PUBLIC}/${token}`);
    expect(data.title).toBe("Rental agreement");
    expect(data.html).toContain("Ayşe Yılmaz");
    expect(data.yourTurn).toBe(true);
    expect(data.consentText).toMatch(/electronic signature/i);

    const row = client
      .query("select status as s from signature_signers where request_id = ?")
      .get(id) as { s: string };
    expect(row.s).toBe("viewed");
  });

  test("does not expose the other signers' addresses", async () => {
    const { data } = await create({
      signers: [
        { email: "tenant@example.com", name: "Tenant" },
        { email: "landlord@example.com", name: "Landlord" },
      ],
    });
    const token = data.links[0].url.split("/sign/")[1];
    const view = await ok("GET", `${PUBLIC}/${token}`);
    // A counterparty's address is not this signer's to read just because they
    // share a contract.
    expect(JSON.stringify(view)).not.toContain("landlord@example.com");
    expect(view.data.signerCount).toBe(2);
  });

  test("an unknown token is the same answer as a deleted one", async () => {
    const a = await h.fetch(`${PUBLIC}/sig_${"0".repeat(48)}`);
    const b = await h.fetch(`${PUBLIC}/not-even-a-token`);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    // Same sentence for both: telling them apart would make this endpoint an
    // oracle for whether a given token ever existed.
    const message = async (r: Response) => ((await r.json()) as any).error.message;
    expect(await message(a)).toBe(await message(b));
  });
});

describe("signing", () => {
  const opened = async (body: Record<string, unknown> = {}) => {
    const { data } = await create(body);
    return { id: data.request.id, tokens: data.links.map((l: any) => l.url.split("/sign/")[1]) };
  };

  test("a typed signature completes a single-signer request", async () => {
    const { id, tokens } = await opened();
    const { data } = await ok("POST", `${PUBLIC}/${tokens[0]}/sign`, {
      kind: "typed",
      text: "Ayşe Yılmaz",
      consent: true,
    });
    expect(data.status).toBe("completed");

    const req = await ok("GET", `${BASE}/${id}`);
    expect(req.data.status).toBe("completed");
    expect(req.data.signedDocumentKey).toMatch(/^documents\//);
    expect(req.data.signedDocumentHash).toMatch(/^[0-9a-f]{64}$/);
    // The signed render carries the signature and the certificate.
    const signedHtml = rendered[rendered.length - 1]!;
    expect(signedHtml).toContain("Ayşe Yılmaz");
    expect(signedHtml).toContain("Signature certificate");
    expect(signedHtml).toContain(req.data.documentHash);
    // …and everyone who signed gets the copy.
    expect(emails.join("\n")).toContain("tenant@example.com");
  });

  test("a drawn signature is accepted and the image never leaves the server", async () => {
    const { id, tokens } = await opened();
    await ok("POST", `${PUBLIC}/${tokens[0]}/sign`, { kind: "drawn", image: PNG_1PX, consent: true });
    const req = await ok("GET", `${BASE}/${id}`);
    expect(req.data.signers[0].signatureKind).toBe("drawn");
    // A signature is reusable evidence — the admin list has no reason to hand
    // it around, and the certificate is where it belongs.
    expect(JSON.stringify(req.data)).not.toContain("iVBORw0KGgo");
  });

  test("signing without consent is refused", async () => {
    const { tokens } = await opened();
    const res = await h.fetch(
      `${PUBLIC}/${tokens[0]}/sign`,
      json("POST", { kind: "typed", text: "X", consent: false }),
    );
    expect(res.status).toBe(422);
  });

  test("signing twice is refused rather than signing twice", async () => {
    const { tokens } = await opened();
    await ok("POST", `${PUBLIC}/${tokens[0]}/sign`, { kind: "typed", text: "A", consent: true });
    const again = await h.fetch(
      `${PUBLIC}/${tokens[0]}/sign`,
      json("POST", { kind: "typed", text: "A", consent: true }),
    );
    expect(again.status).toBe(410);
  });

  test("the IP and user agent are recorded", async () => {
    const { id, tokens } = await opened();
    const res = await h.fetch(`${PUBLIC}/${tokens[0]}/sign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7",
        "user-agent": "TestBrowser/1.0",
      },
      body: JSON.stringify({ kind: "typed", text: "A", consent: true }),
    });
    expect(res.ok).toBe(true);
    const req = await ok("GET", `${BASE}/${id}`);
    expect(req.data.signers[0].ip).toBe("203.0.113.7");
    expect(req.data.signers[0].userAgent).toBe("TestBrowser/1.0");
  });

  test("an ordered request will not let the second signer go first", async () => {
    const { tokens } = await opened({
      ordered: true,
      signers: [{ email: "first@example.com" }, { email: "second@example.com" }],
    });
    const early = await h.fetch(
      `${PUBLIC}/${tokens[1]}/sign`,
      json("POST", { kind: "typed", text: "B", consent: true }),
    );
    expect(early.status).toBe(403);

    const view = await ok("GET", `${PUBLIC}/${tokens[1]}`);
    expect(view.data.yourTurn).toBe(false);
  });

  test("an unordered request completes only when everyone has signed", async () => {
    const { id, tokens } = await opened({
      signers: [{ email: "a@example.com" }, { email: "b@example.com" }],
    });
    const first = await ok("POST", `${PUBLIC}/${tokens[0]}/sign`, {
      kind: "typed",
      text: "A",
      consent: true,
    });
    expect(first.data.status).toBe("pending");
    expect((await ok("GET", `${BASE}/${id}`)).data.signedDocumentKey).toBeNull();

    const second = await ok("POST", `${PUBLIC}/${tokens[1]}/sign`, {
      kind: "typed",
      text: "B",
      consent: true,
    });
    expect(second.data.status).toBe("completed");
  });

  test("the signed key is written back onto the row it describes", async () => {
    await ok("POST", "/api/collections", {
      slug: "leases",
      name: "Leases",
      fields: [
        { name: "tenant", type: "text" },
        { name: "signed_doc", type: "text" },
      ],
    });
    const row = await ok("POST", "/api/items/leases", { tenant: "Ayşe" });
    const { tokens } = await opened({
      writeBack: { collection: "leases", id: row.data.id, field: "signed_doc" },
    });
    await ok("POST", `${PUBLIC}/${tokens[0]}/sign`, { kind: "typed", text: "A", consent: true });

    const after = await ok("GET", `/api/items/leases/${row.data.id}`);
    expect(after.data.signed_doc).toMatch(/^documents\//);
  });
});

describe("a renderer that dies between the signature and the copy", () => {
  test("keeps the signature, and the admin can produce the copy afterwards", async () => {
    const { data } = await create();
    const token = data.links[0].url.split("/sign/")[1];
    const { buildContext } = await import("../src/server/context");
    const ctx = (await buildContext(h.env)) as any;
    const working = ctx.pdf;
    ctx.pdf = {
      name: "stub",
      render: async () => {
        throw new Error("renderer unreachable");
      },
    };

    // The signer is not told their signature failed, because it did not.
    const out = await ok("POST", `${PUBLIC}/${token}/sign`, { kind: "typed", text: "A", consent: true });
    expect(out.data.finalized).toBe(false);
    const stranded = await ok("GET", `${BASE}/${data.request.id}`);
    expect(stranded.data.status).toBe("pending");
    expect(stranded.data.signers[0].status).toBe("signed");
    expect(stranded.data.signedDocumentKey).toBeNull();

    // Every signing link is spent by now, so this is the only way back.
    ctx.pdf = working;
    const fixed = await ok("POST", `${BASE}/${data.request.id}/finalize`);
    expect(fixed.data.status).toBe("completed");
    expect(fixed.data.signedDocumentKey).toMatch(/^documents\//);

    // …and it will not run twice over a completed request.
    const again = await h.fetch(`${BASE}/${data.request.id}/finalize`, json("POST"));
    expect(again.status).toBe(422);
  });

  test("finalizing a request somebody still owes a signature on is refused", async () => {
    const { data } = await create({
      signers: [{ email: "a@example.com" }, { email: "b@example.com" }],
    });
    const res = await h.fetch(`${BASE}/${data.request.id}/finalize`, json("POST"));
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/not everyone/i);
  });
});

describe("declining", () => {
  test("one refusal ends the whole request", async () => {
    // A contract two of three people signed is not partially signed, and the
    // remaining links would otherwise stay live against something nobody can
    // complete.
    const { data } = await create({
      signers: [{ email: "a@example.com" }, { email: "b@example.com" }],
    });
    const tokens = data.links.map((l: any) => l.url.split("/sign/")[1]);
    await ok("POST", `${PUBLIC}/${tokens[0]}/decline`, { reason: "Wrong price" });

    const req = await ok("GET", `${BASE}/${data.request.id}`);
    expect(req.data.status).toBe("declined");
    expect(req.data.signers[0].declineReason).toBe("Wrong price");

    const other = await h.fetch(
      `${PUBLIC}/${tokens[1]}/sign`,
      json("POST", { kind: "typed", text: "B", consent: true }),
    );
    expect(other.status).toBe(410);
  });
});

describe("void and resend", () => {
  test("voiding invalidates the links that are already out there", async () => {
    const { data } = await create();
    const token = data.links[0].url.split("/sign/")[1];
    await ok("POST", `${BASE}/${data.request.id}/void`, { reason: "Superseded" });

    // Not merely refused by status — the token itself stops resolving, so no
    // read path has to remember to check.
    const res = await h.fetch(`${PUBLIC}/${token}`);
    expect(res.status).toBe(404);
    const req = await ok("GET", `${BASE}/${data.request.id}`);
    expect(req.data.status).toBe("voided");
  });

  test("a signed request cannot be voided", async () => {
    const { data } = await create();
    const token = data.links[0].url.split("/sign/")[1];
    await ok("POST", `${PUBLIC}/${token}/sign`, { kind: "typed", text: "A", consent: true });
    const res = await h.fetch(`${BASE}/${data.request.id}/void`, json("POST", {}));
    expect(res.status).toBe(422);
  });

  test("resending replaces the link rather than repeating it", async () => {
    const { data } = await create();
    const old = data.links[0].url.split("/sign/")[1];
    const hashBefore = client
      .query("select token_hash as h from signature_signers where request_id = ?")
      .get(data.request.id) as { h: string };

    const out = await ok("POST", `${BASE}/${data.request.id}/signers/${data.request.signers[0].id}/resend`);
    expect(out.data.sent).toBe(true);
    expect(out.data.email).toBe("tenant@example.com");

    // The whole point of resending is that a link which went astray stops
    // working — a resend that left the old one live would fix nothing.
    expect((await h.fetch(`${PUBLIC}/${old}`)).status).toBe(404);
    const hashAfter = client
      .query("select token_hash as h from signature_signers where request_id = ?")
      .get(data.request.id) as { h: string };
    expect(hashAfter.h).not.toBe(hashBefore.h);
  });
});

describe("expiry", () => {
  test("passes by the clock, with nothing having to run", async () => {
    const { data } = await create();
    const token = data.links[0].url.split("/sign/")[1];
    client
      .query("update signature_requests set expires_at = ? where id = ?")
      .run(Date.now() - 1000, data.request.id);

    const view = await ok("GET", `${PUBLIC}/${token}`);
    expect(view.data.status).toBe("expired");
    const res = await h.fetch(
      `${PUBLIC}/${token}/sign`,
      json("POST", { kind: "typed", text: "A", consent: true }),
    );
    expect(res.status).toBe(410);

    // …and the stored status is still `pending`, which is what makes the
    // derivation load-bearing rather than decorative.
    const row = client
      .query("select status as s from signature_requests where id = ?")
      .get(data.request.id) as { s: string };
    expect(row.s).toBe("pending");
    expect((await ok("GET", `${BASE}?status=expired`)).data).toHaveLength(1);
  });
});

describe("parseSignatureImage", () => {
  test("accepts a real PNG data URL", () => {
    expect(parseSignatureImage(PNG_1PX)).toBe(PNG_1PX);
  });

  test("refuses an SVG, which can carry script", () => {
    expect(() => parseSignatureImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toThrow();
  });

  test("refuses base64 that is not a PNG", () => {
    // The value is interpolated into HTML a headless browser opens, so a
    // payload that merely CLAIMS png is not enough.
    expect(() => parseSignatureImage("data:image/png;base64,aGVsbG8gd29ybGQ=")).toThrow(/PNG/);
  });

  test("refuses a payload with a quote in it", () => {
    // Anything outside the base64 alphabet could close the `src` attribute.
    expect(() => parseSignatureImage(`data:image/png;base64,ab"onerror=alert(1)`)).toThrow();
  });

  test("refuses an oversized image without decoding it", () => {
    expect(() => parseSignatureImage(`data:image/png;base64,${"A".repeat(1_000_000)}`)).toThrow(/large/i);
  });
});

describe("the signed artefact", () => {
  const row = (over: Partial<SignatureRequestRow> = {}): SignatureRequestRow =>
    ({
      id: "req-1",
      tenantId: "t1",
      title: "Agreement",
      message: null,
      templateKey: null,
      bodyHtml: "<html><body><p>Terms</p></body></html>",
      pageOptions: null,
      filename: "a.pdf",
      documentHash: "deadbeef",
      documentKey: null,
      signedDocumentKey: null,
      signedDocumentHash: null,
      status: "pending",
      ordered: false,
      expiresAt: null,
      completedAt: null,
      voidedAt: null,
      voidReason: null,
      writeBack: null,
      notifyEmails: null,
      createdBy: null,
      createdAt: null,
      updatedAt: null,
      ...over,
    }) as SignatureRequestRow;

  const signer = (over: Partial<SignatureSignerRow> = {}): SignatureSignerRow =>
    ({
      id: "s1",
      requestId: "req-1",
      email: "a@example.com",
      name: "Ayşe",
      role: "Tenant",
      orderIndex: 0,
      tokenHash: "x",
      status: "signed",
      sentAt: null,
      viewedAt: null,
      signedAt: 1_770_000_000_000,
      declinedAt: null,
      declineReason: null,
      signatureKind: "typed",
      signatureImage: null,
      signatureText: "Ayşe",
      consentText: "I agree",
      ip: "203.0.113.7",
      userAgent: null,
      createdAt: null,
      updatedAt: null,
      ...over,
    }) as SignatureSignerRow;

  test("goes before </body> so the document's own styles still apply", () => {
    const html = buildSignedHtml(row(), [signer()]);
    expect(html.indexOf("Signature certificate")).toBeLessThan(html.indexOf("</body>"));
    expect(html).toContain("Terms");
  });

  test("a template may place the block itself", () => {
    const html = buildSignedHtml(
      row({ bodyHtml: "<html><body><p>A</p><!--backlex:signatures--><p>B</p></body></html>" }),
      [signer()],
    );
    expect(html.indexOf("Ayşe")).toBeLessThan(html.indexOf("<p>B</p>"));
  });

  test("escapes the values that reach the rendered document", () => {
    // The operator's own labels are arbitrary text too — a role typed in the
    // admin still arrives in a document a browser executes.
    const html = buildSignedHtml(row(), [
      signer({ name: "<script>alert(1)</script>", role: "\"><img src=x>", signatureText: "<b>x</b>" }),
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('"><img src=x>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("a drawn signature is embedded as the image it was validated to be", () => {
    const html = buildSignedHtml(row(), [signer({ signatureKind: "drawn", signatureImage: PNG_1PX })]);
    expect(html).toContain(`src="${PNG_1PX}"`);
  });
});

describe("effectiveStatus", () => {
  test("only pending decays into expired", () => {
    const past = Date.now() - 1;
    expect(effectiveStatus({ status: "pending", expiresAt: past } as SignatureRequestRow)).toBe("expired");
    expect(effectiveStatus({ status: "completed", expiresAt: past } as SignatureRequestRow)).toBe(
      "completed",
    );
    expect(effectiveStatus({ status: "pending", expiresAt: null } as SignatureRequestRow)).toBe("pending");
  });
});
