import { AwsClient } from "aws4fetch";
import type { StorageAdapter, StoredObject } from "@workeros/core/adapters";

export interface S3FetchConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Custom S3 endpoint for R2 / B2 / MinIO / DO Spaces. AWS S3 leave blank. */
  endpoint?: string;
}

const FALLBACK_REGION = "auto";

const objectUrl = (cfg: S3FetchConfig, key: string): string => {
  const region = cfg.region ?? FALLBACK_REGION;
  if (cfg.endpoint) {
    const base = cfg.endpoint.replace(/\/$/, "");
    return `${base}/${cfg.bucket}/${encodeURI(key)}`;
  }
  return `https://${cfg.bucket}.s3.${region}.amazonaws.com/${encodeURI(key)}`;
};

const bucketUrl = (cfg: S3FetchConfig, search = ""): string => {
  const region = cfg.region ?? FALLBACK_REGION;
  if (cfg.endpoint) {
    const base = cfg.endpoint.replace(/\/$/, "");
    return `${base}/${cfg.bucket}${search}`;
  }
  return `https://${cfg.bucket}.s3.${region}.amazonaws.com${search}`;
};

/**
 * Hand-rolled regex extractor for ListObjectsV2 XML — keeps the edge bundle
 * dep-free. The schema is small and stable across S3-compatible providers
 * (AWS, R2, B2, MinIO, DO Spaces).
 */
const parseList = (xml: string): StoredObject[] => {
  const out: StoredObject[] = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const block = match[1] ?? "";
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const size = block.match(/<Size>(\d+)<\/Size>/)?.[1];
    const lastMod = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
    if (!key) continue;
    out.push({
      key: key.trim(),
      size: size ? Number(size) : 0,
      uploadedAt: lastMod ? new Date(lastMod.trim()) : new Date(),
    });
  }
  return out;
};

/**
 * S3-compatible storage adapter built on `aws4fetch`. Works in any runtime
 * with WHATWG `fetch` — Bun, Workers, Vercel Edge, Netlify Edge, Node 18+.
 *
 * For a Bun-native fast path use `bunS3Storage()` first and fall through to
 * this when `Bun.S3Client` is unavailable.
 */
export const s3FetchStorage = (cfg: S3FetchConfig): StorageAdapter => {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region ?? FALLBACK_REGION,
    service: "s3",
  });

  return {
    async put({ key, body, contentType }) {
      const url = objectUrl(cfg, key);
      const res = await aws.fetch(url, {
        method: "PUT",
        body: body as BodyInit,
        ...(contentType ? { headers: { "content-type": contentType } } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`s3 put ${res.status}: ${text.slice(0, 200)}`);
      }
      const size = Number(res.headers.get("content-length") ?? 0);
      return {
        key,
        size,
        contentType,
        uploadedAt: new Date(),
      };
    },
    async get(key) {
      const url = objectUrl(cfg, key);
      const res = await aws.fetch(url, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`s3 get ${res.status}: ${text.slice(0, 200)}`);
      }
      const len = Number(res.headers.get("content-length") ?? 0);
      const ctype = res.headers.get("content-type") ?? undefined;
      const lastMod = res.headers.get("last-modified");
      return {
        body: res.body!,
        meta: {
          key,
          size: len,
          contentType: ctype,
          uploadedAt: lastMod ? new Date(lastMod) : new Date(),
        },
      };
    },
    async delete(key) {
      const url = objectUrl(cfg, key);
      await aws.fetch(url, { method: "DELETE" });
      // S3 delete is idempotent — 204 / 404 both fine.
    },
    async list(prefix = "") {
      const params = new URLSearchParams({
        "list-type": "2",
        "max-keys": "1000",
        ...(prefix ? { prefix } : {}),
      });
      const url = bucketUrl(cfg, `?${params}`);
      const res = await aws.fetch(url, { method: "GET" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`s3 list ${res.status}: ${text.slice(0, 200)}`);
      }
      const xml = await res.text();
      return parseList(xml);
    },
    async signedUrl(key, ttlSeconds) {
      const u = new URL(objectUrl(cfg, key));
      u.searchParams.set("X-Amz-Expires", String(ttlSeconds));
      const signed = await aws.sign(new Request(u.toString(), { method: "GET" }), {
        aws: { signQuery: true },
      });
      return signed.url;
    },
  };
};
