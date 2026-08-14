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
};
