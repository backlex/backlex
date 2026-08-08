import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, email, file, half, image, int, moneyIn, ms, notes, num, parent, pct, position, rating, rel, sec, select, slugField, stacked, tabbed, text, ts, url, userLink } from "../dsl";

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
        ...half(position("course"), bool("published", { default: true, label: "Published" })),
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
          ...half(url("video_url", { label: "Video URL" }), int("duration_minutes", { default: 0, label: "Duration (min)", validation: { min: 0 } })),
        ]),
        sec("Publishing", [
          ...half(position("module"), bool("published", { default: true, label: "Published" })),
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
        ...half(rel("enrollment", "enrollments", { required: true }), rel("lesson", "lessons", { required: true })),
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
        ...half(rel("enrollment", "enrollments"), text("serial", { unique: true, label: "Serial number" })),
        ...half(ts("issued_at", { indexed: true, label: "Issued at" }), date("expires_at", { label: "Expires at" })),
        select("status", [ch("issued", C.green), ch("revoked", C.red), ch("expired", C.gray)], { default: "issued" }),
      ],
      samples: [{ student: { ref: "students:0" }, course: { ref: "courses:0" }, enrollment: { ref: "enrollments:0" }, serial: "CERT-0001", issued_at: ms("2026-06-30"), status: "issued" }],
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
};
