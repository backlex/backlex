/**
 * AWS Signature Version 4 — the verifying half.
 *
 * Every S3 client in existence already knows how to SIGN. What this file does
 * is recompute the same signature from the request that arrived and compare,
 * which is the entire reason `rclone`, `aws-cli`, `mc` and every backup tool
 * that speaks S3 can point at a backlex workspace without any adapter.
 *
 * ## The three shapes a request can arrive in
 *
 *  1. **Header auth** — `Authorization: AWS4-HMAC-SHA256 Credential=…`. What
 *     almost everything sends.
 *  2. **Presigned query auth** — `X-Amz-Signature=…` in the URL. What a shared
 *     link is, and what `mc share` and browser uploads produce.
 *  3. **Chunked bodies** — `Content-Encoding: aws-chunked` with a
 *     `STREAMING-…` content hash. `mc` and `aws s3 cp` use it for anything
 *     large. The SEED signature (the one over the headers) is verified exactly
 *     as in case 1; the per-chunk signatures are not, and the reason is stated
 *     rather than hidden: AWS's own `STREAMING-UNSIGNED-PAYLOAD-TRAILER` does
 *     not sign chunks either, the request is already authenticated by the seed,
 *     and the body's integrity in transit is TLS's job.
 *
 * ## What is checked, and why each one is there
 *
 *  - the signature itself, in constant time;
 *  - the date skew (±15 minutes), so a captured request is not replayable
 *    forever;
 *  - a presigned URL's own `X-Amz-Expires`, which is the only thing bounding it;
 *  - that every header the signature covers was actually present.
 *
 * There is no "signature version 2" fallback. A verifier that accepts a weaker
 * scheme is exactly as strong as the weaker scheme.
 */

const enc = new TextEncoder();

const hex = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
};

export const sha256Hex = async (data: string | Uint8Array): Promise<string> =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      (typeof data === "string" ? enc.encode(data) : data) as unknown as BufferSource,
    ),
  );

const hmac = async (
  key: Uint8Array<ArrayBufferLike>,
  data: string,
): Promise<Uint8Array<ArrayBufferLike>> => {
  const k = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", k, enc.encode(data) as unknown as BufferSource),
  );
};

/** Constant-time comparison — a signature check that returns early on the
 *  first differing byte leaks the correct prefix to a patient caller. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * The URI encoding SigV4 canonicalization requires. Not `encodeURIComponent`:
 * that leaves `!'()*` alone and encodes nothing else the spec wants, and for
 * the path component `/` must survive. Getting this wrong produces a signature
 * mismatch for exactly the keys that contain interesting characters, which is
 * the hardest class of bug to report.
 */
