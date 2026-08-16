import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, divider, email, flag, half, hint, image, int, ms, notes, parent, position, rel, relMany, sec, select, slugField, stacked, tabbed, text, url, when } from "../dsl";

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
          ...half(text("sender_name", { label: "From name" }), email("sender_email", { label: "From address", conditions: [when("status", "_eq", "active", "required")] })),
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
      kanbanGroupBy: "_status",
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
      kanbanGroupBy: "status",
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
          flag("active"),
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
  /**
   * The rules an editorial desk runs on, already running.
   *
   * Deliberately absent: "the post names a newsletter, so send it to that
   * list". Who is ON a list is `subscribers.newsletters` — a `relation_many`
   * held on the OTHER side — and a flow's `data` is the post row, which cannot
   * join. The step that would compile is a `foreach` over every subscriber,
   * which mails the whole audience regardless of which list the post was for;
   * that is not the same automation, and it is the one mistake a mailing list
   * never recovers from. So the flow below proofs the issue to the list's own
   * from-address and leaves the send where the audience is.
   *
   * Deliberately absent too: anything counted from a date. The only declared
   * timestamp in this template is `subscribers.subscribed_at`, and nothing
   * fills it — a `schedule:` trigger on it would fire for the seeded rows and
   * never once for a real signup, which is worse than not shipping it. The
   * welcome below rides the row arriving instead.
   */
  flows: [
    {
      name: "Tell the desk a comment is waiting for moderation",
      trigger: "event:items:comments:created",
      operations: [
        {
          // Gated rather than unconditional: an editor writing a reply straight
          // into the thread creates it already published, and a queue notice
          // for a comment nobody has to look at trains people to ignore the
          // ones that matter.
          type: "condition",
          filter: { status: { _eq: "pending" } },
          then: [
            {
              type: "notification",
              title: "A comment is waiting: {{ data.author_name }}",
              body: "“{{ data.body }}” — approve it, hide it, or mark it as spam.",
              url: "/collections/comments",
            },
          ],
        },
      ],
    },
    {
      name: "Announce a post going live, and flag what it is missing",
      // `published`, not `updated` with a condition on the state. The publish
      // action emits its own event — from the item route and from the
      // scheduled-publish tick alike — so this fires ONCE on the move. An
      // `updated` trigger sees the row as it now stands with no before-image,
      // so it cannot tell "just went live" from "was corrected while live",
      // and would repeat the whole check on every typo fix.
      trigger: "event:items:posts:published",
      operations: [
        {
          type: "notification",
          title: "{{ data.title }} is live",
          body: "Published at /{{ data.slug }}. Share it, and keep an eye on the comments for a day.",
          url: "/collections/posts",
        },
        {
          type: "condition",
          filter: { seo_description: { _empty: true } },
          then: [
            {
              type: "notification",
              title: "{{ data.title }} went live with no meta description",
              body: "Search engines will scrape one out of the body instead. Write it on the post's SEO tab.",
              url: "/collections/posts",
            },
          ],
        },
        {
          // Both halves are checked on purpose: a post with no featured image
          // is not missing its alt text, and a rule that said so would be
          // wrong on every text-only post the desk publishes.
          type: "condition",
          filter: { cover: { _nempty: true }, cover_alt: { _empty: true } },
          then: [
            {
              type: "notification",
              title: "{{ data.title }} has a featured image and no alt text",
              body: "Screen readers and search engines both read that field. One line describing the picture is enough.",
              url: "/collections/posts",
            },
          ],
        },
      ],
    },
    {
      name: "Draft a redirect when a post is pulled from publication",
      // `archived`, not `unpublished`. Both take a post off the site, but
      // unpublishing is a routine editing move a post comes straight back
      // from — and `from_path` is unique, so a redirect drafted on every
      // unpublish would fail the second time the same post came down.
      // Archiving is the state that means "pulled from publication", which is
      // exactly when a live URL is left with nowhere to go.
      trigger: "event:items:posts:archived",
      operations: [
        {
          // `to_path` is the blog home rather than a guess at a successor: the
          // flow holds the post row and nothing else, so it cannot know what
          // replaced it. `active: false` keeps the rule out of the routing
          // table until an editor points it somewhere and switches it on.
          type: "item.create",
          collection: "redirects",
          data: {
            from_path: "/{{ data.slug }}",
            to_path: "/",
            permanent: true,
            active: false,
          },
        },
        {
          type: "notification",
          title: "{{ data.title }} was pulled — its URL needs somewhere to go",
          body: "A permanent redirect from /{{ data.slug }} is drafted and switched off. Point it at whatever supersedes the post, then turn it on.",
          url: "/collections/redirects",
        },
      ],
    },
    {
      name: "Send the newsletter issue proof for review when a post goes live (needs email + a PDF renderer)",
      // Off until both are configured — the name carries the prerequisite so
      // nobody has to open the flow to find out why it is quiet.
      active: false,
      trigger: "event:items:posts:published",
      operations: [
        {
          // Only for the posts that were actually queued to a list. A post
          // with no `newsletter` is a web-only piece, and proofing an issue
          // nobody is going to send is noise in somebody's inbox.
          type: "condition",
          filter: { newsletter: { _nempty: true } },
          then: [
            { type: "document.render", templateKey: "newsletter_issue" },
            {
              type: "email",
              to: "{{ data.newsletter.sender_email }}",
              subject: "Issue proof — {{ data.title }}",
              html: "<p>This post is queued to a newsletter. The issue proof is attached — read it, then send it from the Subscribers list.</p>",
              attach: ["{{ $last.key }}"],
            },
          ],
        },
      ],
    },
    {
      name: "Welcome a new subscriber (needs email)",
      active: false,
      // On the row arriving rather than counted from `subscribed_at`: that
      // column is typed in by the desk, so a signup through the public form
      // leaves it empty and a date-counted welcome would never reach the
      // people it exists for.
      trigger: "event:items:subscribers:created",
      operations: [
        {
          type: "condition",
          filter: { status: { _neq: "unsubscribed" } },
          then: [
            {
              type: "email",
              to: "{{ data.email }}",
              subject: "Thanks for subscribing",
              html:
                "<p>Hello {{ data.name }},</p>" +
                "<p>You are on the list. Every issue lands in this inbox — reply to any of them, a person reads it.</p>",
            },
          ],
        },
      ],
    },
    {
      name: "Monthly content report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Content overview",
          subject: "Content — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "post_proof",
      name: "Post proof",
      description: "The post on one printable page, for a last read-through or a sign-off.",
      filename: "post-{{ data.slug }}",
      variables: ["title", "body"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:24px;margin:0 0 6px;line-height:1.25}" +
        ".muted{color:#666;font-size:11px}" +
        ".lede{font-size:15px;color:#333;margin:14px 0 18px}" +
        "hr{border:0;border-top:1px solid #e5e5e5;margin:18px 0}" +
        "img{max-width:100%}" +
        "table{width:100%;border-collapse:collapse;margin-top:8px}" +
        "th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #eee;font-size:11px}" +
        "th{width:32%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">{{ data.author.name }} · {{ data.category.name }} · ' +
        "{{ data.reading_minutes }} min read · /{{ data.slug }}</p>" +
        '<p class="lede">{{ data.excerpt }}</p>' +
        "<hr>" +
        "<div>{{ data.body }}</div>" +
        "<hr>" +
        '<p class="muted">Checked before publishing:</p>' +
        "<table>" +
        "<tr><th>SEO title</th><td>{{ data.seo_title }}</td></tr>" +
        "<tr><th>Meta description</th><td>{{ data.seo_description }}</td></tr>" +
        "<tr><th>Featured image alt</th><td>{{ data.cover_alt }}</td></tr>" +
        "<tr><th>Canonical URL</th><td>{{ data.canonical_url }}</td></tr>" +
        "<tr><th>Hidden from search</th><td>{{ data.noindex }}</td></tr>" +
        "<tr><th>Who can read it</th><td>{{ data.visibility }}</td></tr>" +
        "</table>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "newsletter_issue",
      name: "Newsletter issue",
      description: "The post laid out as the issue subscribers receive — proofed before it goes out.",
      filename: "issue-{{ data.slug }}",
      variables: ["title", "body"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:14px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:620px}" +
        ".from{font-size:11px;color:#888;letter-spacing:.05em;text-transform:uppercase;margin:0}" +
        "h1{font-size:22px;margin:10px 0 4px;line-height:1.3}" +
        ".lede{color:#444;margin:0 0 20px}" +
        "img{max-width:100%}" +
        ".foot{margin-top:28px;border-top:1px solid #e5e5e5;padding-top:12px;font-size:11px;color:#888}" +
        "</style></head><body>" +
        '<p class="from">{{ data.newsletter.sender_name }} · {{ data.newsletter.sender_email }}</p>' +
        "<h1>{{ data.title }}</h1>" +
        '<p class="lede">{{ data.excerpt }}</p>' +
        "<div>{{ data.body }}</div>" +
        "<!-- The recipients are the subscribers whose `newsletters` include " +
        "this post's list. That is a many-to-many the render cannot walk, so " +
        "this page is the PROOF, not the send. -->" +
        '<p class="foot">Read it on the site at /{{ data.slug }}.<br>' +
        "You are getting this because you subscribed to " +
        "{{ data.newsletter.name }}. Unsubscribe any time.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "18mm" },
    },
  ],
  forms: [
    {
      // Which list a signup lands on is deliberately not on the form: the link
      // is a `relation_many`, which is never form-eligible, and letting an
      // outsider pick their own lists is a decision the desk owns anyway —
      // `newsletters.subscribe_on_signup` is where it is made.
      name: "Newsletter signup",
      collection: "subscribers",
      settings: {
        submitLabel: "Subscribe",
        successMessage: "You're on the list — the next issue will land in your inbox.",
      },
      fields: [
        { name: "name", label: "Your name", help: "Optional — it only ever appears in the greeting." },
        { name: "email", label: "Email address" },
      ],
    },
    {
      // Lands as an author profile rather than in an applicant table, because
      // there is no applicant table and inventing one would be a collection
      // this vertical never otherwise needs. The desk keeps the profile or
      // deletes it; nothing an applicant fills in reaches the site until a
      // post is assigned to them. `name` is exposed because the schema
      // requires it — a required field left off the form fails the whole apply.
      name: "Contributor application",
      collection: "authors",
      settings: {
        submitLabel: "Apply to write",
        successMessage: "Thanks — the editors read every pitch and reply within a fortnight.",
      },
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Email address" },
        { name: "bio", label: "About you", help: "A short paragraph, and what you'd like to write about." },
        { name: "website", label: "Website or portfolio" },
        { name: "twitter", label: "Twitter / X handle" },
        { name: "location" },
      ],
    },
  ],
  agents: [
    {
      name: "Editorial assistant",
      handle: "editorial-assistant",
      description: "Answers questions about what is published, what is waiting, and what the audience is doing with it.",
      systemPrompt:
        "You help an editorial desk read its own site. Answer questions about " +
        "posts, pages, comments, authors and subscribers using the " +
        "workspace's own data. Two fields decide whether a post is out: " +
        "`_status` is the publishing state (draft, published, archived) and " +
        "`visibility` is who may read it once live — never collapse them, a " +
        "published members-only post is live. A comment counts as being on " +
        "the site only while its status is published; pending, hidden and " +
        "spam are all off it. Rank a moderation backlog oldest first. The " +
        "subscriber engagement counters are typed in by the desk rather than " +
        "measured, so treat them as a floor and say so when you quote one. " +
        "Name a post by its title and its slug, so the person reading you can " +
        "find it. Be brief and specific, and say plainly when the data does " +
        "not answer the question.",
      tools: [
        "collections.list",
        "collections.read",
        "collections.aggregate",
        "collections.search",
        "dashboards.run",
      ],
      maxSteps: 8,
    },
  ],
};
