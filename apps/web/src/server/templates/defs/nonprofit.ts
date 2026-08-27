import type { SchemaTemplate } from "../types";
import { bool, C, ch, date, email, flag, half, int, money, moneyIn, ms, notes, num, phone, rel, sec, select, slugField, stacked, tabbed, text, ts, userLink, when } from "../dsl";

export const nonprofit: SchemaTemplate = {
  id: "nonprofit",
  label: "Nonprofit",
  groups: ["Donors", "Fundraising", "Programs", "Volunteering"],
  description:
    "Salesforce NPSP-grade fundraising: donors, campaigns, donations (one-time & recurring), pledges, grants with report deadlines, programs & beneficiaries, memberships, donor communications, volunteers, events and volunteer shifts.",
  collections: [
    {
      slug: "donors", group: "Donors", singular: "Donor", plural: "Donors", defaultSort: "name",
      portalLink: { emailField: "email", role: "Donor (portal)" },
      fields: tabbed(
        sec("Donor", [
          ...half(
            text("name", { required: true }),
            select("type", [ch("individual", C.blue), ch("organization", C.purple), ch("foundation", C.teal)], { default: "individual" }),
          ),
          ...half(email("email", { unique: true }), phone("phone")),
          userLink(),
        ]),
        sec("Address", [
          text("address"),
          ...half(text("city"), text("country")),
        ]),
        sec("Giving history", [
          money("total_donated", { default: 0, label: "Total donated" }),
          ...half(date("first_gift_at", { label: "First gift" }), date("last_gift_at", { label: "Last gift" })),
        ]),
      ),
      samples: [{ name: "Jordan Reed", email: "jordan@example.com", type: "individual", total_donated: 100 }, { name: "Globex Foundation", email: "giving@globex.example", type: "foundation", total_donated: 25000 }],
    },
    {
      // Restricted vs unrestricted money (CiviCRM financial type) — the split
      // an auditor asks about first.
      slug: "funds", group: "Fundraising", singular: "Fund", plural: "Funds", defaultSort: "name",
      fields: [
        ...half(
          text("name", { required: true }),
          select("restriction", [ch("unrestricted", C.green), ch("temporarily_restricted", C.amber, "Temporarily restricted"), ch("permanently_restricted", C.red, "Permanently restricted")], { default: "unrestricted" }),
        ),
        ...half(text("code", { label: "GL code" }), flag("active")),
        notes("description"),
      ],
      samples: [
        { name: "General operating", restriction: "unrestricted", code: "4000", active: true },
        { name: "Winter relief", restriction: "temporarily_restricted", code: "4200", active: true, description: "Gifts earmarked for the winter emergency response." },
      ],
    },
    {
      slug: "campaigns", group: "Fundraising", singular: "Campaign", plural: "Campaigns", defaultSort: "-created_at",
      fields: stacked(
        sec("Campaign", [
          ...half(text("name", { required: true }), slugField("name")),
          { name: "description", type: "longtext", interface: "richtext" },
          ...half(
            select("type", [ch("annual_fund", C.blue, "Annual fund"), ch("capital", C.purple), ch("event", C.amber), ch("emergency", C.red)], { default: "annual_fund" }),
            rel("fund", "funds"),
          ),
        ]),
        sec("Progress", [
          ...half(money("goal_amount", { label: "Goal" }), money("raised_amount", { default: 0, label: "Raised" })),
          ...half(
            select("status", [ch("planned", C.gray), ch("active", C.green), ch("paused", C.amber), ch("completed", C.blue)], { default: "planned" }),
            date("starts_at", { range: { end: "ends_at", bounds: "[]" }, indexed: true, label: "Starts at" }),
          ),
          date("ends_at", { label: "Ends at" }),
        ]),
      ),
      samples: [{ name: "Winter Fund", slug: "winter-fund", description: "Support families this winter.", type: "emergency", fund: { ref: "funds:1" }, goal_amount: 50000, raised_amount: 12500, status: "active", starts_at: ms("2026-11-01"), ends_at: ms("2026-12-31") }],
    },
    {
      slug: "donations", group: "Fundraising", singular: "Donation", plural: "Donations", ownerScoped: true, defaultSort: "-donated_at",
      fields: stacked(
        sec("Gift", [
          ...half(rel("donor", "donors"), rel("campaign", "campaigns")),
          ...half(rel("fund", "funds"), moneyIn("amount", { required: true })),
          ...half(
            select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
            select("type", [ch("one_time", C.blue, "One-time"), ch("recurring", C.purple)], { default: "one_time", label: "Gift type" }),
          ),
        ]),
        sec("Processing", [
          ...half(
            select("payment_method", [ch("card", C.blue), ch("bank_transfer", C.teal, "Bank transfer"), ch("cash", C.gray), ch("check", C.amber)], { default: "card", label: "Payment method" }),
            select("status", [ch("pending", C.amber), ch("completed", C.green), ch("refunded", C.red)], { default: "completed" }),
          ),
          ...half(bool("anonymous", { default: false, label: "Anonymous" }), bool("tax_receipt_sent", { default: false, label: "Tax receipt sent" })),
          ts("donated_at", { indexed: true, label: "Donated at" }),
        ]),
      ),
      samples: [{ donor: { ref: "donors:0" }, campaign: { ref: "campaigns:0" }, fund: { ref: "funds:1" }, amount: 100, currency: "USD", type: "one_time", payment_method: "card", status: "completed", donated_at: ms("2026-11-10") }],
    },
    {
      slug: "pledges", group: "Fundraising", singular: "Pledge", plural: "Pledges", defaultSort: "-created_at",
      fields: [
        ...half(rel("donor", "donors"), rel("campaign", "campaigns")),
        ...half(money("amount"), int("installments", { default: 1, validation: { min: 1 } })),
        ...half(
          select("status", [ch("active", C.green), ch("fulfilled", C.blue), ch("cancelled", C.gray)], { default: "active" }),
          date("start_date", { label: "Start date" }),
        ),
      ],
      samples: [{ donor: { ref: "donors:1" }, campaign: { ref: "campaigns:0" }, amount: 12000, installments: 12, status: "active", start_date: ms("2026-01-01") }],
    },
    {
      slug: "pledge_payments", group: "Fundraising", singular: "Pledge payment", plural: "Pledge payments", defaultSort: "-due_on",
      note: "The installment schedule behind a pledge — what turns a promise into a forecast.",
      fields: [
        ...half(rel("pledge", "pledges", { required: true }), rel("donation", "donations", { label: "Fulfilled by" })),
        ...half(moneyIn("amount"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
        date("due_on", { indexed: true, label: "Due on" }),
        ...half(
          select("status", [ch("scheduled", C.blue), ch("paid", C.green), ch("overdue", C.red), ch("written_off", C.gray, "Written off")], { default: "scheduled" }),
          date("paid_on", { label: "Paid on", conditions: [when("status", "_eq", "paid", "required"), when("status", "_neq", "paid", "hidden")] }),
        ),
      ],
      samples: [
        { pledge: { ref: "pledges:0" }, amount: 1000, due_on: ms("2026-01-31"), status: "paid", paid_on: ms("2026-01-29") },
        { pledge: { ref: "pledges:0" }, amount: 1000, due_on: ms("2026-02-28"), status: "scheduled" },
      ],
    },
    {
      slug: "grants", group: "Fundraising", singular: "Grant", plural: "Grants", defaultSort: "-applied_at",
      kanbanGroupBy: "status",
      fields: [
        ...half(text("name", { required: true }), text("funder")),
        ...half(
          money("amount"),
          select("status", [ch("researching", C.gray), ch("applied", C.blue), ch("awarded", C.green), ch("declined", C.red)], { default: "researching" }),
        ),
        ...half(date("applied_at", { indexed: true, label: "Applied at" }), date("decision_at", { label: "Decision date" })),
      ],
      samples: [{ name: "Community Resilience Grant", funder: "City Foundation", amount: 30000, status: "applied", applied_at: ms("2026-05-01") }],
    },
    {
      slug: "grant_reports", group: "Fundraising", singular: "Grant report", plural: "Grant reports", defaultSort: "due_date",
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("grant", "grants"), text("title", { required: true })),
        ...half(date("due_date", { indexed: true, label: "Due date" }), ts("submitted_at", { label: "Submitted at" })),
        select("status", [ch("upcoming", C.amber), ch("submitted", C.blue), ch("approved", C.green)], { default: "upcoming" }),
        notes("note"),
      ],
      samples: [{ grant: { ref: "grants:0" }, title: "Mid-year progress report", due_date: ms("2026-09-30"), status: "upcoming" }],
    },
    {
      slug: "programs", group: "Programs", singular: "Program", plural: "Programs", defaultSort: "name",
      fields: [
        text("name", { required: true }),
        notes("description"),
        ...half(
          money("budget"),
          select("status", [ch("active", C.green), ch("paused", C.amber), ch("completed", C.blue)], { default: "active" }),
        ),
      ],
      samples: [{ name: "After-school tutoring", description: "Weekly tutoring for local students.", budget: 18000, status: "active" }],
    },
    {
      slug: "beneficiaries", group: "Programs", singular: "Beneficiary", plural: "Beneficiaries", defaultSort: "-enrolled_at",
      fields: [
        ...half(rel("program", "programs"), text("name", { required: true, label: "Name / alias" })),
        ...half(
          date("enrolled_at", { indexed: true, label: "Enrolled at" }),
          select("status", [ch("waitlist", C.amber), ch("active", C.green), ch("exited", C.gray)], { default: "active" }),
        ),
      ],
      samples: [{ program: { ref: "programs:0" }, name: "Student A-102", enrolled_at: ms("2026-02-10"), status: "active" }],
    },
    {
      slug: "memberships", group: "Donors", singular: "Membership", plural: "Memberships", defaultSort: "-joined_at", displayTemplate: "{{member_name}}",
      fields: stacked(
        sec("Member", [
          ...half(text("member_name", { required: true, label: "Member name" }), email("member_email", { label: "Member email" })),
          ...half(
            select("level", [ch("student", C.gray), ch("individual", C.blue), ch("family", C.teal), ch("patron", C.purple)], { default: "individual" }),
            money("annual_fee", { label: "Annual fee" }),
          ),
        ]),
        sec("Term", [
          ...half(date("joined_at", { indexed: true, label: "Joined at" }), date("renews_at", { indexed: true, label: "Renews at" })),
          select("status", [ch("active", C.green), ch("lapsed", C.amber), ch("cancelled", C.gray)], { default: "active" }),
        ]),
      ),
      samples: [{ member_name: "Robin Vale", member_email: "robin@example.com", level: "family", joined_at: ms("2026-01-15"), renews_at: ms("2027-01-15"), status: "active", annual_fee: 120 }],
    },
    {
      slug: "communications", group: "Donors", singular: "Communication", plural: "Communications", defaultSort: "-sent_at",
      fields: [
        ...half(
          rel("donor", "donors"),
          select("channel", [ch("email", C.blue), ch("phone", C.teal), ch("mail", C.gray), ch("meeting", C.purple)], { default: "email" }),
        ),
        ...half(text("subject"), ts("sent_at", { indexed: true, label: "Sent at" })),
        notes("outcome"),
      ],
      samples: [{ donor: { ref: "donors:1" }, channel: "meeting", subject: "Annual giving review", sent_at: ms("2026-06-05T14:00:00Z"), outcome: "Interested in increasing the pledge next year." }],
    },
    {
      slug: "volunteers", group: "Volunteering", singular: "Volunteer", plural: "Volunteers", defaultSort: "name",
      portalLink: { emailField: "email", role: "Volunteer (portal)" },
      fields: [
        ...half(text("name", { required: true }), email("email")),
        ...half(phone("phone"), select("status", [ch("active", C.green), ch("inactive", C.gray)], { default: "active" })),
        notes("skills"),
        userLink(),
      ],
      samples: [{ name: "Casey Morgan", email: "casey@example.com", skills: "Event setup, outreach.", status: "active" }],
    },
    {
      slug: "events", group: "Volunteering", singular: "Event", plural: "Events", defaultSort: "-starts_at",
      fields: [
        ...half(text("title", { required: true }), slugField("title")),
        { name: "description", type: "longtext", interface: "richtext" },
        ...half(ts("starts_at", { indexed: true, label: "Starts at" }), text("location")),
        int("capacity", { validation: { min: 0 } }),
      ],
      samples: [{ title: "Charity Gala", slug: "charity-gala", description: "Annual fundraising gala.", starts_at: ms("2026-12-05T18:00:00Z"), location: "Grand Hotel", capacity: 200 }],
    },
    {
      slug: "volunteer_shifts", group: "Volunteering", singular: "Shift", plural: "Shifts", defaultSort: "-created_at",
      fields: [
        ...half(rel("event", "events"), rel("volunteer", "volunteers")),
        ...half(text("role"), num("hours", { validation: { min: 0 } })),
        select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("no_show", C.red, "No show")], { default: "scheduled" }),
      ],
      samples: [{ event: { ref: "events:0" }, volunteer: { ref: "volunteers:0" }, role: "Registration desk", hours: 4, status: "scheduled" }],
    },
  ],
  roles: [
    {
      name: "Development officer",
      description: "Own donor relationships and the fundraising pipeline: donors, donations, pledges, grants, reports and communications.",
      permissions: [
        { collection: "donors", action: "read" },
        { collection: "donors", action: "create" },
        { collection: "donors", action: "update" },
        { collection: "campaigns", action: "read" },
        { collection: "campaigns", action: "update" },
        { collection: "donations", action: "read" },
        { collection: "donations", action: "create" },
        { collection: "donations", action: "update" },
        { collection: "pledges", action: "read" },
        { collection: "pledges", action: "create" },
        { collection: "pledges", action: "update" },
        { collection: "grants", action: "read" },
        { collection: "grants", action: "create" },
        { collection: "grants", action: "update" },
        { collection: "grant_reports", action: "read" },
        { collection: "grant_reports", action: "create" },
        { collection: "grant_reports", action: "update" },
        { collection: "memberships", action: "read" },
        { collection: "memberships", action: "create" },
        { collection: "memberships", action: "update" },
        { collection: "communications", action: "read" },
        { collection: "communications", action: "create" },
        { collection: "communications", action: "update" },
      ],
    },
    {
      name: "Volunteer coordinator",
      description: "Run volunteering: volunteers, events and shifts; read programs and beneficiaries.",
      permissions: [
        { collection: "volunteers", action: "read" },
        { collection: "volunteers", action: "create" },
        { collection: "volunteers", action: "update" },
        { collection: "events", action: "read" },
        { collection: "events", action: "create" },
        { collection: "events", action: "update" },
        { collection: "volunteer_shifts", action: "read" },
        { collection: "volunteer_shifts", action: "create" },
        { collection: "volunteer_shifts", action: "update" },
        { collection: "programs", action: "read" },
        { collection: "beneficiaries", action: "read" },
      ],
    },
    {
      name: "Donor (portal)",
      description: "Signed-in donor self-service: browse campaigns and events, see own donor record, donations and pledges.",
      permissions: [
        { collection: "campaigns", action: "read" },
        { collection: "events", action: "read" },
        { collection: "donors", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "donations", action: "read", condition: { "donor.app_user_id": { _eq: "$user.id" } } },
        { collection: "pledges", action: "read", condition: { "donor.app_user_id": { _eq: "$user.id" } } },
      ],
    },
    {
      name: "Volunteer (portal)",
      description: "Signed-in volunteer self-service: browse events, see own volunteer profile and shifts.",
      permissions: [
        { collection: "events", action: "read" },
        { collection: "volunteers", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "volunteer_shifts", action: "read", condition: { "volunteer.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "Fundraising overview",
      description: "Giving, campaigns, grants and volunteering at a glance.",
      panels: [
        { name: "Donors", kind: "items-aggregate", viz: "counter", config: { collection: "donors", agg: "count" } },
        { name: "Donated", kind: "items-aggregate", viz: "counter", config: { collection: "donations", agg: "sum", field: "amount" } },
        { name: "Pledged", kind: "items-aggregate", viz: "counter", config: { collection: "pledges", agg: "sum", field: "amount" } },
        { name: "Volunteers", kind: "items-aggregate", viz: "counter", config: { collection: "volunteers", agg: "count" } },
        { name: "Campaigns by status", kind: "items-aggregate", viz: "donut", config: { collection: "campaigns", agg: "count", groupBy: "status" } },
        { name: "Donations by method", kind: "items-aggregate", viz: "bars", config: { collection: "donations", agg: "count", groupBy: "payment_method" } },
        { name: "Grants by status", kind: "items-aggregate", viz: "bars", config: { collection: "grants", agg: "count", groupBy: "status" } },
        { name: "Memberships by status", kind: "items-aggregate", viz: "donut", config: { collection: "memberships", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * The rules a fundraising office runs on, already running.
   *
   * Deliberately absent: "a gift landed, so add it to the donor's total and to
   * the campaign's raised amount". Both are running totals, and a running total
   * needs the figure already there PLUS this one — a flow's `data` is the
   * donation row alone, and `item.update` writes a value rather than adding to
   * one. A step that set `total_donated` to this gift's amount would replace a
   * lifetime of giving with the last cheque. So the flow records the gift, logs
   * the acknowledgement it owes, and leaves the totals to whoever keeps them.
   *
   * Absent for the opposite reason: a `…:transition:` trigger. Not one status
   * field in this template declares a lifecycle, so there is no move to hang off
   * — `…:updated` plus a condition is what is available, and it cannot tell
   * "just became completed" from "was saved again while completed". That is why
   * nothing below writes a row on an update: the two flows that act on a status
   * act on the CREATE, which happens once.
   */
  flows: [
    {
      name: "Log the thank-you a completed gift owes its donor",
      trigger: "event:items:donations:created",
      operations: [
        {
          // `sent_at` is deliberately left empty: the row records an
          // acknowledgement that is OWED, not one that went out, and whoever
          // sends it fills the date in. The donor id is on the donation itself,
          // so this is the one link a flow here can make honestly.
          type: "condition",
          filter: { status: { _eq: "completed" } },
          then: [
            {
              type: "item.create",
              collection: "communications",
              data: {
                donor: "{{ data.donor }}",
                channel: "email",
                subject: "Thank-you for the gift of {{ data.amount }} {{ data.currency }}",
              },
            },
          ],
        },
        {
          type: "notification",
          title: "Gift recorded: {{ data.amount }} {{ data.currency }}",
          body: "Taken by {{ data.payment_method }}, status {{ data.status }}. A completed gift has an acknowledgement waiting in Communications.",
          url: "/collections/donations",
        },
      ],
    },
    {
      name: "Chase a pledge instalment three days before it falls due",
      // Fires once per instalment, three days before `due_on`, at 09:00, and
      // only for the ones still owed.
      //
      // No communication row is written here, and that is not an omission: the
      // donor is on the PLEDGE, not on the instalment, and a flow's `data` is
      // one row with nothing to join through. Writing `donor: null` would put a
      // dangling acknowledgement in the donor timeline, so the flow reports the
      // instalment and leaves the reminder to the person who can see who it is.
      trigger: `schedule:${JSON.stringify({
        collection: "pledge_payments",
        field: "due_on",
        offset: { value: 3, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "scheduled" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "Pledge instalment of {{ data.amount }} is due in three days",
          body: "Open the instalment, follow it to its pledge and its donor, and send the reminder that donor prefers.",
          url: "/collections/pledge_payments",
        },
      ],
    },
    {
      name: "Sweep overnight: instalments past due, memberships past renewal",
      // One flow because it is one fact twice: a date has passed and the row
      // still says otherwise. Both filters exclude the rows already moved, so
      // the sweep is safe to run every night and writes nothing on a quiet one.
      //
      // No grace period is assumed on either — a workspace that gives members a
      // fortnight widens the second filter rather than discovering later that a
      // renewal it had already banked was marked lapsed at 6am.
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "pledge_payments",
          filter: { status: { _eq: "scheduled" }, due_on: { _lt: "$now" } },
          sort: "due_on",
          do: [
            {
              type: "item.update",
              collection: "pledge_payments",
              id: "{{ $item.id }}",
              data: { status: "overdue" },
            },
          ],
        },
        {
          type: "foreach",
          collection: "memberships",
          filter: { status: { _eq: "active" }, renews_at: { _lt: "$now" } },
          sort: "renews_at",
          do: [
            {
              type: "item.update",
              collection: "memberships",
              id: "{{ $item.id }}",
              data: { status: "lapsed" },
            },
          ],
        },
      ],
    },
    {
      name: "Warn thirty days before a grant report is due",
      // Thirty days rather than three: a grant report is written from programme
      // figures somebody else holds, and the cost of missing one is not a late
      // fee, it is the next grant. `upcoming` is the only status that can still
      // be late — a submitted or approved report has nothing left to chase.
      trigger: `schedule:${JSON.stringify({
        collection: "grant_reports",
        field: "due_date",
        offset: { value: 30, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "upcoming" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "Grant report due in 30 days: {{ data.title }}",
          body: "Due {{ data.due_date }}. Ask the programme for its figures now — the cover sheet is the quick part.",
          url: "/collections/grant_reports",
        },
      ],
    },
    {
      name: "Email the donor's receipt for a completed gift (needs email + a PDF renderer)",
      // Off until both are configured; the name carries the prerequisite so
      // nobody has to open it to find out.
      active: false,
      // On the CREATE, not on `tax_receipt_sent` being ticked — which is the
      // version that reads better and would be wrong. `status` declares no
      // lifecycle here, so there is no transition trigger to use, and an
      // `…:updated` one cannot tell a first tick from the fifth save afterwards:
      // every corrected typo would post the donor another receipt. A gift is
      // recorded `completed` by default, so the create IS the receiptable
      // moment, and it happens exactly once.
      trigger: "event:items:donations:created",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "completed" } },
          then: [
            { type: "document.render", templateKey: "donation_receipt" },
            {
              type: "email",
              to: "{{ data.donor.email }}",
              subject: "Your donation receipt",
              html: "<p>Thank you for your gift. Your receipt is attached.</p>",
              attach: ["{{ $last.key }}"],
            },
          ],
        },
      ],
    },
    {
      name: "Monthly fundraising report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Fundraising overview",
          subject: "Fundraising — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "donation_receipt",
      name: "Donation receipt",
      description: "The receipt a donor keeps for their own tax return.",
      // Keyed on the row id rather than a receipt number, because this template
      // does not issue one yet. Point both at the number the day the column
      // exists — a receipt an auditor can find twice is the whole point of it.
      filename: "donation-receipt-{{ data.id }}",
      variables: ["amount", "currency", "donated_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:36%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>Donation receipt</h1>" +
        '<p class="muted">Reference {{ data.id }} · Received {{ data.donated_at }}</p>' +
        "<p><strong>{{ data.donor.name }}</strong><br>{{ data.donor.address }}<br>" +
        "{{ data.donor.city }} {{ data.donor.country }}</p>" +
        "<table>" +
        "<tr><th>Amount</th><td>{{ data.amount }} {{ data.currency }}</td></tr>" +
        "<tr><th>Received by</th><td>{{ data.payment_method }}</td></tr>" +
        "<tr><th>Gift type</th><td>{{ data.type }}</td></tr>" +
        "<tr><th>Appeal</th><td>{{ data.campaign.name }}</td></tr>" +
        "<tr><th>Fund</th><td>{{ data.fund.name }} ({{ data.fund.restriction }})</td></tr>" +
        "</table>" +
        '<p class="muted">No goods or services were provided in return for this gift ' +
        "unless stated above. Which registration this is receipted under, and whether " +
        "it is deductible, is for your organisation to state here before the first one " +
        "goes out — nobody else can say it for you.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "grant_report_cover",
      name: "Grant report cover sheet",
      description: "The page a grant report is submitted behind.",
      filename: "grant-report-{{ data.id }}",
      variables: ["title", "due_date"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">Report on {{ data.grant.name }} · {{ data.grant.funder }}</p>' +
        "<table>" +
        "<tr><th>Grant</th><td>{{ data.grant.name }}</td></tr>" +
        "<tr><th>Funder</th><td>{{ data.grant.funder }}</td></tr>" +
        "<tr><th>Awarded</th><td>{{ data.grant.amount }}</td></tr>" +
        "<tr><th>Report due</th><td>{{ data.due_date }}</td></tr>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "<tr><th>Submitted</th><td>{{ data.submitted_at }}</td></tr>" +
        "</table>" +
        "<p>{{ data.note }}</p>" +
        '<p class="muted">What the money did belongs on the pages after this one. ' +
        "A cover sheet reads one row, and programme spend sits on the programme — " +
        "the two are never added together on the way out of here.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      // `status` and the login link are deliberately off: a public link that
      // could set either is a public link that admits somebody to the workspace.
      // The column's default puts a sign-up in as active, which is where the
      // coordinator picks it up.
      name: "Volunteer sign-up",
      collection: "volunteers",
      settings: {
        submitLabel: "Sign me up",
        successMessage: "Thank you — the volunteer coordinator will be in touch before the next shift.",
      },
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Email", help: "Where shift confirmations are sent." },
        { name: "phone", label: "Phone", help: "Include the country code — numbers are stored in international form." },
        { name: "skills", label: "What can you help with?", help: "Anything you have done before, and when you are usually free." },
      ],
    },
    {
      // `annual_fee` is asked of nobody: what a level costs is the
      // organisation's to state, not the applicant's to offer. The dates and
      // `status` are the membership team's for the same reason — an applicant
      // cannot make themselves active by ticking a box.
      name: "Membership application",
      collection: "memberships",
      settings: {
        submitLabel: "Apply to join",
        successMessage: "Thank you — we'll confirm your membership and its fee before anything is charged.",
      },
      fields: [
        { name: "member_name", label: "Full name" },
        { name: "member_email", label: "Email" },
        { name: "level", label: "Membership level", help: "Pick the one that fits — we'll confirm what it costs." },
      ],
    },
  ],
  agents: [
    {
      name: "Fundraising analyst",
      handle: "fundraising-analyst",
      description: "Answers what was given, what was only promised, and what is still owed to a funder.",
      systemPrompt:
        "You help a fundraising team read its own giving. Answer from the " +
        "workspace's data and nothing else.\n\n" +
        "Money given and money promised are different things: a donation is " +
        "received, a pledge is a promise, and its instalments live in pledge " +
        "payments. Never add pledged amounts into a giving total — report them " +
        "side by side and say which is which. Only a donation whose status is " +
        "completed has been received; pending and refunded have not. Amounts in " +
        "different currencies are never added together.\n\n" +
        "Restricted money is not spendable money. The restriction is on the " +
        "fund a gift points at, so name the fund behind any figure and never " +
        "present temporarily or permanently restricted gifts as available to " +
        "the general programme.\n\n" +
        "Two confidences hold however the question is put. A gift marked " +
        "anonymous counts in a total but its donor is never named. " +
        "Beneficiaries are recorded under an alias on purpose — report them as " +
        "counts by programme and status, never as people.\n\n" +
        "Grant reporting is judged on dates: rank grant reports by due date, " +
        "soonest first, and treat anything still upcoming past its due date as " +
        "late. Volunteer effort is the hours on completed shifts — a scheduled " +
        "shift has not happened yet. The workspace's agreed figures are the " +
        "Fundraising overview dashboard, so read them there rather than adding " +
        "rows up your own way. Be brief, name the campaign, fund or grant you " +
        "mean, and say plainly when the data does not answer the question.",
      // No KPI tool: this template bundles a dashboard and no KPI definitions,
      // so that dashboard is where its agreed figures actually live.
      tools: [
        "collections.list",
        "collections.read",
        "collections.aggregate",
        "collections.search",
        "dashboards.run",
      ],
      maxSteps: 8,
    },
  ],
};
