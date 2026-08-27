/**
 * Bundled KPI definitions, per schema template.
 *
 * A template used to hand over collections, sample rows and a dashboard, and
 * leave the workspace to work out for itself what "revenue" or "refund rate"
 * means. These close that gap: applying a vertical now also installs its
 * vocabulary, already defined, so the KPIs page, a dashboard tile and Ask AI
 * agree on each figure from the first minute rather than after somebody
 * writes it down three times.
 *
 * Kept out of `catalog.ts` only because that file is already very long; the
 * shape is `SchemaTemplate["kpis"]` and it is attached to each template there.
 *
 * ## Rules these follow, and why
 *
 * - **Every `field` and `dateField` is a real column of the named collection.**
 *   The catalog test walks these against the template's own field list, because
 *   a KPI naming a column that does not exist is not a compile error — it is a
 *   tile that renders a VALIDATION message on somebody's dashboard.
 * - **`dateField` is set only when the column genuinely dates the event.** An
 *   order has `placed_at`; a product does not have a date that means anything
 *   for "how many products". Windowing on the wrong column produces a "change"
 *   that actually describes when rows were imported, which reads exactly like a
 *   real trend.
 * - **`direction: "down"` wherever rising is bad** — refunds, cancellations,
 *   overdue invoices, downtime, scrap, no-shows. Without it a worsening number
 *   renders green.
 * - **`money` format only on `money`-typed columns.** The aggregate engine
 *   rescales those from minor units and reports their currency; a `number`
 *   column formatted as money would print a plain float with a currency symbol
 *   glued on.
 * - Counts stay `count` rather than `sum` of a quantity column unless the
 *   quantity is the point, so the figure survives a schema whose sample data is
 *   sparse.
 */
import type { TemplateKpi } from "./types";

