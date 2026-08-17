import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, flag, half, hint, image, int, money, ms, notes, num, phone, position, rel, sec, select, seq, stacked, tabbed, text, ts } from "../dsl";

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
        ...half(position(), flag("active", { label: "Active" })),
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
          ...half(position("category"), flag("available", { label: "Available" })),
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
        flag("active", { label: "Active" }),
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
      kanbanGroupBy: "status",
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
        ...half(phone("phone"), flag("active", { label: "Active" })),
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
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Order", [
          ...half(seq("number", "R-{#####}"), ts("opened_at", { indexed: true, label: "Opened at" })),
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
        { table: { ref: "tables:1" }, server: { ref: "staff:1" }, type: "dine_in", status: "open", subtotal: 22, tax: 1.9, total: 23.9, opened_at: ms("2026-07-04T19:15:00Z") },
        { type: "delivery", delivery_zone: { ref: "delivery_zones:0" }, status: "preparing", subtotal: 28, tax: 2.4, total: 33.9, opened_at: ms("2026-07-04T19:40:00Z") },
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
  /**
   * The rules a service runs on, already running.
   *
   * Deliberately absent: "the check was paid, so take the ingredients down".
   * What a check consumed is three joins away — `order_items` names the menu
   * item, `recipe_items` says what that dish is made of, and only then does an
   * `ingredients` row have a quantity to lose — and a flow's `data` is the
   * order row alone. A step that decremented anything would be guessing at the
   * recipe, and a wrong depletion is worse than none because the stock figure
   * still reads as maintained. So the kitchen flows below report facts and
   * leave the count to whoever is holding the tub.
   *
   * Note also that NOTHING in this template's statuses declares a lifecycle
   * (`flow(...)` in the field's `select`), so no `…:transition:…` trigger
   * exists to fire once on a real move. The two table flows are therefore
   * `…:updated` plus a condition, which re-fires on every later edit of a row
   * that is already in that state — acceptable here only because both writes
   * are idempotent: setting an occupied table to `occupied` again changes
   * nothing. Nothing that MAILS a guest is triggered that way; those are
   * anchored on a date instead.
   */
  flows: [
    {
      name: "Chase a table that was booked half an hour ago and is still not seated",
      // Thirty minutes is the grace period a floor actually keeps, and a
      // schedule is what makes it fire ONCE per reservation rather than on
      // every save. Minutes, so `at` must be null — a wall clock ("30 minutes
      // before, at 09:00") names two different instants and is refused at save
      // time.
      trigger: `schedule:${JSON.stringify({
        collection: "reservations",
        field: "reserved_at",
        offset: { value: 30, unit: "minutes", direction: "after" },
        at: null,
        timeZone: null,
        where: { status: { _in: ["pending", "confirmed"] } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.name }} has not been seated",
          body: "Booked for {{ data.party_size }} at {{ data.reserved_at }} and still {{ data.status }}. Seat them, or mark it a no-show so the table can be released.",
          url: "/collections/reservations",
        },
      ],
    },
    {
      name: "Occupy a table the moment a dine-in check is opened",
      trigger: "event:items:orders:created",
      operations: [
        {
          type: "condition",
          // The order is what actually occupies a table, which is why this
          // hangs off the check and not off a reservation being confirmed: a
          // reservation is for a time in the FUTURE, and `tables.status`
          // describes the floor right now — marking a table `reserved` at
          // confirmation would black it out for every service in between.
          filter: { type: { _eq: "dine_in" }, table: { _null: false } },
          then: [
            {
              type: "item.update",
              collection: "tables",
              id: "{{ data.table }}",
              data: { status: "occupied" },
            },
          ],
        },
      ],
    },
    {
      name: "Free the table when the check is paid",
      trigger: "event:items:orders:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "paid" }, table: { _null: false } },
          then: [
            {
              type: "item.update",
              collection: "tables",
              id: "{{ data.table }}",
              data: { status: "available" },
            },
            {
              type: "notification",
              title: "Check {{ data.number }} paid",
              body: "{{ data.total }} on a {{ data.type }} check. The table is back on the floor as available.",
              url: "/collections/orders",
            },
          ],
        },
      ],
    },
    {
      name: "Ask for a reorder when an ingredient falls below its own minimum",
      // An event + `condition` rather than a nightly `foreach`, and the reason
      // is mechanical rather than stylistic: "below its own minimum" compares
      // two columns of the same row, and only the IN-MEMORY matcher a
      // `condition` step uses can resolve `$field.<sibling>`. A `foreach`
      // filter compiles to SQL, which has no such variable — there the
      // threshold would have to be a fixed number, and one number is wrong for
      // every ingredient except the one it was typed for.
      trigger: "event:items:ingredients:updated",
      operations: [
        {
          type: "condition",
          // `min_stock` above zero as well: an ingredient nobody has set a par
          // level on defaults to 0, and 0 ≤ 0 would chase every one of them.
          filter: { min_stock: { _gt: 0 }, stock_qty: { _lte: "$field.min_stock" } },
          then: [
            {
              type: "notification",
              title: "{{ data.name }} is down to {{ data.stock_qty }} {{ data.unit }}",
              body: "Below its par level of {{ data.min_stock }} {{ data.unit }}. Its Supplier is on the ingredient — raise the order from there.",
              url: "/collections/ingredients",
            },
          ],
        },
      ],
    },
    {
      name: "Remind a guest the day before their table (needs email)",
      // Off until a mail transport is configured. Anchored on the booking date
      // rather than on the status changing: the reservation carries its own
      // `email`, the schedule fires exactly once per row, and `where` excludes
      // the rows with no address to write to — an update trigger would re-send
      // the reminder every time the host edited a party size.
      active: false,
      trigger: `schedule:${JSON.stringify({
        collection: "reservations",
        field: "reserved_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 600,
        timeZone: null,
        where: { status: { _in: ["pending", "confirmed"] }, email: { _null: false } },
      })}`,
      operations: [
        {
          type: "email",
          to: "{{ data.email }}",
          subject: "Your table tomorrow",
          html: "<p>Hello {{ data.name }},</p><p>We have you down for {{ data.party_size }} at {{ data.reserved_at }}.</p><p>If anything has changed — the time, the number of covers, an allergy we should know about — just reply to this message.</p>",
        },
      ],
    },
    {
      name: "Monthly restaurant report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Restaurant overview",
          subject: "Restaurant — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "table_check",
      name: "Table check",
      description: "The bill as the guest is handed it.",
      filename: "check-{{ data.number }}",
      variables: ["number", "total"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A5;margin:10mm}" +
        "body{font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:19px;margin:0 0 3px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px 5px;border-bottom:1px solid #e5e5e5}" +
        "td.n,th.n{text-align:right}" +
        ".totals{margin-top:12px;width:100%}" +
        ".totals td{border:0;padding:3px 5px}" +
        "</style></head><body>" +
        "<h1>Check {{ data.number }}</h1>" +
        '<p class="muted">Opened {{ data.opened_at }} · {{ data.type }}</p>' +
        '<table><thead><tr><th>Item</th><th class="n">Qty</th>' +
        '<th class="n">Unit</th><th class="n">Line total</th></tr></thead><tbody>' +
        "<!-- one row per order item; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        '<table class="totals"><tr><td class="n">Subtotal</td><td class="n">{{ data.subtotal }}</td></tr>' +
        '<tr><td class="n">Tax</td><td class="n">{{ data.tax }}</td></tr>' +
        '<tr><td class="n">Tip</td><td class="n">{{ data.tip }}</td></tr>' +
        '<tr><td class="n"><strong>Total</strong></td>' +
        '<td class="n"><strong>{{ data.total }}</strong></td></tr></table>' +
        '<p class="muted">Service is not included unless a tip is printed above. ' +
        "Please tell your server about any allergy before ordering — the kitchen " +
        "keeps an allergen note against every dish.</p>" +
        "</body></html>",
      pageOptions: { format: "A5", margin: "10mm" },
    },
    {
      key: "menu_item_spec",
      name: "Menu item spec sheet",
      description: "The card a section hangs by the pass: how a dish is built, what it costs, what it contains.",
      filename: "spec-{{ data.name }}",
      // `allergens` is deliberately NOT required here even though it is the most
      // important line on the page: a dish with nothing to declare leaves it
      // empty, and refusing to render those would mean the sheet only exists for
      // the risky half of the menu.
      variables: ["name", "price"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 4px}" +
        "h2{font-size:14px;margin:22px 0 4px}" +
        ".muted{color:#666}" +
        ".warn{border:1px solid #dc2626;color:#dc2626;padding:8px 10px;margin-top:16px}" +
        "table{width:100%;border-collapse:collapse;margin-top:8px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "</style></head><body>" +
        "<h1>{{ data.name }}</h1>" +
        '<p class="muted">{{ data.description }}</p>' +
        "<table>" +
        "<tr><th>Menu price</th><td>{{ data.price }}</td></tr>" +
        "<tr><th>Food cost</th><td>{{ data.cost }}</td></tr>" +
        "<tr><th>Prep time</th><td>{{ data.prep_minutes }} min</td></tr>" +
        "<tr><th>Calories</th><td>{{ data.calories }}</td></tr>" +
        "<tr><th>Vegetarian / vegan</th><td>{{ data.vegetarian }} / {{ data.vegan }}</td></tr>" +
        "<tr><th>Gluten-free / spicy</th><td>{{ data.gluten_free }} / {{ data.spicy }}</td></tr>" +
        "</table>" +
        '<div class="warn"><strong>Allergens:</strong> {{ data.allergens }}</div>' +
        "<h2>Recipe</h2>" +
        "<table><thead><tr><th>Ingredient</th><th>Quantity</th></tr></thead><tbody>" +
        "<!-- one row per recipe item; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        '<p class="muted">Food cost is per portion at the quantities above. Restate ' +
        "it whenever an ingredient's unit cost moves, or the margin on this dish is " +
        "a number nobody can defend.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "18mm" },
    },
  ],
  forms: [
    {
      // `status` is left off on purpose. Every request arrives `pending` — the
      // field's own default — and the host decides; a guest who could pick
      // `confirmed` would be booking themselves in. `table` is a relation, so it
      // is not form-eligible anyway, which is the right answer twice over: the
      // host assigns the table once they can see the plan.
      name: "Book a table",
      collection: "reservations",
      settings: {
        submitLabel: "Request a table",
        successMessage:
          "Thank you — we'll confirm by email or phone. Nothing is held until we do.",
      },
      fields: [
        { name: "name", label: "Your name" },
        { name: "party_size", label: "Party size", help: "How many people, including you." },
        { name: "reserved_at", label: "Date and time" },
        { name: "email", label: "Email" },
        { name: "phone", label: "Phone", help: "So we can reach you on the day if anything changes." },
        {
          name: "notes",
          label: "Anything we should know?",
          help: "A high chair, step-free access, an allergy, a birthday.",
        },
      ],
    },
    {
      // `active` stays off the form: a supplier is in play once the kitchen says
      // so, not once they have filled a form in. The column defaults to true, so
      // exposing it would let an applicant switch themselves on.
      name: "Kitchen supplier details",
      collection: "suppliers",
      settings: {
        submitLabel: "Send details",
        successMessage: "Received — the kitchen will be in touch about ordering.",
      },
      fields: [
        { name: "name", label: "Company name" },
        { name: "contact_name", label: "Who we speak to" },
        { name: "phone", label: "Phone" },
        { name: "email", label: "Orders email", help: "Where our orders should be sent." },
      ],
    },
  ],
  agents: [
    {
      name: "Restaurant assistant",
      handle: "restaurant-assistant",
      description: "Answers questions about service, the menu and the kitchen's stock.",
      systemPrompt:
        "You help a restaurant run its service. Answer questions about menu " +
        "items, tables, reservations, orders, ingredients, waste and staff " +
        "shifts using the workspace's own data. Money is only real once an " +
        "order's status is `paid` — never count `voided` orders as sales, and " +
        "never count an `open` one as taken. A cover is a person: count " +
        "`party_size`, not the number of reservation rows, and treat `no_show` " +
        "and `cancelled` bookings as covers that never arrived. A dish's margin " +
        "is its `price` minus its `cost`, per portion. Stock is held per " +
        "ingredient in its own `unit` and is not decremented automatically — an " +
        "order does not reduce it, so say `stock_qty` is what somebody last " +
        "counted rather than what is on the shelf. When a figure has a seeded " +
        "KPI — Sales, Average check, Covers booked, Waste cost — run that " +
        "definition rather than adding rows up your own way, so your answer " +
        "matches the dashboard. Be brief, name the check number, the table or " +
        "the dish you mean, and say plainly when the data does not answer the " +
        "question.",
      tools: [
        "collections.list",
        "collections.read",
        "collections.aggregate",
        "collections.search",
        "kpis.run",
        "dashboards.run",
      ],
      maxSteps: 8,
    },
  ],
};
