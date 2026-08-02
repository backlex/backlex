/**
 * Multi-surface parity for availability & booking.
 *
 * The point of this gate is not that the surfaces exist — it is that they share
 * ONE implementation. Every one funnels through `services/booking.ts`, so the
 * rules that decide the whole feature's behaviour hold identically everywhere:
 * the capacity guarantee, the derived statuses, and the fact that only the
 * public path is confined to the published grid.
 *
 * The one place the surfaces deliberately DIFFER is who is told a token, and
 * that difference is asserted rather than assumed — REST, the SDK, GraphQL and
 * the CLI hand the page link and the manage link to the caller who just made
 * them; MCP does not, because a tool result is transcript that gets summarised,
 * forwarded and stored.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { bookingTools } from "../src/server/mcp/tools/booking";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let restoreLog: typeof console.log;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

const gql = async (query: string, variables?: Record<string, unknown>) => {
  const res = await h.fetch("/api/graphql", json("POST", { query, variables }));
  return (await res.json()) as { data?: any; errors?: { message: string; extensions?: any }[] };
};

const sdk = () =>
  createClient({ url: "http://local.test", fetch: (input: any, init: any) => h.fetch(String(input), init) });

const mcp = (name: string) => {
  const t = bookingTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing MCP tool ${name}`);
  return t;
};
const mcpCtx = () => ({ fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init) }) as any;

/** 2026-08-03 is a Monday; every resource here opens 09:00–12:00 UTC on one. */
const MONDAY_0900 = "2026-08-03T09:00:00.000Z";
const SUNDAY = "2026-08-02T00:00:00.000Z";
const MONDAY_END = "2026-08-04T00:00:00.000Z";

const RESOURCE = {
  name: "Dr Yilmaz",
  timeZone: "UTC",
  slotMinutes: 30,
  horizonDays: 365,
  rules: [{ kind: "open", weekday: 1, startMinute: 540, endMinute: 720 }],
};

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  restoreLog = console.log;
  console.log = (...args: unknown[]) => {
    if (!args.map(String).join(" ").startsWith("[email]")) restoreLog(...args);
  };
});
afterEach(() => {
  console.log = restoreLog;
  h.cleanup();
});

describe("REST", () => {
  test("creates a resource, lists slots and takes one", async () => {
    const created = await h.fetch(
      "/api/admin/booking/resources",
      json("POST", { key: "rest", ...RESOURCE }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    expect(body.data.token).toMatch(/^bkg_/);

    const slots = await (
      await h.fetch(`/api/public/book/${body.data.token}/slots?from=${SUNDAY}&to=${MONDAY_END}`)
    ).json();
    expect(slots.data.slots).toHaveLength(6);

    const booked = await h.fetch(
      `/api/public/book/${body.data.token}`,
      json("POST", { start: MONDAY_0900, email: "a@example.com" }),
    );
    expect(booked.status).toBe(201);
  });
});

describe("SDK", () => {
  test("drives the same paths and returns the tokens once", async () => {
    const c = sdk();
    const created = await c.booking.createResource({ key: "sdk", ...RESOURCE } as never);
    expect(created.data.token).toMatch(/^bkg_/);
    expect(created.data.url).toContain(`/book/${created.data.token}`);

    const slots = await c.booking.slots("sdk", { from: SUNDAY, to: MONDAY_END });
    expect(slots.data.slots).toHaveLength(6);

    const booked = await c.booking.book("sdk", { start: MONDAY_0900, email: "a@example.com" });
    expect(booked.data.booking.status).toBe("confirmed");
    expect(booked.data.manageToken).toMatch(/^bkm_/);

    const listed = await c.booking.listBookings({ resource: "sdk" });
    expect(listed.total).toBe(1);

    const cancelled = await c.booking.cancel(booked.data.booking.id, { notify: false });
    expect(cancelled.data.status).toBe("cancelled");
  });

  test("rotating a token through the SDK kills the old page link", async () => {
    const c = sdk();
    const created = await c.booking.createResource({ key: "sdk2", ...RESOURCE } as never);
    const rotated = await c.booking.rotateToken("sdk2");
    expect(rotated.data.token).not.toBe(created.data.token);
    expect((await h.fetch(`/api/public/book/${created.data.token}/slots`)).status).toBe(404);
  });
});

describe("GraphQL", () => {
  test("mirrors the resource, slot and booking paths", async () => {
    const made = await gql(
      `mutation ($key:String!,$name:String!,$rules:[BookingRuleInput!]) {
         createBookingResource(key:$key,name:$name,timeZone:"UTC",slotMinutes:30,horizonDays:365,rules:$rules) {
           token resource { key name timeZone rules { weekday startMinute } }
         }
       }`,
      { key: "gql", name: "Dr Yilmaz", rules: RESOURCE.rules },
    );
    expect(made.errors).toBeUndefined();
    expect(made.data.createBookingResource.token).toMatch(/^bkg_/);
    expect(made.data.createBookingResource.resource.rules[0].weekday).toBe(1);

    const slots = await gql(
      `query { bookingSlots(key:"gql", from:"${SUNDAY}", to:"${MONDAY_END}") { slots { start remaining } } }`,
    );
    expect(slots.data.bookingSlots.slots).toHaveLength(6);

    const booked = await gql(
      `mutation { createBooking(resource:"gql", start:"${MONDAY_0900}", name:"Ada") {
         manageToken booking { id status source } } }`,
    );
    expect(booked.errors).toBeUndefined();
    expect(booked.data.createBooking.booking.source).toBe("admin");

    const id = booked.data.createBooking.booking.id;
    const cancelled = await gql(
      `mutation { cancelBooking(id:"${id}", notify:false) { status } }`,
    );
    expect(cancelled.data.cancelBooking.status).toBe("cancelled");
  });

  test("a taken slot surfaces as CONFLICT rather than as a masked error", async () => {
    await gql(
      `mutation ($rules:[BookingRuleInput!]) {
         createBookingResource(key:"gqlc",name:"C",timeZone:"UTC",slotMinutes:30,horizonDays:365,rules:$rules) { token }
       }`,
      { rules: RESOURCE.rules },
    );
    await gql(`mutation { createBooking(resource:"gqlc", start:"${MONDAY_0900}") { booking { id } } }`);
    const clash = await gql(
      `mutation { createBooking(resource:"gqlc", start:"${MONDAY_0900}") { booking { id } } }`,
    );
    expect(clash.errors?.[0]?.extensions?.code).toBe("CONFLICT");
  });
});

describe("MCP", () => {
  test("covers the same operations", async () => {
    const names = bookingTools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "booking.list_resources",
        "booking.get_resource",
        "booking.create_resource",
        "booking.update_resource",
        "booking.slots",
        "booking.list",
        "booking.book",
        "booking.confirm",
        "booking.cancel",
        "booking.reschedule",
        "booking.no_show",
      ]),
    );
  });

  test("never hands a token back — a tool result is transcript", async () => {
    const created = await mcp("booking.create_resource").handler(
      { key: "mcp", ...RESOURCE },
      mcpCtx(),
    );
    const text = JSON.stringify(created);
    expect(text).not.toContain("bkg_");
    // The resource itself still comes back; it is only the credential that is
    // withheld.
    expect(text).toContain("Dr Yilmaz");

    const booked = await mcp("booking.book").handler(
      { resource: "mcp", start: MONDAY_0900, name: "Ada" },
      mcpCtx(),
    );
    const bookedText = JSON.stringify(booked);
    expect(bookedText).not.toContain("bkm_");
    expect(bookedText).toContain("confirmed");
  });

  test("reads the same slots the public page would", async () => {
    await mcp("booking.create_resource").handler({ key: "mcp2", ...RESOURCE }, mcpCtx());
    const out = await mcp("booking.slots").handler(
      { key: "mcp2", from: SUNDAY, to: MONDAY_END },
      mcpCtx(),
    );
    expect((out.structuredContent as any).data.slots).toHaveLength(6);
  });
});

