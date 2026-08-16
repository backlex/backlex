import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, flag, geo, half, hint, int, money, moneyIn, ms, notes, parent, phone, rel, sec, select, seq, stacked, tabbed, text, ts, when } from "../dsl";

export const inventory: SchemaTemplate = {
  id: "inventory",
  label: "Inventory / Operations",
  groups: ["Catalog", "Stock", "Purchasing"],
  description:
    "NetSuite-grade inventory: items with reorder points, multi-warehouse stock levels (on-hand / reserved / available), suppliers, purchase orders with line items, transfers and adjustments — plus warehouse bins, lot/expiry tracking, cycle counts with variance lines and supplier returns (RMA).",
  collections: [
    {
      slug: "warehouses", group: "Stock", singular: "Warehouse", plural: "Warehouses", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("code")),
        text("address"),
        ...half(text("city"), text("country")),
        geo("coordinates", ["address", "city", "country"], { label: "Map pin" }),
        flag("active", { label: "Active" }),
      ],
      samples: [{ name: "Central DC", code: "DC-1", city: "Newark", country: "US", active: true }, { name: "West DC", code: "DC-2", city: "Reno", country: "US", active: true }],
    },
    {
      slug: "bins", group: "Stock", singular: "Bin", plural: "Bins", defaultSort: "code",
      fields: [
        ...half(rel("warehouse", "warehouses"), text("code", { required: true, unique: true })),
        ...half(text("zone"), text("capacity_note", { label: "Capacity note" })),
      ],
      samples: [
        { warehouse: { ref: "warehouses:0" }, code: "A-01-01", zone: "A", capacity_note: "2 pallets" },
        { warehouse: { ref: "warehouses:0" }, code: "B-02-03", zone: "B", capacity_note: "Shelf — small parts" },
        { warehouse: { ref: "warehouses:1" }, code: "W-A-01", zone: "A", capacity_note: "1 pallet" },
      ],
    },
    {
      slug: "suppliers", group: "Purchasing", singular: "Supplier", plural: "Suppliers", defaultSort: "name",
      fields: stacked(
        sec("Supplier", [
          ...half(text("name", { required: true }), text("contact_name", { label: "Contact name" })),
          ...half(email("email"), phone("phone")),
          text("address"),
        ]),
        sec("Terms", [
          ...half(
            select("payment_terms", [ch("net_15", C.blue, "Net 15"), ch("net_30", C.teal, "Net 30"), ch("net_60", C.amber, "Net 60"), ch("prepaid", C.gray)], { default: "net_30", label: "Payment terms" }),
            int("lead_time_days", { validation: { min: 0 }, label: "Lead time (days)" }),
          ),
          flag("active", { label: "Active" }),
        ]),
      ),
      samples: [{ name: "Globex Supplies", contact_name: "Pat Lee", email: "sales@globex.example", phone: "+15555550190", payment_terms: "net_30", lead_time_days: 11, active: true }],
    },
    {
      slug: "item_categories", group: "Catalog", singular: "Category", plural: "Categories", defaultSort: "name",
      fields: [...half(text("name", { required: true }), parent("item_categories"))],
      samples: [{ name: "Components" }, { name: "Finished goods" }],
    },
    {
      slug: "items", group: "Catalog", singular: "Item", plural: "Items", fts: true, defaultSort: "name",
      fields: tabbed(
        sec("Item", [
          ...half(text("name", { required: true, searchable: true }), text("sku", { unique: true, label: "SKU" })),
          ...half(text("barcode", { label: "Barcode" }), text("unit", { default: "ea", label: "Unit of measure" })),
          notes("description", { searchable: true }),
          ...half(rel("category", "item_categories"), rel("supplier", "suppliers")),
        ]),
        sec("Pricing", [
          ...half(money("unit_cost", { label: "Unit cost" }), money("unit_price", { label: "Sell price" })),
        ]),
        sec("Replenishment", [
          ...half(
            int("reorder_point", { default: 0, validation: { min: 0 }, label: "Reorder point", description: "Available stock at or below this triggers a reorder." }),
            int("reorder_quantity", { default: 0, validation: { min: 0 }, label: "Reorder qty" }),
          ),
          ...half(bool("lot_tracked", { default: false, label: "Lot tracked" }), flag("active", { label: "Active" })),
        ]),
      ),
      samples: [{ name: "Widget A", sku: "WID-A", category: { ref: "item_categories:0" }, supplier: { ref: "suppliers:0" }, unit_cost: 4.5, unit_price: 9.99, unit: "ea", reorder_point: 100, reorder_quantity: 500, lot_tracked: true }, { name: "Widget B", sku: "WID-B", category: { ref: "item_categories:0" }, supplier: { ref: "suppliers:0" }, unit_cost: 6.0, unit_price: 12.99, unit: "ea", reorder_point: 50, reorder_quantity: 200 }],
    },
    {
      slug: "stock_levels", group: "Stock", singular: "Stock level", plural: "Stock levels",
      fields: [
        hint("stock_levels_available", "Available is generated as on hand − reserved. Incoming is what's already on a purchase order."),
        ...half(rel("item", "items"), rel("warehouse", "warehouses")),
        rel("bin", "bins"),
        ...half(
          int("on_hand", { default: 0, validation: { min: 0 }, label: "On hand" }),
          int("reserved", { default: 0, validation: { min: 0 }, label: "Reserved" }),
        ),
        ...half(
          int("incoming", { default: 0, validation: { min: 0 }, label: "Incoming" }),
          computedNum("available", "on_hand - reserved", { label: "Available" }),
        ),
      ],
      samples: [
        { item: { ref: "items:0" }, warehouse: { ref: "warehouses:0" }, bin: { ref: "bins:0" }, on_hand: 500, reserved: 20 },
        { item: { ref: "items:1" }, warehouse: { ref: "warehouses:0" }, bin: { ref: "bins:1" }, on_hand: 200, reserved: 0 },
      ],
    },
    {
      slug: "lots", group: "Stock", singular: "Lot", plural: "Lots", defaultSort: "expiry_date", displayTemplate: "{{lot_number}}",
      fields: [
        ...half(rel("item", "items"), text("lot_number", { required: true, label: "Lot number" })),
        ...half(date("expiry_date", { indexed: true, label: "Expiry date" }), int("qty", { default: 0, validation: { min: 0 } })),
        select("status", [ch("available", C.green), ch("reserved", C.blue), ch("quarantine", C.amber), ch("expired", C.red)], { default: "available" }),
      ],
      samples: [
        { item: { ref: "items:0" }, lot_number: "L-2606-01", expiry_date: ms("2027-06-30"), qty: 300, status: "available" },
        { item: { ref: "items:0" }, lot_number: "L-2603-04", expiry_date: ms("2026-09-15"), qty: 200, status: "reserved" },
      ],
    },
    {
      slug: "purchase_orders", group: "Purchasing", singular: "Purchase order", plural: "Purchase orders", defaultSort: "-order_date",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Order", [
          ...half(seq("number", "PO-{#####}"), select("status", [ch("draft", C.gray), ch("ordered", C.blue), ch("partial", C.amber, "Partially received"), ch("received", C.green), ch("cancelled", C.red)], { default: "draft" })),
          ...half(rel("supplier", "suppliers"), rel("warehouse", "warehouses")),
        ]),
        sec("Dates & total", [
          ...half(date("order_date", { indexed: true, label: "Order date" }), date("expected_date", { label: "Expected date" })),
          ...half(moneyIn("total"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ]),
      ),
      samples: [{ supplier: { ref: "suppliers:0" }, warehouse: { ref: "warehouses:0" }, status: "ordered", total: 2250, currency: "USD", order_date: ms("2026-06-01"), expected_date: ms("2026-06-12") }],
    },
    {
      slug: "purchase_order_items", group: "Purchasing", singular: "PO line", plural: "PO lines",
      fields: [
        hint("po_lines_total", "Line total is generated as qty ordered × unit cost."),
        ...half(rel("purchase_order", "purchase_orders"), rel("item", "items")),
        ...half(
          int("qty_ordered", { default: 1, validation: { min: 0 }, label: "Qty ordered" }),
          int("qty_received", { default: 0, validation: { min: 0 }, label: "Qty received" }),
        ),
        ...half(money("unit_cost", { label: "Unit cost" }), computedNum("line_total", "qty_ordered * unit_cost", { label: "Line total" })),
      ],
      samples: [{ purchase_order: { ref: "purchase_orders:0" }, item: { ref: "items:0" }, qty_ordered: 500, qty_received: 0, unit_cost: 4.5 }],
    },
    {
      // Booking stock in against a PO (ERPNext Purchase Receipt) — the event
      // that actually moves quantity, kept apart from the order itself.
      slug: "goods_receipts", group: "Purchasing", singular: "Goods receipt", plural: "Goods receipts", defaultSort: "-received_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Receipt", [
          ...half(seq("number", "GRN-{#####}"), rel("purchase_order", "purchase_orders")),
          ...half(rel("warehouse", "warehouses"), ts("received_at", { indexed: true, label: "Received at" })),
          ...half(
            select("status", [ch("draft", C.gray), ch("posted", C.green), ch("cancelled", C.red)], { default: "draft" }),
            text("received_by", { label: "Received by" }),
          ),
        ]),
        sec("Inspection", [
          ...half(
            select("inspection_result", [ch("not_required", C.gray, "Not required"), ch("passed", C.green), ch("failed", C.red)], { default: "not_required", label: "Inspection" }),
            text("carrier"),
          ),
          // Say what failed — an inspection nobody wrote up is one nobody can act on.
          notes("note", { conditions: [when("inspection_result", "_eq", "failed", "required")] }),
        ]),
      ),
      samples: [{ purchase_order: { ref: "purchase_orders:0" }, warehouse: { ref: "warehouses:0" }, received_at: ms("2026-06-12"), status: "posted", received_by: "Riley Chen", inspection_result: "passed", carrier: "UPS Freight" }],
    },
    {
      slug: "goods_receipt_lines", group: "Purchasing", singular: "Receipt line", plural: "Receipt lines",
      fields: [
        ...half(rel("goods_receipt", "goods_receipts"), rel("item", "items")),
        ...half(int("qty_received", { default: 0, validation: { min: 0 }, label: "Qty received" }), int("qty_rejected", { default: 0, validation: { min: 0 }, label: "Qty rejected" })),
        ...half(rel("lot", "lots", { label: "Into lot" }), rel("bin", "bins", { label: "Put away to" })),
      ],
      samples: [{ goods_receipt: { ref: "goods_receipts:0" }, item: { ref: "items:0" }, qty_received: 500, qty_rejected: 0, lot: { ref: "lots:0" }, bin: { ref: "bins:0" } }],
    },
    {
      slug: "stock_transfers", group: "Stock", singular: "Transfer", plural: "Transfers", defaultSort: "-transferred_at",
      kanbanGroupBy: "status",
      fields: [
        rel("item", "items"),
        ...half(rel("from_warehouse", "warehouses", { label: "From warehouse" }), rel("to_warehouse", "warehouses", { label: "To warehouse" })),
        ...half(int("quantity", { validation: { min: 0 } }), select("status", [ch("pending", C.amber), ch("in_transit", C.blue, "In transit"), ch("completed", C.green)], { default: "pending" })),
        ts("transferred_at", { indexed: true, label: "Transferred at" }),
      ],
      samples: [{ item: { ref: "items:0" }, from_warehouse: { ref: "warehouses:0" }, to_warehouse: { ref: "warehouses:1" }, quantity: 50, status: "completed", transferred_at: ms("2026-06-10") }],
    },
    {
      slug: "stock_adjustments", group: "Stock", singular: "Adjustment", plural: "Adjustments", defaultSort: "-adjusted_at",
      fields: [
        ...half(rel("item", "items"), rel("warehouse", "warehouses")),
        ...half(
          int("quantity_change", { label: "Quantity change", description: "Negative to write stock off, positive to write it on." }),
          select("reason", [ch("count", C.blue, "Cycle count"), ch("damage", C.red), ch("theft", C.amber), ch("return", C.green), ch("correction", C.gray)], { default: "count" }),
        ),
        ...half(
          ts("adjusted_at", { indexed: true, label: "Adjusted at" }),
          // Damage and theft are the two reasons somebody will be asked about later.
          notes("note", { conditions: [when("reason", "_in", ["damage", "theft"], "required")] }),
        ),
      ],
      samples: [{ item: { ref: "items:1" }, warehouse: { ref: "warehouses:0" }, quantity_change: -5, reason: "damage", note: "Water damage in transit.", adjusted_at: ms("2026-06-15") }],
    },
    {
      slug: "cycle_counts", group: "Stock", singular: "Cycle count", plural: "Cycle counts", defaultSort: "-scheduled_for",
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("warehouse", "warehouses"), date("scheduled_for", { indexed: true, label: "Scheduled for" })),
        ...half(
          select("status", [ch("planned", C.blue), ch("counting", C.amber), ch("done", C.green)], { default: "planned" }),
          text("counted_by", { label: "Counted by", conditions: [when("status", "_neq", "planned", "required")] }),
        ),
        notes("note"),
      ],
      samples: [
        { warehouse: { ref: "warehouses:0" }, scheduled_for: ms("2026-07-15"), status: "counting", counted_by: "Riley Chen" },
        { warehouse: { ref: "warehouses:1" }, scheduled_for: ms("2026-08-01"), status: "planned" },
      ],
    },
    {
      slug: "cycle_count_lines", group: "Stock", singular: "Count line", plural: "Count lines",
      fields: [
        hint("count_lines_variance", "Variance is generated as counted − expected; post a stock adjustment to reconcile it."),
        ...half(rel("cycle_count", "cycle_counts", { label: "Cycle count" }), rel("item", "items")),
        ...half(
          int("expected_qty", { default: 0, validation: { min: 0 }, label: "Expected qty" }),
          int("counted_qty", { default: 0, validation: { min: 0 }, label: "Counted qty" }),
        ),
        computedNum("variance", "counted_qty - expected_qty", { label: "Variance" }),
      ],
      samples: [
        { cycle_count: { ref: "cycle_counts:0" }, item: { ref: "items:0" }, expected_qty: 500, counted_qty: 498 },
        { cycle_count: { ref: "cycle_counts:0" }, item: { ref: "items:1" }, expected_qty: 200, counted_qty: 200 },
      ],
    },
    {
      slug: "supplier_returns", group: "Purchasing", singular: "Supplier return", plural: "Supplier returns", defaultSort: "-returned_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Return", [
          ...half(text("number", { required: true, unique: true, label: "RMA number" }), rel("supplier", "suppliers")),
          ...half(rel("item", "items"), int("qty", { default: 1, validation: { min: 1 } })),
        ]),
        sec("Outcome", [
          ...half(
            select("reason", [ch("defective", C.red), ch("wrong_item", C.amber, "Wrong item"), ch("overstock", C.blue)], { default: "defective" }),
            select("status", [ch("draft", C.gray), ch("shipped", C.blue), ch("credited", C.green), ch("rejected", C.red)], { default: "draft" }),
          ),
          ...half(
            money("credit_amount", { label: "Credit amount", conditions: [when("status", "_eq", "credited", "required")] }),
            date("returned_at", { indexed: true, label: "Returned at" }),
          ),
          notes("note"),
        ]),
      ),
      samples: [{ number: "RMA-3001", supplier: { ref: "suppliers:0" }, item: { ref: "items:1" }, qty: 5, reason: "defective", status: "shipped", credit_amount: 30, returned_at: ms("2026-06-18"), note: "Water-damaged units from PO-2001 shipment." }],
    },
  ],
  roles: [
    {
      name: "Warehouse operator",
      description: "Day-to-day stock moves, counts and lot handling; read-only purchasing.",
      permissions: [
        { collection: "warehouses", action: "read" },
        { collection: "bins", action: "read" },
        { collection: "item_categories", action: "read" },
        { collection: "items", action: "read" },
        { collection: "suppliers", action: "read" },
        { collection: "stock_levels", action: "read" },
        { collection: "stock_levels", action: "create" },
        { collection: "stock_levels", action: "update" },
        { collection: "lots", action: "read" },
        { collection: "lots", action: "create" },
        { collection: "lots", action: "update" },
        { collection: "stock_transfers", action: "read" },
        { collection: "stock_transfers", action: "create" },
        { collection: "stock_transfers", action: "update" },
        { collection: "stock_adjustments", action: "read" },
        { collection: "stock_adjustments", action: "create" },
        { collection: "cycle_counts", action: "read" },
        { collection: "cycle_counts", action: "update" },
        { collection: "cycle_count_lines", action: "read" },
        { collection: "cycle_count_lines", action: "create" },
        { collection: "cycle_count_lines", action: "update" },
        { collection: "purchase_orders", action: "read" },
        { collection: "purchase_order_items", action: "read" },
        { collection: "purchase_order_items", action: "update" },
      ],
    },
    {
      name: "Purchasing manager",
      description: "Own suppliers, purchase orders and supplier returns.",
      permissions: [
        { collection: "items", action: "read" },
        { collection: "item_categories", action: "read" },
        { collection: "warehouses", action: "read" },
        { collection: "stock_levels", action: "read" },
        { collection: "suppliers", action: "read" },
        { collection: "suppliers", action: "create" },
        { collection: "suppliers", action: "update" },
        { collection: "purchase_orders", action: "read" },
        { collection: "purchase_orders", action: "create" },
        { collection: "purchase_orders", action: "update" },
        { collection: "purchase_order_items", action: "read" },
        { collection: "purchase_order_items", action: "create" },
        { collection: "purchase_order_items", action: "update" },
        { collection: "supplier_returns", action: "read" },
        { collection: "supplier_returns", action: "create" },
        { collection: "supplier_returns", action: "update" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Inventory overview",
      description: "Stock position, purchasing flow, count accuracy and returns.",
      panels: [
        { name: "Active items", kind: "items-aggregate", viz: "counter", config: { collection: "items", agg: "count" } },
        { name: "Units on hand", kind: "items-aggregate", viz: "counter", config: { collection: "stock_levels", agg: "sum", field: "on_hand" } },
        { name: "Purchase orders", kind: "items-aggregate", viz: "counter", config: { collection: "purchase_orders", agg: "count" } },
        { name: "PO spend", kind: "items-aggregate", viz: "counter", config: { collection: "purchase_orders", agg: "sum", field: "total" } },
        { name: "POs by status", kind: "items-aggregate", viz: "donut", config: { collection: "purchase_orders", agg: "count", groupBy: "status" } },
        { name: "Lots by status", kind: "items-aggregate", viz: "donut", config: { collection: "lots", agg: "count", groupBy: "status" } },
        { name: "Adjustments by reason", kind: "items-aggregate", viz: "bars", config: { collection: "stock_adjustments", agg: "count", groupBy: "reason" } },
        { name: "Returns by reason", kind: "items-aggregate", viz: "bars", config: { collection: "supplier_returns", agg: "count", groupBy: "reason" } },
      ],
    },
  ],
  /**
   * The rules a stockroom runs on, already running.
   *
   * Deliberately absent: "available fell below the item's reorder point, so
   * raise a purchase order". That is the automation every inventory operator
   * asks for first, and a flow cannot express it — `data` is the `stock_levels`
   * row and the reorder point lives on `items`, one join away that a flow has
   * no way to make. A step that reordered on a fixed number would be wrong for
   * every item in the catalog except the one it was tuned against. So the flow
   * reports the one threshold the row can answer for itself and leaves the
   * judgement where the two figures sit side by side.
   */
  flows: [
    {
      name: "Raise a stock-out the moment a line runs down to nothing",
      trigger: "event:items:stock_levels:updated",
      operations: [
        {
          type: "condition",
          filter: { on_hand: { _lte: 0 } },
          then: [
            {
              type: "notification",
              title: "A stock line has hit zero",
              body: "Nothing on hand at this warehouse; {{ data.incoming }} already on order. Check the item's reorder point before raising another purchase order.",
              url: "/collections/stock_levels",
            },
          ],
        },
      ],
    },
    {
      name: "Chase a purchase order two days after it was expected",
      // `after`, not `before`: a buyer does not need telling that an order is
      // still in transit on the day it was promised — they need telling once it
      // is late. Only orders still owed, so a fully received or cancelled one
      // never surfaces.
      trigger: `schedule:${JSON.stringify({
        collection: "purchase_orders",
        field: "expected_date",
        offset: { value: 2, unit: "days", direction: "after" },
        at: 480,
        timeZone: null,
        where: { status: { _in: ["ordered", "partial"] } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "Purchase order {{ data.number }} is late",
          body: "Expected {{ data.expected_date }} and still not fully received. Chase the supplier or split the receipt.",
          url: "/collections/purchase_orders",
        },
      ],
    },
    {
      name: "Warn thirty days before a lot expires",
      // Thirty days is the window in which stock can still be sold, marked down
      // or returned — after that the only move left is a write-off. `_in` on the
      // two live statuses rather than `_nin` on `expired`: a quarantined lot is
      // already somebody's problem and does not need a second reminder, and a
      // lot holding nothing is not worth a notification at all.
      trigger: `schedule:${JSON.stringify({
        collection: "lots",
        field: "expiry_date",
        offset: { value: 30, unit: "days", direction: "before" },
        at: 420,
        timeZone: null,
        where: { status: { _in: ["available", "reserved"] }, qty: { _gt: 0 } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "Lot {{ data.lot_number }} expires in thirty days",
          body: "{{ data.qty }} units dated {{ data.expiry_date }}. Pick this lot first, or plan the markdown now.",
          url: "/collections/lots",
        },
      ],
    },
    {
      name: "Mark a lot expired the morning after its date",
      trigger: "cron:0 5 * * *",
      operations: [
        {
          type: "foreach",
          collection: "lots",
          filter: { expiry_date: { _lt: "$now" }, status: { _nin: ["expired"] } },
          do: [
            {
              type: "item.update",
              collection: "lots",
              id: "{{ $item.id }}",
              data: { status: "expired" },
            },
          ],
        },
      ],
    },
    {
      name: "Escalate a goods receipt that failed inspection",
      // No supplier return is raised here on purpose. A return needs the
      // supplier and the item, and the receipt row carries neither — the
      // supplier is on the purchase order and the items are on the receipt
      // lines. Two joins a flow cannot make, so it reports the failure and
      // names what to open.
      trigger: "event:items:goods_receipts:updated",
      operations: [
        {
          type: "condition",
          filter: { inspection_result: { _eq: "failed" } },
          then: [
            {
              type: "notification",
              title: "Goods receipt {{ data.number }} failed inspection",
              body: "Delivered by {{ data.carrier }}. Quarantine the affected lots and raise a supplier return against the order it came in on.",
              url: "/collections/goods_receipts",
            },
          ],
        },
      ],
    },
    {
      name: "Email the purchase order to the supplier when it is placed (needs email + a PDF renderer)",
      // Off until both are configured — see the note in docs/templates.md. The
      // name carries the prerequisite so nobody has to open it to find out.
      active: false,
      trigger: "event:items:purchase_orders:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "ordered" } },
          then: [
            { type: "document.render", templateKey: "purchase_order" },
            {
              type: "email",
              to: "{{ data.supplier.email }}",
              subject: "Purchase order {{ data.number }}",
              html: "<p>Our purchase order is attached. Please confirm the delivery date.</p>",
              attach: ["{{ $last.key }}"],
            },
          ],
        },
      ],
    },
  ],
  documents: [
    {
      key: "purchase_order",
      name: "Purchase order",
      description: "The order as the supplier receives it.",
      filename: "purchase-order-{{ data.number }}",
      variables: ["number", "total", "currency"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:18px}" +
        "th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #e5e5e5}" +
        "td.n,th.n{text-align:right}" +
        ".totals{margin-top:14px;width:100%}" +
        ".totals td{border:0;padding:3px 6px}" +
        "</style></head><body>" +
        "<h1>Purchase order {{ data.number }}</h1>" +
        '<p class="muted">Ordered {{ data.order_date }} · Expected {{ data.expected_date }}</p>' +
        "<p><strong>{{ data.supplier.name }}</strong><br>{{ data.supplier.address }}</p>" +
        "<p>Deliver to <strong>{{ data.warehouse.name }}</strong><br>" +
        "{{ data.warehouse.address }}<br>{{ data.warehouse.city }} {{ data.warehouse.country }}</p>" +
        '<table><thead><tr><th>Item</th><th class="n">Qty ordered</th>' +
        '<th class="n">Unit cost</th><th class="n">Line total</th></tr></thead><tbody>' +
        "<!-- one row per PO line; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        '<table class="totals"><tr><td class="n"><strong>Total {{ data.currency }}</strong></td>' +
        '<td class="n"><strong>{{ data.total }}</strong></td></tr></table>' +
        '<p class="muted">Quote this order number on the delivery note and on your invoice.</p>' +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "goods_receipt_note",
      name: "Goods received note",
      description: "What was booked in on the dock, and who signed for it.",
      filename: "grn-{{ data.number }}",
      variables: ["number", "received_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:18px}" +
        "th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #e5e5e5}" +
        "td.n,th.n{text-align:right}" +
        ".sign{margin-top:28px}" +
        "</style></head><body>" +
        "<h1>Goods received note {{ data.number }}</h1>" +
        '<p class="muted">Received {{ data.received_at }} · Against order ' +
        "{{ data.purchase_order.number }}</p>" +
        "<p>Warehouse <strong>{{ data.warehouse.name }}</strong><br>" +
        "Carrier {{ data.carrier }}</p>" +
        '<table><thead><tr><th>Item</th><th class="n">Received</th>' +
        '<th class="n">Rejected</th><th>Lot</th><th>Put away to</th></tr></thead><tbody>' +
        "<!-- one row per receipt line; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        "<p>Inspection: <strong>{{ data.inspection_result }}</strong></p>" +
        '<p class="muted">{{ data.note }}</p>' +
        '<p class="sign">Received by {{ data.received_by }} — signature ' +
        "____________________</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "supplier_return_note",
      name: "Supplier return note",
      description: "Travels with the goods going back, and states the credit expected.",
      filename: "return-{{ data.number }}",
      variables: ["number", "qty", "reason"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:18px}" +
        "th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #e5e5e5}" +
        "td.n,th.n{text-align:right}" +
        "</style></head><body>" +
        "<h1>Supplier return {{ data.number }}</h1>" +
        '<p class="muted">Returned {{ data.returned_at }}</p>' +
        "<p><strong>{{ data.supplier.name }}</strong><br>{{ data.supplier.address }}</p>" +
        // One row, not a foreach stub: a supplier return IS one item and one
        // quantity in this schema, so the table is the row.
        '<table><thead><tr><th>Item</th><th class="n">Qty</th>' +
        "<th>Reason</th></tr></thead><tbody><tr><td>{{ data.item.name }}</td>" +
        '<td class="n">{{ data.qty }}</td><td>{{ data.reason }}</td></tr></tbody></table>' +
        "<p>Credit expected: <strong>{{ data.credit_amount }}</strong></p>" +
        '<p class="muted">{{ data.note }}</p>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "Supplier onboarding",
      collection: "suppliers",
      settings: {
        submitLabel: "Send details",
        successMessage: "Thank you — purchasing will confirm your terms before the first order.",
      },
      fields: [
        { name: "name", label: "Company name" },
        { name: "contact_name", label: "Who we should speak to" },
        { name: "email", label: "Orders email", help: "Where purchase orders should be sent." },
        { name: "phone" },
        { name: "address" },
        { name: "payment_terms", label: "Payment terms" },
        { name: "lead_time_days", label: "Typical lead time (days)", help: "From order to dispatch, not to delivery." },
      ],
    },
    {
      name: "New item request",
      collection: "items",
      // Cost is asked for, sell price is not: the supplier quotes what it costs
      // and the margin is nobody's business but ours. Category and supplier are
      // relations, so they are not offerable on a public form at all — the
      // buyer sets both when they review the submission.
      settings: {
        submitLabel: "Submit item",
        successMessage: "Thanks — a buyer will review it and set the category and supplier.",
      },
      fields: [
        { name: "name", label: "Item name" },
        { name: "sku", label: "SKU", help: "Yours, if you have one — we'll map it to ours." },
        { name: "barcode", label: "Barcode (EAN / UPC)" },
        { name: "unit", label: "Unit of measure", help: "How it is sold: ea, box, kg, m." },
        { name: "description" },
        { name: "unit_cost", label: "Cost per unit" },
        { name: "lot_tracked", label: "Sold in dated lots", help: "Tick if the goods carry a lot number and an expiry." },
      ],
    },
  ],
  agents: [
    {
      name: "Stock assistant",
      handle: "stock-assistant",
      description: "Answers what is on hand, what is on order and what is about to expire.",
      systemPrompt:
        "You help a warehouse and purchasing team read their own stock position. " +
        "Answer from the workspace's data only. Available is on hand minus " +
        "reserved — quote available when someone asks what they can sell or " +
        "ship, and never quote on hand as if it were free. Quantities belong to " +
        "one warehouse: say which, and never add two warehouses together " +
        "without saying that is what you did. When asked what to reorder, " +
        "compare each item's available stock against its own reorder point and " +
        "subtract what is already incoming. When asked about lots, order them " +
        "by expiry date, soonest first. Be brief and specific, name the SKU, and " +
        "say plainly when the data does not answer the question.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search", "dashboards.run"],
      maxSteps: 8,
    },
  ],
};