export const uriEncode = (value: string, encodeSlash: boolean): string => {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const unreserved =
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~";
    if (unreserved) {
      out += ch;
    } else if (ch === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      for (const byte of enc.encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
};

export interface ParsedAuth {
  accessKeyId: string;
  /** `YYYYMMDD` from the credential scope. */
  dateStamp: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
  /** Presigned only: seconds the URL is valid for. */
  expiresIn?: number;
  presigned: boolean;
}

const parseCredential = (
  credential: string,
): { accessKeyId: string; dateStamp: string; region: string; service: string } | null => {
  // `<akid>/<date>/<region>/<service>/aws4_request`. The access key id may not
  // contain `/`, which our generator guarantees, so a plain split is total.
  const parts = credential.split("/");
  if (parts.length !== 5 || parts[4] !== "aws4_request") return null;
  return {
    accessKeyId: parts[0]!,
    dateStamp: parts[1]!,
    region: parts[2]!,
    service: parts[3]!,
  };
};

/** Pull the auth material out of a request, or `null` when it carries none. */
export const parseSigV4 = (req: Request): ParsedAuth | null => {
  const url = new URL(req.url);
  const qs = url.searchParams;

  if (qs.get("X-Amz-Signature")) {
    const cred = parseCredential(qs.get("X-Amz-Credential") ?? "");
    const amzDate = qs.get("X-Amz-Date");
    if (!cred || !amzDate) return null;
    const expires = Number(qs.get("X-Amz-Expires") ?? "");
    return {
      ...cred,
      signedHeaders: (qs.get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean),
      signature: qs.get("X-Amz-Signature")!,
      amzDate,
      expiresIn: Number.isFinite(expires) ? expires : undefined,
      presigned: true,
    };
  }

  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("AWS4-HMAC-SHA256")) return null;
  const rest = header.slice("AWS4-HMAC-SHA256".length).trim();
  const fields = new Map<string, string>();
  for (const part of rest.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const cred = parseCredential(fields.get("Credential") ?? "");
  const signature = fields.get("Signature");
  const amzDate = req.headers.get("x-amz-date");
  if (!cred || !signature || !amzDate) return null;
  return {
    ...cred,
    signedHeaders: (fields.get("SignedHeaders") ?? "").split(";").filter(Boolean),
    signature,
    amzDate,
    presigned: false,
  };
};

/** Maximum clock skew between the signature's timestamp and ours. */
export const MAX_SKEW_MS = 15 * 60 * 1000;

/** `YYYYMMDDTHHMMSSZ` → epoch ms, or NaN. */
export const parseAmzDate = (amzDate: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!m) return Number.NaN;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
};

const canonicalQuery = (url: URL, presigned: boolean): string => {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams) {
    // A presigned URL signs every parameter EXCEPT the signature itself —
    // including it would make the signature cover its own value.
    if (presigned && k === "X-Amz-Signature") continue;
    pairs.push([uriEncode(k, true), uriEncode(v, true)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
};

const canonicalHeaders = (
  req: Request,
  signedHeaders: string[],
  url: URL,
): { canonical: string; missing: string | null } => {
  const lines: string[] = [];
  for (const name of signedHeaders) {
    let value: string | null;
    if (name === "host") {
      // `Request` on some runtimes drops the Host header into the URL only.
      value = req.headers.get("host") ?? url.host;
    } else {
      value = req.headers.get(name);
    }
    if (value === null) return { canonical: "", missing: name };
    // Trim, and collapse runs of spaces outside quotes. The spec's rule; the
    // simplified collapse is what every server implements in practice.
    lines.push(`${name}:${value.trim().replace(/\s+/g, " ")}`);
  }
  return { canonical: `${lines.join("\n")}\n`, missing: null };
};

export interface VerifyInput {
  req: Request;
  auth: ParsedAuth;
  secretKey: string;
  /** The `x-amz-content-sha256` value, or the hash of a buffered body. */
  payloadHash: string;
  now?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: "SignatureDoesNotMatch" | "RequestTimeTooSkewed" | "ExpiredToken" | "MissingHeader"; message: string };

/**
 * Recompute the signature and compare.
 *
 * The canonical request is rebuilt from what ARRIVED, never from what the
 * client said it signed — the only thing taken from the client's word is which
 * headers to include, and a header it named but did not send is refused rather
 * than treated as empty.
 */
export const verifySigV4 = async (input: VerifyInput): Promise<VerifyResult> => {
  const { req, auth, secretKey } = input;
  const now = input.now ?? Date.now();
  const url = new URL(req.url);

  const signedAt = parseAmzDate(auth.amzDate);
  if (!Number.isFinite(signedAt)) {
    return { ok: false, code: "SignatureDoesNotMatch", message: "Malformed X-Amz-Date" };
  }
  if (Math.abs(now - signedAt) > MAX_SKEW_MS) {
    return {
      ok: false,
      code: "RequestTimeTooSkewed",
      message: "The difference between the request time and the current time is too large",
    };
  }
  if (auth.presigned) {
    // A presigned URL is a bearer credential in a link; its own expiry is the
    // only thing bounding it, so an absent or absurd one is refused rather
    // than defaulted.
    const ttl = auth.expiresIn;
    if (!ttl || ttl <= 0 || ttl > 7 * 24 * 3600) {
      return { ok: false, code: "ExpiredToken", message: "Invalid X-Amz-Expires" };
    }
    if (now > signedAt + ttl * 1000) {
      return { ok: false, code: "ExpiredToken", message: "Request has expired" };
    }
  }

  const { canonical: headerBlock, missing } = canonicalHeaders(req, auth.signedHeaders, url);
  if (missing) {
    return {
      ok: false,
      code: "MissingHeader",
      message: `Signed header "${missing}" was not sent`,
    };
  }

  const canonicalRequest = [
    req.method.toUpperCase(),
    uriEncode(decodeURIComponent(url.pathname), false),
    canonicalQuery(url, auth.presigned),
    headerBlock,
    auth.signedHeaders.join(";"),
    input.payloadHash,
  ].join("\n");

  const scope = `${auth.dateStamp}/${auth.region}/${auth.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    auth.amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key: Uint8Array<ArrayBufferLike> = enc.encode(`AWS4${secretKey}`);
  for (const part of [auth.dateStamp, auth.region, auth.service, "aws4_request"]) {
    key = await hmac(key, part);
  }
  const expected = hex(await hmac(key, stringToSign));

  return timingSafeEqual(expected, auth.signature)
    ? { ok: true }
    : {
        ok: false,
        code: "SignatureDoesNotMatch",
        message:
          "The request signature we calculated does not match the signature you provided",
      };
};

/** Content hashes that mean "the body is not covered by this signature". */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const STREAMING_PREFIX = "STREAMING-";

export const isStreamingPayload = (contentSha: string | null): boolean =>
  Boolean(contentSha && contentSha.startsWith(STREAMING_PREFIX));

/**
 * Decode an `aws-chunked` body.
 *
 * Each chunk is `<hex length>[;chunk-signature=<sig>]\r\n<bytes>\r\n`, ending
 * with a zero-length chunk and an optional trailer. Per-chunk signatures are
 * NOT verified — see the header for why — but the framing is parsed strictly:
 * a chunk whose declared length runs past the buffer is an error, not a
 * truncation, because silently accepting it would store a partial object under
 * a name the client believes holds the whole one.
 */
export const decodeAwsChunked = (body: Uint8Array): Uint8Array => {
  const out: Uint8Array<ArrayBufferLike>[] = [];
  let i = 0;
  const findCrlf = (from: number): number => {
    for (let j = from; j + 1 < body.length; j += 1) {
      if (body[j] === 0x0d && body[j + 1] === 0x0a) return j;
    }
    return -1;
  };
  while (i < body.length) {
    const eol = findCrlf(i);
    if (eol < 0) break;
    const header = new TextDecoder().decode(body.subarray(i, eol));
    const size = Number.parseInt(header.split(";")[0]!.trim(), 16);
    if (!Number.isFinite(size)) {
      throw new Error("Malformed aws-chunked body: unreadable chunk length");
    }
    i = eol + 2;
    if (size === 0) break;
    if (i + size > body.length) {
      throw new Error("Malformed aws-chunked body: chunk runs past the end of the request");
    }
    out.push(body.subarray(i, i + size));
    i += size + 2; // skip the chunk's trailing CRLF
  }
  const total = out.reduce((n, c) => n + c.length, 0);
  const merged: Uint8Array<ArrayBufferLike> = new Uint8Array(total);
  let at = 0;
  for (const c of out) {
    merged.set(c, at);
    at += c.length;
  }
  return merged;
};
