import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, divider, email, half, hint, image, int, ms, notes, parent, position, rel, relMany, sec, select, slugField, stacked, tabbed, text, url } from "../dsl";

export const blog: SchemaTemplate = {
  id: "blog",
  label: "Blog / CMS",
  groups: ["Content", "Taxonomy", "People", "Audience"],
  description: "WordPress-grade content: posts & pages with SEO, categories, tags, authors, media, comments and a newsletter audience.",
  collections: [
    {
      slug: "media", group: "Content", singular: "Media", plural: "Media",
      fields: [
        image("file"),
        text("alt", { label: "Alt text", description: "Describes the image for screen readers and search engines." }),
        text("caption"),
        ...half(int("width", { label: "Width (px)" }), int("height", { label: "Height (px)" })),
      ],
    },
    {
      slug: "authors", group: "People", singular: "Author", plural: "Authors", defaultSort: "name",
      fields: stacked(
        sec("Profile", [
          ...half(text("name", { required: true }), slugField("name")),
          notes("bio"),
          image("avatar"),
        ]),
        sec("Contact & links", [
          ...half(email("email"), url("website")),
          ...half(text("twitter", { label: "Twitter / X handle" }), text("location")),
        ]),
      ),
      samples: [
        { name: "Ada Lovelace", slug: "ada-lovelace", bio: "Writes about engineering and the craft of building software.", email: "ada@example.com", location: "London, UK" },
        { name: "Grace Hopper", slug: "grace-hopper", bio: "Product notes, release walkthroughs and the occasional rant.", email: "grace@example.com", location: "New York, US" },
      ],
    },
    {
      slug: "categories", group: "Taxonomy", singular: "Category", plural: "Categories", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), slugField("name")),
        notes("description"),
        ...half(parent("categories"), text("color", { interface: "color" })),
      ],
      samples: [
        { name: "Engineering", slug: "engineering", color: C.blue },
        { name: "Product", slug: "product", color: C.purple },
      ],
    },
    {
      slug: "tags", group: "Taxonomy", singular: "Tag", plural: "Tags", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), slugField("name")),
        notes("description"),
        ...half(
          text("color", { interface: "color", label: "Accent color" }),
          select("visibility", [ch("public", C.green), ch("internal", C.gray)], {
            default: "public", label: "Visibility",
            description: "Internal tags organize the desk but never render on the site.",
          }),
        ),
      ],
      samples: [{ name: "Release", slug: "release", visibility: "public" }, { name: "Tutorial", slug: "tutorial", visibility: "public" }],
    },
    {
      slug: "newsletters", group: "Audience", singular: "Newsletter", plural: "Newsletters", defaultSort: "position",
      note: "Email lists a post can be sent to.",
      fields: stacked(
        sec("Newsletter", [
          ...half(text("name", { required: true }), slugField("name")),
          notes("description"),
          ...half(
            select("status", [ch("active", C.green), ch("archived", C.gray)], { default: "active" }),
            position(),
          ),
        ]),
        sec("Sender", [
          ...half(text("sender_name", { label: "From name" }), email("sender_email", { label: "From address" })),
          bool("subscribe_on_signup", { default: true, label: "Subscribe new members automatically" }),
        ]),
      ),
      samples: [
        { name: "Weekly digest", slug: "weekly-digest", description: "One email a week with everything we published.", status: "active", position: 1, sender_name: "The Editors", sender_email: "hello@example.com", subscribe_on_signup: true },
        { name: "Product releases", slug: "product-releases", description: "Sent whenever we ship something notable.", status: "active", position: 2, sender_name: "Product", sender_email: "product@example.com", subscribe_on_signup: false },
      ],
    },
    {
      slug: "subscribers", group: "Audience", singular: "Subscriber", plural: "Subscribers", defaultSort: "-created_at",
      fields: stacked(
        sec("Subscriber", [
          ...half(text("name"), email("email", { required: true, unique: true })),
          ...half(
            select("status", [ch("free", C.blue), ch("comped", C.purple), ch("paid", C.green), ch("unsubscribed", C.gray)], { default: "free" }),
            date("subscribed_at", { label: "Subscribed on" }),
          ),
          relMany("newsletters", "newsletters", { label: "Subscribed lists" }),
        ]),
        sec("Engagement", [
          ...half(
            int("email_count", { default: 0, label: "Emails received" }),
            int("email_opened_count", { default: 0, label: "Emails opened" }),
          ),
          notes("note", { label: "Internal note" }),
        ], { folded: true }),
      ),
      samples: [
        { name: "Alan Turing", email: "alan@example.com", status: "paid", subscribed_at: ms("2026-01-12T09:00:00Z"), email_count: 24, email_opened_count: 19 },
        { name: "Katherine Johnson", email: "katherine@example.com", status: "free", subscribed_at: ms("2026-03-02T14:30:00Z"), email_count: 9, email_opened_count: 7 },
      ],
    },
    {
      slug: "posts", group: "Content", singular: "Post", plural: "Posts", ownerScoped: true, versioned: true, vectorize: true, fts: true,
      defaultSort: "-_published_at",
      fields: tabbed(
        sec("Content", [
          text("title", { required: true, vectorize: true, searchable: true }),
          slugField("title"),
          { name: "excerpt", type: "longtext", interface: "textarea", vectorize: true, searchable: true, description: "Shown on index pages and in the newsletter preview." },
          { name: "body", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
          divider("cover", "Featured image"),
          image("cover"),
          text("cover_alt", { label: "Featured image alt text" }),
        ]),
        sec("Organize", [
          ...half(rel("author", "authors"), rel("category", "categories")),
          relMany("tags", "tags"),
          ...half(
            {
              name: "featured", type: "boolean", interface: "toggle", default: false,
              label: "Featured post", description: "Pin this post to the top of the blog home page.",
            },
            { name: "reading_minutes", type: "integer", default: 0, label: "Reading time (min)" },
          ),
        ]),
        sec("Audience", [
          hint("posts_publish", "Publishing is handled by the Publish action on this record — these settings only control who may read it once live."),
          ...half(
            select("visibility", [ch("public", C.green), ch("members", C.blue), ch("paid", C.purple)], {
              default: "public", label: "Who can read this",
            }),
            rel("newsletter", "newsletters", { label: "Send to newsletter" }),
          ),
        ]),
        sec("SEO", [
          text("seo_title", { label: "SEO title" }),
          notes("seo_description", { label: "SEO description" }),
          image("og_image", { label: "Social share image" }),
          ...half(
            url("canonical_url", { label: "Canonical URL", description: "Set when this post was first published elsewhere." }),
            bool("noindex", { default: false, label: "Hide from search engines" }),
          ),
        ]),
      ),
      samples: [
        {
          title: "Hello, world", slug: "hello-world",
          excerpt: "Our very first post.", body: "Welcome to the blog. This is the first post.",
          author: { ref: "authors:0" }, category: { ref: "categories:0" }, reading_minutes: 3, visibility: "public",
        },
        {
          title: "Shipping the v1", slug: "shipping-the-v1",
          excerpt: "What changed in the first release.", body: "A walkthrough of everything in v1.",
          author: { ref: "authors:1" }, category: { ref: "categories:1" }, featured: true, reading_minutes: 6, visibility: "public",
        },
      ],
    },
    {
      slug: "pages", group: "Content", singular: "Page", plural: "Pages", versioned: true, fts: true, defaultSort: "title",
      fields: stacked(
        sec("Content", [
          ...half(text("title", { required: true, searchable: true }), slugField("title")),
          { name: "body", type: "longtext", interface: "richtext", searchable: true },
        ]),
        sec("SEO", [
          text("seo_title", { label: "SEO title" }),
          notes("seo_description", { label: "SEO description" }),
          ...half(
            url("canonical_url", { label: "Canonical URL" }),
            bool("noindex", { default: false, label: "Hide from search engines" }),
          ),
        ], { folded: true }),
      ),
      samples: [{ title: "About", slug: "about", body: "About this site." }, { title: "Contact", slug: "contact", body: "Get in touch." }],
    },
    {
      slug: "comments", group: "Content", singular: "Comment", plural: "Comments", defaultSort: "-created_at", displayTemplate: "{{author_name}}",
      note: "Reader replies awaiting moderation.",
      fields: stacked(
        sec("Comment", [
          ...half(rel("post", "posts", { required: true, onDelete: "cascade" }), rel("subscriber", "subscribers", { label: "Member" })),
          ...half(text("author_name"), email("author_email")),
          notes("body", { required: true }),
          rel("parent", "comments", { label: "In reply to", onDelete: "cascade" }),
        ]),
        sec("Moderation", [
          ...half(
            select("status", [ch("published", C.green), ch("pending", C.amber), ch("hidden", C.gray), ch("spam", C.red)], { default: "pending" }),
            int("likes_count", { default: 0, label: "Likes" }),
          ),
        ]),
      ),
      samples: [
        { post: { ref: "posts:0" }, author_name: "Alan Turing", author_email: "alan@example.com", body: "Great first post — looking forward to more.", status: "published", likes_count: 3 },
        { post: { ref: "posts:1" }, author_name: "Katherine Johnson", author_email: "katherine@example.com", body: "Any chance of a deeper dive on the migration?", status: "pending" },
      ],
    },
    {
      slug: "redirects", group: "Content", singular: "Redirect", plural: "Redirects", defaultSort: "from_path",
      note: "301/302 rules kept when URLs change.",
      fields: [
        ...half(
          text("from_path", { required: true, unique: true, label: "From path", description: "Path only, e.g. /old-post." }),
          text("to_path", { required: true, label: "To path or URL" }),
        ),
        ...half(
          bool("permanent", { default: true, label: "Permanent (301)" }),
          bool("active", { default: true }),
        ),
      ],
      samples: [
        { from_path: "/hello", to_path: "/hello-world", permanent: true, active: true },
        { from_path: "/v1", to_path: "/shipping-the-v1", permanent: true, active: true },
      ],
    },
  ],
  roles: [
    {
      name: "Editor",
      description: "Create and edit content; publish posts and pages.",
      permissions: [
        { collection: "posts", action: "read" },
        { collection: "posts", action: "create" },
        { collection: "posts", action: "update" },
        { collection: "posts", action: "publish" },
        { collection: "pages", action: "read" },
        { collection: "pages", action: "create" },
        { collection: "pages", action: "update" },
        { collection: "pages", action: "publish" },
        { collection: "media", action: "read" },
        { collection: "media", action: "create" },
        { collection: "media", action: "update" },
        { collection: "categories", action: "read" },
        { collection: "tags", action: "read" },
        { collection: "authors", action: "read" },
        { collection: "comments", action: "read" },
        { collection: "comments", action: "update" },
        { collection: "comments", action: "delete" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Content overview",
      description: "Publishing volume, draft flow and audience at a glance.",
      panels: [
        { name: "Posts", kind: "items-aggregate", viz: "counter", config: { collection: "posts", agg: "count" } },
        { name: "Pages", kind: "items-aggregate", viz: "counter", config: { collection: "pages", agg: "count" } },
        { name: "Subscribers", kind: "items-aggregate", viz: "counter", config: { collection: "subscribers", agg: "count" } },
        { name: "Posts by status", kind: "items-aggregate", viz: "donut", config: { collection: "posts", agg: "count", groupBy: "_status" } },
        { name: "Comments by status", kind: "items-aggregate", viz: "donut", config: { collection: "comments", agg: "count", groupBy: "status" } },
      ],
    },
  ],
};
