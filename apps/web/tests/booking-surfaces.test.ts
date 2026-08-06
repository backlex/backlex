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
import { parseQuestion } from "../../../packages/cli/src/booking";
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

/**
 * Every resource here opens 09:00–12:00 UTC on a Monday, and that Monday is
 * DERIVED rather than written down — a literal date turns "which slots are
 * still bookable" into a test that decays through the morning it names and
 * recovers the next day. See the same note in `booking.test.ts`.
 */
const nextMonday = (): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7));
  return d;
};
const MONDAY = nextMonday();
const mondayAt = (hh: number, mm = 0): string => {
  const d = new Date(MONDAY);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
};
const dayFromMonday = (offset: number): string => {
  const d = new Date(MONDAY);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString();
};
const MONDAY_0900 = mondayAt(9);
const SUNDAY = dayFromMonday(-1);
const MONDAY_END = dayFromMonday(1);
/** An off-grid time an operator may take but the public page may not offer.
 *  Three distinct days so the three surfaces don't collide on one slot. */
const offGrid = (dayOffset: number, hh: number, mm: number): string => {
  const d = new Date(MONDAY);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
};

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
      start: offGrid(0, 15, 7),
      end: offGrid(0, 15, 37),
    });
    expect(viaSdk.data.booking.status).toBe("confirmed");

    const viaGql = await gql(
      `mutation { createBooking(resource:"grid", start:"${offGrid(1, 15, 7)}", end:"${offGrid(1, 15, 37)}") { booking { id } } }`,
    );
    expect(viaGql.errors).toBeUndefined();

    // The booker's own page may not.
    const viaPublic = await h.fetch(
      `/api/public/book/${created.data.token}`,
      json("POST", { start: offGrid(2, 15, 7), email: "a@example.com" }),
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

  /**
   * The intake questions reach every surface. The CLI is the only one that has
   * to invent a grammar for them, so the grammar is what is pinned here — the
   * rest post the same object the admin does.
   */
  test("the CLI's --ask grammar produces what every other surface posts", () => {
    expect(parseQuestion("reason")).toEqual({
      name: "reason",
      label: "Reason",
      type: "text",
      required: false,
    });
    expect(parseQuestion("notes:textarea")).toMatchObject({ type: "textarea", required: false });
    expect(parseQuestion("insured!:boolean")).toMatchObject({ type: "boolean", required: true });
    expect(parseQuestion("reason_for_visit!=Check-up|Follow-up")).toEqual({
      name: "reason_for_visit",
      // The label the booker reads, rather than the key the answer is stored
      // under — typing it twice on a command line is a tax for the common case.
      label: "Reason for visit",
      type: "select",
      required: true,
      options: ["Check-up", "Follow-up"],
    });
    // Options are decisive on every surface, the public page included.
    expect(parseQuestion("size=S|M|L").type).toBe("select");

    expect(() => parseQuestion("Reason For Visit")).toThrow(/not a question name/);
    expect(() => parseQuestion("reason:dropdown")).toThrow(/not a question type/);
    expect(() => parseQuestion("reason:select")).toThrow(/nothing to choose from/);
  });

  test("the page's appearance is the same object on every surface", async () => {
    const c = sdk();
    const made = await c.booking.createResource({
      key: "look",
      ...RESOURCE,
      settings: { theme: "light", accent: "#34C79A", font: "lexend" },
    } as never);
    const look = { theme: "light", accent: "#34C79A", font: "lexend" };
    expect(made.data.resource.settings).toEqual(look);

    const viaGql = await gql(`query { bookingResource(key:"look") { settings } }`);
    expect(viaGql.data.bookingResource.settings).toEqual(look);

    const viaMcp = await mcp("booking.get_resource").handler({ key: "look" }, mcpCtx());
    expect((viaMcp.structuredContent as any).data.settings).toEqual(look);

    // And the page itself — it cannot paint what it was not handed.
    const res = await h.fetch(`/api/public/book/${made.data.token}/slots`);
    expect(((await res.json()) as any).data.resource.settings).toEqual(look);
  });

  test("a question set round-trips through the SDK", async () => {
    const c = sdk();
    const made = await c.booking.createResource({
      key: "asks",
      ...RESOURCE,
      questions: [parseQuestion("reason!=Check-up|Follow-up"), parseQuestion("insured:boolean")],
    } as never);
    expect(made.data.resource.questions).toHaveLength(2);

    // The public page is handed them too — it cannot ask what it was not told.
    const res = await h.fetch(`/api/public/book/${made.data.token}/slots`);
    const pub = (await res.json()) as any;
    expect(pub.data.resource.questions[0]).toMatchObject({
      name: "reason",
      type: "select",
      required: true,
    });
  });
});
