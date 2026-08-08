import type { SchemaTemplate } from "../types";
import { C, ch, date, email, file, half, int, money, moneyIn, ms, notes, phone, position, rating, rel, sec, select, slugField, stacked, tabbed, text, ts, url } from "../dsl";

export const ats: SchemaTemplate = {
  id: "ats",
  label: "Recruiting (ATS)",
  groups: ["Jobs", "Candidates", "Hiring"],
  description:
    "Greenhouse/Lever-grade applicant tracking: job requisitions, candidates with a source-channel lookup, referrals with bonuses, talent pools, a configurable interview pipeline of stages with per-stage interview kits, applications (status separate from stage), interviews, scorecards, offers and offer approvals.",
  collections: [
    {
      slug: "departments", group: "Jobs", singular: "Department", plural: "Departments", defaultSort: "name",
      fields: [text("name", { required: true })],
      samples: [{ name: "Engineering" }, { name: "Marketing" }],
    },
    {
      slug: "candidate_sources", group: "Candidates", singular: "Source", plural: "Sources", defaultSort: "name",
      note: "Where candidates come from — powers source-of-hire reporting.",
      fields: [
        ...half(
          text("name", { required: true }),
          select("kind", [ch("referral", C.green), ch("job_board", C.teal, "Job board"), ch("agency", C.amber), ch("organic", C.blue)], { default: "organic" }),
        ),
      ],
      samples: [
        { name: "Employee referral", kind: "referral" },
        { name: "LinkedIn Jobs", kind: "job_board" },
        { name: "TechTalent Agency", kind: "agency" },
      ],
    },
    {
      slug: "jobs", group: "Jobs", singular: "Job", plural: "Jobs", versioned: true, fts: true, defaultSort: "-created_at",
      fields: tabbed(
        sec("Job", [
          ...half(text("title", { required: true, searchable: true }), slugField("title")),
          ...half(text("requisition_id", { label: "Requisition ID" }), rel("department", "departments")),
          { name: "description", type: "longtext", interface: "richtext", searchable: true },
        ]),
        sec("Details", [
          ...half(
            text("location"),
            select("employment_type", [ch("full_time", C.green, "Full time"), ch("part_time", C.blue, "Part time"), ch("contract", C.amber), ch("internship", C.teal), ch("temporary", C.gray)], { default: "full_time", label: "Employment type" }),
          ),
          ...half(
            select("status", [ch("draft", C.gray), ch("open", C.green), ch("on_hold", C.amber, "On hold"), ch("closed", C.slate), ch("filled", C.blue)], { default: "open" }),
            int("openings", { default: 1, validation: { min: 0 } }),
          ),
          ...half(text("hiring_manager", { label: "Hiring manager" }), text("recruiter")),
        ]),
        sec("Compensation", [
          ...half(
            money("salary_min", { label: "Salary min" }),
            money("salary_max", { label: "Salary max", validation: { rule: { salary_max: { _gte: "$field.salary_min" } }, message: "The maximum must be at least the minimum." } }),
          ),
          select("salary_currency", ["USD", "EUR", "GBP"], { default: "USD", label: "Currency" }),
        ]),
      ),
      samples: [{ title: "Senior Backend Engineer", slug: "senior-backend-engineer", requisition_id: "REQ-001", description: "Build our API platform.", department: { ref: "departments:0" }, location: "Remote", employment_type: "full_time", status: "open", openings: 2, hiring_manager: "Grace Hopper", salary_min: 120000, salary_max: 160000 }],
    },
    {
      slug: "stages", group: "Hiring", singular: "Stage", plural: "Stages", defaultSort: "position",
      fields: [
        ...half(rel("job", "jobs"), text("name", { required: true })),
        ...half(
          select("type", [ch("application_review", C.gray, "Application review"), ch("assessment", C.teal), ch("phone_interview", C.blue, "Phone interview"), ch("onsite_interview", C.amber, "Onsite interview"), ch("offer", C.purple), ch("hired", C.green)], { default: "application_review", label: "Stage type" }),
          position("job"),
        ),
      ],
      samples: [
        { job: { ref: "jobs:0" }, name: "Application Review", type: "application_review", position: 1 },
        { job: { ref: "jobs:0" }, name: "Phone Screen", type: "phone_interview", position: 2 },
        { job: { ref: "jobs:0" }, name: "Onsite", type: "onsite_interview", position: 3 },
        { job: { ref: "jobs:0" }, name: "Offer", type: "offer", position: 4 },
      ],
    },
    {
      slug: "interview_kits", group: "Hiring", singular: "Interview kit", plural: "Interview kits", defaultSort: "name",
      note: "Per-stage question pack + rubric so every interviewer runs the same loop.",
      fields: [
        ...half(rel("stage", "stages", { required: true }), text("name", { required: true })),
        notes("questions", { label: "Questions" }),
        text("rubric_hint", { label: "Rubric hint" }),
      ],
      samples: [
        { stage: { ref: "stages:1" }, name: "Phone screen kit", questions: "Walk through a recent system you shipped. What tradeoffs did you make under deadline pressure?", rubric_hint: "Look for ownership and clear tradeoff reasoning." },
        { stage: { ref: "stages:2" }, name: "System design kit", questions: "Design a rate limiter for a multi-tenant API. Cover storage, fairness and failure modes.", rubric_hint: "Score depth of failure-mode analysis over breadth." },
      ],
    },
    {
      slug: "candidates", group: "Candidates", singular: "Candidate", plural: "Candidates", fts: true, defaultSort: "last_name",
      fields: stacked(
        sec("Candidate", [
          ...half(text("first_name", { label: "First name", searchable: true }), text("last_name", { label: "Last name", searchable: true })),
          ...half(email("email", { unique: true }), phone("phone")),
          text("location"),
        ]),
        sec("Background", [
          ...half(text("current_company", { label: "Current company" }), text("current_title", { label: "Current title" })),
          ...half(file("resume"), url("linkedin", { label: "LinkedIn" })),
        ]),
        sec("Source", [
          ...half(
            select("source", [ch("inbound", C.blue), ch("referral", C.green), ch("sourced", C.purple), ch("agency", C.amber), ch("job_board", C.teal, "Job board"), ch("event", C.gray), ch("social_media", C.slate, "Social media")], { default: "inbound" }),
            rel("source_channel", "candidate_sources", { label: "Source channel" }),
          ),
        ]),
      ),
      samples: [{ first_name: "Jordan", last_name: "Reed", email: "jordan@example.com", phone: "+15555550123", current_company: "Initech", current_title: "Backend Engineer", source: "referral", source_channel: { ref: "candidate_sources:0" } }],
    },
    {
      slug: "talent_pools", group: "Candidates", singular: "Talent pool", plural: "Talent pools", defaultSort: "name",
      fields: [text("name", { required: true }), notes("description")],
      samples: [{ name: "Backend bench", description: "Strong backend candidates to revisit when a req opens." }, { name: "Future leaders", description: "High-potential candidates for staff+ roles." }],
    },
    {
      slug: "talent_pool_members", group: "Candidates", singular: "Pool member", plural: "Pool members", defaultSort: "-added_at",
      fields: [
        ...half(rel("pool", "talent_pools", { required: true }), rel("candidate", "candidates", { required: true })),
        ...half(date("added_at", { indexed: true, label: "Added at" }), notes("notes")),
      ],
      samples: [{ pool: { ref: "talent_pools:0" }, candidate: { ref: "candidates:0" }, added_at: ms("2026-06-16"), notes: "Keep warm even if REQ-001 closes." }],
    },
    {
      slug: "referrals", group: "Candidates", singular: "Referral", plural: "Referrals", defaultSort: "-created_at",
      fields: [
        ...half(text("referrer", { required: true, label: "Referring employee" }), rel("candidate", "candidates", { required: true })),
        ...half(
          money("bonus_amount", { label: "Bonus amount" }),
          select("status", [ch("submitted", C.blue), ch("interviewing", C.amber), ch("hired", C.green), ch("bonus_paid", C.purple, "Bonus paid"), ch("not_hired", C.gray, "Not hired")], { default: "submitted" }),
        ),
      ],
      samples: [{ referrer: "Grace Hopper", candidate: { ref: "candidates:0" }, bonus_amount: 2000, status: "interviewing" }],
    },
    {
      slug: "applications", group: "Candidates", singular: "Application", plural: "Applications", ownerScoped: true, defaultSort: "-applied_at",
      fields: stacked(
        sec("Application", [
          ...half(rel("job", "jobs"), rel("candidate", "candidates")),
          ...half(rel("stage", "stages"), ts("applied_at", { indexed: true, label: "Applied at" })),
        ]),
        sec("Progress", [
          ...half(
            select("status", [ch("active", C.blue), ch("rejected", C.red), ch("hired", C.green)], { default: "active" }),
            rating("rating"),
          ),
          ...half(
            select("source", [ch("inbound", C.blue), ch("referral", C.green), ch("sourced", C.purple), ch("agency", C.amber), ch("job_board", C.teal, "Job board")], { default: "inbound" }),
            text("rejection_reason", { label: "Rejection reason" }),
          ),
          notes("notes"),
        ]),
      ),
      samples: [{ job: { ref: "jobs:0" }, candidate: { ref: "candidates:0" }, stage: { ref: "stages:1" }, status: "active", source: "referral", rating: 4, notes: "Strong background — schedule a call.", applied_at: ms("2026-06-15") }],
    },
    {
      slug: "interviews", group: "Hiring", singular: "Interview", plural: "Interviews", defaultSort: "-scheduled_at",
      fields: stacked(
        sec("Interview", [
          ...half(rel("application", "applications"), rel("stage", "stages")),
          ...half(rel("kit", "interview_kits", { label: "Interview kit" }), text("interviewer")),
        ]),
        sec("Slot", [
          ...half(
            ts("scheduled_at", { indexed: true, label: "Scheduled at" }),
            int("duration_minutes", { default: 60, label: "Duration (min)", validation: { min: 0 } }),
          ),
          select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("cancelled", C.gray), ch("no_show", C.red, "No show")], { default: "scheduled" }),
          notes("feedback"),
        ]),
      ),
      samples: [{ application: { ref: "applications:0" }, stage: { ref: "stages:1" }, kit: { ref: "interview_kits:0" }, interviewer: "Grace Hopper", scheduled_at: ms("2026-06-22T16:00:00Z"), status: "scheduled" }],
    },
    {
      slug: "scorecards", group: "Hiring", singular: "Scorecard", plural: "Scorecards", defaultSort: "-created_at",
      fields: [
        ...half(rel("interview", "interviews"), rel("application", "applications")),
        ...half(
          text("interviewer"),
          select("recommendation", [ch("strong_yes", C.green, "Strong yes"), ch("yes", C.teal), ch("no", C.amber), ch("strong_no", C.red, "Strong no"), ch("no_decision", C.gray, "No decision")], { default: "no_decision" }),
        ),
        notes("notes"),
      ],
      samples: [{ interview: { ref: "interviews:0" }, application: { ref: "applications:0" }, interviewer: "Grace Hopper", recommendation: "yes", notes: "Solid systems-design answers." }],
    },
    {
      slug: "offers", group: "Hiring", singular: "Offer", plural: "Offers", defaultSort: "-created_at",
      fields: stacked(
        sec("Offer", [
          ...half(rel("application", "applications"), rel("candidate", "candidates")),
          rel("job", "jobs"),
        ]),
        sec("Terms", [
          ...half(moneyIn("salary"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
          ...half(
            date("start_date", { label: "Start date" }),
            select("status", [ch("draft", C.gray), ch("approved", C.blue), ch("sent", C.amber), ch("accepted", C.green), ch("declined", C.red), ch("rescinded", C.slate)], { default: "draft" }),
          ),
          ts("sent_at", { label: "Sent at" }),
        ]),
      ),
      samples: [{ application: { ref: "applications:0" }, candidate: { ref: "candidates:0" }, job: { ref: "jobs:0" }, salary: 150000, currency: "USD", start_date: ms("2026-08-01"), status: "draft" }],
    },
    {
      slug: "offer_approvals", group: "Hiring", singular: "Offer approval", plural: "Offer approvals", defaultSort: "-created_at",
      fields: [
        ...half(rel("offer", "offers", { required: true }), text("approver", { required: true })),
        ...half(
          select("status", [ch("pending", C.amber), ch("approved", C.green), ch("rejected", C.red)], { default: "pending" }),
          ts("decided_at", { label: "Decided at" }),
        ),
      ],
      samples: [{ offer: { ref: "offers:0" }, approver: "Grace Hopper", status: "pending" }],
    },
  ],
  roles: [
    {
      name: "Recruiter",
      description: "Own the pipeline: candidates, applications, interviews, referrals, pools and offers.",
      permissions: [
        { collection: "departments", action: "read" },
        { collection: "candidate_sources", action: "read" },
        { collection: "candidate_sources", action: "create" },
        { collection: "candidate_sources", action: "update" },
        { collection: "jobs", action: "read" },
        { collection: "jobs", action: "create" },
        { collection: "jobs", action: "update" },
        { collection: "stages", action: "read" },
        { collection: "stages", action: "create" },
        { collection: "stages", action: "update" },
        { collection: "interview_kits", action: "read" },
        { collection: "interview_kits", action: "create" },
        { collection: "interview_kits", action: "update" },
        { collection: "candidates", action: "read" },
        { collection: "candidates", action: "create" },
        { collection: "candidates", action: "update" },
        { collection: "talent_pools", action: "read" },
        { collection: "talent_pools", action: "create" },
        { collection: "talent_pools", action: "update" },
        { collection: "talent_pool_members", action: "read" },
        { collection: "talent_pool_members", action: "create" },
        { collection: "talent_pool_members", action: "update" },
        { collection: "talent_pool_members", action: "delete" },
        { collection: "referrals", action: "read" },
        { collection: "referrals", action: "create" },
        { collection: "referrals", action: "update" },
        { collection: "applications", action: "read" },
        { collection: "applications", action: "create" },
        { collection: "applications", action: "update" },
        { collection: "interviews", action: "read" },
        { collection: "interviews", action: "create" },
        { collection: "interviews", action: "update" },
        { collection: "scorecards", action: "read" },
        { collection: "offers", action: "read" },
        { collection: "offers", action: "create" },
        { collection: "offers", action: "update" },
        { collection: "offer_approvals", action: "read" },
        { collection: "offer_approvals", action: "create" },
      ],
    },
    {
      name: "Interviewer",
      description: "See the loop, run interviews and file scorecards — nothing else.",
      permissions: [
        { collection: "jobs", action: "read" },
        { collection: "stages", action: "read" },
        { collection: "interview_kits", action: "read" },
        { collection: "candidates", action: "read" },
        { collection: "applications", action: "read" },
        { collection: "interviews", action: "read" },
        { collection: "interviews", action: "update" },
        { collection: "scorecards", action: "read" },
        { collection: "scorecards", action: "create" },
        { collection: "scorecards", action: "update" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Recruiting pipeline",
      description: "Requisition load, candidate flow and decision quality.",
      panels: [
        { name: "Jobs", kind: "items-aggregate", viz: "counter", config: { collection: "jobs", agg: "count" } },
        { name: "Candidates", kind: "items-aggregate", viz: "counter", config: { collection: "candidates", agg: "count" } },
        { name: "Applications", kind: "items-aggregate", viz: "counter", config: { collection: "applications", agg: "count" } },
        { name: "Applications by status", kind: "items-aggregate", viz: "donut", config: { collection: "applications", agg: "count", groupBy: "status" } },
        { name: "Candidates by source", kind: "items-aggregate", viz: "bars", config: { collection: "candidates", agg: "count", groupBy: "source" } },
        { name: "Jobs by status", kind: "items-aggregate", viz: "bars", config: { collection: "jobs", agg: "count", groupBy: "status" } },
        { name: "Offers by status", kind: "items-aggregate", viz: "donut", config: { collection: "offers", agg: "count", groupBy: "status" } },
        { name: "Scorecards by recommendation", kind: "items-aggregate", viz: "bars", config: { collection: "scorecards", agg: "count", groupBy: "recommendation" } },
      ],
    },
  ],
};
