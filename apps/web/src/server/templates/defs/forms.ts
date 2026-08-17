import type { SchemaTemplate } from "../types";
import { C, bool, ch, email, flag, half, int, ms, notes, position, rel, sec, select, slugField, stacked, text, ts, url } from "../dsl";

export const forms: SchemaTemplate = {
  id: "forms",
  label: "Forms & surveys",
  groups: ["Forms", "Results", "Integrations"],
  description:
    "Typeform-grade form builder: folders of forms with a typed question bank (text, choice, rating, file…), required & conditional fields, complete/partial responses and per-question answers — plus share links, submit webhooks and notification rules.",
  collections: [
    {
      slug: "form_folders", group: "Forms", singular: "Folder", plural: "Folders", defaultSort: "position",
      fields: [...half(text("name", { required: true }), position())],
      samples: [{ name: "Customer research", position: 1 }],
    },
    {
      slug: "forms", group: "Forms", singular: "Form", plural: "Forms", defaultSort: "-created_at",
      fields: stacked(
        sec("Form", [
          ...half(text("name", { required: true }), slugField("name")),
          notes("description"),
          ...half(
            rel("folder", "form_folders"),
            select("status", [ch("draft", C.gray), ch("published", C.green), ch("closed", C.red)], { default: "draft" }),
          ),
        ]),
        sec("After submit", [
          notes("submit_message", { label: "Thank-you message" }),
          ...half(
            bool("allow_multiple", { default: true, label: "Allow multiple submissions" }),
            bool("requires_login", { default: false, label: "Requires login" }),
          ),
          int("response_count", { default: 0, validation: { min: 0 }, label: "Responses" }),
        ]),
      ),
      samples: [{ name: "Customer Feedback", slug: "customer-feedback", description: "Tell us how we did.", folder: { ref: "form_folders:0" }, status: "published", submit_message: "Thanks for your feedback!" }],
    },
    {
      slug: "questions", group: "Forms", singular: "Question", plural: "Questions", defaultSort: "position",
      fields: [
        rel("form", "forms"),
        ...half(text("label", { required: true }), text("help_text", { label: "Help text" })),
        ...half(
          select("type", [ch("short_text", C.blue, "Short text"), ch("long_text", C.teal, "Long text"), ch("email", C.purple), ch("number", C.gray), ch("single_select", C.amber, "Single choice"), ch("multi_select", C.amber, "Multiple choice"), ch("rating", C.green), ch("date", C.slate), ch("file", C.gray), ch("yes_no", C.blue, "Yes / no")], { default: "short_text" }),
          position("form"),
        ),
        ...half(bool("required", { default: false }), { name: "options", type: "json", interface: "json", label: "Choices" }),
      ],
      samples: [
        { form: { ref: "forms:0" }, label: "How satisfied were you?", type: "rating", position: 1, required: true },
        { form: { ref: "forms:0" }, label: "Any other comments?", type: "long_text", position: 2 },
      ],
    },
    {
      slug: "responses", group: "Results", singular: "Response", plural: "Responses", defaultSort: "-submitted_at",
      fields: [
        ...half(rel("form", "forms"), email("email")),
        ...half(
          select("status", [ch("complete", C.green), ch("partial", C.amber)], { default: "complete" }),
          ts("submitted_at", { indexed: true, label: "Submitted at" }),
        ),
      ],
      samples: [{ form: { ref: "forms:0" }, email: "jordan@example.com", status: "complete", submitted_at: ms("2026-06-20") }],
    },
    {
      slug: "answers", group: "Results", singular: "Answer", plural: "Answers",
      fields: [...half(rel("response", "responses"), rel("question", "questions")), notes("value")],
      samples: [
        { response: { ref: "responses:0" }, question: { ref: "questions:0" }, value: "5" },
        { response: { ref: "responses:0" }, question: { ref: "questions:1" }, value: "Loved the support." },
      ],
    },
    {
      slug: "share_links", group: "Integrations", singular: "Share link", plural: "Share links", defaultSort: "-created_at",
      fields: [
        ...half(rel("form", "forms"), text("token", { unique: true, required: true })),
        ...half(ts("expires_at", { indexed: true, label: "Expires at" }), flag("active")),
        ...half(
          int("max_responses", { validation: { min: 0 }, label: "Max responses" }),
          int("responses_used", { default: 0, validation: { min: 0 }, label: "Responses used" }),
        ),
      ],
      samples: [{ form: { ref: "forms:0" }, token: "shr_9f2k7d1m", expires_at: ms("2026-09-30"), max_responses: 500, responses_used: 42, active: true }],
    },
    {
      slug: "webhooks", group: "Integrations", singular: "Webhook", plural: "Webhooks", defaultSort: "-created_at",
      fields: [
        rel("form", "forms"),
        url("url", { required: true }),
        ...half(
          select("event", [ch("on_submit", C.green, "On submit"), ch("on_partial", C.amber, "On partial")], { default: "on_submit" }),
          text("secret", { private: true, label: "Signing secret" }),
        ),
        ...half(flag("active"), int("last_status", { label: "Last status code" })),
      ],
      samples: [{ form: { ref: "forms:0" }, url: "https://hooks.example.com/forms/feedback", event: "on_submit", secret: "whsec_demo", active: true, last_status: 200 }],
    },
    {
      slug: "notification_rules", group: "Integrations", singular: "Notification rule", plural: "Notification rules", defaultSort: "-created_at",
      fields: [
        ...half(rel("form", "forms"), email("notify_email", { required: true, label: "Notify email" })),
        ...half(text("condition", { label: "Condition", description: "Only notify when this holds, e.g. rating <= 2." }), flag("active")),
      ],
      samples: [{ form: { ref: "forms:0" }, notify_email: "support@backlex.example", condition: "rating <= 2", active: true }],
    },
  ],
  roles: [
    {
      name: "Form builder",
      description: "Build and distribute forms: folders, forms, questions, share links, webhooks and notification rules; read responses and answers.",
      permissions: [
        { collection: "form_folders", action: "read" },
        { collection: "form_folders", action: "create" },
        { collection: "form_folders", action: "update" },
        { collection: "forms", action: "read" },
        { collection: "forms", action: "create" },
        { collection: "forms", action: "update" },
        { collection: "questions", action: "read" },
        { collection: "questions", action: "create" },
        { collection: "questions", action: "update" },
        { collection: "questions", action: "delete" },
        { collection: "share_links", action: "read" },
        { collection: "share_links", action: "create" },
        { collection: "share_links", action: "update" },
        { collection: "webhooks", action: "read" },
        { collection: "webhooks", action: "create" },
        { collection: "webhooks", action: "update" },
        { collection: "notification_rules", action: "read" },
        { collection: "notification_rules", action: "create" },
        { collection: "notification_rules", action: "update" },
        { collection: "responses", action: "read" },
        { collection: "answers", action: "read" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Forms overview",
      description: "Response volume, form health and distribution.",
      panels: [
        { name: "Forms", kind: "items-aggregate", viz: "counter", config: { collection: "forms", agg: "count" } },
        { name: "Responses", kind: "items-aggregate", viz: "counter", config: { collection: "responses", agg: "count" } },
        { name: "Share links", kind: "items-aggregate", viz: "counter", config: { collection: "share_links", agg: "count" } },
        { name: "Responses by status", kind: "items-aggregate", viz: "donut", config: { collection: "responses", agg: "count", groupBy: "status" } },
        { name: "Forms by status", kind: "items-aggregate", viz: "donut", config: { collection: "forms", agg: "count", groupBy: "status" } },
        { name: "Questions by type", kind: "items-aggregate", viz: "bars", config: { collection: "questions", agg: "count", groupBy: "type" } },
      ],
    },
  ],
  /**
   * The rules a forms team runs on, already running.
   *
   * Deliberately absent: "a notification rule says to email this address, so
   * email it". The rule lives on `notification_rules` — a different row from
   * the response that just arrived — and a flow's `data` is the response, which
   * cannot join. A `foreach` over the rules would run them for every form at
   * once, which is a different automation and a worse one. So the arrival is
   * announced in the feed and the routing stays where the rules are.
   *
   * Deliberately absent too: anything that reads an ANSWER. A response's
   * answers are rows in `answers`, so "notify when the rating is 1 or 2" —
   * which is what `notification_rules.condition` is for — cannot be evaluated
   * by a flow holding the response. Saying that plainly is better than a rule
   * that looks like it filters and does not.
   */
  flows: [
    {
      name: "Tell the team when a response lands",
      trigger: "event:items:responses:created",
      operations: [
        {
          // Two voices from one flow: a partial is a form somebody abandoned
          // half-way, which is a different problem from a completed one and
          // reads differently in a feed.
          type: "condition",
          filter: { status: { _eq: "partial" } },
          then: [
            {
              type: "notification",
              title: "A response was abandoned half-way",
              body: "Started on {{ data.form.name }} and never finished. Worth checking whether a question is doing the stopping.",
              url: "/collections/responses",
            },
          ],
          else: [
            {
              type: "notification",
              title: "New response: {{ data.form.name }}",
              body: "Submitted by {{ data.email }}. The answers are on the response.",
              url: "/collections/responses",
            },
          ],
        },
      ],
    },
    {
      name: "Say when a share link has been used up",
      trigger: "event:items:share_links:updated",
      operations: [
        {
          // `$field.` compares two columns of the SAME row, which is the one
          // cross-column question a flow can actually answer — both values are
          // on the link. A link at its cap still resolves and still answers,
          // so nobody finds out until a respondent is turned away.
          //
          // The `max_responses` guard is load-bearing, not decoration. The
          // matcher coerces with `Number()` and `Number(null)` is 0, so on an
          // UNCAPPED link `responses_used >= $field.max_responses` reads as
          // `>= 0` — true for every link that ever gets touched. `_gt: 0` also
          // rules out a cap of zero, which is a closed link rather than a full
          // one and has nothing to announce.
          type: "condition",
          filter: {
            max_responses: { _gt: 0 },
            responses_used: { _gte: "$field.max_responses" },
            active: { _eq: true },
          },
          then: [
            {
              type: "notification",
              title: "A share link has hit its response cap",
              body: "{{ data.responses_used }} of {{ data.max_responses }} used on {{ data.form.name }}. Raise the cap or issue a new link.",
              url: "/collections/share_links",
            },
          ],
        },
      ],
    },
    {
      name: "Warn a week before a share link expires",
      // Once per link, seven days out, and only for links still in play — an
      // expiry that passes quietly is a campaign that stops collecting without
      // anybody deciding it should.
      trigger: `schedule:${JSON.stringify({
        collection: "share_links",
        field: "expires_at",
        offset: { value: 7, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { active: { _eq: true } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "A share link expires in a week",
          body: "The link for {{ data.form.name }} stops working on {{ data.expires_at }}. Extend it, or let it lapse on purpose.",
          url: "/collections/share_links",
        },
      ],
    },
    {
      name: "Retire share links the morning after they expire",
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "share_links",
          filter: { expires_at: { _lt: "$now" }, active: { _eq: true } },
          do: [
            {
              type: "item.update",
              collection: "share_links",
              id: "{{ $item.id }}",
              data: { active: false },
            },
          ],
        },
      ],
    },
    {
      name: "Thank a respondent for their answers (needs email)",
      // Off until a transport is configured. Addressed to the address on the
      // response itself, so it works for an anonymous respondent who typed one
      // and stays silent for one who did not.
      active: false,
      trigger: "event:items:responses:created",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "complete" }, email: { _nempty: true } },
          then: [
            {
              type: "email",
              to: "{{ data.email }}",
              subject: "Thanks for answering {{ data.form.name }}",
              html: "<p>Your answers are in — thank you for taking the time.</p>",
            },
          ],
        },
      ],
    },
    {
      name: "Monthly forms report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Forms overview",
          subject: "Forms — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "form_response_receipt",
      name: "Response receipt",
      description: "Confirmation of one submitted response.",
      filename: "response-{{ data.id }}",
      variables: ["email", "status"],
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
        "<h1>{{ data.form.name }}</h1>" +
        '<p class="muted">Response receipt</p>' +
        "<table>" +
        "<tr><th>Submitted by</th><td>{{ data.email }}</td></tr>" +
        "<tr><th>Submitted at</th><td>{{ data.submitted_at }}</td></tr>" +
        "<tr><th>State</th><td>{{ data.status }}</td></tr>" +
        "</table>" +
        "<!-- the answers themselves live in `answers`, one row per question; " +
        "fill them from your own query or a foreach -->" +
        '<p class="muted">Keep this for your records.</p>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "form_summary_sheet",
      name: "Form summary",
      description: "The one page a form is reviewed over before it goes out.",
      filename: "form-{{ data.slug }}",
      variables: ["name", "status"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.name }}</h1>" +
        '<p class="muted">{{ data.description }}</p>' +
        "<table>" +
        "<tr><th>State</th><td>{{ data.status }}</td></tr>" +
        "<tr><th>Responses</th><td>{{ data.response_count }}</td></tr>" +
        "<tr><th>Multiple submissions</th><td>{{ data.allow_multiple }}</td></tr>" +
        "<tr><th>Requires login</th><td>{{ data.requires_login }}</td></tr>" +
        "</table>" +
        '<p class="muted">{{ data.submit_message }}</p>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  /*
   * No bundled public form, and this is the one vertical where that is the
   * point rather than an omission.
   *
   * A backlex form writes ONE row into ONE collection. The row a submission
   * would have to become here is a `responses` row, and the thing that makes it
   * mean anything is its `form` relation — which is not a form-eligible field,
   * so a public form cannot set it. Every submission would land unattached to
   * any survey, which is a row nobody can read.
   *
   * The deeper reason is worth saying too: this template MODELS a form builder.
   * Bundling backlex's own public form on top of it would put two answers to
   * the same question in one workspace and leave an operator guessing which one
   * their respondents are filling in.
   */
  agents: [
    {
      name: "Survey analyst",
      handle: "survey-analyst",
      description: "Answers questions about response volume and where forms lose people.",
      systemPrompt:
        "You help a team read its own survey results. Answer questions about " +
        "forms, questions, responses and answers using the workspace's own " +
        "data. A response is `complete` or `partial`, and the two are never " +
        "added together — a completion rate is completes over all responses, " +
        "and you should say both numbers. An answer's `value` is stored as " +
        "text whatever the question's type, so a rating is the string \"5\": " +
        "read the question's `type` before treating a value as a number, and " +
        "say when a set of answers is too small to average. Questions belong " +
        "to a form and carry a position, so \"where do people drop out\" is a " +
        "question about the last position answered. Be brief, name the form " +
        "you mean, and say plainly when the data does not answer the question.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
