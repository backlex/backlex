import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, file, half, hint, image, int, money, ms, notes, num, pct, phone, position, rel, relMany, sec, select, stacked, tabbed, text, ts, url, when } from "../dsl";

export const projects: SchemaTemplate = {
  id: "projects",
  label: "Project management",
  groups: ["Planning", "Work", "Finance", "Organize"],
  description:
    "Jira/Linear-grade issue tracking: projects (optionally tied to a client) with member allocations, issues with type/state/priority and subtask & epic hierarchy, task dependencies, sprints (cycles), milestones, labels, comments, worklogs, plus a delivery layer of risks, expenses and category budgets.",
  collections: [
    {
      slug: "members", group: "Organize", singular: "Member", plural: "Members", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), email("email", { unique: true })),
        ...half(
          image("avatar"),
          select("role", [ch("admin", C.purple), ch("member", C.blue), ch("guest", C.gray)], { default: "member" }),
        ),
      ],
      samples: [{ name: "Ada Lovelace", email: "ada@team.example", role: "admin" }, { name: "Grace Hopper", email: "grace@team.example", role: "member" }],
    },
    {
      slug: "clients", group: "Organize", singular: "Client", plural: "Clients", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("contact_name", { label: "Contact name" })),
        ...half(email("email"), phone("phone")),
        url("website"),
        notes("notes"),
      ],
      samples: [{ name: "Acme Corp", contact_name: "Alex Chen", email: "alex@acme.example", website: "https://acme.example/" }],
    },
    {
      slug: "projects", group: "Planning", singular: "Project", plural: "Projects", defaultSort: "name",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Project", [
          ...half(text("name", { required: true }), text("key", { unique: true, label: "Key" })),
          notes("description"),
          ...half(
            select("status", [ch("backlog", C.gray), ch("planned", C.blue), ch("started", C.amber), ch("paused", C.slate), ch("completed", C.green), ch("canceled", C.red)], { default: "planned" }),
            text("color", { interface: "color" }),
          ),
        ]),
        sec("Ownership & dates", [
          ...half(rel("lead", "members"), rel("client", "clients")),
          ...half(date("start_date", { label: "Start date" }), date("target_date", { indexed: true, label: "Target date" })),
        ]),
      ),
      samples: [{ name: "Website Redesign", key: "WEB", lead: { ref: "members:0" }, client: { ref: "clients:0" }, status: "started", description: "Refresh the marketing site.", target_date: ms("2026-09-01") }],
    },
    {
      slug: "project_members", group: "Organize", singular: "Project member", plural: "Project members", defaultSort: "-created_at",
      note: "Who works on which project, in what capacity and at what allocation.",
      fields: [
        ...half(rel("project", "projects", { required: true }), rel("member", "members", { required: true })),
        ...half(
          select("role", [ch("lead", C.purple), ch("member", C.blue), ch("viewer", C.gray)], { default: "member" }),
          pct("allocation", { label: "Allocation %" }),
        ),
      ],
      samples: [
        { project: { ref: "projects:0" }, member: { ref: "members:0" }, role: "lead", allocation: 60 },
        { project: { ref: "projects:0" }, member: { ref: "members:1" }, role: "member", allocation: 50 },
      ],
    },
    {
      slug: "labels", group: "Organize", singular: "Label", plural: "Labels", defaultSort: "name",
      fields: [...half(text("name", { required: true }), text("color", { interface: "color" })), notes("description")],
      samples: [{ name: "frontend", color: C.blue }, { name: "bug", color: C.red }],
    },
    {
      slug: "milestones", group: "Planning", singular: "Milestone", plural: "Milestones", defaultSort: "target_date",
      fields: [
        ...half(rel("project", "projects"), text("name")),
        notes("description"),
        ...half(date("target_date", { indexed: true, label: "Target date" }), position("project")),
        select("status", [ch("upcoming", C.gray), ch("in_progress", C.blue, "In progress"), ch("completed", C.green)], { default: "upcoming" }),
      ],
      samples: [{ project: { ref: "projects:0" }, name: "Design complete", target_date: ms("2026-07-15"), status: "in_progress", position: 1 }],
    },
    {
      slug: "sprints", group: "Planning", singular: "Sprint", plural: "Sprints", defaultSort: "-start_date",
      fields: [
        ...half(rel("project", "projects"), text("name")),
        notes("goal"),
        ...half(int("number", { label: "Cycle #" }), select("state", [ch("future", C.gray), ch("active", C.green), ch("closed", C.slate)], { default: "future" })),
        ...half(date("start_date", { range: { end: "end_date", bounds: "[]" }, indexed: true, label: "Start date" }), date("end_date", { label: "End date" })),
      ],
      samples: [{ project: { ref: "projects:0" }, name: "Sprint 1", goal: "Ship the new home page.", number: 1, start_date: ms("2026-07-01"), end_date: ms("2026-07-14"), state: "active" }],
    },
    {
      slug: "issues", group: "Work", singular: "Issue", plural: "Issues", ownerScoped: true, fts: true, defaultSort: "-created_at",
      kanbanGroupBy: "state",
      fields: tabbed(
        sec("Issue", [
          ...half(text("identifier", { unique: true, label: "Identifier" }), text("title", { required: true, searchable: true })),
          notes("description", { searchable: true }),
          ...half(
            select("type", [ch("epic", C.purple), ch("story", C.green), ch("task", C.blue), ch("bug", C.red), ch("subtask", C.gray)], { default: "task" }),
            select("state", [ch("backlog", C.gray), ch("todo", C.slate), ch("in_progress", C.blue, "In progress"), ch("in_review", C.amber, "In review"), ch("done", C.green), ch("canceled", C.red)], { default: "backlog" }),
          ),
          select("priority", [ch("urgent", C.red), ch("high", C.amber), ch("medium", C.blue), ch("low", C.gray), ch("no_priority", C.slate, "No priority")], { default: "medium" }),
        ]),
        sec("Assignment", [
          ...half(rel("project", "projects"), rel("assignee", "members")),
          ...half(
            rel("reporter", "members"),
            // A subtask is defined by what it hangs off; an epic is the top of the
            // tree and has nothing above it.
            rel("parent", "issues", {
              label: "Parent issue",
              conditions: [when("type", "_eq", "subtask", "required"), when("type", "_eq", "epic", "hidden")],
            }),
          ),
          relMany("labels", "labels"),
        ]),
        sec("Planning", [
          ...half(rel("sprint", "sprints"), rel("milestone", "milestones")),
          ...half(num("story_points", { validation: { min: 0 }, label: "Story points" }), num("estimate_hours", { validation: { min: 0 }, label: "Estimate (h)" })),
          ...half(date("start_date", { label: "Start date" }), date("due_date", { indexed: true, label: "Due date" })),
        ]),
      ),
      samples: [
        { identifier: "WEB-1", title: "Wireframe the home page", description: "Low-fi wireframes for review.", type: "story", state: "in_progress", priority: "high", project: { ref: "projects:0" }, assignee: { ref: "members:0" }, reporter: { ref: "members:1" }, sprint: { ref: "sprints:0" }, story_points: 3, estimate_hours: 12, due_date: ms("2026-07-08") },
        { identifier: "WEB-2", title: "Set up analytics", description: "Add privacy-friendly analytics.", type: "task", state: "backlog", priority: "medium", project: { ref: "projects:0" }, assignee: { ref: "members:1" }, story_points: 2 },
      ],
    },
    {
      slug: "task_dependencies", group: "Work", singular: "Dependency", plural: "Dependencies", defaultSort: "-created_at",
      note: "Directed links between issues — `task` waits on `depends_on` when kind is blocks.",
      fields: [
        ...half(rel("task", "issues", { required: true }), rel("depends_on", "issues", { required: true, label: "Depends on" })),
        select("kind", [ch("blocks", C.red), ch("relates", C.blue)], { default: "blocks" }),
      ],
      samples: [{ task: { ref: "issues:1" }, depends_on: { ref: "issues:0" }, kind: "blocks" }],
    },
    {
      slug: "risks", group: "Planning", singular: "Risk", plural: "Risks", defaultSort: "-created_at",
      fields: stacked(
        sec("Risk", [
          ...half(rel("project", "projects", { required: true }), text("title", { required: true })),
          ...half(
            select("probability", [ch("low", C.green), ch("medium", C.amber), ch("high", C.red)], { default: "medium" }),
            select("impact", [ch("low", C.green), ch("medium", C.amber), ch("high", C.red)], { default: "medium" }),
          ),
        ]),
        sec("Response", [
          ...half(
            rel("owner", "members"),
            select("status", [ch("open", C.blue), ch("mitigating", C.amber), ch("closed", C.green), ch("accepted", C.gray)], { default: "open" }),
          ),
          notes("mitigation", { conditions: [when("status", "_eq", "mitigating", "required")] }),
        ]),
      ),
      samples: [{ project: { ref: "projects:0" }, title: "Design resourcing gap in August", probability: "medium", impact: "high", mitigation: "Line up a freelance designer before the vacation window.", owner: { ref: "members:0" }, status: "mitigating" }],
    },
    {
      slug: "expenses", group: "Finance", singular: "Expense", plural: "Expenses", defaultSort: "-incurred_at",
      fields: [
        ...half(rel("project", "projects", { required: true }), text("description", { required: true })),
        ...half(money("amount"), date("incurred_at", { indexed: true, label: "Incurred at" })),
        ...half(
          bool("billable", { default: false }),
          select("status", [ch("submitted", C.amber), ch("approved", C.blue), ch("reimbursed", C.green), ch("rejected", C.red)], { default: "submitted" }),
        ),
      ],
      samples: [
        { project: { ref: "projects:0" }, description: "Stock photography license", amount: 240, incurred_at: ms("2026-07-02"), billable: true, status: "approved" },
        { project: { ref: "projects:0" }, description: "Usability-testing incentives", amount: 375, incurred_at: ms("2026-07-06"), billable: false, status: "submitted" },
      ],
    },
    {
      slug: "budgets", group: "Finance", singular: "Budget line", plural: "Budgets", defaultSort: "category",
      note: "Per-project, per-category envelope.",
      fields: [
        hint("budgets_remaining", "Remaining is generated as planned − spent."),
        ...half(
          rel("project", "projects", { required: true }),
          select("category", [ch("labor", C.blue), ch("software", C.purple), ch("travel", C.amber), ch("other", C.gray)], { default: "labor" }),
        ),
        ...half(money("amount_planned", { label: "Planned" }), money("amount_spent", { label: "Spent" })),
        computedNum("remaining", "amount_planned - amount_spent", { label: "Remaining" }),
      ],
      samples: [
        { project: { ref: "projects:0" }, category: "labor", amount_planned: 40000, amount_spent: 12500 },
        { project: { ref: "projects:0" }, category: "software", amount_planned: 3000, amount_spent: 900 },
      ],
    },
    {
      slug: "worklogs", group: "Work", singular: "Worklog", plural: "Worklogs", ownerScoped: true, defaultSort: "-logged_at",
      fields: [
        ...half(rel("issue", "issues"), rel("member", "members")),
        ...half(num("hours", { validation: { min: 0 } }), ts("logged_at", { indexed: true, label: "Logged at" })),
        ...half(bool("billable", { default: true }), notes("description")),
      ],
      samples: [{ issue: { ref: "issues:0" }, member: { ref: "members:0" }, hours: 3.5, billable: true, logged_at: ms("2026-07-03") }],
    },
    {
      slug: "comments", group: "Work", singular: "Comment", plural: "Comments", ownerScoped: true, defaultSort: "created_at",
      fields: [...half(rel("issue", "issues"), rel("author", "members")), notes("body")],
      samples: [{ issue: { ref: "issues:0" }, author: { ref: "members:1" }, body: "First draft looks great!" }],
    },
    {
      // Files pinned to a project or an issue — OpenProject/Jira both treat
      // attachments as first-class rather than links buried in a comment.
      slug: "attachments", group: "Work", singular: "Attachment", plural: "Attachments", defaultSort: "-created_at",
      fields: [
        ...half(rel("project", "projects"), rel("issue", "issues")),
        ...half(text("title"), rel("uploaded_by", "members", { label: "Uploaded by" })),
        file("file"),
      ],
      samples: [{ project: { ref: "projects:0" }, issue: { ref: "issues:0" }, title: "Home page wireframe v2", uploaded_by: { ref: "members:0" } }],
    },
  ],
  roles: [
    {
      name: "Project manager",
      description: "Run delivery end to end: projects, planning, staffing, risks and finances.",
      permissions: [
        { collection: "members", action: "read" },
        { collection: "clients", action: "read" },
        { collection: "clients", action: "create" },
        { collection: "clients", action: "update" },
        { collection: "projects", action: "read" },
        { collection: "projects", action: "create" },
        { collection: "projects", action: "update" },
        { collection: "project_members", action: "read" },
        { collection: "project_members", action: "create" },
        { collection: "project_members", action: "update" },
        { collection: "project_members", action: "delete" },
        { collection: "labels", action: "read" },
        { collection: "labels", action: "create" },
        { collection: "labels", action: "update" },
        { collection: "milestones", action: "read" },
        { collection: "milestones", action: "create" },
        { collection: "milestones", action: "update" },
        { collection: "sprints", action: "read" },
        { collection: "sprints", action: "create" },
        { collection: "sprints", action: "update" },
        { collection: "issues", action: "read" },
        { collection: "issues", action: "create" },
        { collection: "issues", action: "update" },
        { collection: "issues", action: "delete" },
        { collection: "task_dependencies", action: "read" },
        { collection: "task_dependencies", action: "create" },
        { collection: "task_dependencies", action: "update" },
        { collection: "task_dependencies", action: "delete" },
        { collection: "risks", action: "read" },
        { collection: "risks", action: "create" },
        { collection: "risks", action: "update" },
        { collection: "expenses", action: "read" },
        { collection: "expenses", action: "create" },
        { collection: "expenses", action: "update" },
        { collection: "budgets", action: "read" },
        { collection: "budgets", action: "create" },
        { collection: "budgets", action: "update" },
        { collection: "worklogs", action: "read" },
        { collection: "comments", action: "read" },
        { collection: "comments", action: "create" },
        { collection: "comments", action: "update" },
      ],
    },
    {
      name: "Contributor",
      description: "Work the board: read plans, update issues, log time and comment.",
      permissions: [
        { collection: "members", action: "read" },
        { collection: "projects", action: "read" },
        { collection: "project_members", action: "read" },
        { collection: "labels", action: "read" },
        { collection: "milestones", action: "read" },
        { collection: "sprints", action: "read" },
        { collection: "issues", action: "read" },
        { collection: "issues", action: "create" },
        { collection: "issues", action: "update" },
        { collection: "task_dependencies", action: "read" },
        { collection: "task_dependencies", action: "create" },
        { collection: "risks", action: "read" },
        { collection: "expenses", action: "read" },
        { collection: "expenses", action: "create" },
        { collection: "worklogs", action: "read" },
        { collection: "worklogs", action: "create" },
        { collection: "worklogs", action: "update" },
        { collection: "comments", action: "read" },
        { collection: "comments", action: "create" },
        { collection: "comments", action: "update" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Delivery overview",
      description: "Issue flow, effort, risk and spend across projects.",
      panels: [
        { name: "Projects", kind: "items-aggregate", viz: "counter", config: { collection: "projects", agg: "count" } },
        { name: "Issues", kind: "items-aggregate", viz: "counter", config: { collection: "issues", agg: "count" } },
        { name: "Hours logged", kind: "items-aggregate", viz: "counter", config: { collection: "worklogs", agg: "sum", field: "hours" } },
        { name: "Expenses", kind: "items-aggregate", viz: "counter", config: { collection: "expenses", agg: "sum", field: "amount" } },
        { name: "Issues by state", kind: "items-aggregate", viz: "donut", config: { collection: "issues", agg: "count", groupBy: "state" } },
        { name: "Issues by priority", kind: "items-aggregate", viz: "bars", config: { collection: "issues", agg: "count", groupBy: "priority" } },
        { name: "Issues by type", kind: "items-aggregate", viz: "bars", config: { collection: "issues", agg: "count", groupBy: "type" } },
        { name: "Risks by status", kind: "items-aggregate", viz: "donut", config: { collection: "risks", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * The rules a delivery operation runs on, already running.
   *
   * Deliberately absent: "the last issue in a sprint closed, so close the
   * sprint". Whether anything is still open in a cycle is a question about the
   * OTHER issues in it, and a flow's `data` is the one issue that just changed
   * — a step that closed the cycle on every `done` would close it on the first
   * ticket of the sprint. So the clock closes a sprint once its end date has
   * passed, and the note that goes with it says what to check.
   */
  flows: [
    {
      name: "Nudge an issue two days before it is due",
      // Fires once per row, two days before `due_date`, at 09:00 — and only for
      // work still in play. `_nin` rather than `_neq`, because "not finished"
      // has to exclude the cancelled ones as well as the done ones.
      trigger: `schedule:${JSON.stringify({
        collection: "issues",
        field: "due_date",
        offset: { value: 2, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { state: { _nin: ["done", "canceled"] } },
      })}`,
      operations: [
        // `author` is left empty on purpose: the flow is not a member, and
        // borrowing somebody's name would put words in their mouth on their
        // own board.
        {
          type: "item.create",
          collection: "comments",
          data: {
            issue: "{{ data.id }}",
            body: "Due in two days — move the state on, or move the date.",
          },
        },
        {
          type: "notification",
          title: "{{ data.title }} is due in two days",
          body: "A note has been left on the issue.",
          url: "/collections/issues",
        },
      ],
    },
    {
      name: "Close a sprint the morning after its end date",
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "sprints",
          filter: { state: { _eq: "active" }, end_date: { _lt: "$now" } },
          do: [
            {
              type: "item.update",
              collection: "sprints",
              id: "{{ $item.id }}",
              data: { state: "closed" },
            },
            // What is still open in the cycle lives on other rows, and the loop
            // holds only the sprint — so the note names the place to look
            // rather than pretending to have counted.
            {
              type: "notification",
              title: "{{ $item.name }} closed",
              body: "The cycle ended. Carry anything unfinished into the next one.",
              url: "/collections/sprints",
            },
          ],
        },
      ],
    },
    {
      name: "Escalate a risk once it is both likely and severe",
      // `updated`, not `created`: a risk is normally logged at medium and grows
      // into a high/high later, and that later move is the one nobody watches.
      trigger: "event:items:risks:updated",
      operations: [
        {
          type: "condition",
          filter: { probability: { _eq: "high" }, impact: { _eq: "high" } },
          then: [
            {
              type: "notification",
              title: "Risk escalated: {{ data.title }}",
              body: "High probability and high impact. Confirm the owner and the mitigation before the next check-in.",
              url: "/collections/risks",
            },
          ],
        },
      ],
    },
    {
      name: "Report an approved expense against its budget",
      // A report, not a write. Charging the envelope means finding the `budgets`
      // row for this project AND this category and restating its `amount_spent`
      // — neither of which is on the expense that triggered the flow. A step
      // that guessed would corrupt the figure it was meant to maintain.
      trigger: "event:items:expenses:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "approved" } },
          then: [
            {
              type: "notification",
              title: "Expense approved: {{ data.description }}",
              body: "{{ data.amount }} approved. Add it to the project's budget line for that category.",
              url: "/collections/budgets",
            },
          ],
        },
      ],
    },
    {
      name: "Send the client the brief when a project starts (needs email + a PDF renderer)",
      // Off until both are configured. The name carries the prerequisite so
      // nobody has to open the flow to find out why it is not running.
      active: false,
      trigger: "event:items:projects:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "started" } },
          then: [
            { type: "document.render", templateKey: "project_brief" },
            {
              type: "email",
              to: "{{ data.client.email }}",
              subject: "{{ data.name }} — project brief",
              html: "<p>We've started work. The brief is attached.</p>",
              attach: ["{{ $last.key }}"],
            },
          ],
        },
      ],
    },
    {
      name: "Monthly delivery report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Delivery overview",
          subject: "Delivery — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "project_brief",
      name: "Project brief",
      description: "What the project is, who is on it and when it lands — the sheet a client gets at kickoff.",
      filename: "project-brief-{{ data.key }}",
      variables: ["name", "key", "status", "target_date"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 4px}" +
        "h2{font-size:12px;margin:22px 0 6px;text-transform:uppercase;letter-spacing:.06em;color:#555}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:6px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5;vertical-align:top}" +
        "th{width:32%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.name }}</h1>" +
        '<p class="muted">{{ data.key }} · {{ data.status }}</p>' +
        "<h2>Brief</h2>" +
        "<p>{{ data.description }}</p>" +
        "<h2>Who and when</h2>" +
        "<table>" +
        "<tr><th>Client</th><td>{{ data.client.name }} — {{ data.client.contact_name }}</td></tr>" +
        "<tr><th>Project lead</th><td>{{ data.lead.name }}</td></tr>" +
        "<tr><th>Start</th><td>{{ data.start_date }}</td></tr>" +
        "<tr><th>Target</th><td>{{ data.target_date }}</td></tr>" +
        "</table>" +
        "<h2>Milestones</h2>" +
        "<table><tbody>" +
        "<!-- one row per milestone; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "sprint_report",
      name: "Sprint report",
      description: "What one cycle set out to do and where it finished — the sheet a review is run from.",
      filename: "sprint-report-{{ data.number }}",
      variables: ["name", "goal", "start_date", "end_date"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #e5e5e5}" +
        "td.n,th.n{text-align:right}" +
        "</style></head><body>" +
        "<h1>{{ data.name }}</h1>" +
        '<p class="muted">{{ data.project.name }} · cycle {{ data.number }} · {{ data.state }}</p>' +
        "<p><strong>Goal.</strong> {{ data.goal }}</p>" +
        '<p class="muted">{{ data.start_date }} → {{ data.end_date }}</p>' +
        '<table><thead><tr><th>Issue</th><th>Assignee</th><th class="n">Points</th>' +
        "<th>State</th></tr></thead><tbody>" +
        "<!-- one row per issue in the cycle; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "18mm" },
    },
  ],
  forms: [
    {
      name: "Report a bug or request work",
      collection: "issues",
      settings: {
        submitLabel: "Send it in",
        successMessage: "Thanks — it's on the board and someone will triage it.",
      },
      // `state` is deliberately not exposed: an intake form says what is wanted,
      // not where it sits in the workflow. The column's default puts it in the
      // backlog, which is where triage picks it up.
      fields: [
        { name: "title", label: "What needs doing?" },
        { name: "description", label: "Details", help: "Steps to reproduce, links, screenshots — whatever helps." },
        { name: "priority", label: "How urgent is it?" },
        { name: "due_date", label: "Needed by", help: "Leave blank if there is no deadline." },
      ],
    },
    {
      name: "New client details",
      collection: "clients",
      settings: {
        submitLabel: "Send details",
        successMessage: "Thank you — we'll set the project up and be in touch.",
      },
      fields: [
        { name: "name", label: "Company or full name" },
        { name: "contact_name", label: "Main contact" },
        { name: "email", label: "Email" },
        { name: "phone" },
        { name: "website" },
        { name: "notes", label: "Anything we should know?" },
      ],
    },
  ],
  agents: [
    {
      name: "Delivery assistant",
      handle: "delivery-assistant",
      description: "Answers questions about what is moving, what is stuck and what it has cost.",
      systemPrompt:
        "You help a delivery team keep projects moving. Answer questions about " +
        "projects, issues, sprints, worklogs and budgets using the workspace's " +
        "own data. Name an issue by its identifier and its state, and quote " +
        "effort from worklogs rather than from estimates — an estimate is what " +
        "somebody hoped, hours logged are what was spent, and the two are never " +
        "added together. When asked what is at risk, look first at issues past " +
        "their due date and still open, then at open rows in risks. Never invent " +
        "an owner, a date or a status. Be brief and specific, and say plainly " +
        "when the data does not answer the question.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search", "kpis.run"],
      maxSteps: 8,
    },
  ],
};