describe("one implementation, not five", () => {
  test("only the PUBLIC path is confined to the published grid", async () => {
    const c = sdk();
    const created = await c.booking.createResource({ key: "grid", ...RESOURCE } as never);

    // Operator surfaces may book off-grid — that is what a phone call is.
    const viaSdk = await c.booking.book("grid", {
      start: "2026-08-03T15:07:00.000Z",
      end: "2026-08-03T15:37:00.000Z",
    });
    expect(viaSdk.data.booking.status).toBe("confirmed");

    const viaGql = await gql(
      `mutation { createBooking(resource:"grid", start:"2026-08-04T15:07:00.000Z", end:"2026-08-04T15:37:00.000Z") { booking { id } } }`,
    );
    expect(viaGql.errors).toBeUndefined();

    // The booker's own page may not.
    const viaPublic = await h.fetch(
      `/api/public/book/${created.data.token}`,
      json("POST", { start: "2026-08-05T15:07:00.000Z", email: "a@example.com" }),
    );
    expect(viaPublic.status).toBe(422);
  });

  test("the capacity guarantee holds no matter which surface asks", async () => {
    const c = sdk();
    await c.booking.createResource({ key: "cap", ...RESOURCE, capacity: 2 } as never);

    await c.booking.book("cap", { start: MONDAY_0900, name: "one" });
    const viaGql = await gql(
      `mutation { createBooking(resource:"cap", start:"${MONDAY_0900}", name:"two") { booking { id } } }`,
    );
    expect(viaGql.errors).toBeUndefined();

    // A third, across a third surface, still hits the same ceiling — and it
    // surfaces as a thrown CONFLICT rather than as a tool result the agent
    // could mistake for a successful booking.
    await expect(
      mcp("booking.book").handler({ resource: "cap", start: MONDAY_0900, name: "three" }, mcpCtx()),
    ).rejects.toThrow(/CONFLICT/);
  });

  test("the derived statuses are the same on every surface", async () => {
    const c = sdk();
    await c.booking.createResource({ key: "past", ...RESOURCE } as never);
    const made = await c.booking.book("past", {
      start: "2020-01-06T09:00:00.000Z",
      end: "2020-01-06T09:30:00.000Z",
    });

    // Nothing wrote `completed` anywhere; every surface derives it.
    expect((await c.booking.getBooking(made.data.booking.id)).data.status).toBe("completed");
    const viaGql = await gql(`query { booking(id:"${made.data.booking.id}") { status storedStatus } }`);
    expect(viaGql.data.booking.status).toBe("completed");
    expect(viaGql.data.booking.storedStatus).toBe("confirmed");
    const viaMcp = await mcp("booking.list").handler({ resource: "past" }, mcpCtx());
    expect((viaMcp.structuredContent as any).data[0].status).toBe("completed");
  });
});
