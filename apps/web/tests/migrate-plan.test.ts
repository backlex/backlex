/**
 * @backlex/migrate unit tests — type mapping, plan building, topo order,
 * plan validation. Pure functions, no DB.
 */
import { describe, expect, test } from "bun:test";
import {
  buildPlan,
  collectionShapeMismatch,
  dedupeSlugsAgainst,
  mapColumn,
  mapPkType,
  parsePlan,
  sanitizeName,
  topoSort,
} from "../../../packages/migrate/src";
import type { SourceInspection } from "../../../packages/migrate/src";

describe("mapColumn", () => {
  test("scalar mappings mirror the adopt suggester", () => {
    expect(mapColumn({ name: "a", dbType: "character varying(80)", nullable: true })?.type).toBe("text");
    expect(mapColumn({ name: "a", dbType: "varchar(500)", nullable: true })?.type).toBe("longtext");
    expect(mapColumn({ name: "a", dbType: "text", nullable: true })?.type).toBe("longtext");
    expect(mapColumn({ name: "a", dbType: "bigint", nullable: true })?.type).toBe("integer");
    expect(mapColumn({ name: "a", dbType: "boolean", nullable: true })?.type).toBe("boolean");
    expect(mapColumn({ name: "a", dbType: "jsonb", nullable: true })?.type).toBe("json");
    expect(mapColumn({ name: "a", dbType: "timestamp with time zone", nullable: true })?.type).toBe("timestamp");
    expect(mapColumn({ name: "a", dbType: "uuid", nullable: true })?.type).toBe("uuid");
  });

  test("migration-only fallbacks: enum → text+choices, array → json, decimal warns", () => {
    const en = mapColumn({ name: "status", dbType: "enum", nullable: true, enumValues: ["a", "b"] });
    expect(en?.type).toBe("text");
    expect(en?.choices).toEqual(["a", "b"]);
    expect(en?.warning).toContain("enum");

    const arr = mapColumn({ name: "tags", dbType: "_text", nullable: true });
    expect(arr?.type).toBe("json");
    expect(arr?.warning).toContain("array");

    const dec = mapColumn({ name: "price", dbType: "numeric(10,2)", nullable: true });
    expect(dec?.type).toBe("number");
    expect(dec?.warning).toContain("decimal");
  });

  test("binary and unknown types have no copy target", () => {
    expect(mapColumn({ name: "blob", dbType: "bytea", nullable: true })).toBeNull();
    expect(mapColumn({ name: "geo", dbType: "geometry", nullable: true })).toBeNull();
  });

  test("mapPkType narrows to the collection pk types", () => {
    expect(mapPkType("uuid")).toBe("uuid");
    expect(mapPkType("bigint")).toBe("integer");
    expect(mapPkType("character varying(40)")).toBe("text");
    expect(mapPkType("bytea")).toBeNull();
  });
});

describe("sanitizeName", () => {
  test("snake_cases source identifiers", () => {
    expect(sanitizeName("fullName")).toBe("full_name");
    expect(sanitizeName("Order-Items")).toBe("order_items");
    expect(sanitizeName("2fa_codes")).toBe("t_2fa_codes");
  });
});

describe("topoSort", () => {
  test("parents come first; cycles are appended and reported", () => {
    const acyclic = topoSort(["b", "a", "c"], [["a", "b"], ["b", "c"]]);
    expect(acyclic.order).toEqual(["a", "b", "c"]);
    expect(acyclic.cyclic).toEqual([]);

    const cyclic = topoSort(["x", "y", "z"], [["x", "y"], ["y", "x"]]);
    expect(cyclic.order).toContain("z");
    expect(cyclic.cyclic.sort()).toEqual(["x", "y"]);
    expect(cyclic.order.length).toBe(3);
  });
});

const customers: SourceInspection = {
  table: "customers",
  columns: [
    { name: "id", dbType: "bigint", nullable: false },
    { name: "fullName", dbType: "character varying(120)", nullable: false },
    { name: "created_at", dbType: "timestamp with time zone", nullable: true },
    { name: "owner_id", dbType: "text", nullable: true },
  ],
  pk: { column: "id", dbType: "bigint" },
  foreignKeys: [],
};
const orders: SourceInspection = {
  table: "orders",
  columns: [
    { name: "id", dbType: "bigint", nullable: false },
    { name: "customer_id", dbType: "bigint", nullable: true },
    { name: "status", dbType: "enum", nullable: true, enumValues: ["pending", "shipped"] },
    { name: "attachment", dbType: "bytea", nullable: true },
  ],
  pk: { column: "id", dbType: "bigint" },
  foreignKeys: [
    { column: "customer_id", referencesTable: "customers", referencesColumn: "id", composite: false },
  ],
};
const nopk: SourceInspection = {
  table: "audit_log",
  columns: [{ name: "line", dbType: "text", nullable: true }],
  pk: null,
  foreignKeys: [],
};

