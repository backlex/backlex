import type { SchemaTemplate } from "../types";
import { C, ch, date, email, file, half, int, money, moneyIn, ms, notes, phone, position, rating, rel, sec, select, seq, slugField, stacked, tabbed, text, ts, url, when } from "../dsl";

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
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Job", [
          ...half(text("title", { required: true, searchable: true }), slugField("title")),
          ...half(seq("requisition_id", "REQ-{YYYY}-{####}", { label: "Requisition ID" }), rel("department", "departments")),
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
      samples: [{ title: "Senior Backend Engineer", slug: "senior-backend-engineer", description: "Build our API platform.", department: { ref: "departments:0" }, location: "Remote", employment_type: "full_time", status: "open", openings: 2, hiring_manager: "Grace Hopper", salary_min: 120000, salary_max: 160000 }],
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
      kanbanGroupBy: "status",
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
            text("rejection_reason", { label: "Rejection reason", conditions: [when("status", "_eq", "rejected", "required"), when("status", "_neq", "rejected", "hidden")] }),
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
      kanbanGroupBy: "status",
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
  /**
   * The rules a recruiting operation runs on, already running.
   *
   * Deliberately absent: "the offer was accepted, so pay the referral bonus and
   * close the requisition". Both need a row a flow cannot reach. A `referrals`
   * row is keyed by CANDIDATE, not by offer, and for most hires there is no
   * such row at all; a job is filled when accepted offers reach its `openings`,
   * and that count lives on neither the offer nor the job. A step that guessed
   * would pay a bonus nobody earned, or close a req with a seat still open. So
   * the flows report and leave the judgement where the figures are.
   *
   * Also absent: a reminder addressed to the interviewer. `interviews.interviewer`
   * is a NAME typed into a text column, not a workspace user — a notification
   * has nobody to deliver to and an email has no address. Everything here is
   * addressed to the recruiting team, which is who the workspace actually knows.
   */
  flows: [
    {
      name: "Tell the recruiter when an application lands",
      trigger: "event:items:applications:created",
      operations: [
        // Referrals first is not decoration — it is the one SLA nearly every
        // recruiting team actually keeps, and it is the reason `source` is on
        // the application as well as on the candidate.
        {
          type: "condition",
          filter: { source: { _eq: "referral" } },
          then: [
            {
              type: "notification",
              title: "Referred candidate applied: {{ data.candidate.first_name }} {{ data.candidate.last_name }}",
              body: "Referrals are screened first. Read it today, then move it onto the first stage of the job's own pipeline.",
              url: "/collections/applications",
            },
          ],
          else: [
            {
              type: "notification",
              title: "New application: {{ data.candidate.first_name }} {{ data.candidate.last_name }}",
              body: "Arrived via {{ data.source }} for {{ data.job.title }}. Move it onto the first stage of that job's pipeline once it has been read.",
              url: "/collections/applications",
            },
          ],
        },
      ],
    },
    {
      name: "Chase an interview whose slot has passed with no outcome recorded",
      // An interview left on `scheduled` after its slot is the single most
      // common gap in an ATS: the loop happened, nobody closed the record, and
      // the debrief runs on memory. Capped and oldest-first, like every sweep
      // here — switched on over a year of history an uncapped one would post a
      // digest nobody reads to the bottom of.
      //
      // Deliberately does NOT check whether a scorecard exists: a scorecard is
      // a row in another collection and a flow's `data` is one row with no
      // join, so the body asks for it rather than pretending to know.
      trigger: "cron:0 7 * * *",
      operations: [
        {
          type: "foreach",
          collection: "interviews",
          filter: { status: { _eq: "scheduled" }, scheduled_at: { _lt: "$now" } },
          sort: "scheduled_at",
          limit: 25,
          do: [
            {
              type: "notification",
              title: "No outcome recorded: {{ $item.interviewer }}",
              body: "The slot has passed and this interview is still marked scheduled. Set it to completed, cancelled or no show, and file the scorecard while it is fresh.",
              url: "/collections/interviews",
            },
          ],
        },
      ],
    },
    {
      name: "Chase an offer nobody has answered five days after it went out",
      // Fires once per offer, five days after `sent_at`, at 09:00 — and only
      // for the ones still sitting on `sent`. An offer that was never sent has
      // a null `sent_at`, which names no instant, so it never fires.
      trigger: `schedule:${JSON.stringify({
        collection: "offers",
        field: "sent_at",
        offset: { value: 5, unit: "days", direction: "after" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "sent" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "Offer to {{ data.candidate.first_name }} {{ data.candidate.last_name }} is five days old",
          body: "Still unanswered. Chase it today — the start date on it is {{ data.start_date }}, and a silent offer is usually a competing one.",
          url: "/collections/offers",
        },
      ],
    },
    {
      name: "Mark the application hired when its offer is accepted",
      // An `…:updated` trigger with a condition, NOT a transition trigger: a
      // transition trigger only exists where the status field declares a
      // lifecycle, and `offers.status` deliberately declares none. So this
      // re-fires on every later edit made while the offer sits on `accepted`.
      // It survives that because the write is idempotent — setting `hired` on
      // an application already hired changes nothing — and the only thing that
      // repeats is the notification.
      //
      // The stage is left alone on purpose: the hired stage is a `stages` row
      // belonging to that job, and this run holds the offer row alone.
      trigger: "event:items:offers:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "accepted" } },
          then: [
            {
              type: "item.update",
              collection: "applications",
              id: "{{ data.application }}",
              data: { status: "hired" },
            },
            {
              type: "notification",
              title: "Offer accepted by {{ data.candidate.first_name }} {{ data.candidate.last_name }}",
              body: "The application is now hired. Move it to the hired stage of {{ data.job.title }}'s pipeline, and close or re-post the requisition if the last seat has gone.",
              url: "/collections/offers",
            },
          ],
        },
      ],
    },
    {
      name: "Email the offer letter when the offer goes out (needs email + a PDF renderer)",
      // Off until both are configured — the name carries the prerequisite so
      // nobody has to open it to find out. Same trigger shape as above and the
      // same caveat, which matters more here because this one MAILS somebody:
      // give `offers.status` a lifecycle and this should become
      // `event:items:offers:transition:status:*:sent`, which fires once on the
      // real move instead of on every save made while the offer reads `sent`.
      active: false,
      trigger: "event:items:offers:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "sent" } },
          then: [
            { type: "document.render", templateKey: "offer_letter" },
            {
              type: "email",
              to: "{{ data.candidate.email }}",
              subject: "Your offer for {{ data.job.title }}",
              html: "<p>Your offer letter is attached. Reply to this message to accept or decline — your recruiter records the answer against the offer.</p>",
              attach: ["{{ $last.key }}"],
            },
          ],
        },
      ],
    },
    {
      name: "Weekly recruiting report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 * * 1",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Recruiting pipeline",
          subject: "Recruiting — last week",
        },
      ],
    },
  ],
  documents: [
    {
      // Rendered against an OFFER row. The three variables are the three facts
      // that make it an offer rather than a letter: without a salary, a
      // currency and a start date it must not render at all.
      key: "offer_letter",
      name: "Offer letter",
      description: "The offer as the candidate receives it.",
      filename: "offer-{{ data.id }}",
      variables: ["salary", "currency", "start_date"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:22mm}" +
        "body{font:13px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 16px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin:18px 0}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:34%;color:#555;font-weight:600}" +
        ".sig{margin-top:44px}" +
        "</style></head><body>" +
        "<h1>Offer of employment</h1>" +
        "<p>Dear {{ data.candidate.first_name }},</p>" +
        "<p>Following your conversations with the team, we are pleased to offer you " +
        "the position of <strong>{{ data.job.title }}</strong> on the terms below.</p>" +
        "<table>" +
        "<tr><th>Position</th><td>{{ data.job.title }}</td></tr>" +
        "<tr><th>Engagement</th><td>{{ data.job.employment_type }}</td></tr>" +
        "<tr><th>Location</th><td>{{ data.job.location }}</td></tr>" +
        "<tr><th>Salary</th><td>{{ data.salary }} {{ data.currency }} per year</td></tr>" +
        "<tr><th>Start date</th><td>{{ data.start_date }}</td></tr>" +
        "<tr><th>Hiring manager</th><td>{{ data.job.hiring_manager }}</td></tr>" +
        "</table>" +
        "<p>The offer is made subject to the checks discussed during the process, " +
        "and it lapses if it has not been accepted by the start date above.</p>" +
        '<p class="muted">Reply to your recruiter to accept or decline. Your answer ' +
        "is recorded against this offer — this letter is not itself a signature.</p>" +
        '<p class="sig">_____________________________<br>For the company · date</p>' +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "22mm" },
    },
    {
      // Rendered against an INTERVIEW KIT row — the sheet an interviewer takes
      // into the room. `rubric_hint` is deliberately not a required variable:
      // a kit written this morning may not have one yet, and refusing to print
      // the questions over a missing hint helps nobody.
      key: "interview_kit",
      name: "Interview kit",
      description: "The question pack and rubric an interviewer runs the loop from.",
      filename: "interview-kit-{{ data.name }}",
      variables: ["name", "questions"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        "h2{font-size:14px;margin:22px 0 6px}" +
        ".muted{color:#666}" +
        ".q{white-space:pre-wrap}" +
        "table{width:100%;border-collapse:collapse;margin-top:10px}" +
        "th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #e5e5e5}" +
        "td.box{width:12%;text-align:center;color:#999}" +
        ".rule{border-bottom:1px solid #ccc;height:22px}" +
        "</style></head><body>" +
        "<h1>{{ data.name }}</h1>" +
        '<p class="muted">Stage: {{ data.stage.name }} · {{ data.stage.type }}</p>' +
        "<h2>Questions</h2>" +
        '<p class="q">{{ data.questions }}</p>' +
        "<h2>What a strong answer looks like</h2>" +
        '<p class="q">{{ data.rubric_hint }}</p>' +
        "<h2>Evidence</h2>" +
        '<div class="rule"></div><div class="rule"></div><div class="rule"></div>' +
        '<div class="rule"></div>' +
        "<h2>Recommendation</h2>" +
        "<table><tbody>" +
        '<tr><td>Strong yes</td><td class="box">[ ]</td><td>No</td><td class="box">[ ]</td></tr>' +
        '<tr><td>Yes</td><td class="box">[ ]</td><td>Strong no</td><td class="box">[ ]</td></tr>' +
        '<tr><td>No decision</td><td class="box">[ ]</td><td></td><td class="box"></td></tr>' +
        "</tbody></table>" +
        '<p class="muted">File this as a scorecard against the interview as soon as ' +
        "the loop ends. The debrief reads the scorecard's recommendation, not this sheet.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      // Creates a CANDIDATE, not an application: a public link cannot know
      // which requisition it was opened from, and guessing one would file
      // people against the wrong job. The recruiter attaches the person to the
      // job, which is also where the source channel gets set.
      //
      // A returning candidate's second submission is refused by the unique
      // email, and that is the right answer rather than a gap — the person
      // already exists, and what they need is another application, not another
      // record of themselves.
      name: "Apply for a job",
      collection: "candidates",
      settings: {
        submitLabel: "Send application",
        successMessage: "Thank you — every application is read, and we come back either way.",
      },
      fields: [
        { name: "first_name", label: "First name" },
        { name: "last_name", label: "Last name" },
        { name: "email", label: "Email", help: "Where we reply — use an address you check." },
        { name: "phone", label: "Phone", help: "Include the country code, e.g. +1 555 010 0100." },
        { name: "location", label: "Where you are based", help: "City and country is enough." },
        { name: "current_company", label: "Current company" },
        { name: "current_title", label: "Current title" },
        { name: "linkedin", label: "LinkedIn", help: "Optional." },
        { name: "resume", label: "CV", help: "PDF travels best." },
      ],
    },
    {
      // The requisition-intake link a hiring manager fills in without an admin
      // seat. Safe as a link because `jobs` is versioned: a submission lands as
      // a DRAFT and nothing is live until recruiting publishes it. The
      // requisition id, the recruiter, the department and the status stay
      // recruiting's to set — a request is not an open role.
      name: "Request a new requisition",
      collection: "jobs",
      settings: {
        submitLabel: "Send request",
        successMessage: "Thanks — recruiting picks these up and comes back with a requisition number.",
      },
      fields: [
        { name: "title", label: "Role title" },
        { name: "description", label: "What the role does", help: "The work itself, not the ideal person." },
        { name: "location", label: "Location", help: "An office, a city, or Remote." },
        { name: "employment_type", label: "Employment type" },
        { name: "openings", label: "How many people", help: "One requisition can cover several seats." },
        { name: "hiring_manager", label: "Hiring manager" },
        { name: "salary_min", label: "Band minimum" },
        { name: "salary_max", label: "Band maximum", help: "Must be at least the minimum." },
        { name: "salary_currency", label: "Currency" },
      ],
    },
  ],
  agents: [
    {
      name: "Recruiting assistant",
      handle: "recruiting-assistant",
      description: "Answers questions about the pipeline, the loop and where each candidate stands.",
      systemPrompt:
        "You help a recruiting team run its hiring. Answer questions about jobs, " +
        "candidates, applications, interviews, scorecards and offers using the " +
        "workspace's own data.\n\n" +
        "Keep the three nouns apart. A CANDIDATE is a person; an APPLICATION is " +
        "that person against one job; a JOB is one requisition. One candidate can " +
        "hold several applications, so never count people by counting " +
        "applications, and never call a candidate rejected when what was " +
        "rejected is one of their applications.\n\n" +
        "Status and stage are different columns meaning different things. An " +
        "application's `status` is only active, rejected or hired; how far it has " +
        "actually got is its `stage`, a row belonging to that job and ordered by " +
        "`position`. Stages are per job, so a stage on one job never compares " +
        "with a stage on another. An interview counts as done when its own " +
        "`status` says completed — a slot in the past proves nothing. A hiring " +
        "opinion is the `recommendation` on a scorecard, never the rating on an " +
        "application.\n\n" +
        "Offers each carry their own currency, so report one figure per currency " +
        "and never add across them. Asked where hires come from, say which column " +
        "you read: the candidate carries a `source` and so does the application, " +
        "and the two can disagree. Candidate contact details and CVs belong to " +
        "the hiring team — give them when someone asks about that candidate, not " +
        "in a list or a digest. Be brief, name the candidate and the job you " +
        "mean, and say plainly when the data does not answer the question.",
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
