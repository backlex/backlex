import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, computedText, date, email, file, flag, flow, geo, half, hint, int, money, moneyIn, ms, notes, num, parent, pct, phone, rel, sec, select, seq, stacked, tabbed, text, ts, userLink, when } from "../dsl";

export const hr: SchemaTemplate = {
  id: "hr",
  label: "HR / People",
  groups: ["People", "Organization", "Operations", "Payroll", "Learning"],
  description:
    "Workday/BambooHR-grade HRIS: employees with manager hierarchy, departments, locations, positions, a full leave stack (leave types, per-year allocations with remaining balance, requests, public holidays), attendance, contracts, benefits with enrollments, goals, onboarding checklists, performance reviews, promotions and transfers, emergency contacts, documents, compensation history, payroll runs with payslips, expense claims and a training register.",
  collections: [
    {
      slug: "departments", group: "Organization", singular: "Department", plural: "Departments", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("code")),
        ...half(parent("departments"), text("cost_center", { label: "Cost center" })),
      ],
      samples: [{ name: "Engineering", code: "ENG" }, { name: "Sales", code: "SALES" }],
    },
    {
      slug: "locations", group: "Organization", singular: "Location", plural: "Locations", defaultSort: "name",
      fields: [
        ...half(
          text("name", { required: true }),
          select("type", [ch("office", C.blue), ch("remote", C.teal), ch("hybrid", C.purple), ch("field", C.amber)], { default: "office" }),
        ),
        ...half(text("city"), text("country")),
        geo("coordinates", ["city", "country"], { label: "Map pin" }),
        ...half(text("timezone", { label: "Timezone (IANA)" }), bool("is_headquarters", { default: false, label: "Headquarters" })),
      ],
      samples: [{ name: "HQ", type: "office", city: "Austin", country: "US", timezone: "America/Chicago", is_headquarters: true }],
    },
    {
      slug: "positions", group: "Organization", singular: "Position", plural: "Positions", defaultSort: "title",
      fields: [
        ...half(text("title", { required: true }), text("job_code", { label: "Job code" })),
        ...half(rel("department", "departments"), text("level", { label: "Level / grade" })),
        ...half(
          select("flsa_status", [ch("exempt", C.blue), ch("non_exempt", C.amber, "Non-exempt")], { default: "exempt", label: "FLSA status" }),
          bool("is_filled", { default: false, label: "Filled" }),
        ),
      ],
      samples: [{ title: "Software Engineer", job_code: "ENG-2", department: { ref: "departments:0" }, level: "L3", flsa_status: "exempt" }, { title: "Account Executive", job_code: "SAL-2", department: { ref: "departments:1" }, level: "L3", flsa_status: "exempt" }],
    },
    {
      slug: "leave_types", group: "Operations", singular: "Leave type", plural: "Leave types", defaultSort: "name",
      note: "Time-off policy catalog — leave requests and yearly allocations reference these.",
      fields: [
        ...half(text("name", { required: true }), num("default_annual_days", { validation: { min: 0 }, label: "Default annual days" })),
        ...half(bool("paid", { default: true, label: "Paid" }), bool("requires_approval", { default: true, label: "Requires approval" })),
        text("color", { interface: "color" }),
      ],
      samples: [
        { name: "Vacation", paid: true, requires_approval: true, default_annual_days: 20, color: C.blue },
        { name: "Sick leave", paid: true, requires_approval: false, default_annual_days: 10, color: C.amber },
        { name: "Unpaid leave", paid: false, requires_approval: true, default_annual_days: 0, color: C.gray },
      ],
    },
    {
      slug: "benefits", group: "Organization", singular: "Benefit", plural: "Benefits", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("provider")),
        ...half(
          select("type", [ch("health", C.green), ch("dental", C.teal), ch("retirement", C.purple), ch("stipend", C.blue)], { default: "health" }),
          money("monthly_cost", { label: "Monthly cost" }),
        ),
        flag("active"),
      ],
      samples: [
        { name: "Medical PPO", provider: "BlueShield", type: "health", monthly_cost: 450, active: true },
        { name: "401(k) match", provider: "Fidelity", type: "retirement", monthly_cost: 200, active: true },
        { name: "Wellness stipend", type: "stipend", monthly_cost: 50, active: true },
      ],
    },
    {
      slug: "public_holidays", group: "Operations", singular: "Public holiday", plural: "Public holidays", defaultSort: "date",
      fields: [
        ...half(text("name", { required: true }), date("date", { indexed: true, required: true })),
        rel("location", "locations", { label: "Location", description: "Leave empty to apply the holiday everywhere." }),
      ],
      samples: [
        { name: "Independence Day (observed)", date: ms("2026-07-03"), location: { ref: "locations:0" } },
        { name: "Labor Day", date: ms("2026-09-07"), location: { ref: "locations:0" } },
      ],
    },
    {
      slug: "employees", group: "People", singular: "Employee", plural: "Employees", fts: true, defaultSort: "last_name",
      displayTemplate: "{{first_name}} {{last_name}}",
      portalLink: { emailField: "work_email", role: "Employee (self-service)" },
      fields: tabbed(
        sec("Identity", [
          ...half(seq("employee_number", "E-{####}", { label: "Employee #" }), computedText("full_name", "first_name || ' ' || last_name", { label: "Full name" })),
          ...half(text("first_name", { label: "First name", searchable: true }), text("last_name", { label: "Last name", searchable: true })),
          text("preferred_name", { label: "Preferred name" }),
        ]),
        sec("Contact", [
          ...half(email("work_email", { unique: true, label: "Work email" }), email("personal_email", { label: "Personal email" })),
          ...half(phone("phone"), date("date_of_birth", { label: "Date of birth" })),
          userLink(),
        ]),
        sec("Role", [
          text("job_title", { label: "Job title" }),
          ...half(rel("department", "departments"), rel("position", "positions")),
          ...half(rel("manager", "employees"), rel("location", "locations")),
        ]),
        sec("Employment", [
          ...half(
            select("employment_type", [ch("full_time", C.green, "Full time"), ch("part_time", C.blue, "Part time"), ch("contract", C.amber), ch("intern", C.teal), ch("temporary", C.gray)], { default: "full_time", label: "Employment type" }),
            select("status", [ch("active", C.green), ch("on_leave", C.amber, "On leave"), ch("terminated", C.red)], { default: "active" }),
          ),
          ...half(
            date("hire_date", { indexed: true, label: "Hire date" }),
            date("termination_date", { label: "Termination date", conditions: [when("status", "_eq", "terminated", "required")] }),
          ),
        ]),
        sec("Compensation", [
          hint("employees_comp", "This is the current headline figure. Every change is kept as its own row under Compensation history."),
          ...half(money("compensation_amount", { label: "Base compensation" }), select("compensation_currency", ["USD", "EUR", "GBP"], { default: "USD", label: "Currency" })),
          select("pay_frequency", [ch("hourly", C.gray), ch("biweekly", C.blue), ch("semimonthly", C.teal, "Semi-monthly"), ch("monthly", C.purple), ch("annually", C.green)], { default: "monthly", label: "Pay frequency" }),
        ]),
      ),
      samples: [
        { first_name: "Ada", last_name: "Lovelace", work_email: "ada@company.example", job_title: "Software Engineer", department: { ref: "departments:0" }, position: { ref: "positions:0" }, location: { ref: "locations:0" }, employment_type: "full_time", status: "active", hire_date: ms("2024-03-01"), compensation_amount: 145000 },
        { first_name: "Sam", last_name: "Taylor", work_email: "sam@company.example", job_title: "Account Executive", department: { ref: "departments:1" }, position: { ref: "positions:1" }, location: { ref: "locations:0" }, employment_type: "full_time", status: "active", hire_date: ms("2025-09-15"), compensation_amount: 110000 },
      ],
    },
    {
      slug: "emergency_contacts", group: "People", singular: "Emergency contact", plural: "Emergency contacts",
      fields: [
        ...half(rel("employee", "employees", { required: true }), text("name", { required: true })),
        ...half(text("relationship"), phone("phone", { required: true })),
        ...half(email("email"), bool("is_primary", { default: false, label: "Primary contact" })),
      ],
      samples: [{ employee: { ref: "employees:0" }, name: "Byron Lovelace", relationship: "Spouse", phone: "+15555550177", is_primary: true }],
    },
    {
      slug: "leave_allocations", group: "Operations", singular: "Leave allocation", plural: "Leave allocations", defaultSort: "-year",
      note: "Per-employee, per-type, per-year balance.",
      fields: [
        hint("leave_alloc_remaining", "Days remaining is generated as allocated − used; correct the two inputs rather than the balance."),
        ...half(rel("employee", "employees", { required: true }), rel("leave_type", "leave_types", { required: true, label: "Leave type" })),
        ...half(int("year", { indexed: true, validation: { min: 2000 } }), num("days_allocated", { validation: { min: 0 }, label: "Days allocated" })),
        ...half(
          num("days_used", { default: 0, validation: { min: 0 }, label: "Days used" }),
          computedNum("days_remaining", "days_allocated - days_used", { label: "Days remaining" }),
        ),
      ],
      samples: [
        { employee: { ref: "employees:0" }, leave_type: { ref: "leave_types:0" }, year: 2026, days_allocated: 20, days_used: 5 },
        { employee: { ref: "employees:0" }, leave_type: { ref: "leave_types:1" }, year: 2026, days_allocated: 10, days_used: 1 },
        { employee: { ref: "employees:1" }, leave_type: { ref: "leave_types:0" }, year: 2026, days_allocated: 20, days_used: 0 },
      ],
    },
    {
      slug: "leave_requests", group: "Operations", singular: "Time off", plural: "Time off", defaultSort: "-start_date",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Request", [
          rel("employee", "employees"),
          ...half(
            select("type", [ch("vacation", C.blue), ch("sick", C.amber), ch("personal", C.teal), ch("unpaid", C.gray), ch("parental", C.purple), ch("bereavement", C.slate)], { default: "vacation" }),
            rel("leave_type", "leave_types", { label: "Leave type" }),
          ),
          notes("reason"),
        ]),
        sec("Dates", [
          ...half(
            date("start_date", { range: { end: "end_date", bounds: "[]" }, indexed: true, label: "Start date" }),
            date("end_date", { label: "End date", validation: { rule: { end_date: { _gte: "$field.start_date" } }, message: "End date must be on or after the start date." } }),
          ),
          ...half(num("days", { validation: { min: 0 } }), bool("half_day", { default: false, label: "Half day" })),
        ]),
        sec("Approval", [
          ...half(
            select("status", [ch("pending", C.amber), ch("approved", C.green), ch("denied", C.red), ch("cancelled", C.gray)], {
              default: "pending",
              ...flow(
                { pending: ["approved", "denied", "cancelled"], approved: ["cancelled"] },
                { initial: ["pending"], labels: { approved: "Approve", denied: "Deny", cancelled: "Cancel" } },
              ),
            }),
            rel("approver", "employees"),
          ),
          ts("approved_at", { label: "Approved at" }),
        ]),
      ),
      samples: [
        { employee: { ref: "employees:0" }, type: "vacation", leave_type: { ref: "leave_types:0" }, start_date: ms("2026-08-10"), end_date: ms("2026-08-17"), days: 5, status: "pending" },
        { employee: { ref: "employees:1" }, type: "sick", leave_type: { ref: "leave_types:1" }, start_date: ms("2026-06-24"), end_date: ms("2026-06-24"), days: 1, status: "approved", approver: { ref: "employees:0" }, approved_at: ms("2026-06-23T15:00:00Z"), reason: "Doctor's appointment." },
      ],
    },
    {
      slug: "attendance_records", group: "Operations", singular: "Attendance record", plural: "Attendance", defaultSort: "-date",
      fields: [
        ...half(rel("employee", "employees", { required: true }), date("date", { indexed: true, required: true })),
        ...half(ts("check_in", { range: { end: "check_out" }, label: "Check in" }), ts("check_out", { label: "Check out" })),
        ...half(
          int("worked_minutes", { validation: { min: 0 }, label: "Worked (min)" }),
          select("status", [ch("present", C.green), ch("remote", C.teal), ch("absent", C.red), ch("late", C.amber)], { default: "present" }),
        ),
      ],
      samples: [
        { employee: { ref: "employees:0" }, date: ms("2026-07-09"), check_in: ms("2026-07-09T14:00:00Z"), check_out: ms("2026-07-09T22:30:00Z"), worked_minutes: 480, status: "present" },
        { employee: { ref: "employees:1" }, date: ms("2026-07-09"), check_in: ms("2026-07-09T13:30:00Z"), check_out: ms("2026-07-09T22:00:00Z"), worked_minutes: 480, status: "remote" },
      ],
    },
    {
      slug: "contracts", group: "People", singular: "Contract", plural: "Contracts", defaultSort: "-start_date",
      fields: stacked(
        sec("Contract", [
          ...half(
            rel("employee", "employees", { required: true }),
            select("type", [ch("permanent", C.green), ch("fixed_term", C.blue, "Fixed term"), ch("contractor", C.amber)], { default: "permanent" }),
          ),
          ...half(
            select("status", [ch("draft", C.gray), ch("active", C.green), ch("expired", C.slate), ch("terminated", C.red)], { default: "active" }),
            num("weekly_hours", { validation: { min: 0 }, label: "Weekly hours" }),
          ),
        ]),
        sec("Term & pay", [
          ...half(date("start_date", { range: { end: "end_date", bounds: "[]" }, indexed: true, label: "Start date" }), date("end_date", { label: "End date" })),
          ...half(moneyIn("salary"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
        ]),
      ),
      samples: [
        { employee: { ref: "employees:0" }, type: "permanent", start_date: ms("2024-03-01"), weekly_hours: 40, salary: 145000, currency: "USD", status: "active" },
        { employee: { ref: "employees:1" }, type: "permanent", start_date: ms("2025-09-15"), weekly_hours: 40, salary: 110000, currency: "USD", status: "active" },
      ],
    },
    {
      slug: "benefit_enrollments", group: "People", singular: "Benefit enrollment", plural: "Benefit enrollments", defaultSort: "-since",
      fields: [
        ...half(rel("employee", "employees", { required: true }), rel("benefit", "benefits", { required: true })),
        ...half(
          date("since", { indexed: true, label: "Enrolled since" }),
          select("status", [ch("active", C.green), ch("waived", C.gray), ch("ended", C.slate)], { default: "active" }),
        ),
      ],
      samples: [
        { employee: { ref: "employees:0" }, benefit: { ref: "benefits:0" }, since: ms("2024-04-01"), status: "active" },
        { employee: { ref: "employees:0" }, benefit: { ref: "benefits:1" }, since: ms("2024-04-01"), status: "active" },
        { employee: { ref: "employees:1" }, benefit: { ref: "benefits:0" }, since: ms("2025-10-01"), status: "active" },
      ],
    },
    {
      slug: "performance_reviews", group: "Operations", singular: "Review", plural: "Reviews", defaultSort: "-created_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Review", [
          ...half(rel("employee", "employees"), rel("reviewer", "employees")),
          ...half(
            text("period", { label: "Cycle / period" }),
            select("review_type", [ch("annual", C.blue), ch("quarterly", C.teal), ch("probationary", C.amber), ch("self", C.gray), ch("peer", C.purple), ch("360", C.green)], { default: "annual", label: "Review type" }),
          ),
        ]),
        sec("Outcome", [
          ...half(
            select("rating", [ch("outstanding", C.green), ch("exceeds", C.teal, "Exceeds expectations"), ch("meets", C.blue, "Meets expectations"), ch("partially_meets", C.amber, "Partially meets"), ch("does_not_meet", C.red, "Does not meet")], { default: "meets" }),
            select("status", [ch("not_started", C.gray, "Not started"), ch("in_progress", C.blue, "In progress"), ch("submitted", C.amber), ch("completed", C.green)], { default: "not_started" }),
          ),
          notes("notes"),
        ]),
      ),
      samples: [{ employee: { ref: "employees:0" }, period: "2025 H2", review_type: "annual", rating: "outstanding", status: "completed", notes: "Outstanding contributions this half." }],
    },
    {
      slug: "goals", group: "Operations", singular: "Goal", plural: "Goals", defaultSort: "due_date",
      fields: stacked(
        sec("Goal", [
          ...half(rel("employee", "employees", { required: true }), text("title", { required: true })),
          notes("description"),
        ]),
        sec("Tracking", [
          ...half(date("due_date", { indexed: true, label: "Due" }), pct("progress", { label: "Progress %" })),
          ...half(
            select("status", [ch("on_track", C.green, "On track"), ch("at_risk", C.amber, "At risk"), ch("behind", C.red), ch("achieved", C.blue), ch("dropped", C.gray)], { default: "on_track" }),
            rel("review", "performance_reviews", { label: "Linked review" }),
          ),
        ]),
      ),
      samples: [
        { employee: { ref: "employees:0" }, title: "Ship API platform v2", due_date: ms("2026-09-30"), progress: 60, status: "on_track", review: { ref: "performance_reviews:0" } },
        { employee: { ref: "employees:1" }, title: "Close $500k new ARR", due_date: ms("2026-12-31"), progress: 35, status: "at_risk" },
      ],
    },
    {
      slug: "onboarding_tasks", group: "Operations", singular: "Onboarding task", plural: "Onboarding tasks", defaultSort: "due_date",
      fields: [
        ...half(rel("employee", "employees", { required: true }), text("task", { required: true })),
        ...half(
          select("owner", [ch("hr", C.purple, "HR"), ch("it", C.blue, "IT"), ch("manager", C.teal)], { default: "hr" }),
          date("due_date", { indexed: true, label: "Due" }),
        ),
        bool("done", { default: false }),
      ],
      samples: [
        { employee: { ref: "employees:1" }, task: "Provision laptop and accounts", owner: "it", due_date: ms("2025-09-15"), done: true },
        { employee: { ref: "employees:1" }, task: "Benefits enrollment session", owner: "hr", due_date: ms("2025-09-22"), done: true },
        { employee: { ref: "employees:1" }, task: "30-day check-in", owner: "manager", due_date: ms("2025-10-15"), done: false },
      ],
    },
    {
      // Promotion / transfer / separation as one auditable trail (ERPNext splits
      // these into three doctypes; one row per move keeps the history readable).
      slug: "job_changes", group: "People", singular: "Job change", plural: "Job changes", defaultSort: "-effective_date",
      fields: stacked(
        sec("Change", [
          ...half(
            rel("employee", "employees", { required: true }),
            select("kind", [ch("promotion", C.green), ch("transfer", C.blue), ch("role_change", C.teal, "Role change"), ch("separation", C.red)], { default: "promotion" }),
          ),
          ...half(date("effective_date", { indexed: true, label: "Effective date" }), rel("approved_by", "employees", { label: "Approved by" })),
        ]),
        sec("From → to", [
          ...half(rel("from_position", "positions", { label: "From position" }), rel("to_position", "positions", { label: "To position" })),
          ...half(rel("from_department", "departments", { label: "From department" }), rel("to_department", "departments", { label: "To department" })),
          notes("note"),
        ]),
      ),
      samples: [{ employee: { ref: "employees:0" }, kind: "promotion", effective_date: ms("2026-04-01"), from_position: { ref: "positions:0" }, to_position: { ref: "positions:0" }, note: "Promoted to senior band after the H2 review." }],
    },
    {
      slug: "documents", group: "People", singular: "Document", plural: "Documents",
      fields: [
        ...half(rel("employee", "employees"), text("title")),
        ...half(
          select("type", [ch("offer_letter", C.blue, "Offer letter"), ch("contract", C.purple), ch("tax_form", C.amber, "Tax form"), ch("certification", C.teal), ch("policy", C.gray), ch("other", C.slate)], { default: "other" }),
          date("expires_at", { label: "Expires at" }),
        ),
        file("file"),
      ],
      samples: [{ employee: { ref: "employees:0" }, title: "Offer letter", type: "offer_letter" }],
    },
    {
      slug: "compensation_history", group: "People", singular: "Compensation change", plural: "Compensation history", defaultSort: "-effective_date",
      fields: [
        ...half(rel("employee", "employees"), date("effective_date", { indexed: true, label: "Effective date" })),
        ...half(moneyIn("amount"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
        ...half(
          select("pay_type", [ch("salary", C.blue), ch("hourly", C.teal)], { default: "salary", label: "Pay type" }),
          select("change_reason", [ch("hire", C.green), ch("merit", C.blue), ch("promotion", C.purple), ch("market_adjustment", C.amber, "Market adjustment"), ch("role_change", C.teal, "Role change")], { default: "merit", label: "Reason" }),
        ),
      ],
      samples: [{ employee: { ref: "employees:0" }, effective_date: ms("2024-03-01"), amount: 145000, currency: "USD", pay_type: "salary", change_reason: "hire" }],
    },
    {
      slug: "payroll_runs", group: "Payroll", singular: "Payroll run", plural: "Payroll runs", defaultSort: "-pay_date",
      fields: stacked(
        sec("Run", [
          ...half(text("name", { required: true }), select("status", [ch("draft", C.gray), ch("processing", C.blue), ch("approved", C.teal), ch("paid", C.green), ch("cancelled", C.red)], { default: "draft" })),
          ...half(date("period_start", { range: { end: "period_end", bounds: "[]" }, label: "Period start" }), date("period_end", { label: "Period end" })),
          ...half(date("pay_date", { indexed: true, label: "Pay date" }), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
        ]),
        sec("Totals", [
          hint("payroll_totals", "Totals summarise the payslips in this run — regenerate them after adding or editing a payslip."),
          ...half(moneyIn("total_gross", { label: "Total gross" }), moneyIn("total_deductions", { label: "Total deductions" })),
          ...half(moneyIn("total_net", { label: "Total net" }), int("employee_count", { label: "Employees paid" })),
        ]),
      ),
      samples: [{ name: "July 2026 — monthly", status: "paid", period_start: ms("2026-07-01"), period_end: ms("2026-07-31"), pay_date: ms("2026-07-31"), currency: "USD", total_gross: 21250, total_deductions: 5950, total_net: 15300, employee_count: 2 }],
    },
    {
      slug: "payslips", group: "Payroll", singular: "Payslip", plural: "Payslips", defaultSort: "-created_at",
      fields: stacked(
        sec("Payslip", [
          ...half(rel("payroll_run", "payroll_runs", { required: true }), rel("employee", "employees", { required: true })),
          ...half(
            select("status", [ch("draft", C.gray), ch("issued", C.blue), ch("paid", C.green)], { default: "draft" }),
            num("worked_days", { validation: { min: 0 }, label: "Worked days" }),
          ),
        ]),
        sec("Earnings", [
          ...half(money("base_pay", { label: "Base pay" }), money("overtime_pay", { label: "Overtime" })),
          ...half(money("bonus"), money("gross_pay", { label: "Gross pay" })),
        ]),
        sec("Deductions", [
          ...half(money("tax"), money("social_security", { label: "Social security" })),
          ...half(money("other_deductions", { label: "Other deductions" }), money("net_pay", { label: "Net pay" })),
          file("document", { label: "Payslip PDF" }),
        ]),
      ),
      samples: [
        { payroll_run: { ref: "payroll_runs:0" }, employee: { ref: "employees:0" }, status: "paid", worked_days: 22, base_pay: 12083, gross_pay: 12083, tax: 2900, social_security: 520, net_pay: 8663 },
        { payroll_run: { ref: "payroll_runs:0" }, employee: { ref: "employees:1" }, status: "paid", worked_days: 22, base_pay: 9167, gross_pay: 9167, tax: 2200, social_security: 400, net_pay: 6567 },
      ],
    },
    {
      slug: "expense_claims", group: "Payroll", singular: "Expense claim", plural: "Expense claims", defaultSort: "-spent_on",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Claim", [
          ...half(rel("employee", "employees", { required: true }), date("spent_on", { indexed: true, label: "Spent on" })),
          ...half(
            select("category", [ch("travel", C.blue), ch("meals", C.amber), ch("equipment", C.purple), ch("training", C.teal), ch("other", C.slate)], { default: "travel" }),
            text("merchant"),
          ),
          ...half(moneyIn("amount", { required: true }), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
          notes("description"),
        ]),
        sec("Approval", [
          ...half(
            select("status", [ch("draft", C.gray), ch("submitted", C.blue), ch("approved", C.green), ch("rejected", C.red), ch("reimbursed", C.teal)], { default: "draft" }),
            rel("approver", "employees"),
          ),
          ...half(
            date("reimbursed_on", {
              label: "Reimbursed on",
              conditions: [
                when("status", "_eq", "reimbursed", "required"),
                when("status", "_neq", "reimbursed", "hidden"),
              ],
            }),
            file("receipt"),
          ),
        ]),
      ),
      samples: [
        { employee: { ref: "employees:1" }, spent_on: ms("2026-06-18"), category: "travel", merchant: "Delta", amount: 480, currency: "USD", description: "Customer visit — Chicago.", status: "reimbursed", approver: { ref: "employees:0" }, reimbursed_on: ms("2026-06-30") },
        { employee: { ref: "employees:0" }, spent_on: ms("2026-07-02"), category: "equipment", merchant: "Apple", amount: 1450, currency: "USD", description: "Replacement laptop.", status: "submitted" },
      ],
    },
    {
      slug: "trainings", group: "Learning", singular: "Training", plural: "Trainings", defaultSort: "-starts_at",
      fields: stacked(
        sec("Training", [
          ...half(text("name", { required: true }), select("kind", [ch("onboarding", C.blue), ch("compliance", C.red), ch("technical", C.teal), ch("leadership", C.purple), ch("other", C.slate)], { default: "technical" })),
          notes("description"),
          ...half(text("provider"), bool("mandatory", { default: false, label: "Mandatory" })),
        ]),
        sec("Schedule", [
          ...half(ts("starts_at", { range: { end: "ends_at" }, indexed: true, label: "Starts at" }), ts("ends_at", { label: "Ends at" })),
          ...half(text("location"), money("cost_per_seat", { label: "Cost per seat" })),
        ]),
      ),
      samples: [
        { name: "Security awareness 2026", kind: "compliance", description: "Annual security and data-handling refresher.", provider: "Internal", mandatory: true, starts_at: ms("2026-09-01T09:00:00Z"), ends_at: ms("2026-09-01T12:00:00Z"), location: "Remote", cost_per_seat: 0 },
        { name: "Advanced TypeScript", kind: "technical", provider: "Frontend Masters", mandatory: false, starts_at: ms("2026-10-05T13:00:00Z"), ends_at: ms("2026-10-07T17:00:00Z"), location: "Remote", cost_per_seat: 350 },
      ],
    },
    {
      slug: "training_attendance", group: "Learning", singular: "Training attendance", plural: "Training attendance",
      fields: [
        ...half(rel("training", "trainings", { required: true }), rel("employee", "employees", { required: true })),
        ...half(
          select("status", [ch("invited", C.gray), ch("registered", C.blue), ch("attended", C.green), ch("no_show", C.red, "No-show"), ch("completed", C.teal)], { default: "invited" }),
          date("completed_on", { label: "Completed on", conditions: [when("status", "_eq", "completed", "required")] }),
        ),
        ...half(int("score", { validation: { min: 0, max: 100 } }), file("certificate")),
      ],
      samples: [
        { training: { ref: "trainings:0" }, employee: { ref: "employees:0" }, status: "completed", completed_on: ms("2026-09-01"), score: 96 },
        { training: { ref: "trainings:0" }, employee: { ref: "employees:1" }, status: "registered" },
      ],
    },
  ],
  roles: [
    {
      name: "HR admin",
      description: "Full people-ops access: employees, leave, attendance, contracts, benefits, reviews and documents.",
      permissions: [
        { collection: "departments", action: "read" },
        { collection: "departments", action: "create" },
        { collection: "departments", action: "update" },
        { collection: "locations", action: "read" },
        { collection: "locations", action: "create" },
        { collection: "locations", action: "update" },
        { collection: "positions", action: "read" },
        { collection: "positions", action: "create" },
        { collection: "positions", action: "update" },
        { collection: "leave_types", action: "read" },
        { collection: "leave_types", action: "create" },
        { collection: "leave_types", action: "update" },
        { collection: "benefits", action: "read" },
        { collection: "benefits", action: "create" },
        { collection: "benefits", action: "update" },
        { collection: "public_holidays", action: "read" },
        { collection: "public_holidays", action: "create" },
        { collection: "public_holidays", action: "update" },
        { collection: "employees", action: "read" },
        { collection: "employees", action: "create" },
        { collection: "employees", action: "update" },
        { collection: "leave_allocations", action: "read" },
        { collection: "leave_allocations", action: "create" },
        { collection: "leave_allocations", action: "update" },
        { collection: "leave_requests", action: "read" },
        { collection: "leave_requests", action: "create" },
        { collection: "leave_requests", action: "update" },
        { collection: "leave_requests", action: "delete" },
        { collection: "attendance_records", action: "read" },
        { collection: "attendance_records", action: "create" },
        { collection: "attendance_records", action: "update" },
        { collection: "attendance_records", action: "delete" },
        { collection: "contracts", action: "read" },
        { collection: "contracts", action: "create" },
        { collection: "contracts", action: "update" },
        { collection: "benefit_enrollments", action: "read" },
        { collection: "benefit_enrollments", action: "create" },
        { collection: "benefit_enrollments", action: "update" },
        { collection: "performance_reviews", action: "read" },
        { collection: "performance_reviews", action: "create" },
        { collection: "performance_reviews", action: "update" },
        { collection: "goals", action: "read" },
        { collection: "goals", action: "create" },
        { collection: "goals", action: "update" },
        { collection: "onboarding_tasks", action: "read" },
        { collection: "onboarding_tasks", action: "create" },
        { collection: "onboarding_tasks", action: "update" },
        { collection: "onboarding_tasks", action: "delete" },
        { collection: "documents", action: "read" },
        { collection: "documents", action: "create" },
        { collection: "documents", action: "update" },
        { collection: "compensation_history", action: "read" },
        { collection: "compensation_history", action: "create" },
        { collection: "compensation_history", action: "update" },
        { collection: "job_changes", action: "read" },
        { collection: "job_changes", action: "create" },
        { collection: "job_changes", action: "update" },
        { collection: "emergency_contacts", action: "read" },
        { collection: "emergency_contacts", action: "create" },
        { collection: "emergency_contacts", action: "update" },
        { collection: "payroll_runs", action: "read" },
        { collection: "payroll_runs", action: "create" },
        { collection: "payroll_runs", action: "update" },
        { collection: "payslips", action: "read" },
        { collection: "payslips", action: "create" },
        { collection: "payslips", action: "update" },
        { collection: "expense_claims", action: "read" },
        { collection: "expense_claims", action: "update" },
        { collection: "trainings", action: "read" },
        { collection: "trainings", action: "create" },
        { collection: "trainings", action: "update" },
        { collection: "training_attendance", action: "read" },
        { collection: "training_attendance", action: "create" },
        { collection: "training_attendance", action: "update" },
      ],
    },
    {
      name: "Manager",
      description: "Manager self-service: view the org, approve time off, track attendance, run reviews and goals for direct reports.",
      permissions: [
        { collection: "departments", action: "read" },
        { collection: "locations", action: "read" },
        { collection: "positions", action: "read" },
        { collection: "employees", action: "read" },
        { collection: "leave_types", action: "read" },
        { collection: "public_holidays", action: "read" },
        { collection: "leave_allocations", action: "read" },
        { collection: "leave_requests", action: "read" },
        { collection: "leave_requests", action: "create" },
        { collection: "leave_requests", action: "update" },
        { collection: "attendance_records", action: "read" },
        { collection: "performance_reviews", action: "read" },
        { collection: "performance_reviews", action: "create" },
        { collection: "performance_reviews", action: "update" },
        { collection: "goals", action: "read" },
        { collection: "goals", action: "create" },
        { collection: "goals", action: "update" },
        { collection: "onboarding_tasks", action: "read" },
        { collection: "onboarding_tasks", action: "update" },
      ],
    },
    {
      name: "Employee (self-service)",
      description: "Employee self-service portal: own profile, leave balances and requests, attendance, benefits, goals and onboarding tasks; request time off.",
      permissions: [
        { collection: "leave_types", action: "read" },
        { collection: "public_holidays", action: "read" },
        { collection: "benefits", action: "read" },
        { collection: "employees", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "leave_allocations", action: "read", condition: { "employee.app_user_id": { _eq: "$user.id" } } },
        { collection: "leave_requests", action: "read", condition: { "employee.app_user_id": { _eq: "$user.id" } } },
        { collection: "leave_requests", action: "create" },
        { collection: "leave_requests", action: "update", condition: { "employee.app_user_id": { _eq: "$user.id" } } },
        { collection: "attendance_records", action: "read", condition: { "employee.app_user_id": { _eq: "$user.id" } } },
        { collection: "benefit_enrollments", action: "read", condition: { "employee.app_user_id": { _eq: "$user.id" } } },
        { collection: "goals", action: "read", condition: { "employee.app_user_id": { _eq: "$user.id" } } },
        { collection: "onboarding_tasks", action: "read", condition: { "employee.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "People overview",
      description: "Headcount, leave, attendance and performance at a glance.",
      panels: [
        { name: "Headcount", kind: "items-aggregate", viz: "counter", config: { collection: "employees", agg: "count" } },
        { name: "Time-off requests", kind: "items-aggregate", viz: "counter", config: { collection: "leave_requests", agg: "count" } },
        { name: "Employees by status", kind: "items-aggregate", viz: "donut", config: { collection: "employees", agg: "count", groupBy: "status" } },
        { name: "Employees by type", kind: "items-aggregate", viz: "bars", config: { collection: "employees", agg: "count", groupBy: "employment_type" } },
        { name: "Time off by status", kind: "items-aggregate", viz: "donut", config: { collection: "leave_requests", agg: "count", groupBy: "status" } },
        { name: "Time off by type", kind: "items-aggregate", viz: "bars", config: { collection: "leave_requests", agg: "count", groupBy: "type" } },
        { name: "Attendance by status", kind: "items-aggregate", viz: "bars", config: { collection: "attendance_records", agg: "count", groupBy: "status" } },
        { name: "Goals by status", kind: "items-aggregate", viz: "donut", config: { collection: "goals", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * The rules a people operation runs on, already running.
   *
   * Deliberately absent: "time off was approved, so take the days off the
   * allocation". The balance lives on a `leave_allocations` row keyed by
   * employee, leave type AND year — a different row from the request, which is
   * all a flow's `data` holds. A step that guessed which allocation to debit
   * would corrupt a balance silently, and a wrong balance is discovered a year
   * later. So the flow reports the request and leaves the subtraction where the
   * allocation is.
   */
  flows: [
    {
      name: "Open the standard onboarding checklist for a new hire",
      trigger: "event:items:employees:created",
      operations: [
        // The three things every hire needs, split by who actually does them.
        // Deliberately undated: an employee record is routinely created before
        // the start date is settled, and a task dated from an empty `hire_date`
        // is a deadline in 1970.
        {
          type: "item.create",
          collection: "onboarding_tasks",
          data: { employee: "{{ data.id }}", task: "Sign the contract and tax forms", owner: "hr" },
        },
        {
          type: "item.create",
          collection: "onboarding_tasks",
          data: { employee: "{{ data.id }}", task: "Provision laptop, accounts and building access", owner: "it" },
        },
        {
          type: "item.create",
          collection: "onboarding_tasks",
          data: { employee: "{{ data.id }}", task: "Day-one welcome and team walkthrough", owner: "manager" },
        },
        {
          type: "notification",
          title: "{{ data.first_name }} {{ data.last_name }} has been added",
          body: "Three onboarding tasks are open. Set their due dates once the start date is confirmed.",
          url: "/collections/onboarding_tasks",
        },
      ],
    },
    {
      name: "Tell the team a time-off request is waiting on a decision",
      trigger: "event:items:leave_requests:created",
      operations: [
        // Reports it and stops there. Whether the employee HAS the days is on
        // their allocation row, which this run cannot see — so the body says
        // what to check rather than approving on a number it does not have.
        {
          type: "notification",
          title: "A time-off request needs a decision",
          body: "Check the employee's remaining balance for this leave type and year, then approve or deny.",
          url: "/collections/leave_requests",
        },
      ],
    },
    {
      name: "Warn thirty days before an employee document expires",
      // Right-to-work papers, certifications and visas are the ones that lapse
      // quietly. Fires once per row, at 09:00 — rows with no expiry never fire,
      // because a null date names no instant.
      trigger: `schedule:${JSON.stringify({
        collection: "documents",
        field: "expires_at",
        offset: { value: 30, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: null,
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.title }} expires in 30 days",
          body: "Ask for the renewed copy before it lapses — an expired right-to-work paper or certification stops somebody working.",
          url: "/collections/documents",
        },
      ],
    },
    {
      name: "Open a probation review ninety days after a hire date",
      // `after`, not `before`: this is the one schedule in the vertical that
      // counts forward from a date already in the past. Terminated and on-leave
      // records are filtered out in SQL rather than re-checked per row.
      trigger: `schedule:${JSON.stringify({
        collection: "employees",
        field: "hire_date",
        offset: { value: 90, unit: "days", direction: "after" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "item.create",
          collection: "performance_reviews",
          data: {
            employee: "{{ data.id }}",
            period: "Probation — first 90 days",
            review_type: "probationary",
            status: "not_started",
          },
        },
        {
          type: "notification",
          title: "Probation review due for {{ data.first_name }} {{ data.last_name }}",
          body: "Ninety days in. The review has been opened as not started — assign a reviewer.",
          url: "/collections/performance_reviews",
        },
      ],
    },
    {
      name: "Expire a contract the morning after its end date",
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "contracts",
          // A contract with no end date is permanent and never matches: a NULL
          // fails the comparison rather than reading as long past.
          filter: { status: { _eq: "active" }, end_date: { _lt: "$now" } },
          do: [
            {
              type: "item.update",
              collection: "contracts",
              id: "{{ $item.id }}",
              data: { status: "expired" },
            },
          ],
        },
      ],
    },
    {
      name: "Email the payslip when it is issued (needs email + a PDF renderer)",
      // Off until both are configured — the name carries the prerequisite so
      // nobody has to open it to find out.
      active: false,
      trigger: "event:items:payslips:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "issued" } },
          then: [
            { type: "document.render", templateKey: "payslip" },
            {
              type: "email",
              to: "{{ data.employee.work_email }}",
              subject: "Your payslip",
              html: "<p>Your payslip for this run is attached. Questions go to HR.</p>",
              attach: ["{{ $last.key }}"],
            },
          ],
        },
      ],
    },
  ],
  documents: [
    {
      key: "payslip",
      name: "Payslip",
      description: "One employee's pay for one run, as they receive it.",
      filename: "payslip-{{ data.id }}",
      variables: ["gross_pay", "net_pay", "tax"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "td.n,th.n{text-align:right}" +
        "tr.net td{border-top:2px solid #111;border-bottom:0;font-weight:600}" +
        "</style></head><body>" +
        "<h1>Payslip</h1>" +
        '<p class="muted">{{ data.payroll_run.name }} · paid {{ data.payroll_run.pay_date }}</p>' +
        "<p><strong>{{ data.employee.first_name }} {{ data.employee.last_name }}</strong><br>" +
        "Employee {{ data.employee.employee_number }} · {{ data.employee.job_title }}<br>" +
        "Days worked: {{ data.worked_days }}</p>" +
        '<table><thead><tr><th>Earnings</th><th class="n">Amount</th></tr></thead><tbody>' +
        '<tr><td>Base pay</td><td class="n">{{ data.base_pay }}</td></tr>' +
        '<tr><td>Overtime</td><td class="n">{{ data.overtime_pay }}</td></tr>' +
        '<tr><td>Bonus</td><td class="n">{{ data.bonus }}</td></tr>' +
        '<tr><td><strong>Gross pay</strong></td>' +
        '<td class="n"><strong>{{ data.gross_pay }}</strong></td></tr>' +
        "</tbody></table>" +
        '<table><thead><tr><th>Deductions</th><th class="n">Amount</th></tr></thead><tbody>' +
        '<tr><td>Tax</td><td class="n">{{ data.tax }}</td></tr>' +
        '<tr><td>Social security</td><td class="n">{{ data.social_security }}</td></tr>' +
        '<tr><td>Other deductions</td><td class="n">{{ data.other_deductions }}</td></tr>' +
        '<tr class="net"><td>Net pay</td><td class="n">{{ data.net_pay }}</td></tr>' +
        "</tbody></table>" +
        '<p class="muted">Queries about this payslip go to People Operations.</p>' +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "18mm" },
    },
    {
      // Rendered against an EMPLOYEE row, not a payslip — this is the letter a
      // bank or a consulate asks for, and it deliberately states employment
      // only. Pay belongs in it when the employee asks for it to be there, not
      // by default: the letter is handed to a third party.
      key: "employment_verification",
      name: "Employment verification letter",
      description: "Confirms that someone works here, for a bank, a landlord or a consulate.",
      filename: "employment-verification-{{ data.employee_number }}",
      variables: ["first_name", "last_name", "job_title", "hire_date"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:22mm}" +
        "body{font:13px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:19px;margin:0 0 18px}" +
        ".muted{color:#666}" +
        ".sig{margin-top:48px}" +
        "</style></head><body>" +
        "<h1>Confirmation of employment</h1>" +
        "<p>To whom it may concern,</p>" +
        "<p>This letter confirms that <strong>{{ data.first_name }} {{ data.last_name }}</strong> " +
        "(employee {{ data.employee_number }}) is employed by this company as " +
        "<strong>{{ data.job_title }}</strong>, and has been since {{ data.hire_date }}.</p>" +
        "<p>The engagement is {{ data.employment_type }} and the record is currently " +
        "{{ data.status }}.</p>" +
        '<p class="muted">This letter states employment only. It is not an offer, ' +
        "a contract, or a statement of pay.</p>" +
        '<p class="sig">_____________________________<br>People Operations · date</p>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "22mm" },
    },
  ],
  forms: [
    {
      name: "New hire details",
      collection: "employees",
      settings: {
        submitLabel: "Send my details",
        successMessage: "Thank you — HR has your details and will be in touch before your first day.",
      },
      // Personal side only. The work email, the department and the pay are the
      // company's to set, and a public link that could write them is a public
      // link that can put somebody on the payroll.
      fields: [
        { name: "first_name", label: "First name" },
        { name: "last_name", label: "Last name" },
        { name: "preferred_name", label: "Preferred name", help: "What you would like colleagues to call you." },
        { name: "personal_email", label: "Personal email", help: "Where we write before your work account exists." },
        { name: "phone", label: "Mobile", help: "Include the country code — numbers are stored in international form." },
        { name: "date_of_birth", label: "Date of birth", help: "Used for payroll and benefits enrolment." },
      ],
    },
    {
      name: "Emergency contact",
      collection: "emergency_contacts",
      settings: {
        submitLabel: "Save contact",
        successMessage: "Thank you — HR will attach this to your employee record.",
      },
      fields: [
        { name: "name", label: "Contact's full name" },
        { name: "relationship", help: "Spouse, parent, friend — whatever fits." },
        { name: "phone", label: "Phone", help: "Include the country code, e.g. +1 555 010 0100." },
        { name: "email", label: "Email", help: "Optional — used only if we cannot reach them by phone." },
      ],
    },
  ],
  agents: [
    {
      name: "People assistant",
      handle: "people-assistant",
      description: "Answers questions about headcount, time off and payroll totals.",
      systemPrompt:
        "You help a people team read its own HR records. Answer from the " +
        "workspace's data and nothing else.\n\n" +
        "Privacy comes first: never disclose an individual's pay, date of birth, " +
        "personal email, phone number or emergency contacts. Asked about pay, " +
        "answer with a total, an average or a headcount instead, and say why. " +
        "Job title, department, manager and start date are ordinary directory " +
        "facts and may be named.\n\n" +
        "A leave balance is per employee, per leave type and per YEAR — always " +
        "say which year a figure covers, and never add balances across types. " +
        "Payroll amounts are denominated by each run's own currency, so report " +
        "one figure per currency rather than one sum. Be brief and specific, and " +
        "say plainly when the data does not answer the question.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search", "kpis.run"],
      maxSteps: 8,
    },
  ],
};
