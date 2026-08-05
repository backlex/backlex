/**
 * Regression: the two SAML metadata-import endpoints must fetch through
 * `fetchOutbound` like every other admin-supplied URL in the product.
 *
 * `POST /api/admin/saml/providers/import-metadata` and its platform twin take a
 * `metadataUrl` from an admin and have the worker fetch it, which is the
 * definition of a request-forgery sink. Every other such endpoint — outbound
 * webhooks, sync-hooks, the flow `request` op, OIDC discovery, the integrations
 * token exchange — already routes through `fetchOutbound`, which applies the
 * private-host block and re-validates every redirect hop when the guard is on.
 * These two were bare `fetch` calls, so on managed cloud (where the guard is
 * deliberately ON) a workspace admin could point one at an internal address and
 * read the outcome back through the parse result and through the status code the
 * error message carries.
 *
 * The guard is off by default on self-host, which is why these tests turn it on
 * explicitly: what is under test is that the endpoint CONSULTS it, not what the
 * default happens to be.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Addresses a metadata URL has no business reaching. The cloud metadata
 *  endpoint is the one that actually pays out — it hands back credentials. */
const PRIVATE = [
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://127.0.0.1:8787/api/admin/settings",
  "http://10.0.0.5/internal",
  "http://[::1]/x",
];

describe("tenant SAML metadata import", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness({ BLOCK_PRIVATE_FETCH_HOSTS: "1" });
    await seedAdmin(h);
  });

  test("refuses a private host instead of fetching it", async () => {
    for (const url of PRIVATE) {
      const r = await h.fetch(
        "/api/admin/saml/providers/import-metadata",
        json({ metadataUrl: url }),
      );
      // Anything but a successful fetch-and-parse. The point is that the request
      // is never made; the status only has to show it was refused.
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("a non-http scheme is refused too", async () => {
    const r = await h.fetch(
      "/api/admin/saml/providers/import-metadata",
      json({ metadataUrl: "file:///etc/hosts" }),
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test("inline XML still works — the guard only governs the FETCH", async () => {
    // Guards that quietly break the ordinary path are how they get turned off.
    // `metadataXml` never makes a request, so it must be unaffected.
    const r = await h.fetch(
      "/api/admin/saml/providers/import-metadata",
      json({ metadataXml: "<nonsense/>" }),
    );
    // It may well reject the XML as unparseable — what it must NOT do is fail
    // for a network-policy reason.
    const body = (await r.json()) as any;
    expect(JSON.stringify(body)).not.toContain("private");
  });
});

describe("platform SAML metadata import", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness({ BLOCK_PRIVATE_FETCH_HOSTS: "1", PLATFORM_SSO: "1" });
    await seedAdmin(h);
  });

  test("refuses a private host instead of fetching it", async () => {
    for (const url of PRIVATE) {
      const r = await h.fetch(
        "/api/platform/saml/providers/import-metadata",
        json({ metadataUrl: url }),
      );
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
  });
});
