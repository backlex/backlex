import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Public form file-upload blocks — the anonymous upload endpoint (size / MIME
 * / rate-limit valves), the signed-ticket handshake on submit (raw storage
 * keys must never pass), cross-form ticket rejection, and the stale-upload
 * sweep. Mirrors the posture of forms.test.ts: admin traffic via `h.fetch`,
 * public traffic via a cookie-less `app.fetch`.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("public form file uploads", () => {
  let h: TestHarness;
  const slug = `apply_${Date.now()}`;
  let formId = "";
  let token = "";
  let otherToken = "";

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  const upload = (tok: string, field: string, file: File) => {
    const fd = new FormData();
    fd.append("field", field);
    fd.append("file", file);
    return publicFetch(`/api/public/forms/${tok}/upload`, {
      method: "POST",
      body: fd,
    });
  };

  const pngFile = (name = "cv.png", bytes = 1024) =>
    new File([new Uint8Array(bytes).fill(7)], name, { type: "image/png" });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const createCollection = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "full_name", type: "text", required: true, label: "Full name" },
          { name: "attachment", type: "file", label: "CV" },
        ],
      }),
    );
    expect(createCollection.status).toBe(201);

    const createForm = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Job application",
        collection: slug,
        fields: [
          { name: "full_name" },
          { name: "attachment", accept: ["image/*", "application/pdf"] },
        ],
      }),
    );
    expect(createForm.status).toBe(201);
    const body = (await createForm.json()) as {
      data: { form: { id: string }; token: string };
    };
    formId = body.data.form.id;
    token = body.data.token;

    const createOther = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Other form",
        collection: slug,
        fields: [{ name: "full_name" }, { name: "attachment" }],
      }),
    );
    expect(createOther.status).toBe(201);
    otherToken = ((await createOther.json()) as { data: { token: string } }).data
      .token;
  });

  afterAll(() => {
    h.cleanup();
  });

  test("file fields are form-eligible", async () => {
    const res = await h.fetch(`/api/admin/forms/eligible-fields/${slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string; type: string }[] };
    expect(body.data.find((f) => f.name === "attachment")?.type).toBe("file");
  });

  test("public definition exposes the file block with accept + effective cap", async () => {
    const res = await publicFetch(`/api/public/forms/${token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        blocks: Array<{
          name?: string;
          type?: string;
          accept: string[] | null;
          maxBytes: number | null;
        }>;
      };
    };
    const block = body.data.blocks.find((b) => b.name === "attachment");
    expect(block?.type).toBe("file");
    expect(block?.accept).toEqual(["image/*", "application/pdf"]);
    // No block-level cap set — falls back to the env ceiling (5 MiB default).
    expect(block?.maxBytes).toBe(5 * 1024 * 1024);
  });

  test("upload stores the file and returns a fut_ ticket", async () => {
    const res = await upload(token, "attachment", pngFile());
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { ticket: string; name: string; size: number; contentType: string | null };
    };
    expect(body.data.ticket.startsWith("fut_")).toBe(true);
    expect(body.data.name).toBe("cv.png");
    expect(body.data.size).toBe(1024);
    expect(body.data.contentType).toBe("image/png");
  });

  test("upload rejects a field that is not a file block", async () => {
    const res = await upload(token, "full_name", pngFile());
    expect(res.status).toBe(422);
  });

  test("upload rejects a disallowed MIME type", async () => {
    const file = new File([new Uint8Array(64)], "notes.txt", { type: "text/plain" });
    const res = await upload(token, "attachment", file);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("not accepted");
  });

  test("block-level maxBytes rejects an oversized upload", async () => {
    const patch = await h.fetch(`/api/admin/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "full_name" },
          { name: "attachment", accept: ["image/*"], maxBytes: 512 },
        ],
      }),
    });
    expect(patch.status).toBe(200);

    const res = await upload(token, "attachment", pngFile("big.png", 2048));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("too large");

    // Restore the roomy config for the remaining tests.
    const restore = await h.fetch(`/api/admin/forms/${formId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "full_name" },
          { name: "attachment", accept: ["image/*", "application/pdf"] },
        ],
      }),
    });
    expect(restore.status).toBe(200);
  });

  test("submit swaps the ticket for the stored key", async () => {
    const up = await upload(token, "attachment", pngFile("mine.png"));
    expect(up.status).toBe(201);
    const { ticket } = ((await up.json()) as { data: { ticket: string } }).data;

    const res = await publicFetch(`/api/public/forms/${token}/submit`, {
      ...json({ data: { full_name: "Ada", attachment: ticket } }),
    });
    expect(res.status).toBe(201);

    const rows = await h.fetch(`/api/items/${slug}`);
    const data = ((await rows.json()) as { data: Record<string, unknown>[] }).data;
    const mine = data.find((r) => r.full_name === "Ada");
    expect(String(mine?.attachment)).toStartWith(`form-uploads/${formId}/`);
    expect(String(mine?.attachment)).toEndWith(".png");
  });

  test("submit rejects a raw storage key for a file field", async () => {
    const res = await publicFetch(`/api/public/forms/${token}/submit`, {
      ...json({ data: { full_name: "Eve", attachment: "logo.png" } }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("upload is missing or expired");
  });

  test("submit rejects a ticket minted for another form", async () => {
    const up = await upload(otherToken, "attachment", pngFile("theirs.png"));
    expect(up.status).toBe(201);
    const { ticket } = ((await up.json()) as { data: { ticket: string } }).data;

    const res = await publicFetch(`/api/public/forms/${token}/submit`, {
      ...json({ data: { full_name: "Mallory", attachment: ticket } }),
    });
    expect(res.status).toBe(422);
  });

  test("an omitted optional file block just submits without it", async () => {
    const res = await publicFetch(`/api/public/forms/${token}/submit`, {
      ...json({ data: { full_name: "NoFile" } }),
    });
    expect(res.status).toBe(201);
  });

  test("per-form/IP upload rate limit trips", async () => {
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const res = await upload(token, "attachment", pngFile(`f${i}.png`, 64));
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(201);
    }
    expect(limited).toBe(true);
  });

  test("sweep deletes stale pending uploads but keeps consumed ones", async () => {
    const { buildContext } = await import("../src/server/context");
    const { sweepStaleFormUploads } = await import(
      "../src/server/services/form-uploads"
    );
    const ctx = await buildContext(h.env);

    // The submitted upload ("mine.png" → consumed) plus at least one pending
    // one from the earlier tests are in `files`. Backdate them ALL past the
    // 24h stale window — only rows still carrying the pending marker may go.
    const db = new Database(h.env.SQLITE_PATH!);
    const before = db
      .query<{ key: string; metadata: string | null }, []>(
        "SELECT key, metadata FROM files WHERE key LIKE 'tenants/%/form-uploads/%'",
      )
      .all();
    expect(before.length).toBeGreaterThan(1);
    const pendingBefore = before.filter((r) =>
      r.metadata?.includes("formUploadPending"),
    );
    const consumedBefore = before.filter(
      (r) => !r.metadata?.includes("formUploadPending"),
    );
    expect(pendingBefore.length).toBeGreaterThan(0);
    expect(consumedBefore.length).toBeGreaterThan(0);

    db.exec(
      `UPDATE files SET created_at = ${Date.now() - 25 * 60 * 60 * 1000} WHERE key LIKE 'tenants/%/form-uploads/%'`,
    );
    db.close();

    await sweepStaleFormUploads(ctx);

    const after = new Database(h.env.SQLITE_PATH!)
      .query<{ key: string; metadata: string | null }, []>(
        "SELECT key, metadata FROM files WHERE key LIKE 'tenants/%/form-uploads/%'",
      )
      .all();
    expect(after.some((r) => r.metadata?.includes("formUploadPending"))).toBe(false);
    for (const kept of consumedBefore) {
      expect(after.map((r) => r.key)).toContain(kept.key);
    }
  });
});
