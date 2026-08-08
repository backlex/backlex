import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, file, half, hint, image, int, money, ms, notes, num, pct, phone, position, rel, relMany, sec, select, stacked, tabbed, text, ts, url } from "../dsl";

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
          ...half(rel("reporter", "members"), rel("parent", "issues", { label: "Parent issue" })),
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
          notes("mitigation"),
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
};
