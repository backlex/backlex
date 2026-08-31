/**
 * The Postgres half of `localized-permission-condition`.
 *
 * The bug it guards was DIALECT-SPLIT, and measuring both halves is what made
 * that visible. A permission condition on a `localized` column compiled to a
 * bare `"region"`, and the base table has no such column:
 *
 *   SQLite/D1  → a double-quoted identifier matching no column is a STRING
 *                LITERAL, so the predicate became `'region' != 'confidential'`,
 *                always true. Restricted rows came back. Silent.
 *   Postgres   → `column "region" does not exist`. A hard error.
 *
 * So on the dialect that ships to D1 tenants it failed OPEN and nobody saw it,
 * while on Postgres it would have failed loudly the first time anyone tried.
 * This file exists because a fix measured on one dialect is a fix for one
 * dialect: the correlated sidecar subquery has to be valid SQL on both, and the
 * answer has to be the same on both.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

let harness: PgTestHarness | undefined;
const slug = `lpcpg_${Date.now()}`;
let token = "";

beforeAll(async () => {
  harness = (await makeHarnessPgOrFail("localized-perm-cond-pg")) ?? undefined;
  if (!harness) return;
  const h = harness;
  const signUp = await h.fetch(
    "/api/auth/sign-up/email",
    json("POST", { email: `pg-lpc-${Date.now()}@example.test`, password: "correct-horse-battery", name: "A" }),
  );
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  await h.fetch("/api/admin/settings", json("PATCH", { i18nLocales: ["en", "tr"], i18nDefaultLocale: "en" }));
  const created = await h.fetch(
    "/api/collections",
    json("POST", {
      slug,
      fields: [
        { name: "title", type: "text" },
        { name: "region", type: "text", localized: true },
      ],
    }),
  );
  if (created.status !== 201) throw new Error(`collection failed: ${created.status}`);

  for (const [title, region] of [
    ["clean", { en: "public", tr: "public" }],
    ["dirty", { en: "confidential", tr: "confidential" }],
    ["mixed", { en: "public", tr: "confidential" }],
  ] as const) {
    const r = await h.fetch(`/api/items/${slug}`, json("POST", { title, region }));
    if (r.status !== 201) throw new Error(`seed ${title} failed: ${r.status}`);
  }

  const roles = await h.fetch("/api/roles");
  const roleId = ((await roles.json()) as { data: { id: string; name: string }[] }).data.find(
    (r) => r.name === "authenticated",
  )!.id;
  const granted = await h.fetch(
    `/api/roles/${roleId}/permissions`,
    json("POST", { collection: slug, action: "read", condition: { region: { _neq: "confidential" } } }),
  );
  if (granted.status >= 300) throw new Error(`grant failed: ${granted.status}`);

  const invited = await h.fetch("/api/app-users/invite", json("POST", { email: `pg-u-${Date.now()}@cond.test` }));
  if (invited.status !== 201) throw new Error(`invite failed: ${invited.status}`);
  const { data } = (await invited.json()) as { data: { token: string } };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "cond-pass-12345" }),
  );
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status}`);
  token = ((await accepted.json()) as { token: string }).token;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

const skipped = (): boolean => !harness;

test(
  "the rule is enforced on Postgres too, and gives the same answer in every locale mode",
  async () => {
    if (skipped()) return;
    const h = harness!;
    const titles = async (qs: string): Promise<string[]> => {
      const res = await h.app.request(`/api/items/${slug}${qs}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // A 500 here is the OLD Postgres failure — `column "region" does not
      // exist` — which is what the bare identifier produced on this dialect.
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { title: string }[] }).data.map((r) => r.title).sort();
    };
    for (const qs of ["", "?locale=en", "?locale=tr", "?locale=*"]) {
      expect(await titles(qs)).toEqual(["clean", "mixed"]);
    }
  },
  PGLITE_TEST_TIMEOUT_MS,
);
