import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, waitFor } from "@testing-library/react";
import { FlowBuilder } from "../../src/client/admin/pages/automation/flow-builder";
import { compileGraph, FlowCompileError, triggerKeyOf } from "../../src/client/admin/pages/automation/flow-graph";
import { renderWithProviders } from "./render";

// The builder's trigger node printed `config.collection || "posts"` for every
// kind but a date schedule. Only item triggers carry a collection, so a cron, a
// webhook and a sign-up trigger all read "on posts" (#382) — and a new trigger
// defaulted to `posts`, a collection most workspaces do not have.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/collections")) {
      return json({ data: [{ slug: "orders", fields: [] }, { slug: "discounts", fields: [] }] });
    }
    return json({ data: [] });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const trigger = (type: string, config: Record<string, unknown>) => ({
  id: "f1",
  name: "Flow",
  enabled: false,
  nodes: [{ id: "n1", kind: "trigger", type, x: 60, y: 160, config }],
  edges: [],
});

const renderBuilder = (initial?: ReturnType<typeof trigger>) =>
  renderWithProviders(
    <FlowBuilder initial={initial} onClose={() => {}} onSave={() => {}} pushToast={() => {}} />,
  );

/** The canvas node's body — the rail repeats some of the same words. */
const nodeBody = () => document.querySelector(".fb-node-trigger .fb-node-body")?.textContent ?? "";

describe("the builder's trigger node", () => {
  test("a cron trigger reads its cadence and pattern, not a collection", () => {
    renderBuilder(trigger("cron", { cron: "0 3 * * *" }));
    expect(nodeBody()).toContain("Every day at 03:00");
    expect(nodeBody()).toContain("0 3 * * *");
    expect(nodeBody()).not.toContain("posts");
  });

  test("a webhook trigger names its endpoint", () => {
    renderBuilder(trigger("webhook", {}));
    expect(nodeBody()).toBe("POST /api/webhook/f1");
  });

  test("a sign-up trigger says nothing its header does not", () => {
    renderBuilder(trigger("auth.signup", {}));
    expect(nodeBody()).toBe("");
  });

  test("an item trigger names its collection, and `*` reads as any collection", () => {
    renderBuilder(trigger("item.created", { collection: "orders", when: "" }));
    expect(nodeBody()).toBe("on orders");
    cleanup();
    renderBuilder(trigger("item.created", { collection: "*", when: "" }));
    expect(nodeBody()).toBe("on any collection");
  });

  test("a new flow asks for a collection instead of assuming `posts`", () => {
    renderBuilder();
    expect(nodeBody()).toBe("Pick a collection");
  });

  test("the collection picker offers this workspace's collections", async () => {
    renderBuilder(trigger("item.updated", { collection: "orders", when: "" }));
    // The inspector opens on the trigger; its picker shows the saved slug
    // rather than a blank from a hard-coded blog list.
    await waitFor(() => {
      const picker = [...document.querySelectorAll("button[role=combobox]")].find((b) =>
        b.textContent?.includes("orders"),
      );
      expect(picker).toBeDefined();
    });
  });
});

describe("trigger keys", () => {
  const graph = (config: Record<string, unknown>, type = "item.created") => ({
    nodes: [
      { id: "n1", kind: "trigger" as const, type, x: 0, y: 0, config },
      { id: "n2", kind: "action" as const, type: "log", x: 0, y: 0, config: { message: "hi" } },
    ],
    edges: [{ from: "n1", to: "n2", branch: null }],
  });

  test("an item trigger with no collection is refused, not saved as every collection", () => {
    expect(() => compileGraph(graph({ collection: "", when: "" }))).toThrow(FlowCompileError);
    expect(compileGraph(graph({ collection: "*", when: "" })).trigger).toBe("event:items:*:created");
    expect(compileGraph(graph({ collection: "orders", when: "" })).trigger).toBe("event:items:orders:created");
  });

  test("triggerKeyOf is the saved key, or null while the node cannot be saved", () => {
    const node = (type: string, config: Record<string, unknown>) => ({ id: "n1", kind: "trigger" as const, type, x: 0, y: 0, config });
    expect(triggerKeyOf(node("cron", { cron: "0 3 * * *" }))).toBe("cron:0 3 * * *");
    expect(triggerKeyOf(node("cron", { cron: "" }))).toBeNull();
    expect(triggerKeyOf(node("webhook", {}))).toBe("webhook");
    expect(triggerKeyOf(node("auth.signup", {}))).toBe("event:auth:signup");
    expect(triggerKeyOf(node("schedule", { collection: "orders", field: "" }))).toBeNull();
    expect(triggerKeyOf(node("item.published", { collection: "posts" }))).toBeNull();
  });
});
