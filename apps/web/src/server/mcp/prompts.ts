/**
 * MCP prompts surface. Starter templates that help an agent reason about
 * the workspace without the user having to write the priming themselves.
 * Each template renders a single user message (no system/assistant turns)
 * with argument values interpolated.
 *
 * Tool sub-fetches happen INSIDE prompts that need live data (e.g.
 * `describe_collection` reads the collection schema first so the prompt
 * arrives self-contained). That follows the same `fetchInternal` pattern
 * as tools — permissions and tenant isolation are preserved.
 */
import type { ToolCtx } from "./types";
import { readJson } from "./internal-fetch";

export interface McpPromptDescriptor {
  name: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface McpPromptResponse {
  description?: string;
  messages: McpPromptMessage[];
}

const PROMPTS: McpPromptDescriptor[] = [
  {
    name: "describe_collection",
    description:
      "Walk through a collection's schema + a few sample rows and produce a " +
      "short, plain-language description of what it appears to store and how " +
      "it would be used.",
    arguments: [
      { name: "collection", description: "Collection slug.", required: true },
    ],
  },
  {
    name: "generate_queries",
    description:
      "Given a collection's schema, propose 3-5 useful Directus-shaped " +
      "`filter` queries an analyst might run, with a one-line rationale each.",
    arguments: [
      { name: "collection", description: "Collection slug.", required: true },
      {
        name: "intent",
        description:
          "Optional free-text framing (`recent inventory issues`, `top-spending customers this quarter`, …).",
        required: false,
      },
    ],
  },
  {
    name: "permission_rule",
    description:
      "Translate an English access-control sentence into a backlex " +
      "permissions DSL condition + fields allow-list.",
    arguments: [
      { name: "collection", description: "Collection slug.", required: true },
      {
        name: "intent",
        description:
          "What you want the role to be able to do (`see only their own orders`, `read everything but no PII`, …).",
        required: true,
      },
    ],
  },
];

export const listPrompts = (): { prompts: McpPromptDescriptor[] } => ({
  prompts: PROMPTS,
});

interface CollectionMeta {
  slug: string;
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  fields: Array<{ name: string; type: string; required?: boolean; to?: string }>;
}

const renderCollectionContext = async (
  ctx: ToolCtx,
  slug: string,
  withSample: boolean,
): Promise<string> => {
  const metaRes = await ctx.fetchInternal(`/api/collections/${encodeURIComponent(slug)}`);
  const meta = await readJson<{ data: CollectionMeta }>(metaRes);
  const fieldLines = (meta.data.fields ?? []).map((f) => {
    const flags = [
      f.required ? "required" : null,
      f.to ? `→ ${f.to}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `  - ${f.name}: ${f.type}${flags ? ` (${flags})` : ""}`;
  });
  const note = meta.data.note ? `\nNote: ${meta.data.note}\n` : "";
  let sampleBlock = "";
  if (withSample) {
    try {
      const sampleRes = await ctx.fetchInternal(
        `/api/items/${encodeURIComponent(slug)}?limit=3`,
      );
      const sampleBody = await readJson<{ data: unknown[] }>(sampleRes);
      sampleBlock = `\n\nSample rows (first 3):\n\`\`\`json\n${JSON.stringify(sampleBody.data, null, 2)}\n\`\`\``;
    } catch {
      sampleBlock = `\n\n(Sample rows unavailable — collection may be empty or read-restricted.)`;
    }
  }
  return (
    `Collection: \`${meta.data.slug}\`` +
    (meta.data.plural ? ` (${meta.data.plural})` : "") +
    `\n${note}\nFields:\n${fieldLines.join("\n")}${sampleBlock}`
  );
};

const requireArg = (args: Record<string, unknown> | undefined, name: string): string => {
  const v = args?.[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`prompt argument "${name}" is required`);
  }
  return v;
};

export const getPrompt = async (
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<McpPromptResponse> => {
  const descriptor = PROMPTS.find((p) => p.name === name);
  if (!descriptor) {
    throw new Error(`unknown prompt: ${name}`);
  }

  switch (name) {
    case "describe_collection": {
      const slug = requireArg(args, "collection");
      const context = await renderCollectionContext(ctx, slug, true);
      const text =
        `${context}\n\n` +
        `Using the schema and sample rows above, describe in 2-3 sentences ` +
        `what the \`${slug}\` collection stores and the typical use case it ` +
        `supports. Call out any fields whose purpose is non-obvious. Avoid ` +
        `restating the schema verbatim.`;
      return {
        description: descriptor.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    }

    case "generate_queries": {
      const slug = requireArg(args, "collection");
      const intent = typeof args?.intent === "string" ? args.intent : "";
      const context = await renderCollectionContext(ctx, slug, false);
      const intentLine = intent
        ? `\n\nFocus on this user intent: "${intent}".`
        : "";
      const text =
        `${context}\n\n` +
        `Propose 3-5 useful queries against \`${slug}\`. Format each as JSON ` +
        `(Directus-shaped \`filter\` + optional \`sort\` / \`limit\`) in a ` +
        `fenced code block, followed by a one-line rationale. Don't invent ` +
        `field names — use only the fields above.${intentLine}`;
      return {
        description: descriptor.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    }

    case "permission_rule": {
      const slug = requireArg(args, "collection");
      const intent = requireArg(args, "intent");
      const context = await renderCollectionContext(ctx, slug, false);
      const text =
        `${context}\n\n` +
        `Translate this access-control intent into a backlex permissions ` +
        `DSL condition and (optionally) a field allow-list:\n\n` +
        `Intent: "${intent}"\n\n` +
        `Output exactly two JSON blocks in fenced code blocks:\n` +
        `1. A \`condition\` object using \`_eq\`, \`_neq\`, \`_in\`, \`_lt\`, ` +
        `\`_gt\`, \`_and\`, \`_or\`, \`_not\`, and the variables \`$user.id\`, ` +
        `\`$user.email\`, \`$user.roles\`, \`$tenant.id\`, \`$now\`. Use ` +
        `\`null\` if no condition is needed (caller can read every row).\n` +
        `2. A \`fields\` array of field names. Use \`null\` to allow every ` +
        `field. Refer only to the fields above.\n\n` +
        `End with a one-sentence explanation of how the condition fulfils the intent.`;
      return {
        description: descriptor.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    }

    default:
      // Unreachable — descriptor lookup above filters unknown names.
      throw new Error(`unhandled prompt: ${name}`);
  }
};
