import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, half, hint, image, int, money, ms, notes, num, phone, position, rel, sec, select, stacked, tabbed, text, ts } from "../dsl";

export const restaurant: SchemaTemplate = {
  id: "restaurant",
  label: "Restaurant",
  groups: ["Menu", "Front of house", "Orders", "Kitchen", "Staff"],
  description:
    "Toast/Square-grade restaurant ops: menus with categories, items and modifier groups, dietary flags, tables, reservations, and dine-in / takeout / delivery orders with line items — plus ingredient inventory with suppliers and recipes, waste logs, staff scheduling and delivery zones.",
  collections: [
    {
      slug: "menu_categories", group: "Menu", singular: "Menu category", plural: "Menu categories", defaultSort: "position",
      fields: [
        text("name", { required: true }),
        notes("description"),
        ...half(position(), bool("active", { default: true, label: "Active" })),
      ],
      samples: [{ name: "Starters", position: 1 }, { name: "Mains", position: 2 }, { name: "Desserts", position: 3 }],
    },
    {
      slug: "menu_items", group: "Menu", singular: "Menu item", plural: "Menu items", fts: true, defaultSort: "name",
      fields: tabbed(
        sec("Item", [
          ...half(text("name", { required: true, searchable: true }), rel("category", "menu_categories")),
          notes("description", { searchable: true }),
          ...half(money("price", { required: true }), money("cost", { label: "Food cost" })),
          ...half(position("category"), bool("available", { default: true, label: "Available" })),
          image("image"),
        ]),
        sec("Kitchen", [
          ...half(
            int("prep_minutes", { default: 0, label: "Prep time (min)", validation: { min: 0 } }),
            int("calories", { validation: { min: 0 } }),
          ),
        ]),
        sec("Dietary", [
          ...half(bool("vegetarian", { default: false, label: "Vegetarian" }), bool("vegan", { default: false, label: "Vegan" })),
          ...half(bool("gluten_free", { default: false, label: "Gluten-free" }), bool("spicy", { default: false, label: "Spicy" })),
          notes("allergens", { description: "Anything a guest must be warned about, e.g. nuts, shellfish." }),
        ]),
      ),
      samples: [
        { name: "Bruschetta", description: "Toasted bread, tomato, basil.", category: { ref: "menu_categories:0" }, price: 8, vegetarian: true, position: 1 },
        { name: "Margherita Pizza", description: "Tomato, mozzarella, basil.", category: { ref: "menu_categories:1" }, price: 14, vegetarian: true, position: 1, allergens: "Contains gluten and dairy." },
      ],
    },
    {
      slug: "modifier_groups", group: "Menu", singular: "Modifier group", plural: "Modifier groups", defaultSort: "name",
      fields: [
        ...half(rel("menu_item", "menu_items"), text("name", { required: true })),
        ...half(int("min_select", { default: 0, label: "Min select" }), int("max_select", { default: 1, label: "Max select" })),
        bool("required", { default: false, label: "Required" }),
      ],
      samples: [{ menu_item: { ref: "menu_items:1" }, name: "Size", min_select: 1, max_select: 1, required: true }],
    },
    {
      slug: "modifiers", group: "Menu", singular: "Modifier", plural: "Modifiers", defaultSort: "name",
      fields: [rel("modifier_group", "modifier_groups"), ...half(text("name", { required: true }), money("price", { default: 0 }))],
      samples: [{ modifier_group: { ref: "modifier_groups:0" }, name: 'Large (14")', price: 4 }, { modifier_group: { ref: "modifier_groups:0" }, name: 'Regular (10")', price: 0 }],
    },
    {
      slug: "suppliers", group: "Kitchen", singular: "Supplier", plural: "Suppliers", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("contact_name", { label: "Contact name" })),
        ...half(phone("phone"), email("email")),
        bool("active", { default: true, label: "Active" }),
      ],
      samples: [
        { name: "Verde Produce Co.", contact_name: "Lena Ortiz", phone: "+15555550163", email: "orders@verdeproduce.example", active: true },
        { name: "Bella Dairy", contact_name: "Sam Aker", phone: "+15555550128", email: "sales@belladairy.example", active: true },
      ],
    },
    {
      slug: "ingredients", group: "Kitchen", singular: "Ingredient", plural: "Ingredients", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("unit", { default: "kg", label: "Unit" })),
        ...half(
          num("stock_qty", { default: 0, validation: { min: 0 }, label: "Stock qty" }),
          num("min_stock", { default: 0, validation: { min: 0 }, label: "Min stock" }),
        ),
        ...half(money("unit_cost", { label: "Unit cost" }), rel("supplier", "suppliers")),
      ],
      samples: [
        { name: "Tomatoes", unit: "kg", stock_qty: 24, min_stock: 10, unit_cost: 2.8, supplier: { ref: "suppliers:0" } },
        { name: "Mozzarella", unit: "kg", stock_qty: 12, min_stock: 6, unit_cost: 8.5, supplier: { ref: "suppliers:1" } },
        { name: "Basil", unit: "bunch", stock_qty: 15, min_stock: 8, unit_cost: 1.2, supplier: { ref: "suppliers:0" } },
      ],
    },
    {
      slug: "recipe_items", group: "Kitchen", singular: "Recipe item", plural: "Recipe items",
      fields: [
        ...half(rel("menu_item", "menu_items"), rel("ingredient", "ingredients")),
        ...half(num("qty", { default: 0, validation: { min: 0 } }), text("unit")),
      ],
      samples: [
        { menu_item: { ref: "menu_items:1" }, ingredient: { ref: "ingredients:0" }, qty: 0.15, unit: "kg" },
        { menu_item: { ref: "menu_items:1" }, ingredient: { ref: "ingredients:1" }, qty: 0.12, unit: "kg" },
        { menu_item: { ref: "menu_items:0" }, ingredient: { ref: "ingredients:0" }, qty: 0.08, unit: "kg" },
      ],
    },
    {
      slug: "tables", group: "Front of house", singular: "Table", plural: "Tables", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), int("seats", { default: 2, validation: { min: 1 } })),
        ...half(
          text("section"),
          select("status", [ch("available", C.green), ch("occupied", C.amber), ch("reserved", C.blue)], { default: "available" }),
        ),
      ],
      samples: [{ name: "T1", seats: 2, section: "Patio", status: "available" }, { name: "T2", seats: 4, section: "Main", status: "available" }],
    },
    {
      slug: "reservations", group: "Front of house", singular: "Reservation", plural: "Reservations", defaultSort: "-reserved_at",
      fields: stacked(
        sec("Guest", [
          ...half(text("name", { required: true }), int("party_size", { default: 2, validation: { min: 1 }, label: "Party size" })),
          ...half(email("email"), phone("phone")),
        ]),
        sec("Booking", [
          ...half(ts("reserved_at", { indexed: true, label: "Reserved at" }), rel("table", "tables")),
          select("status", [ch("pending", C.amber), ch("confirmed", C.green), ch("seated", C.blue), ch("completed", C.teal), ch("no_show", C.red, "No show"), ch("cancelled", C.gray)], { default: "pending" }),
          notes("notes"),
        ]),
      ),
      samples: [{ name: "Jordan Reed", email: "jordan@example.com", party_size: 4, reserved_at: ms("2026-07-04T19:00:00Z"), table: { ref: "tables:1" }, status: "confirmed" }],
    },
    {
      slug: "staff", group: "Staff", singular: "Staff member", plural: "Staff", defaultSort: "name",
      fields: [
        ...half(
          text("name", { required: true }),
          select("role", [ch("chef", C.amber), ch("server", C.blue), ch("host", C.teal), ch("manager", C.purple)], { default: "server" }),
        ),
        ...half(phone("phone"), bool("active", { default: true, label: "Active" })),
      ],
      samples: [
        { name: "Elena Rossi", role: "chef", phone: "+15555550151", active: true },
        { name: "Marcus Webb", role: "server", phone: "+15555550134", active: true },
        { name: "Priya Nair", role: "manager", phone: "+15555550119", active: true },
      ],
    },
    {
      slug: "shifts", group: "Staff", singular: "Shift", plural: "Shifts", defaultSort: "-shift_date",
      fields: [
        ...half(rel("staff", "staff"), date("shift_date", { indexed: true, label: "Date" })),
        ...half(text("start_time", { label: "Start" }), text("end_time", { label: "End" })),
        ...half(
          select("role", [ch("chef", C.amber), ch("server", C.blue), ch("host", C.teal), ch("manager", C.purple)], { default: "server" }),
          select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("no_show", C.red, "No show")], { default: "scheduled" }),
        ),
      ],
      samples: [
        { staff: { ref: "staff:0" }, shift_date: ms("2026-07-04"), start_time: "10:00", end_time: "18:00", role: "chef", status: "completed" },
        { staff: { ref: "staff:1" }, shift_date: ms("2026-07-11"), start_time: "16:00", end_time: "23:00", role: "server", status: "scheduled" },
      ],
    },
    {
      slug: "delivery_zones", group: "Orders", singular: "Delivery zone", plural: "Delivery zones", defaultSort: "name",
      fields: [
        text("name", { required: true }),
        notes("postal_codes", { label: "Postal codes" }),
        ...half(money("delivery_fee", { label: "Delivery fee" }), money("min_order", { label: "Min order" })),
      ],
      samples: [
        { name: "Downtown", postal_codes: "10001, 10002, 10003", delivery_fee: 3.5, min_order: 15 },
        { name: "Riverside", postal_codes: "10011, 10012", delivery_fee: 5, min_order: 25 },
      ],
    },
    {
      slug: "orders", group: "Orders", singular: "Order", plural: "Orders", defaultSort: "-opened_at",
      fields: stacked(
        sec("Order", [
          ...half(text("number", { unique: true }), ts("opened_at", { indexed: true, label: "Opened at" })),
          ...half(
            select("type", [ch("dine_in", C.blue, "Dine-in"), ch("takeout", C.teal), ch("delivery", C.purple)], { default: "dine_in" }),
            select("status", [ch("open", C.blue), ch("preparing", C.amber), ch("served", C.teal), ch("paid", C.green), ch("voided", C.red)], { default: "open" }),
          ),
          ...half(rel("table", "tables"), rel("server", "staff", { label: "Server" })),
          rel("delivery_zone", "delivery_zones", { label: "Delivery zone" }),
        ]),
        sec("Totals", [
          ...half(money("subtotal"), money("tax")),
          ...half(money("tip"), money("total")),
        ]),
      ),
      samples: [
        { number: "R-1001", table: { ref: "tables:1" }, server: { ref: "staff:1" }, type: "dine_in", status: "open", subtotal: 22, tax: 1.9, total: 23.9, opened_at: ms("2026-07-04T19:15:00Z") },
        { number: "R-1002", type: "delivery", delivery_zone: { ref: "delivery_zones:0" }, status: "preparing", subtotal: 28, tax: 2.4, total: 33.9, opened_at: ms("2026-07-04T19:40:00Z") },
      ],
    },
    {
      slug: "order_items", group: "Orders", singular: "Order item", plural: "Order items",
      fields: [
        hint("rest_line_total", "Line total is generated as qty × unit price."),
        ...half(rel("order", "orders"), rel("menu_item", "menu_items")),
        ...half(int("qty", { default: 1, validation: { min: 1 } }), money("unit_price")),
        computedNum("line_total", "qty * unit_price", { label: "Line total" }),
        notes("special_requests", { label: "Special requests" }),
      ],
      samples: [{ order: { ref: "orders:0" }, menu_item: { ref: "menu_items:0" }, qty: 1, unit_price: 8 }, { order: { ref: "orders:0" }, menu_item: { ref: "menu_items:1" }, qty: 1, unit_price: 14 }],
    },
    {
      slug: "waste_logs", group: "Kitchen", singular: "Waste log", plural: "Waste logs", defaultSort: "-logged_at",
      fields: [
        ...half(rel("ingredient", "ingredients"), num("qty", { default: 0, validation: { min: 0 } })),
        ...half(
          select("reason", [ch("spoiled", C.red), ch("prep_error", C.amber, "Prep error"), ch("expired", C.slate)], { default: "spoiled" }),
          money("cost"),
        ),
        ts("logged_at", { indexed: true, label: "Logged at" }),
      ],
      samples: [
        { ingredient: { ref: "ingredients:1" }, qty: 1.5, reason: "spoiled", logged_at: ms("2026-07-03T21:30:00Z"), cost: 12.75 },
        { ingredient: { ref: "ingredients:2" }, qty: 3, reason: "expired", logged_at: ms("2026-07-05T09:00:00Z"), cost: 3.6 },
      ],
    },
  ],
  roles: [
    {
      name: "Server",
      description: "Front-of-house: seat tables, take reservations and run orders.",
      permissions: [
        { collection: "menu_categories", action: "read" },
        { collection: "menu_items", action: "read" },
        { collection: "modifier_groups", action: "read" },
        { collection: "modifiers", action: "read" },
        { collection: "delivery_zones", action: "read" },
        { collection: "tables", action: "read" },
        { collection: "tables", action: "update" },
        { collection: "reservations", action: "read" },
        { collection: "reservations", action: "create" },
        { collection: "reservations", action: "update" },
        { collection: "orders", action: "read" },
        { collection: "orders", action: "create" },
        { collection: "orders", action: "update" },
        { collection: "order_items", action: "read" },
        { collection: "order_items", action: "create" },
        { collection: "order_items", action: "update" },
      ],
    },
    {
      name: "Kitchen manager",
      description: "Own the menu, ingredient inventory, recipes, waste and staff scheduling.",
      permissions: [
        { collection: "menu_categories", action: "read" },
        { collection: "menu_categories", action: "create" },
        { collection: "menu_categories", action: "update" },
        { collection: "menu_items", action: "read" },
        { collection: "menu_items", action: "create" },
        { collection: "menu_items", action: "update" },
        { collection: "modifier_groups", action: "read" },
        { collection: "modifier_groups", action: "create" },
        { collection: "modifier_groups", action: "update" },
        { collection: "modifiers", action: "read" },
        { collection: "modifiers", action: "create" },
        { collection: "modifiers", action: "update" },
        { collection: "suppliers", action: "read" },
        { collection: "suppliers", action: "create" },
        { collection: "suppliers", action: "update" },
        { collection: "ingredients", action: "read" },
        { collection: "ingredients", action: "create" },
        { collection: "ingredients", action: "update" },
        { collection: "recipe_items", action: "read" },
        { collection: "recipe_items", action: "create" },
        { collection: "recipe_items", action: "update" },
        { collection: "waste_logs", action: "read" },
        { collection: "waste_logs", action: "create" },
        { collection: "staff", action: "read" },
        { collection: "shifts", action: "read" },
        { collection: "shifts", action: "create" },
        { collection: "shifts", action: "update" },
        { collection: "orders", action: "read" },
        { collection: "order_items", action: "read" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Restaurant overview",
      description: "Order flow, revenue, reservations and kitchen waste.",
      panels: [
        { name: "Orders", kind: "items-aggregate", viz: "counter", config: { collection: "orders", agg: "count" } },
        { name: "Revenue", kind: "items-aggregate", viz: "counter", config: { collection: "orders", agg: "sum", field: "total" } },
        { name: "Reservations", kind: "items-aggregate", viz: "counter", config: { collection: "reservations", agg: "count" } },
        { name: "Covers booked", kind: "items-aggregate", viz: "counter", config: { collection: "reservations", agg: "sum", field: "party_size" } },
        { name: "Waste cost", kind: "items-aggregate", viz: "counter", config: { collection: "waste_logs", agg: "sum", field: "cost" } },
        { name: "Orders by status", kind: "items-aggregate", viz: "donut", config: { collection: "orders", agg: "count", groupBy: "status" } },
        { name: "Orders by type", kind: "items-aggregate", viz: "bars", config: { collection: "orders", agg: "count", groupBy: "type" } },
        { name: "Waste by reason", kind: "items-aggregate", viz: "bars", config: { collection: "waste_logs", agg: "count", groupBy: "reason" } },
      ],
    },
  ],
};
