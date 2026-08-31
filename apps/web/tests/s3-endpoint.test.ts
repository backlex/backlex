/**
 * The S3-compatible endpoint, driven by a real SigV4 signer.
 *
 * The signer below is written INDEPENDENTLY of the verifier, from the AWS
 * signing documentation, and that is the point: a test that reused the server's
 * own canonicalization would pass no matter how wrong both halves were
 * together. Any disagreement between them shows up as a signature mismatch,
 * which is exactly what a real client would report.
 *
 * What is pinned here, beyond "it works":
 *   - a wrong secret, a tampered path and a tampered query each FAIL;
 *   - a stale timestamp fails, so a captured request is not replayable;
 *   - a read-only credential cannot write, and a prefix-scoped one cannot
 *     reach outside its prefix — in BOTH directions, read and write;
 *   - the bucket in the URL is checked against the credential, never used to
 *     choose a workspace;
 *   - errors come back as S3 `<Error>` documents with codes a client branches
 *     on, not as our JSON envelope.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let accessKeyId = "";
let secretAccessKey = "";
let bucket = "";
/** A fresh client IP per test.
 *
 *  The endpoint throttles FAILED authentications per IP, and that counter is
 *  process-global by design. Without a distinct IP the throttle test would
 *  poison every test that ran after it in the same minute — which is exactly
 *  what happened the first time. */
let probeIp = "";

const JSON_HEADERS = { "content-type": "application/json" };
const enc = new TextEncoder();

const hex = (b: ArrayBuffer | Uint8Array): string => {
  const v = b instanceof Uint8Array ? b : new Uint8Array(b);
  return [...v].map((x) => x.toString(16).padStart(2, "0")).join("");
};

const sha256 = async (data: string | Uint8Array): Promise<string> =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      (typeof data === "string" ? enc.encode(data) : data) as never,
    ),
  );

const hmac = async (key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> => {
  const k = await crypto.subtle.importKey(
    "raw",
    key as never,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data) as never));
};

/** Percent-encode per the SigV4 rules (written from the spec, not from the
 *  server's helper — see the file header). */
const enc4 = (v: string, slash: boolean): string => {
  let out = "";
  for (const ch of v) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === "/") out += slash ? "%2F" : "/";
    else for (const b of enc.encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
};

interface SignOpts {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: Uint8Array | string;
  secret?: string;
  akid?: string;
  amzDate?: string;
  contentType?: string;
}

/** Build a signed Request the harness can dispatch. */
const signed = async (o: SignOpts): Promise<Request> => {
  const host = "localhost:5173";
  const amzDate =
    o.amzDate ?? `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const region = "us-east-1";
  const service = "s3";
  const bodyBytes =
    typeof o.body === "string" ? enc.encode(o.body) : (o.body ?? new Uint8Array(0));
  const payloadHash = await sha256(bodyBytes);

  const query = new URLSearchParams(o.query ?? {});
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [enc4(k, true), enc4(v, true)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (o.contentType) headers["content-type"] = o.contentType;
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = `${signedHeaders.map((k) => `${k}:${headers[k]!.trim()}`).join("\n")}\n`;

  const canonicalRequest = [
    o.method,
    enc4(o.path, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256(canonicalRequest),
  ].join("\n");

  let key = enc.encode(`AWS4${o.secret ?? secretAccessKey}`);
  for (const part of [dateStamp, region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  const auth =
    `AWS4-HMAC-SHA256 Credential=${o.akid ?? accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;

  const qs = canonicalQuery ? `?${query.toString()}` : "";
  return new Request(`http://${host}${o.path}${qs}`, {
    method: o.method,
    headers: { ...headers, authorization: auth, "x-forwarded-for": probeIp },
    ...(o.method === "PUT" || o.method === "POST" ? { body: bodyBytes as never } : {}),
  });
};

const call = (req: Request) => h.app.fetch(req, h.env);

const mint = async (over: Record<string, unknown> = {}) => {
  const res = await h.fetch("/api/admin/s3-credentials", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: "test", ...over }),
  });
  if (!res.ok) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    data: { id: string; accessKeyId: string };
    secretAccessKey: string;
  };
};

