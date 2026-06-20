/**
 * Resumable uploads (TUS 1.0.0) over the default fs storage backend. Exercises
 * the full create → PATCH → finalize flow, resume via HEAD, the offset-conflict
 * guard, termination, the Tus-Max-Size limit, and the cron expiry sweep.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { sweepExpiredUploads } from "../src/server/services/uploads";

const TUS = { "Tus-Resumable": "1.0.0" };
const meta = (key: string, contentType?: string) => {
  const parts = [`key ${btoa(key)}`];
  if (contentType) parts.push(`contentType ${btoa(contentType)}`);
  return parts.join(",");
};
const bytes = (n: number): Uint8Array => {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = i % 251;
  return u;
};

describe("Resumable uploads (TUS)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const create = async (key: string, size: number, contentType = "application/octet-stream") => {
    const res = await h.fetch("/api/uploads", {
      method: "POST",
      headers: { ...TUS, "Upload-Length": String(size), "Upload-Metadata": meta(key, contentType) },
    });
    return res;
  };

  const patch = (location: string, offset: number, body: Uint8Array) =>
    h.fetch(location, {
      method: "PATCH",
      headers: { ...TUS, "Upload-Offset": String(offset), "content-type": "application/offset+octet-stream" },
      body,
    });

  test("OPTIONS advertises the TUS capabilities", async () => {
    const res = await h.fetch("/api/uploads", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Tus-Resumable")).toBe("1.0.0");
    expect(res.headers.get("Tus-Version")).toBe("1.0.0");
    expect(res.headers.get("Tus-Extension")).toContain("creation");
    expect(Number(res.headers.get("Tus-Max-Size"))).toBeGreaterThan(0);
  });

  test("create → HEAD → PATCH chunks → finalize, file is readable", async () => {
    const data = bytes(1500);
    const init = await create("docs/big.bin", data.byteLength);
    expect(init.status).toBe(201);
    const location = init.headers.get("Location");
    expect(location).toBeTruthy();

    const head0 = await h.fetch(location!, { method: "HEAD", headers: TUS });
    expect(head0.status).toBe(200);
    expect(head0.headers.get("Upload-Offset")).toBe("0");
    expect(head0.headers.get("Upload-Length")).toBe("1500");

    const p1 = await patch(location!, 0, data.subarray(0, 1000));
    expect(p1.status).toBe(204);
    expect(p1.headers.get("Upload-Offset")).toBe("1000");

    const p2 = await patch(location!, 1000, data.subarray(1000));
    expect(p2.status).toBe(204);
    expect(p2.headers.get("Upload-Offset")).toBe("1500");

    // The assembled object is now served by the storage route.
    const get = await h.fetch("/api/storage/docs/big.bin");
    expect(get.status).toBe(200);
    const got = new Uint8Array(await get.arrayBuffer());
    expect(got.byteLength).toBe(1500);
    expect([...got]).toEqual([...data]);

    // Management view reports completion.
    const view = await h.fetch(location!.replace("/api/uploads/", "/api/uploads/"));
    expect(view.status).toBe(200);
    expect((await view.json()).status).toBe("completed");
  });

  test("PATCH at the wrong offset is a 409 conflict", async () => {
    const init = await create("conflict.bin", 100);
    const location = init.headers.get("Location")!;
    const res = await patch(location, 50, bytes(50)); // server is at 0
    expect(res.status).toBe(409);
  });

  test("a partial upload resumes from the HEAD offset", async () => {
    const data = bytes(800);
    const init = await create("resume.bin", data.byteLength);
    const location = init.headers.get("Location")!;
    await patch(location, 0, data.subarray(0, 300));

    const head = await h.fetch(location, { method: "HEAD", headers: TUS });
    expect(head.headers.get("Upload-Offset")).toBe("300");

    const done = await patch(location, 300, data.subarray(300));
    expect(done.status).toBe(204);
    expect(done.headers.get("Upload-Offset")).toBe("800");
  });

  test("DELETE terminates the session", async () => {
    const init = await create("gone.bin", 100);
    const location = init.headers.get("Location")!;
    const del = await h.fetch(location, { method: "DELETE", headers: TUS });
    expect(del.status).toBe(204);
    const head = await h.fetch(location, { method: "HEAD", headers: TUS });
    expect(head.status).toBe(404);
  });

  test("creation-with-upload sends the first chunk inline", async () => {
    const data = bytes(64);
    const res = await h.fetch("/api/uploads", {
      method: "POST",
      headers: {
        ...TUS,
        "Upload-Length": String(data.byteLength),
        "Upload-Metadata": meta("inline.bin"),
        "content-type": "application/offset+octet-stream",
      },
      body: data,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Upload-Offset")).toBe("64");
    const get = await h.fetch("/api/storage/inline.bin");
    expect(new Uint8Array(await get.arrayBuffer()).byteLength).toBe(64);
  });

  test("init beyond Tus-Max-Size is rejected with 413", async () => {
    const big = makeHarness({ UPLOAD_MAX_BYTES: "1024" });
    try {
      await seedAdmin(big);
      const res = await big.fetch("/api/uploads", {
        method: "POST",
        headers: { ...TUS, "Upload-Length": "999999", "Upload-Metadata": meta("toobig.bin") },
      });
      expect(res.status).toBe(413);
    } finally {
      big.cleanup();
    }
  });

  test("unauthenticated init is rejected", async () => {
    const res = await h.app.fetch(
      new Request("http://localhost:5173/api/uploads", {
        method: "POST",
        headers: { Origin: "http://localhost:5173", ...TUS, "Upload-Length": "10", "Upload-Metadata": meta("nope.bin") },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("the cron sweep aborts uploads past their TTL", async () => {
    const short = makeHarness({ UPLOAD_TTL_MS: "1" });
    try {
      await seedAdmin(short);
      const init = await short.fetch("/api/uploads", {
        method: "POST",
        headers: { ...TUS, "Upload-Length": "100", "Upload-Metadata": meta("stale.bin") },
      });
      expect(init.status).toBe(201);
      const location = init.headers.get("Location")!;
      // expiresAt = now + 1ms; wait past it so the sweep reliably sees it as due
      // even on a warm machine where create→sweep can fall in the same ms.
      await new Promise((r) => setTimeout(r, 15));
      const ctx = await buildContext(short.env);
      await sweepExpiredUploads(ctx);
      const head = await short.fetch(location, { method: "HEAD", headers: TUS });
      expect(head.status).toBe(404); // aborted → gone
    } finally {
      short.cleanup();
    }
  });
});
