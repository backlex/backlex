import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, email, file, flag, half, image, int, moneyIn, ms, notes, num, parent, pct, position, rating, rel, sec, select, seq, slugField, stacked, tabbed, text, ts, url, userLink, when } from "../dsl";

export const lms: SchemaTemplate = {
  id: "lms",
  label: "Online courses (LMS)",
  groups: ["Curriculum", "People", "Assessment", "Progress"],
  description:
    "Canvas/Teachable-grade learning platform: courses with modules & lessons, instructors, students and enrollments with progress, quizzes with questions & graded attempts, certificates and course reviews.",
  collections: [
    {
      slug: "categories", group: "Curriculum", singular: "Category", plural: "Categories", defaultSort: "name",
      fields: [...half(text("name", { required: true }), slugField("name")), parent("categories")],
      samples: [{ name: "Programming", slug: "programming" }, { name: "Design", slug: "design" }],
    },
    {
      slug: "instructors", group: "People", singular: "Instructor", plural: "Instructors", defaultSort: "name",
      fields: [...half(text("name", { required: true }), email("email", { unique: true })), notes("bio"), image("avatar")],
      samples: [{ name: "Dr. Ada Lovelace", email: "ada@academy.example", bio: "Teaches computing fundamentals." }],
    },
    {
      slug: "courses", group: "Curriculum", singular: "Course", plural: "Courses", versioned: true, vectorize: true, fts: true, defaultSort: "title",
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Course", [
          ...half(text("title", { required: true, vectorize: true, searchable: true }), slugField("title")),
          text("subtitle"),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
          ...half(rel("instructor", "instructors"), rel("category", "categories")),
        ]),
        sec("Details", [
          ...half(
            select("level", [ch("beginner", C.green), ch("intermediate", C.amber), ch("advanced", C.red), ch("all_levels", C.blue, "All levels")], { default: "beginner" }),
            select("status", [ch("draft", C.gray), ch("published", C.green), ch("archived", C.slate)], { default: "draft" }),
          ),
          ...half(
            select("pricing_type", [ch("free", C.green), ch("one_time", C.blue, "One-time"), ch("subscription", C.purple), ch("payment_plan", C.amber, "Payment plan")], { default: "free", label: "Pricing" }),
            moneyIn("price", { default: 0 }),
          ),
          ...half(select("currency", ["USD", "EUR", "GBP"], { default: "USD" }), text("language", { default: "en" })),
        ]),
        sec("Media", [
          image("thumbnail"),
          ...half(
            int("duration_minutes", { default: 0, label: "Duration (min)", validation: { min: 0 } }),
            ts("published_at", { indexed: true, label: "Published at" }),
          ),
        ]),
      ),
      samples: [{ title: "Intro to Programming", slug: "intro-to-programming", subtitle: "Start coding from zero", description: "Start coding from zero.", instructor: { ref: "instructors:0" }, category: { ref: "categories:0" }, level: "beginner", pricing_type: "free", price: 0, status: "published", duration_minutes: 240 }],
    },
    {
      slug: "modules", group: "Curriculum", singular: "Module", plural: "Modules", defaultSort: "position",
      fields: [
        ...half(rel("course", "courses"), text("title", { required: true })),
        notes("description"),
        ...half(position("course"), flag("published", { label: "Published" })),
      ],
      samples: [{ course: { ref: "courses:0" }, title: "Getting started", position: 1 }, { course: { ref: "courses:0" }, title: "Variables & types", position: 2 }],
    },
    {
      slug: "lessons", group: "Curriculum", singular: "Lesson", plural: "Lessons", defaultSort: "position",
      fields: stacked(
        sec("Lesson", [
          ...half(rel("course", "courses"), rel("module", "modules")),
          ...half(
            text("title", { required: true }),
            select("type", [ch("video", C.blue), ch("text", C.gray), ch("quiz", C.purple), ch("pdf", C.amber), ch("audio", C.teal), ch("assignment", C.red)], { default: "video" }),
          ),
        ]),
        sec("Content", [
          { name: "content", type: "longtext", interface: "richtext" },
          ...half(url("video_url", { label: "Video URL", conditions: [when("type", "_eq", "video", "required")] }), int("duration_minutes", { default: 0, label: "Duration (min)", validation: { min: 0 } })),
        ]),
        sec("Publishing", [
          ...half(position("module"), flag("published", { label: "Published" })),
          bool("free_preview", { default: false, label: "Free preview", description: "Visible to anyone, even before they enroll." }),
        ]),
      ),
      samples: [{ module: { ref: "modules:0" }, course: { ref: "courses:0" }, title: "Welcome", type: "video", content: "Course overview.", duration_minutes: 5, position: 1, free_preview: true }],
    },
    {
      slug: "students", group: "People", singular: "Student", plural: "Students", defaultSort: "name",
      portalLink: { emailField: "email", role: "Student (portal)" },
      fields: [...half(text("name", { required: true }), email("email", { unique: true })), ...half(image("avatar"), userLink())],
      samples: [{ name: "Sam Taylor", email: "sam@student.example" }],
    },
    {
      slug: "enrollments", group: "Progress", singular: "Enrollment", plural: "Enrollments", ownerScoped: true, defaultSort: "-enrolled_at",
      fields: stacked(
        sec("Enrollment", [
          ...half(rel("student", "students"), rel("course", "courses")),
          ...half(
            select("status", [ch("active", C.green), ch("completed", C.blue), ch("expired", C.amber), ch("cancelled", C.gray)], { default: "active" }),
            pct("progress", { default: 0, label: "Progress (%)" }),
          ),
        ]),
        sec("Dates", [
          ...half(ts("enrolled_at", { indexed: true, label: "Enrolled at" }), ts("completed_at", { label: "Completed at" })),
          ts("expires_at", { label: "Expires at" }),
        ]),
      ),
      samples: [{ student: { ref: "students:0" }, course: { ref: "courses:0" }, status: "active", progress: 35, enrolled_at: ms("2026-06-01") }],
    },
    {
      // Per-lesson completion (Canvas tracks this separately from the course
      // roll-up) — without it, `enrollments.progress` is a number nobody can derive.
      slug: "lesson_progress", group: "Progress", singular: "Lesson progress", plural: "Lesson progress",
      fields: [
        ...half(rel("enrollment", "enrollments", { required: true }), rel("lesson", "lessons", { required: true, uniqueWith: ["enrollment"] })),
        ...half(
          select("status", [ch("not_started", C.gray, "Not started"), ch("in_progress", C.blue, "In progress"), ch("completed", C.green)], { default: "not_started" }),
          int("seconds_watched", { default: 0, validation: { min: 0 }, label: "Seconds watched" }),
        ),
        ts("completed_at", { label: "Completed at" }),
      ],
      samples: [{ enrollment: { ref: "enrollments:0" }, lesson: { ref: "lessons:0" }, status: "completed", seconds_watched: 300, completed_at: ms("2026-06-02") }],
    },
    {
      slug: "quizzes", group: "Assessment", singular: "Quiz", plural: "Quizzes", defaultSort: "title",
      fields: stacked(
        sec("Quiz", [
          ...half(rel("course", "courses"), rel("lesson", "lessons")),
          ...half(
            text("title", { required: true }),
            select("type", [ch("graded", C.green), ch("practice", C.blue), ch("survey", C.gray), ch("exam", C.red)], { default: "graded" }),
          ),
          notes("description"),
        ]),
        sec("Rules", [
          ...half(
            pct("passing_score", { default: 70, label: "Passing score (%)" }),
            int("max_attempts", { default: 0, validation: { min: 0 }, label: "Max attempts", description: "0 means unlimited." }),
          ),
          int("time_limit_minutes", { label: "Time limit (min)", validation: { min: 0 } }),
        ]),
      ),
      samples: [{ course: { ref: "courses:0" }, lesson: { ref: "lessons:0" }, title: "Module 1 quiz", type: "graded", passing_score: 70, max_attempts: 3 }],
    },
    {
      slug: "questions", group: "Assessment", singular: "Question", plural: "Questions", defaultSort: "position",
      fields: [
        rel("quiz", "quizzes"),
        notes("prompt"),
        ...half(
          select("type", [ch("multiple_choice", C.blue, "Multiple choice"), ch("true_false", C.teal, "True / false"), ch("multiple_answers", C.purple, "Multiple answers"), ch("short_answer", C.amber, "Short answer"), ch("essay", C.gray)], { default: "multiple_choice" }),
          num("points", { default: 1, validation: { min: 0 } }),
        ),
        ...half(position("quiz"), { name: "options", type: "json", interface: "json", label: "Choices" }),
        notes("explanation"),
      ],
      samples: [{ quiz: { ref: "quizzes:0" }, prompt: "What is a variable?", type: "multiple_choice", points: 1, position: 1 }],
    },
    {
      slug: "quiz_attempts", group: "Assessment", singular: "Attempt", plural: "Attempts", ownerScoped: true, defaultSort: "-started_at",
      fields: stacked(
        sec("Attempt", [
          ...half(rel("quiz", "quizzes"), rel("student", "students")),
          ...half(rel("enrollment", "enrollments"), int("attempt_number", { default: 1, label: "Attempt #", validation: { min: 1 } })),
        ]),
        sec("Result", [
          ...half(num("score", { validation: { min: 0 } }), bool("passed", { default: false, label: "Passed" })),
          ...half(
            select("status", [ch("in_progress", C.blue, "In progress"), ch("submitted", C.amber), ch("graded", C.green), ch("abandoned", C.gray)], { default: "in_progress" }),
            ts("started_at", { indexed: true, label: "Started at" }),
          ),
          ts("submitted_at", { label: "Submitted at" }),
        ]),
      ),
      samples: [{ quiz: { ref: "quizzes:0" }, student: { ref: "students:0" }, enrollment: { ref: "enrollments:0" }, attempt_number: 1, score: 80, passed: true, status: "graded", started_at: ms("2026-06-05") }],
    },
    {
      // Graded work that isn't a quiz (Canvas Assignment) — the other half of
      // assessment, and the reason a gradebook exists.
      slug: "assignments", group: "Assessment", singular: "Assignment", plural: "Assignments", defaultSort: "due_at",
      fields: stacked(
        sec("Assignment", [
          ...half(rel("course", "courses"), rel("module", "modules")),
          text("title", { required: true }),
          notes("instructions"),
        ]),
        sec("Grading", [
          ...half(
            select("submission_type", [ch("file", C.blue), ch("text", C.gray), ch("url", C.teal), ch("offline", C.slate)], { default: "file", label: "Submission type" }),
            num("points_possible", { default: 100, validation: { min: 0 }, label: "Points possible" }),
          ),
          ...half(ts("available_from", { label: "Available from" }), ts("due_at", { indexed: true, label: "Due at" })),
          bool("allow_late", { default: true, label: "Accept late submissions" }),
        ]),
      ),
      samples: [{ course: { ref: "courses:0" }, module: { ref: "modules:1" }, title: "Build a calculator", instructions: "Submit a repository link with a working CLI calculator.", submission_type: "url", points_possible: 100, due_at: ms("2026-07-20T23:59:00Z"), allow_late: true }],
    },
    {
      slug: "submissions", group: "Assessment", singular: "Submission", plural: "Submissions", ownerScoped: true, defaultSort: "-submitted_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Submission", [
          ...half(rel("assignment", "assignments"), rel("student", "students")),
          ...half(
            select("status", [ch("draft", C.gray), ch("submitted", C.blue), ch("late", C.amber), ch("graded", C.green), ch("returned", C.teal)], { default: "draft" }),
            ts("submitted_at", { indexed: true, label: "Submitted at" }),
          ),
          ...half(url("submission_url", { label: "Submitted URL" }), file("attachment")),
          notes("body", { label: "Written answer" }),
        ]),
        sec("Grade", [
          ...half(num("grade", { validation: { min: 0 }, label: "Grade" }), rel("graded_by", "instructors", { label: "Graded by" })),
          notes("feedback"),
        ]),
      ),
      samples: [{ assignment: { ref: "assignments:0" }, student: { ref: "students:0" }, status: "graded", submitted_at: ms("2026-07-18"), submission_url: "https://github.com/example/calculator", grade: 92, graded_by: { ref: "instructors:0" }, feedback: "Clean structure — add tests for the divide-by-zero path." }],
    },
    {
      slug: "certificates", group: "Progress", singular: "Certificate", plural: "Certificates", defaultSort: "-issued_at",
      fields: [
        ...half(rel("student", "students"), rel("course", "courses")),
        ...half(rel("enrollment", "enrollments"), seq("serial", "CERT-{YYYY}-{####}", { label: "Serial number" })),
        ...half(ts("issued_at", { indexed: true, label: "Issued at" }), date("expires_at", { label: "Expires at" })),
        select("status", [ch("issued", C.green), ch("revoked", C.red), ch("expired", C.gray)], { default: "issued" }),
      ],
      samples: [{ student: { ref: "students:0" }, course: { ref: "courses:0" }, enrollment: { ref: "enrollments:0" }, issued_at: ms("2026-06-30"), status: "issued" }],
    },
    {
      slug: "reviews", group: "Progress", singular: "Review", plural: "Reviews", ownerScoped: true, defaultSort: "-created_at",
      fields: [
        ...half(rel("student", "students"), rel("course", "courses")),
        ...half(rating("rating"), text("title")),
        notes("body"),
        select("status", [ch("pending", C.amber), ch("published", C.green), ch("hidden", C.gray)], { default: "pending" }),
      ],
      samples: [{ student: { ref: "students:0" }, course: { ref: "courses:0" }, rating: 5, title: "Loved it", body: "Clear and beginner-friendly.", status: "published" }],
    },
  ],
  roles: [
    {
      name: "Student (portal)",
      description: "Student portal: browse the catalog and lessons, follow own enrollments, take quizzes, and see own certificates and reviews.",
      permissions: [
        { collection: "categories", action: "read" },
        { collection: "instructors", action: "read" },
        { collection: "courses", action: "read" },
        { collection: "modules", action: "read" },
        { collection: "lessons", action: "read" },
        { collection: "quizzes", action: "read" },
        { collection: "questions", action: "read" },
        { collection: "students", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "enrollments", action: "read", condition: { "student.app_user_id": { _eq: "$user.id" } } },
        { collection: "quiz_attempts", action: "read", condition: { "student.app_user_id": { _eq: "$user.id" } } },
        { collection: "quiz_attempts", action: "create" },
        { collection: "quiz_attempts", action: "update", condition: { "student.app_user_id": { _eq: "$user.id" } } },
        { collection: "certificates", action: "read", condition: { "student.app_user_id": { _eq: "$user.id" } } },
        { collection: "reviews", action: "read", condition: { "student.app_user_id": { _eq: "$user.id" } } },
        { collection: "reviews", action: "create" },
        { collection: "reviews", action: "update", condition: { "student.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  flows: [
    {
      name: "Ask for the certificate once an enrollment is marked completed",
      // `enrollments.status` declares no lifecycle (`flow()`), so a transition
      // trigger is not available on this collection and `…:updated` plus a
      // condition is the honest shape. It re-announces on every later save of a
      // completed enrollment — which costs one line in the feed and nothing
      // else, precisely because the step below writes nothing.
      trigger: "event:items:enrollments:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "completed" } },
          then: [
            {
              type: "notification",
              title: "A student finished a course",
              body: "Progress is {{ data.progress }}% and it completed {{ data.completed_at }}. Raise the certificate from this enrollment's student and course — a flow cannot, because it would mint a second one the next time this row is saved.",
              url: "/collections/certificates",
            },
          ],
        },
      ],
    },
    {
      name: "Chase a student who has not opened the course a week after enrolling",
      // Fires once per enrollment, seven days after `enrolled_at`, at 09:00, and
      // only for the ones still at zero. That first week is where a course
      // business loses people: access was granted, nothing was watched, and by
      // the time anybody looks the refund window has closed.
      trigger: `schedule:${JSON.stringify({
        collection: "enrollments",
        field: "enrolled_at",
        offset: { value: 7, unit: "days", direction: "after" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "active" }, progress: { _eq: 0 } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "A week in and still at 0%",
          body: "Enrolled {{ data.enrolled_at }}, access runs to {{ data.expires_at }}, and nothing has been started. Send the welcome again, or check the first module is published.",
          url: "/collections/enrollments",
        },
      ],
    },
    {
      name: "Chase a submission that has been waiting three days for a mark",
      // Anchored on `submitted_at` so it fires once per submission rather than
      // re-reporting the whole grading queue every morning. Whether a submission
      // is LATE is deliberately not decided here — that needs the assignment's
      // `due_at` and `allow_late`, which live one collection away — so the
      // trigger simply accepts both states as work still owed a grade.
      trigger: `schedule:${JSON.stringify({
        collection: "submissions",
        field: "submitted_at",
        offset: { value: 3, unit: "days", direction: "after" },
        at: 480,
        timeZone: null,
        where: { status: { _in: ["submitted", "late"] } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "A submission has been unmarked for three days",
          body: "Submitted {{ data.submitted_at }} and still {{ data.status }}. Grade it and leave feedback, or return it for another attempt.",
          url: "/collections/submissions",
        },
      ],
    },
    {
      name: "Retire access, certificates and attempts once their time is up",
      // Three sweeps in one daily job because they are one job: every row here
      // has a date that has already gone by and is still claiming to be live.
      // Uncapped on purpose — unlike a digest, an update sweep converges, and a
      // limit would leave the tail of a backlog wrong for another day.
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "enrollments",
          filter: { status: { _eq: "active" }, expires_at: { _lt: "$now" } },
          do: [
            {
              type: "item.update",
              collection: "enrollments",
              id: "{{ $item.id }}",
              data: { status: "expired" },
            },
          ],
        },
        {
          type: "foreach",
          collection: "certificates",
          filter: { status: { _eq: "issued" }, expires_at: { _lt: "$now" } },
          do: [
            {
              type: "item.update",
              collection: "certificates",
              id: "{{ $item.id }}",
              data: { status: "expired" },
            },
          ],
        },
        {
          // A quiz's own `time_limit_minutes` is one collection away, so this
          // uses a flat day rather than pretending it read the rule: an attempt
          // still `in_progress` twenty-four hours after it started is not being
          // taken, and leaving it open spends one of the student's
          // `max_attempts` on a sitting that never happened.
          type: "foreach",
          collection: "quiz_attempts",
          filter: {
            status: { _eq: "in_progress" },
            started_at: { _lt: { $now: { sub: { hours: 24 } } } },
          },
          do: [
            {
              type: "item.update",
              collection: "quiz_attempts",
              id: "{{ $item.id }}",
              data: { status: "abandoned" },
            },
          ],
        },
      ],
    },
    {
      name: "Email the certificate when one is issued (needs email + a PDF renderer)",
      // Off until both are configured — the name carries the prerequisite so
      // nobody has to open it to find out. `created` rather than a status move:
      // a certificate row exists because somebody decided to issue it, so its
      // creation IS the event, and it happens exactly once.
      active: false,
      trigger: "event:items:certificates:created",
      operations: [
        { type: "document.render", templateKey: "course_certificate" },
        {
          type: "email",
          to: "{{ data.student.email }}",
          subject: "Your certificate — {{ data.course.title }}",
          html:
            "<p>Congratulations on finishing the course — your certificate is attached.</p>" +
            "<p>Its serial is <strong>{{ data.serial }}</strong>; quote that if anyone asks you to verify it.</p>",
          attach: ["{{ $last.key }}"],
        },
      ],
    },
    {
      name: "Monthly learning report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Learning overview",
          subject: "Learning — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "course_certificate",
      name: "Course completion certificate",
      description: "What a student gets when they finish — and what the serial verifies.",
      filename: "certificate-{{ data.serial }}",
      variables: ["serial", "issued_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4 landscape;margin:16mm}" +
        "body{font:14px/1.6 Georgia,'Times New Roman',serif;color:#1a1a1a;text-align:center}" +
        ".frame{border:3px double #8a6d3b;padding:36px 30px}" +
        "h1{font-size:30px;letter-spacing:3px;margin:0 0 8px;text-transform:uppercase}" +
        ".muted{color:#666;font-size:12px}" +
        ".name{font-size:26px;margin:22px 0 4px}" +
        ".course{font-size:19px;font-weight:bold;margin:10px 0 20px}" +
        ".meta{margin-top:30px;font-size:12px;color:#555}" +
        "</style></head><body>" +
        '<div class="frame">' +
        "<h1>Certificate of completion</h1>" +
        '<p class="muted">This is to certify that</p>' +
        '<p class="name">{{ data.student.name }}</p>' +
        '<p class="muted">has completed the course</p>' +
        '<p class="course">{{ data.course.title }}</p>' +
        '<p class="muted">{{ data.course.duration_minutes }} minutes of instruction · {{ data.course.level }}</p>' +
        '<p class="meta">Issued {{ data.issued_at }} · Valid until {{ data.expires_at }}<br>' +
        "Serial <strong>{{ data.serial }}</strong></p>" +
        "</div></body></html>",
      pageOptions: { format: "A4", landscape: true, margin: "16mm" },
    },
    {
      key: "course_syllabus",
      name: "Course syllabus",
      description: "The one page a prospective student decides on.",
      filename: "syllabus-{{ data.slug }}",
      variables: ["title", "level", "duration_minutes"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 4px}" +
        "h2{font-size:13px;margin:22px 0 6px;text-transform:uppercase;letter-spacing:1px;color:#555}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:8px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{color:#555;font-weight:600}" +
        "table.facts th{width:30%}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">{{ data.subtitle }}</p>' +
        "<h2>At a glance</h2>" +
        '<table class="facts">' +
        "<tr><th>Instructor</th><td>{{ data.instructor.name }}</td></tr>" +
        "<tr><th>Category</th><td>{{ data.category.name }}</td></tr>" +
        "<tr><th>Level</th><td>{{ data.level }}</td></tr>" +
        "<tr><th>Language</th><td>{{ data.language }}</td></tr>" +
        "<tr><th>Length</th><td>{{ data.duration_minutes }} minutes</td></tr>" +
        "<tr><th>Price</th><td>{{ data.price }} {{ data.currency }} ({{ data.pricing_type }})</td></tr>" +
        "</table>" +
        "<h2>About this course</h2>" +
        "<div>{{ data.description }}</div>" +
        "<h2>Modules and lessons</h2>" +
        "<!-- one row per module, then its lessons in position order; fill from your own query or a foreach -->" +
        "<table><thead><tr><th>Module</th><th>Lesson</th><th>Type</th></tr></thead><tbody>" +
        "</tbody></table>" +
        '<p class="muted">The running order is the position each module and lesson holds, not the date anything ' +
        "was written — a lesson moved in the outline moves here too.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "assignment_feedback",
      name: "Assignment feedback sheet",
      description: "A marked submission as the student receives it back.",
      filename: "feedback-{{ data.id }}",
      variables: ["grade", "feedback"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:34%;color:#555;font-weight:600}" +
        ".feedback{margin-top:18px;padding:12px;border-left:3px solid #d0d0d0;background:#fafafa}" +
        "</style></head><body>" +
        "<h1>{{ data.assignment.title }}</h1>" +
        '<p class="muted">{{ data.student.name }} · submitted {{ data.submitted_at }}</p>' +
        "<table>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "<tr><th>Grade</th><td>{{ data.grade }} / {{ data.assignment.points_possible }}</td></tr>" +
        "<tr><th>Marked by</th><td>{{ data.graded_by.name }}</td></tr>" +
        "<tr><th>Work submitted</th><td>{{ data.submission_url }}</td></tr>" +
        "</table>" +
        '<div class="feedback">{{ data.feedback }}</div>' +
        '<p class="muted">The grade is the mark on this submission; the points it is out of belong to the ' +
        "assignment, so both are printed together rather than as a percentage that hides which is which.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      // Which course they want is a relation, and a public form cannot set one,
      // so an applicant lands as a plain student row and staff attach the
      // enrollment on the same pass they were already making. `app_user_id` is
      // deliberately off the form: it names a real login, and an anonymous
      // submitter must never be able to point a row at somebody else's account.
      // `email` is unique on this collection, so a second sign-up on the same
      // address is refused rather than quietly creating a duplicate person.
      name: "New student details (courses)",
      collection: "students",
      settings: {
        submitLabel: "Send details",
        successMessage: "Thanks — we'll set your access up and email you when the course is open.",
      },
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Email", help: "Where course access and your certificate are sent." },
      ],
    },
    {
      name: "Instructor application",
      collection: "instructors",
      settings: {
        submitLabel: "Apply to teach",
        successMessage: "Received — we review teaching applications weekly.",
      },
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Email" },
        {
          name: "bio",
          label: "What would you teach?",
          help: "Subjects, the level you pitch at, and where you have taught before.",
        },
      ],
    },
  ],
  agents: [
    {
      name: "Learning analyst",
      handle: "learning-analyst",
      description: "Answers questions about enrollments, progress and results.",
      systemPrompt:
        "You help a course team read its own numbers. Answer using the " +
        "workspace's data only. Six things this schema makes necessary. " +
        "`enrollments.progress` is a whole percentage — 20 means twenty " +
        "percent, not a fifth of one. Course completion is an enrollment whose " +
        "status is `completed`; per-lesson completion is a separate " +
        "`lesson_progress` row, so never report lessons finished as courses " +
        "finished. Assessment has two halves that share no table: quizzes with " +
        "`quiz_attempts`, and assignments with `submissions` — a quiz result is " +
        "`score` and `passed` on the attempt against the quiz's own " +
        "`passing_score`, an assignment result is `grade` on the submission out " +
        "of the assignment's `points_possible`, and the two are not the same " +
        "figure. A student may sit one quiz several times, so report the latest " +
        "or the best attempt and say which; never add attempts together. A " +
        "course's `price` carries its own `currency`, amounts in different " +
        "currencies are never added, and a `free` course's price is not " +
        "revenue. A review counts only while its status is `published`, and a " +
        "certificate only while its status is `issued`. When a figure has a " +
        "seeded KPI — new enrollments, completions, average progress, average " +
        "quiz score — run that definition rather than adding rows up your own " +
        "way, so your answer matches the dashboard. Name the course or the " +
        "student you mean, be brief, and say plainly when the data does not " +
        "answer the question.",
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
  dashboards: [
    {
      name: "Learning overview",
      description: "Who enrolled, how far they got, and what the marking queue looks like.",
      panels: [
        { name: "Enrollments", kind: "items-aggregate", viz: "counter", config: { collection: "enrollments", agg: "count" } },
        { name: "Students", kind: "items-aggregate", viz: "counter", config: { collection: "students", agg: "count" } },
        { name: "Courses", kind: "items-aggregate", viz: "counter", config: { collection: "courses", agg: "count" } },
        { name: "Average progress", kind: "items-aggregate", viz: "counter", config: { collection: "enrollments", agg: "avg", field: "progress" } },
        { name: "Enrollments by status", kind: "items-aggregate", viz: "donut", config: { collection: "enrollments", agg: "count", groupBy: "status" } },
        { name: "Courses by level", kind: "items-aggregate", viz: "donut", config: { collection: "courses", agg: "count", groupBy: "level" } },
        { name: "Submissions by status", kind: "items-aggregate", viz: "bars", config: { collection: "submissions", agg: "count", groupBy: "status" } },
        { name: "Quiz attempts by status", kind: "items-aggregate", viz: "bars", config: { collection: "quiz_attempts", agg: "count", groupBy: "status" } },
      ],
    },
  ],
};