beforeEach(async () => {
  probeIp = `10.${(Math.random() * 250 + 1) | 0}.${(Math.random() * 250 + 1) | 0}.1`;
  h = makeHarness();
  await seedAdmin(h);
  const made = await mint();
  accessKeyId = made.data.accessKeyId;
  secretAccessKey = made.secretAccessKey;
  const me = (await (await h.fetch("/api/tenants")).json()) as { data: { slug: string }[] };
  bucket = me.data[0]!.slug;
});
afterEach(() => h.cleanup());

describe("authentication", () => {
  test("a correctly signed request is accepted", async () => {
    const res = await call(await signed({ method: "GET", path: `/s3/${bucket}/` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("xml");
  });

  test("a wrong secret is refused, with an S3 error document", async () => {
    const res = await call(
      await signed({ method: "GET", path: `/s3/${bucket}/`, secret: "not-the-secret" }),
    );
    expect(res.status).toBe(403);
    const body = await res.text();
    // A JSON envelope here would make every S3 client report an unknown
    // failure instead of "signature mismatch".
    expect(body).toContain("<Code>SignatureDoesNotMatch</Code>");
  });

  test("an unknown access key id is refused without saying which part was wrong", async () => {
    const res = await call(
      await signed({ method: "GET", path: `/s3/${bucket}/`, akid: "BLXNOSUCHKEYAAAAAAAA" }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("InvalidAccessKeyId");
  });

  test("no signature at all is refused", async () => {
    const res = await call(
      new Request(`http://localhost:5173/s3/${bucket}/`, {
        headers: { "x-forwarded-for": probeIp },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("tampering with the PATH after signing breaks the signature", async () => {
    const req = await signed({ method: "GET", path: `/s3/${bucket}/one.txt` });
    const moved = new Request(req.url.replace("one.txt", "two.txt"), {
      method: "GET",
      headers: req.headers,
    });
    expect((await call(moved)).status).toBe(403);
  });

  test("tampering with the QUERY after signing breaks the signature", async () => {
    const req = await signed({
      method: "GET",
      path: `/s3/${bucket}/`,
      query: { "list-type": "2", prefix: "safe/" },
    });
    const widened = new Request(req.url.replace("prefix=safe%2F", "prefix="), {
      method: "GET",
      headers: req.headers,
    });
    expect((await call(widened)).status).toBe(403);
  });

  test("a stale timestamp is refused, so a captured request is not replayable", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000)
      .toISOString()
      .replace(/[-:]/g, "")
      .slice(0, 15);
    const res = await call(
      await signed({ method: "GET", path: `/s3/${bucket}/`, amzDate: `${old}Z` }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("RequestTimeTooSkewed");
  });

  test("a body that does not match its declared hash is refused", async () => {
    const req = await signed({ method: "PUT", path: `/s3/${bucket}/x.txt`, body: "hello" });
    // Same headers (so the same signature and the same declared hash), other
    // bytes. Without the body check this would store something nobody signed.
    const swapped = new Request(req.url, {
      method: "PUT",
      headers: req.headers,
      body: enc.encode("goodbye") as never,
    });
    const res = await call(swapped);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("XAmzContentSHA256Mismatch");
  });

  test("repeated failures are throttled, but success is never counted", async () => {
    // The budget exists so a guesser pays; a sync tool making thousands of
    // successful requests a minute must never hit it. An earlier version
    // counted every request and throttled the multipart test — this asserts
    // the semantics that fixed it.
    for (let i = 0; i < 40; i += 1) {
      await call(await signed({ method: "GET", path: `/s3/${bucket}/`, secret: "wrong" }));
    }
    const throttled = await call(
      await signed({ method: "GET", path: `/s3/${bucket}/`, secret: "wrong" }),
    );
    expect(throttled.status).toBe(429);
    expect(await throttled.text()).toContain("SlowDown");
  });
});

describe("objects", () => {
  test("put → head → get → list → delete round-trips", async () => {
    const put = await call(
      await signed({
        method: "PUT",
        path: `/s3/${bucket}/notes/a.txt`,
        body: "hello world",
        contentType: "text/plain",
      }),
    );
    expect(put.status).toBe(200);
    expect(put.headers.get("etag")).toBeTruthy();

    const head = await call(await signed({ method: "HEAD", path: `/s3/${bucket}/notes/a.txt` }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("11");

    const get = await call(await signed({ method: "GET", path: `/s3/${bucket}/notes/a.txt` }));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("hello world");

    const list = await call(
      await signed({ method: "GET", path: `/s3/${bucket}/`, query: { "list-type": "2" } }),
    );
    const xml = await list.text();
    expect(xml).toContain("<Key>notes/a.txt</Key>");
    expect(xml).toContain("<Size>11</Size>");

    const del = await call(await signed({ method: "DELETE", path: `/s3/${bucket}/notes/a.txt` }));
    expect(del.status).toBe(204);
    expect(
      (await call(await signed({ method: "GET", path: `/s3/${bucket}/notes/a.txt` }))).status,
    ).toBe(404);
  });

  test("a missing key is NoSuchKey, not a generic 404 page", async () => {
    const res = await call(await signed({ method: "GET", path: `/s3/${bucket}/nope.txt` }));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<Code>NoSuchKey</Code>");
  });

  test("deleting a key that never existed succeeds, as S3 does", async () => {
    // Clients rely on this for idempotent cleanup; an error would break every
    // `rclone sync --delete`.
    const res = await call(await signed({ method: "DELETE", path: `/s3/${bucket}/ghost.txt` }));
    expect(res.status).toBe(204);
  });

  test("an object written over S3 is visible to the REST storage API", async () => {
    // The whole design claim: this is a second PROTOCOL, not a second store.
    await call(
      await signed({ method: "PUT", path: `/s3/${bucket}/shared.txt`, body: "both" }),
    );
    const rest = await h.fetch("/api/storage/shared.txt");
    expect(rest.status).toBe(200);
    expect(await rest.text()).toBe("both");
  });

  test("a key the REST API would refuse is refused here identically", async () => {
    const res = await call(
      await signed({ method: "PUT", path: `/s3/${bucket}/tenants/evil.txt`, body: "x" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("InvalidArgument");
  });

  test("listing honours a prefix and a delimiter", async () => {
    for (const key of ["a/1.txt", "a/2.txt", "b/1.txt"]) {
      await call(await signed({ method: "PUT", path: `/s3/${bucket}/${key}`, body: "x" }));
    }
    const res = await call(
      await signed({
        method: "GET",
        path: `/s3/${bucket}/`,
        query: { "list-type": "2", prefix: "a/", delimiter: "/" },
      }),
    );
    const xml = await res.text();
    expect(xml).toContain("<Key>a/1.txt</Key>");
    expect(xml).not.toContain("<Key>b/1.txt</Key>");
  });
});

describe("the credential is the boundary", () => {
  test("the bucket in the URL is checked, never used to pick a workspace", async () => {
    const res = await call(await signed({ method: "GET", path: `/s3/someone-elses-bucket/` }));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("NoSuchBucket");
  });

  test("a read-only credential can read and cannot write", async () => {
    await call(await signed({ method: "PUT", path: `/s3/${bucket}/ro.txt`, body: "x" }));
    const ro = await mint({ name: "reader", readOnly: true });
    const opts = { secret: ro.secretAccessKey, akid: ro.data.accessKeyId };

    const get = await call(await signed({ method: "GET", path: `/s3/${bucket}/ro.txt`, ...opts }));
    expect(get.status).toBe(200);

    for (const method of ["PUT", "DELETE"] as const) {
      const res = await call(
        await signed({ method, path: `/s3/${bucket}/ro.txt`, body: "y", ...opts }),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("AccessDenied");
    }
  });

  test("a prefix-scoped credential cannot reach outside it, reading or writing", async () => {
    await call(await signed({ method: "PUT", path: `/s3/${bucket}/team-a/in.txt`, body: "x" }));
    await call(await signed({ method: "PUT", path: `/s3/${bucket}/team-b/out.txt`, body: "x" }));
    const scoped = await mint({ name: "team-a", prefix: "team-a/" });
    const opts = { secret: scoped.secretAccessKey, akid: scoped.data.accessKeyId };

    expect(
      (await call(await signed({ method: "GET", path: `/s3/${bucket}/team-a/in.txt`, ...opts })))
        .status,
    ).toBe(200);
    expect(
      (await call(await signed({ method: "GET", path: `/s3/${bucket}/team-b/out.txt`, ...opts })))
        .status,
    ).toBe(403);
    expect(
      (await call(
        await signed({ method: "PUT", path: `/s3/${bucket}/team-b/new.txt`, body: "x", ...opts }),
      )).status,
    ).toBe(403);

    // …and a LIST cannot widen its own scope by asking for a broader prefix.
    const list = await call(
      await signed({
        method: "GET",
        path: `/s3/${bucket}/`,
        query: { "list-type": "2", prefix: "" },
        ...opts,
      }),
    );
    const xml = await list.text();
    expect(xml).toContain("team-a/in.txt");
    expect(xml).not.toContain("team-b/out.txt");
  });

  test("a disabled credential stops working immediately", async () => {
    const cred = await mint({ name: "temporary" });
    const opts = { secret: cred.secretAccessKey, akid: cred.data.accessKeyId };
    expect((await call(await signed({ method: "GET", path: `/s3/${bucket}/`, ...opts }))).status).toBe(
      200,
    );
    await h.fetch(`/api/admin/s3-credentials/${cred.data.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect((await call(await signed({ method: "GET", path: `/s3/${bucket}/`, ...opts }))).status).toBe(
      403,
    );
  });

  test("the secret is shown once and never listed", async () => {
    const listed = (await (await h.fetch("/api/admin/s3-credentials")).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(listed.data.length).toBeGreaterThan(0);
    for (const row of listed.data) {
      expect(Object.keys(row)).not.toContain("secretKey");
      expect(JSON.stringify(row)).not.toContain(secretAccessKey);
    }
  });
});

describe("multipart", () => {
  test("create → upload parts → complete assembles the object", async () => {
    const created = await call(
      await signed({ method: "POST", path: `/s3/${bucket}/big.txt`, query: { uploads: "" } }),
    );
    expect(created.status).toBe(200);
    const xml = await created.text();
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
    if (!uploadId) {
      // The bundled adapter for this harness may not support multipart; the
      // endpoint says 501 rather than pretending, which is the contract.
      expect(xml).toContain("NotImplemented");
      return;
    }

    const etags: string[] = [];
    for (const [i, chunk] of ["part-one-", "part-two"].entries()) {
      const res = await call(
        await signed({
          method: "PUT",
          path: `/s3/${bucket}/big.txt`,
          query: { partNumber: String(i + 1), uploadId },
          body: chunk,
        }),
      );
      expect(res.status).toBe(200);
      etags.push((res.headers.get("etag") ?? "").replaceAll('"', ""));
    }

    const body =
      `<CompleteMultipartUpload>` +
      etags
        .map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`)
        .join("") +
      `</CompleteMultipartUpload>`;
    const done = await call(
      await signed({ method: "POST", path: `/s3/${bucket}/big.txt`, query: { uploadId }, body }),
    );
    expect(done.status).toBe(200);

    const get = await call(await signed({ method: "GET", path: `/s3/${bucket}/big.txt` }));
    expect(await get.text()).toBe("part-one-part-two");
  });
});