describe("buildPlan", () => {
  const plan = buildPlan([orders, customers, nopk]);
  const byTable = new Map(plan.tables.map((t) => [t.table, t]));

  test("copy order puts FK parents first, over included tables only", () => {
    expect(plan.order).toEqual(["customers", "orders"]);
  });

  test("PK-less tables are excluded with a reason, not dropped silently", () => {
    const t = byTable.get("audit_log")!;
    expect(t.include).toBe(false);
    expect(t.reason).toContain("primary key");
  });

  test("system-column detection maps created_at out of the field list", () => {
    const t = byTable.get("customers")!;
    expect(t.createdAtColumn).toBe("created_at");
    expect(t.fields.some((f) => f.column === "created_at")).toBe(false);
  });

  test("reserved column names get a _src suffix + warning", () => {
    const t = byTable.get("customers")!;
    const f = t.fields.find((x) => x.column === "owner_id");
    expect(f?.name).toBe("owner_id_src");
    expect(t.warnings.some((w) => w.includes("owner_id"))).toBe(true);
  });

  test("single-column FKs to included tables become relations", () => {
    const t = byTable.get("orders")!;
    const rel = t.fields.find((f) => f.column === "customer_id");
    expect(rel?.type).toBe("relation");
    expect(rel?.to).toBe("customers");
  });

  test("unmappable columns are excluded with a warning; enums carry choices", () => {
    const t = byTable.get("orders")!;
    expect(t.fields.some((f) => f.column === "attachment")).toBe(false);
    expect(t.warnings.some((w) => w.includes("attachment"))).toBe(true);
    expect(t.fields.find((f) => f.column === "status")?.choices).toEqual([
      "pending",
      "shipped",
    ]);
  });

  test("integer PK propagates to pkType; NOT NULL propagates to required", () => {
    const t = byTable.get("customers")!;
    expect(t.pkType).toBe("integer");
    expect(t.fields.find((f) => f.column === "fullName")?.required).toBe(true);
    expect(t.fields.find((f) => f.column === "fullName")?.name).toBe("full_name");
  });

  test("the emitted plan round-trips through parsePlan", () => {
    expect(() => parsePlan(JSON.parse(JSON.stringify(plan)))).not.toThrow();
  });
});

describe("parsePlan", () => {
  test("rejects structural mistakes with readable messages", () => {
    expect(() => parsePlan({ version: 2 })).toThrow(/version/);
    const plan = buildPlan([customers]);
    const broken = JSON.parse(JSON.stringify(plan));
    broken.tables[0].slug = "Bad Slug";
    expect(() => parsePlan(broken)).toThrow(/snake_case/);

    const missingOrder = JSON.parse(JSON.stringify(plan));
    missingOrder.order = [];
    expect(() => parsePlan(missingOrder)).toThrow(/missing from order/);
  });
});

describe("collision handling (existing collections)", () => {
  const plan = () => buildPlan([orders, customers]);
  const incompatible = { pkType: "uuid", adopted: false, fields: [{ name: "title" }] };
  const compatibleFor = (slug: string) => {
    const t = plan().tables.find((x) => x.slug === slug)!;
    return { pkType: t.pkType, adopted: false, fields: t.fields.map((f) => ({ name: f.name })) };
  };
  test("mismatch: adopted / pkType / missing fields are all named", () => {
    const t = plan().tables.find((x) => x.slug === "customers")!;
    expect(collectionShapeMismatch(t, { ...incompatible, adopted: true })).toContain("adopted");
    expect(collectionShapeMismatch(t, incompatible)).toContain('pkType "uuid"');
    expect(
      collectionShapeMismatch(t, { pkType: "integer", adopted: false, fields: [] }),
    ).toContain("missing");
    expect(collectionShapeMismatch(t, compatibleFor("customers"))).toBeNull();
  });

  test("dedupe renames incompatible collisions and rewires relations", () => {
    const p = dedupeSlugsAgainst(plan(), new Map([["customers", incompatible]]));
    const cust = p.tables.find((t) => t.table === "customers")!;
    expect(cust.slug).toBe("customers_2");
    expect(cust.warnings.some((w) => w.includes('importing as "customers_2"'))).toBe(true);
    // The orders→customers relation follows the rename.
    const rel = p.tables.find((t) => t.table === "orders")!.fields.find((f) => f.type === "relation");
    expect(rel?.to).toBe("customers_2");
  });

  test("dedupe leaves compatible collisions alone (the resume path)", () => {
    const p = dedupeSlugsAgainst(plan(), new Map([["customers", compatibleFor("customers")]]));
    expect(p.tables.find((t) => t.table === "customers")!.slug).toBe("customers");
  });

  test("dedupe skips names other plan tables or collections already take", () => {
    const p = dedupeSlugsAgainst(
      plan(),
      new Map([
        ["customers", incompatible],
        ["customers_2", incompatible],
      ]),
    );
    expect(p.tables.find((t) => t.table === "customers")!.slug).toBe("customers_3");
  });
});
