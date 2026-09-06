/**
 * `/api/graphql/stream` pays the same parse budget as `/api/graphql`.
 *
 * Faz 7 put a document-size cap and `overBudget` in front of `parse` on the
 * non-streaming door, ahead of the AST so a document nobody can afford never
 * builds one. The stream door is a *second entry point* to the same parser and
 * it reached `parse` directly — no size cap, no budget. Not the fragment
 * fan-out Faz 7 fixed (this path does not walk fragments), just an unbudgeted
 * parse of an arbitrary-size body: parse time and memory with nothing declining
 * it. See #327, and "a guarantee is only as wide as its callers".
 *
 * The assertions drive the HTTP door rather than calling the helper, because
 * the defect was never in the helper — the budget existed and worked. The
 * defect was one caller not reaching it, and only a request can show that.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { MAX_DOCUMENT_CHARS, DEFAULT_MAX_DEPTH } from "../src/server/services/graphql/cost";

const json = { "Content-Type": "application/json" };
const STREAM = "/api/graphql/stream";

describe("the GraphQL stream door's parse budget", () => {
  let h: TestHarness;

  const post = (body: unknown) =>
    h.fetch(STREAM, { method: "POST", headers: json, body: JSON.stringify(body) });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug: "streamed", fields: [{ name: "name", type: "text" }] }),
    });
    expect(made.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("an over-size document is refused before it is parsed", async () => {
    // Padding goes in a COMMENT so the document stays syntactically valid: a
    // refusal on a document that would have failed to parse anyway proves
    // nothing about the size cap.
    const pad = "#".padEnd(MAX_DOCUMENT_CHARS + 1_000, "x");
    const query = `${pad}\nsubscription { items(collection: "streamed") { id } }`;
    expect(query.length).toBeGreaterThan(MAX_DOCUMENT_CHARS);

    const res = await post({ query });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("too large");
  });

  test("a document inside the size cap but over the DEPTH budget is refused", async () => {
    // Distinct from the size cap: small, and still unaffordable, so only
    // `overBudget` can catch it — a size check alone would go green here for
    // the wrong reason.
    //
    // Depth rather than aliases on purpose. An over-alias subscription has many
    // ROOT fields, and `parseSubscription` refuses more than one root field on
    // its own — so an alias test passes whether or not the budget ever runs,
    // which is precisely the vacuous pass this file is trying not to be. A deep
    // document keeps exactly one root field, so the ONLY thing that can refuse
    // it is the budget.
    const depth = DEFAULT_MAX_DEPTH + 8;
    let inner = "id";
    for (let i = 0; i < depth; i++) inner = `f${i} { ${inner} }`;
    const query = `subscription { items(collection: "streamed") { ${inner} } }`;
    expect(query.length).toBeLessThan(MAX_DOCUMENT_CHARS);

    const res = await post({ query });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { message?: string } };
    // Named so a refusal that happens to come from the shape check — "exactly
    // one root field", "collection not found" — cannot be mistaken for the
    // budget doing its job.
    expect(body.error?.message ?? "").toContain("deeply nested");
  });

  test("the GET shape is budgeted too, not just POST", async () => {
    // graphql-sse's distinct-connections mode uses GET. A budget on one verb
    // and not the other is the same defect one door further in.
    const pad = "#".padEnd(MAX_DOCUMENT_CHARS + 1_000, "x");
    const query = `${pad}\nsubscription { items(collection: "streamed") { id } }`;
    const res = await h.fetch(`${STREAM}?query=${encodeURIComponent(query)}`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("too large");
  });

  test("an ordinary subscription is NOT refused by the budget", async () => {
    // The vacuous-pass guard. Everything above would also pass on a door that
    // refuses every document, which would be a worse bug than the one being
    // fixed.
    const res = await post({
      query: `subscription { items(collection: "streamed") { id name } }`,
    });
    expect(res.status).not.toBe(422);
  });

  test("a document with no subscription operation still reports that, not a budget error", async () => {
    // The budget runs BEFORE the shape check, so an affordable-but-wrong
    // document must still get its own message rather than being swallowed.
    const res = await post({ query: `query { items(collection: "streamed") { id } }` });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("subscription");
  });
});