export const TEMPLATE_KPIS: Record<string, TemplateKpi[]> = {
  blog: [
    {
      slug: "published-posts",
      name: "Published posts",
      collection: "posts",
      agg: "count",
      dateField: "created_at",
      direction: "up",
      unit: "posts",
    },
    {
      slug: "new-subscribers",
      name: "New subscribers",
      // `_neq: "unsubscribed"` rather than `_eq: "subscribed"`, which is what
      // this said and which counted nobody: the column's choices are the
      // subscriber's TIER — free, comped, paid — plus `unsubscribed`, and
      // "subscribed" was never one of them. Still a real column, so the
      // reference check passed; the tile just read 0 on every blog workspace
      // for ever. Anything that is not `unsubscribed` is a live subscriber.
      collection: "subscribers",
      agg: "count",
      filter: { status: { _neq: "unsubscribed" } },
      dateField: "subscribed_at",
      direction: "up",
      unit: "subscribers",
    },
    {
      slug: "comments-awaiting-moderation",
      name: "Comments awaiting moderation",
      description: "Pending comments — a backlog, so rising is bad news.",
      collection: "comments",
      agg: "count",
      filter: { status: { _eq: "pending" } },
      direction: "down",
      unit: "comments",
    },
    {
      slug: "posts-by-category",
      name: "Posts by category",
      collection: "posts",
      agg: "count",
      groupBy: "category",
      topN: 10,
    },
  ],

  ecommerce: [
    {
      slug: "net-revenue",
      name: "Net revenue",
      description: "Order totals, excluding cancelled orders.",
      collection: "orders",
      agg: "sum",
      field: "total",
      // `state`, NOT `status`. Cancellation is the order's own lifecycle;
      // `status` is payment, and it has no `cancelled` value — which is why
      // this filter used to name one and exclude nothing, quietly counting
      // every cancelled order into revenue.
      filter: { state: { _neq: "cancelled" } },
      dateField: "placed_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "orders-placed",
      name: "Orders placed",
      collection: "orders",
      agg: "count",
      filter: { state: { _neq: "cancelled" } },
      dateField: "placed_at",
      direction: "up",
      unit: "orders",
    },
    {
      slug: "average-order-value",
      name: "Average order value",
      collection: "orders",
      agg: "avg",
      field: "total",
      filter: { state: { _neq: "cancelled" } },
      dateField: "placed_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "refunded-amount",
      name: "Refunded amount",
      collection: "refunds",
      agg: "sum",
      field: "amount",
      dateField: "processed_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "down",
    },
    {
      slug: "cancelled-orders",
      name: "Cancelled orders",
      collection: "orders",
      agg: "count",
      filter: { state: { _eq: "cancelled" } },
      dateField: "cancelled_at",
      direction: "down",
      unit: "orders",
    },
    {
      slug: "orders-by-status",
      name: "Orders by payment status",
      // Counts, not totals: `total` is denominated per row, so a money sum
      // has to group by `currency` — and a KPI has one grouping dimension.
      // Splitting revenue by status as well is a job for a report, not a tile
      // that would have to pick which of the two questions it is answering.
      collection: "orders",
      agg: "count",
      groupBy: "status",
      dateField: "placed_at",
      topN: 10,
      unit: "orders",
    },
    {
      slug: "orders-by-channel",
      name: "Orders by channel",
      description: "Where the sales came from — web, POS, marketplace, B2B.",
      collection: "orders",
      agg: "count",
      groupBy: "channel",
      dateField: "placed_at",
      topN: 10,
      unit: "orders",
    },
    {
      slug: "returns-requested",
      name: "Returns requested",
      description: "Returns, exchanges and claims opened in the period.",
      collection: "returns",
      agg: "count",
      dateField: "requested_at",
      direction: "down",
      unit: "returns",
    },
    {
      slug: "carts-abandoned",
      name: "Carts abandoned",
      collection: "carts",
      agg: "count",
      filter: { status: { _eq: "abandoned" } },
      dateField: "abandoned_at",
      direction: "down",
      unit: "carts",
    },
    {
      slug: "active-subscriptions",
      name: "Active subscriptions",
      description: "No date column — a running count of who is currently subscribed.",
      collection: "subscriptions",
      agg: "count",
      filter: { status: { _eq: "active" } },
      direction: "up",
      unit: "subscriptions",
    },
    {
      slug: "stock-on-hand",
      name: "Stock on hand",
      // Summed from the LEVELS, which is where stock actually is. It used to
      // sum `products.stock` — a column an operator keeps by hand, and which
      // shipped seeded at 120 for a product whose variants held 90.
      description: "Summed across every location. No date column — a running total, not a period figure.",
      collection: "inventory_levels",
      agg: "sum",
      field: "on_hand",
      direction: "up",
      unit: "units",
    },
  ],

  saas: [
    {
      slug: "invoiced-amount",
      name: "Invoiced amount",
      collection: "invoices",
      agg: "sum",
      field: "amount_due",
      dateField: "issued_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "collected-amount",
      name: "Collected amount",
      collection: "invoices",
      agg: "sum",
      field: "amount_paid",
      dateField: "issued_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "active-subscriptions",
      name: "Active subscriptions",
      collection: "subscriptions",
      agg: "count",
      filter: { status: { _eq: "active" } },
      direction: "up",
      unit: "subs",
    },
    {
      slug: "cancelled-subscriptions",
      name: "Cancelled subscriptions",
      collection: "subscriptions",
      agg: "count",
      dateField: "canceled_at",
      direction: "down",
      unit: "subs",
    },
    {
      slug: "failed-dunning-attempts",
      name: "Failed dunning attempts",
      collection: "dunning_attempts",
      agg: "count",
      filter: { status: { _eq: "failed" } },
      direction: "down",
    },
  ],

  crm: [
    {
      slug: "pipeline-value",
      name: "Open pipeline value",
      description: "Deal amounts still in play — closed-won/lost excluded.",
      collection: "deals",
      agg: "sum",
      field: "amount",
      filter: { stage: { _nin: ["closed_won", "closed_lost"] } },
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "deals-by-stage",
      name: "Deals by stage",
      collection: "deals",
      agg: "count",
      groupBy: "stage",
      topN: 12,
    },
    {
      slug: "new-leads",
      name: "New leads",
      collection: "leads",
      agg: "count",
      dateField: "created_at",
      direction: "up",
      unit: "leads",
    },
    {
      slug: "quotes-sent-value",
      name: "Quotes sent",
      collection: "quotes",
      agg: "sum",
      field: "total",
      dateField: "created_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
  ],

  support: [
    {
      slug: "tickets-opened",
      name: "Tickets opened",
      collection: "tickets",
      agg: "count",
      dateField: "created_at",
      direction: "neutral",
      unit: "tickets",
    },
    {
      slug: "tickets-solved",
      name: "Tickets solved",
      collection: "tickets",
      agg: "count",
      dateField: "solved_at",
      direction: "up",
      unit: "tickets",
    },
    {
      slug: "open-backlog",
      name: "Open backlog",
      description: "Unsolved tickets right now — a standing count, not a period.",
      collection: "tickets",
      agg: "count",
      filter: { status: { _nin: ["solved", "closed"] } },
      direction: "down",
      unit: "tickets",
    },
    {
      slug: "tickets-by-priority",
      name: "Tickets by priority",
      collection: "tickets",
      agg: "count",
      groupBy: "priority",
      topN: 8,
    },
    {
      slug: "average-csat",
      name: "Average CSAT",
      collection: "csat_ratings",
      agg: "avg",
      field: "rating",
      dateField: "submitted_at",
      decimals: 2,
      direction: "up",
    },
  ],

  hr: [
    {
      slug: "active-employees",
      name: "Active employees",
      collection: "employees",
      agg: "count",
      filter: { status: { _eq: "active" } },
      direction: "up",
      unit: "people",
    },
    {
      slug: "new-hires",
      name: "New hires",
      collection: "employees",
      agg: "count",
      dateField: "hire_date",
      direction: "up",
      unit: "people",
    },
    {
      slug: "leavers",
      name: "Leavers",
      collection: "employees",
      agg: "count",
      dateField: "termination_date",
      direction: "down",
      unit: "people",
    },
    {
      slug: "leave-days-taken",
      name: "Leave days taken",
      collection: "leave_requests",
      agg: "sum",
      field: "days",
      filter: { status: { _eq: "approved" } },
      dateField: "start_date",
      decimals: 1,
      unit: "days",
    },
    {
      slug: "payroll-net",
      name: "Payroll net",
      collection: "payroll_runs",
      agg: "sum",
      field: "total_net",
      dateField: "pay_date",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
    },
  ],

  projects: [
    {
      slug: "issues-opened",
      name: "Issues opened",
      collection: "issues",
      agg: "count",
      dateField: "created_at",
      unit: "issues",
    },
    {
      slug: "issues-by-state",
      name: "Issues by state",
      collection: "issues",
      agg: "count",
      groupBy: "state",
      topN: 10,
    },
    {
      slug: "hours-logged",
      name: "Hours logged",
      collection: "worklogs",
      agg: "sum",
      field: "hours",
      dateField: "logged_at",
      decimals: 1,
      unit: "h",
      direction: "up",
    },
    {
      slug: "budget-spent",
      name: "Budget spent",
      collection: "budgets",
      agg: "sum",
      field: "amount_spent",
      direction: "down",
    },
  ],

  events: [
    {
      slug: "ticket-revenue",
      name: "Ticket revenue",
      collection: "orders",
      agg: "sum",
      field: "total",
      dateField: "placed_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "tickets-sold",
      name: "Tickets sold",
      collection: "ticket_types",
      agg: "sum",
      field: "sold",
      direction: "up",
      unit: "tickets",
    },
    {
      slug: "check-ins",
      name: "Check-ins",
      collection: "check_ins",
      agg: "count",
      dateField: "checked_in_at",
      direction: "up",
    },
    {
      slug: "sponsorship-value",
      name: "Sponsorship value",
      collection: "sponsors",
      agg: "sum",
      field: "amount",
      direction: "up",
    },
  ],

  inventory: [
    {
      slug: "stock-available",
      name: "Stock available",
      collection: "stock_levels",
      agg: "sum",
      field: "on_hand",
      direction: "up",
      unit: "units",
    },
    {
      slug: "purchase-order-value",
      name: "Purchase order value",
      collection: "purchase_orders",
      agg: "sum",
      field: "total",
      dateField: "order_date",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
    },
    {
      slug: "stock-adjustments",
      name: "Stock adjustments",
      description: "Manual corrections — frequent ones mean the count is drifting.",
      collection: "stock_adjustments",
      agg: "count",
      dateField: "adjusted_at",
      direction: "down",
    },
    {
      slug: "supplier-returns-value",
      name: "Supplier returns",
      collection: "supplier_returns",
      agg: "sum",
      field: "credit_amount",
      dateField: "returned_at",
      direction: "down",
    },
  ],

  "real-estate": [
    {
      slug: "closed-sale-value",
      name: "Closed sale value",
      collection: "transactions",
      agg: "sum",
      field: "sale_price",
      dateField: "closed_at",
      direction: "up",
    },
    {
      slug: "commission-earned",
      name: "Commission earned",
      collection: "transactions",
      agg: "sum",
      field: "commission",
      dateField: "closed_at",
      direction: "up",
    },
    {
      slug: "rent-collected",
      name: "Rent collected",
      collection: "rent_payments",
      agg: "sum",
      field: "amount",
      dateField: "paid_at",
      direction: "up",
    },
    {
      slug: "listings-by-status",
      name: "Listings by status",
      collection: "properties",
      agg: "count",
      groupBy: "status",
      topN: 8,
    },
    {
      slug: "maintenance-cost",
      name: "Maintenance cost",
      collection: "property_maintenance",
      agg: "sum",
      field: "cost",
      dateField: "reported_at",
      direction: "down",
    },
  ],

  restaurant: [
    {
      slug: "sales-total",
      name: "Sales",
      collection: "orders",
      agg: "sum",
      field: "total",
      dateField: "opened_at",
      direction: "up",
    },
    {
      slug: "average-check",
      name: "Average check",
      collection: "orders",
      agg: "avg",
      field: "total",
      dateField: "opened_at",
      decimals: 2,
      direction: "up",
    },
    {
      slug: "covers-booked",
      name: "Covers booked",
      collection: "reservations",
      agg: "sum",
      field: "party_size",
      dateField: "reserved_at",
      direction: "up",
      unit: "covers",
    },
    {
      slug: "waste-cost",
      name: "Waste cost",
      collection: "waste_logs",
      agg: "sum",
      field: "cost",
      dateField: "logged_at",
      direction: "down",
    },
  ],

  lms: [
    {
      slug: "new-enrollments",
      name: "New enrollments",
      collection: "enrollments",
      agg: "count",
      dateField: "enrolled_at",
      direction: "up",
    },
    {
      slug: "completions",
      name: "Completions",
      collection: "enrollments",
      agg: "count",
      dateField: "completed_at",
      direction: "up",
    },
    {
      slug: "average-progress",
      name: "Average progress",
      collection: "enrollments",
      agg: "avg",
      field: "progress",
      decimals: 1,
      unit: "%",
      direction: "up",
    },
    {
      slug: "average-quiz-score",
      name: "Average quiz score",
      collection: "quiz_attempts",
      agg: "avg",
      field: "score",
      dateField: "submitted_at",
      decimals: 1,
      direction: "up",
    },
  ],

  ats: [
    {
      slug: "applications-received",
      name: "Applications received",
      collection: "applications",
      agg: "count",
      dateField: "applied_at",
      direction: "up",
    },
    {
      slug: "applications-by-stage",
      name: "Applications by stage",
      collection: "applications",
      agg: "count",
      groupBy: "stage",
      topN: 12,
    },
    {
      slug: "interviews-scheduled",
      name: "Interviews scheduled",
      collection: "interviews",
      agg: "count",
      dateField: "scheduled_at",
    },
    {
      slug: "offers-sent",
      name: "Offers sent",
      collection: "offers",
      agg: "count",
      dateField: "sent_at",
      direction: "up",
    },
  ],

  marketplace: [
    {
      slug: "gmv",
      name: "GMV",
      description: "Gross merchandise value across all vendors.",
      collection: "orders",
      agg: "sum",
      field: "total",
      dateField: "placed_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "vendor-payouts",
      name: "Vendor payouts",
      collection: "payouts",
      agg: "sum",
      field: "amount",
      dateField: "period_start",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
    },
    {
      slug: "open-disputes",
      name: "Open disputes",
      collection: "disputes",
      agg: "count",
      filter: { status: { _eq: "open" } },
      direction: "down",
    },
    {
      slug: "listings-by-category",
      name: "Listings by category",
      collection: "listings",
      agg: "count",
      groupBy: "category",
      topN: 10,
    },
  ],

  nonprofit: [
    {
      slug: "donations-received",
      name: "Donations received",
      collection: "donations",
      agg: "sum",
      field: "amount",
      dateField: "donated_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "donor-count",
      name: "Donors giving",
      collection: "donations",
      agg: "count",
      dateField: "donated_at",
      direction: "up",
      unit: "gifts",
    },
    {
      slug: "average-gift",
      name: "Average gift",
      collection: "donations",
      agg: "avg",
      field: "amount",
      dateField: "donated_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "grant-funding",
      name: "Grant funding",
      collection: "grants",
      agg: "sum",
      field: "amount",
      filter: { status: { _eq: "awarded" } },
      dateField: "decision_at",
      direction: "up",
    },
  ],

  forms: [
    {
      slug: "responses-received",
      name: "Responses received",
      collection: "responses",
      agg: "count",
      dateField: "submitted_at",
      direction: "up",
    },
    {
      slug: "responses-by-status",
      name: "Responses by status",
      collection: "responses",
      agg: "count",
      groupBy: "status",
      topN: 8,
    },
    {
      slug: "published-forms",
      name: "Published forms",
      collection: "forms",
      agg: "count",
      filter: { status: { _eq: "published" } },
      direction: "up",
    },
  ],

  invoicing: [
    {
      slug: "invoiced-total",
      name: "Invoiced",
      collection: "invoices",
      agg: "sum",
      field: "total",
      dateField: "issue_date",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
    {
      slug: "payments-received",
      name: "Payments received",
      collection: "payments",
      agg: "sum",
      field: "amount",
      dateField: "received_at",
      direction: "up",
    },
    {
      slug: "outstanding-balance",
      name: "Outstanding balance",
      description: "Unpaid invoice balances right now — a standing figure.",
      collection: "invoices",
      agg: "sum",
      field: "balance_due",
      filter: { status: { _nin: ["paid", "void"] } },
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "down",
    },
    {
      slug: "expenses-total",
      name: "Expenses",
      collection: "expenses",
      agg: "sum",
      field: "amount",
      dateField: "spent_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "down",
    },
  ],

  appointments: [
    {
      slug: "bookings-taken",
      name: "Bookings taken",
      collection: "bookings",
      agg: "count",
      dateField: "starts_at",
      direction: "up",
    },
    {
      slug: "booking-revenue",
      name: "Booking revenue",
      collection: "bookings",
      agg: "sum",
      field: "amount",
      filter: { status: { _neq: "cancelled" } },
      dateField: "starts_at",
      direction: "up",
    },
    {
      slug: "cancellations",
      name: "Cancellations",
      collection: "bookings",
      agg: "count",
      filter: { status: { _eq: "cancelled" } },
      dateField: "starts_at",
      direction: "down",
    },
    {
      slug: "bookings-by-status",
      name: "Bookings by status",
      collection: "bookings",
      agg: "count",
      groupBy: "status",
      dateField: "starts_at",
      topN: 8,
    },
  ],

  "field-service": [
    {
      slug: "work-orders-completed",
      name: "Work orders completed",
      collection: "work_orders",
      agg: "count",
      dateField: "completed_at",
      direction: "up",
    },
    {
      slug: "work-orders-by-status",
      name: "Work orders by status",
      collection: "work_orders",
      agg: "count",
      groupBy: "status",
      topN: 8,
    },
    {
      slug: "time-on-site",
      name: "Time on site",
      collection: "visits",
      agg: "sum",
      field: "minutes_on_site",
      dateField: "started_at",
      unit: "min",
    },
    {
      slug: "service-invoiced",
      name: "Service invoiced",
      collection: "invoices",
      agg: "sum",
      field: "amount",
      dateField: "issued_at",
      // Amounts are denominated by the row's own `currency`, so a single
      // total would be adding lira to dollars. One figure per currency.
      groupBy: "currency",
      format: "money",
      direction: "up",
    },
  ],

  rental: [
    {
      slug: "rental-revenue",
      name: "Rental revenue",
      collection: "rental_orders",
      agg: "sum",
      field: "total",
      dateField: "starts_at",
      direction: "up",
    },
    {
      slug: "late-fees",
      name: "Late fees",
      collection: "rental_orders",
      agg: "sum",
      field: "late_fees",
      dateField: "starts_at",
      direction: "down",
    },
    {
      slug: "damage-charges",
      name: "Damage charges",
      collection: "inspections",
      agg: "sum",
      field: "damage_charge",
      dateField: "inspected_at",
      direction: "down",
    },
    {
      slug: "rentals-by-status",
      name: "Rentals by status",
      collection: "rental_orders",
      agg: "count",
      groupBy: "status",
      topN: 8,
    },
  ],

  fleet: [
    {
      slug: "fuel-cost",
      name: "Fuel cost",
      collection: "fuel_logs",
      agg: "sum",
      field: "cost",
      dateField: "filled_at",
      direction: "down",
    },
    {
      slug: "service-cost",
      name: "Service cost",
      collection: "service_records",
      agg: "sum",
      field: "cost",
      dateField: "serviced_at",
      direction: "down",
    },
    {
      slug: "incidents",
      name: "Incidents",
      collection: "incidents",
      agg: "count",
      dateField: "occurred_at",
      direction: "down",
    },
    {
      slug: "vehicles-by-status",
      name: "Vehicles by status",
      collection: "vehicles",
      agg: "count",
      groupBy: "status",
      topN: 8,
    },
  ],

  maintenance: [
    {
      slug: "requests-raised",
      name: "Requests raised",
      collection: "maintenance_requests",
      agg: "count",
      dateField: "requested_at",
      direction: "down",
    },
    {
      slug: "downtime-minutes",
      name: "Downtime",
      collection: "maintenance_requests",
      agg: "sum",
      field: "downtime_minutes",
      dateField: "requested_at",
      direction: "down",
      unit: "min",
    },
    {
      slug: "maintenance-cost",
      name: "Maintenance cost",
      collection: "maintenance_requests",
      agg: "sum",
      field: "cost",
      dateField: "requested_at",
      direction: "down",
    },
    {
      slug: "requests-by-priority",
      name: "Requests by priority",
      collection: "maintenance_requests",
      agg: "count",
      groupBy: "priority",
      topN: 8,
    },
  ],

  manufacturing: [
    {
      slug: "units-produced",
      name: "Units produced",
      collection: "manufacturing_orders",
      agg: "sum",
      field: "qty_produced",
      dateField: "completed_at",
      direction: "up",
      unit: "units",
    },
    {
      slug: "scrapped-units",
      name: "Scrapped units",
      collection: "scrap_records",
      agg: "sum",
      field: "quantity",
      dateField: "scrapped_at",
      direction: "down",
      unit: "units",
    },
    {
      slug: "downtime-minutes",
      name: "Downtime",
      collection: "downtime_events",
      agg: "sum",
      field: "minutes",
      dateField: "started_at",
      direction: "down",
      unit: "min",
    },
    {
      slug: "orders-by-status",
      name: "Manufacturing orders by status",
      collection: "manufacturing_orders",
      agg: "count",
      groupBy: "status",
      topN: 8,
    },
  ],

  fitness: [
    {
      slug: "active-members",
      name: "Active members",
      collection: "members",
      agg: "count",
      filter: { status: { _eq: "active" } },
      direction: "up",
      unit: "members",
    },
    {
      slug: "check-ins",
      name: "Check-ins",
      collection: "check_ins",
      agg: "count",
      dateField: "checked_in_at",
      direction: "up",
    },
    {
      slug: "class-bookings",
      name: "Class bookings",
      collection: "class_bookings",
      agg: "count",
      dateField: "booked_at",
      direction: "up",
    },
    {
      slug: "payments-taken",
      name: "Payments taken",
      collection: "payments",
      agg: "sum",
      field: "amount",
      dateField: "paid_at",
      direction: "up",
    },
  ],

  legal: [
    {
      slug: "billable-hours",
      name: "Billable hours",
      collection: "time_entries",
      agg: "sum",
      field: "hours",
      dateField: "worked_on",
      decimals: 1,
      unit: "h",
      direction: "up",
    },
    {
      slug: "billable-value",
      name: "Billable value",
      collection: "time_entries",
      agg: "sum",
      field: "amount",
      dateField: "worked_on",
      direction: "up",
    },
    {
      slug: "matters-opened",
      name: "Matters opened",
      collection: "matters",
      agg: "count",
      dateField: "opened_at",
    },
    {
      slug: "invoiced-amount",
      name: "Invoiced",
      collection: "invoices",
      agg: "sum",
      field: "amount",
      dateField: "issued_at",
      direction: "up",
    },
  ],

  clinic: [
    {
      slug: "appointments-booked",
      name: "Appointments booked",
      collection: "appointments",
      agg: "count",
      dateField: "starts_at",
      direction: "up",
    },
    {
      slug: "appointments-by-status",
      name: "Appointments by status",
      description: "No-shows and cancellations show up here as their own bars.",
      collection: "appointments",
      agg: "count",
      groupBy: "status",
      dateField: "starts_at",
      topN: 8,
    },
    {
      slug: "payments-collected",
      name: "Payments collected",
      collection: "payments",
      agg: "sum",
      field: "amount",
      dateField: "paid_at",
      direction: "up",
    },
    {
      slug: "outstanding-invoices",
      name: "Outstanding invoices",
      collection: "invoices",
      agg: "count",
      filter: { status: { _neq: "paid" } },
      direction: "down",
    },
  ],
};
