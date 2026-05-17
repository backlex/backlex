import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCwIcon, SearchIcon, SendIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Badge } from "@workeros/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workeros/ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import { Separator } from "@workeros/ui/components/separator";
import { ScrollArea } from "@workeros/ui/components/scroll-area";
import { cn } from "@workeros/ui/lib/utils";
import { PageHeader } from "@/components/page-header";
import { CodeEditor } from "@/components/code-editor-lazy";
import { JsonBlock } from "@/admin/ui";
import { api } from "@/lib/api";
import { notifyError } from "@/lib/error";

// ────────────────────────────────────────────────────────────────────────────
// OpenAPI 3.1 minimal types (only what we touch).
// ────────────────────────────────────────────────────────────────────────────

type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "options" | "head" | "trace";
const METHOD_ORDER: HttpMethod[] = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];

interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  example?: unknown;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  nullable?: boolean;
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
  example?: unknown;
}

interface OpenApiMediaType {
  schema?: OpenApiSchema;
  example?: unknown;
  examples?: Record<string, { value?: unknown; summary?: string }>;
}

interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>> & {
  parameters?: OpenApiParameter[];
  summary?: string;
  description?: string;
};

interface OpenApiDoc {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
  tags?: Array<{ name: string; description?: string }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Flattened endpoint shape used by the left tree + right pane.
// ────────────────────────────────────────────────────────────────────────────

interface Endpoint {
  id: string;
  method: HttpMethod;
  path: string;
  operation: OpenApiOperation;
  tag: string;
  inheritedParameters: OpenApiParameter[];
}

const flattenEndpoints = (doc: OpenApiDoc | null): Endpoint[] => {
  if (!doc?.paths) return [];
  const out: Endpoint[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item) continue;
    const inherited = item.parameters ?? [];
    for (const m of METHOD_ORDER) {
      const op = item[m];
      if (!op) continue;
      out.push({
        id: `${m.toUpperCase()} ${path}`,
        method: m,
        path,
        operation: op,
        tag: op.tags?.[0] ?? "untagged",
        inheritedParameters: inherited,
      });
    }
  }
  // Stable sort: tag → path → method index.
  out.sort((a, b) => {
    if (a.tag !== b.tag) return a.tag.localeCompare(b.tag);
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method);
  });
  return out;
};

// ────────────────────────────────────────────────────────────────────────────
// Method colour map. Pulled out so it's reused by the list + detail header.
// ────────────────────────────────────────────────────────────────────────────

const METHOD_STYLE: Record<HttpMethod, CSSProperties> = {
  get: {
    background: "oklch(0.94 0.04 240)",
    color: "oklch(0.42 0.16 240)",
    borderColor: "oklch(0.85 0.07 240)",
  },
  post: {
    background: "oklch(0.94 0.05 145)",
    color: "oklch(0.40 0.14 145)",
    borderColor: "oklch(0.85 0.08 145)",
  },
  patch: {
    background: "oklch(0.95 0.06 80)",
    color: "oklch(0.46 0.14 70)",
    borderColor: "oklch(0.86 0.10 80)",
  },
  put: {
    background: "oklch(0.94 0.05 305)",
    color: "oklch(0.44 0.16 305)",
    borderColor: "oklch(0.85 0.08 305)",
  },
  delete: {
    background: "oklch(0.94 0.05 28)",
    color: "oklch(0.46 0.18 28)",
    borderColor: "oklch(0.86 0.10 28)",
  },
  options: {
    background: "oklch(0.93 0.02 270)",
    color: "oklch(0.42 0.04 270)",
    borderColor: "oklch(0.85 0.03 270)",
  },
  head: {
    background: "oklch(0.93 0.02 270)",
    color: "oklch(0.42 0.04 270)",
    borderColor: "oklch(0.85 0.03 270)",
  },
  trace: {
    background: "oklch(0.93 0.02 270)",
    color: "oklch(0.42 0.04 270)",
    borderColor: "oklch(0.85 0.03 270)",
  },
};

const MethodBadge = ({
  method,
  size = "sm",
}: {
  method: HttpMethod;
  size?: "sm" | "md";
}) => {
  const style = METHOD_STYLE[method];
  return (
    <span
      className="font-mono inline-flex shrink-0 items-center justify-center rounded-md border tabular-nums"
      style={{
        ...style,
        fontSize: size === "md" ? 11 : 10,
        fontWeight: 600,
        letterSpacing: "0.04em",
        padding: size === "md" ? "3px 8px" : "2px 6px",
        minWidth: size === "md" ? 56 : 48,
      }}
    >
      {method.toUpperCase()}
    </span>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// $ref resolution + schema → example generation.
// ────────────────────────────────────────────────────────────────────────────

const resolveRef = (doc: OpenApiDoc | null, ref: string): OpenApiSchema | null => {
  if (!doc || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let node: unknown = doc;
  for (const p of parts) {
    if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[p];
    } else {
      return null;
    }
  }
  return (node as OpenApiSchema) ?? null;
};

const dereference = (
  doc: OpenApiDoc | null,
  schema: OpenApiSchema | undefined,
  seen: Set<string> = new Set(),
): OpenApiSchema | undefined => {
  if (!schema) return undefined;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { description: `(circular: ${schema.$ref})` };
    const resolved = resolveRef(doc, schema.$ref);
    if (!resolved) return { description: `(unresolved: ${schema.$ref})` };
    return dereference(doc, resolved, new Set([...seen, schema.$ref]));
  }
  // allOf: shallow-merge into a synthetic object schema so renderers see
  // a single tree of properties.
  if (schema.allOf && schema.allOf.length > 0) {
    const merged: OpenApiSchema = { ...schema, allOf: undefined };
    const props: Record<string, OpenApiSchema> = { ...(merged.properties ?? {}) };
    const required: string[] = [...(merged.required ?? [])];
    for (const sub of schema.allOf) {
      const d = dereference(doc, sub, seen);
      if (d?.properties) Object.assign(props, d.properties);
      if (d?.required) required.push(...d.required);
      if (d?.type && !merged.type) merged.type = d.type;
    }
    if (Object.keys(props).length > 0) merged.properties = props;
    if (required.length > 0) merged.required = Array.from(new Set(required));
    return merged;
  }
  return schema;
};

const exampleFromSchema = (
  doc: OpenApiDoc | null,
  schema: OpenApiSchema | undefined,
  depth = 0,
): unknown => {
  if (!schema || depth > 8) return null;
  const s = dereference(doc, schema);
  if (!s) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum && s.enum.length > 0) return s.enum[0];
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  // oneOf/anyOf: pick the first variant.
  if (!t && (s.oneOf || s.anyOf)) {
    const list = s.oneOf ?? s.anyOf ?? [];
    if (list.length > 0) return exampleFromSchema(doc, list[0], depth + 1);
  }
  switch (t) {
    case "string":
      if (s.format === "date-time") return new Date().toISOString();
      if (s.format === "date") return new Date().toISOString().slice(0, 10);
      if (s.format === "uuid") return "00000000-0000-0000-0000-000000000000";
      if (s.format === "email") return "user@example.com";
      return "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return s.items ? [exampleFromSchema(doc, s.items, depth + 1)] : [];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        out[k] = exampleFromSchema(doc, v, depth + 1);
      }
      return out;
    }
    default: {
      // Untyped but has properties → treat as object.
      if (s.properties) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(s.properties)) {
          out[k] = exampleFromSchema(doc, v, depth + 1);
        }
        return out;
      }
      return null;
    }
  }
};

const typeLabel = (s: OpenApiSchema | undefined): string => {
  if (!s) return "any";
  if (s.$ref) {
    const name = s.$ref.split("/").pop() ?? "ref";
    return name;
  }
  if (s.oneOf) return s.oneOf.map((x) => typeLabel(x)).join(" | ");
  if (s.anyOf) return s.anyOf.map((x) => typeLabel(x)).join(" | ");
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (!t) return s.properties ? "object" : "any";
  if (t === "array") return `${typeLabel(s.items)}[]`;
  if (s.format) return `${t} <${s.format}>`;
  return t;
};

// ────────────────────────────────────────────────────────────────────────────
// Schema tree (Request / Response panes).
// ────────────────────────────────────────────────────────────────────────────

const PropertyRow = ({
  name,
  schema,
  required,
  doc,
  depth,
}: {
  name: string;
  schema: OpenApiSchema | undefined;
  required: boolean;
  doc: OpenApiDoc | null;
  depth: number;
}) => {
  const s = dereference(doc, schema);
  const t = Array.isArray(s?.type) ? s?.type[0] : s?.type;
  const isObject = !!s?.properties || t === "object";
  const isArray = t === "array" && !!s?.items;
  return (
    <div
      className="border-b border-border/50 py-2 last:border-b-0"
      style={{ paddingLeft: depth * 14 }}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <code className="font-mono text-[12.5px] font-medium text-foreground">{name}</code>
        <code className="font-mono text-[11px] text-muted-foreground">{typeLabel(s)}</code>
        {required && (
          <Badge variant="outline" className="h-4 border-destructive/40 px-1.5 text-[9.5px] font-medium uppercase tracking-wide text-destructive">
            required
          </Badge>
        )}
        {s?.enum && s.enum.length > 0 && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            enum: {s.enum.map((e) => JSON.stringify(e)).join(", ")}
          </span>
        )}
      </div>
      {s?.description && (
        <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{s.description}</p>
      )}
      {s?.example !== undefined && (
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          example: <span className="text-foreground/70">{JSON.stringify(s.example)}</span>
        </p>
      )}
      {isObject && s?.properties && (
        <div className="mt-1">
          {Object.entries(s.properties).map(([childName, childSchema]) => (
            <PropertyRow
              key={childName}
              name={childName}
              schema={childSchema}
              required={!!s.required?.includes(childName)}
              doc={doc}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
      {isArray && (() => {
        const inner = dereference(doc, s?.items);
        if (inner?.properties) {
          return (
            <div className="mt-1">
              {Object.entries(inner.properties).map(([childName, childSchema]) => (
                <PropertyRow
                  key={childName}
                  name={`[].${childName}`}
                  schema={childSchema}
                  required={!!inner.required?.includes(childName)}
                  doc={doc}
                  depth={depth + 1}
                />
              ))}
            </div>
          );
        }
        return null;
      })()}
    </div>
  );
};

const SchemaTree = ({
  schema,
  doc,
}: {
  schema: OpenApiSchema | undefined;
  doc: OpenApiDoc | null;
}) => {
  const s = dereference(doc, schema);
  if (!s) {
    return <p className="text-sm text-muted-foreground">No schema.</p>;
  }
  if (s.properties) {
    return (
      <div>
        {Object.entries(s.properties).map(([name, childSchema]) => (
          <PropertyRow
            key={name}
            name={name}
            schema={childSchema}
            required={!!s.required?.includes(name)}
            doc={doc}
            depth={0}
          />
        ))}
      </div>
    );
  }
  // Top-level array of objects.
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  if (t === "array") {
    const inner = dereference(doc, s.items);
    if (inner?.properties) {
      return (
        <div>
          <div className="mb-1 font-mono text-[11px] text-muted-foreground">
            {typeLabel(s)}
          </div>
          {Object.entries(inner.properties).map(([name, childSchema]) => (
            <PropertyRow
              key={name}
              name={`[].${name}`}
              schema={childSchema}
              required={!!inner.required?.includes(name)}
              doc={doc}
              depth={0}
            />
          ))}
        </div>
      );
    }
  }
  // Scalar / unknown — show a single row.
  return (
    <div className="text-sm">
      <code className="font-mono text-[11px] text-muted-foreground">{typeLabel(s)}</code>
      {s.description && (
        <p className="mt-1 text-[12px] text-muted-foreground">{s.description}</p>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Parameters table (path/query/header).
// ────────────────────────────────────────────────────────────────────────────

const ParametersTable = ({
  parameters,
  doc,
  group,
}: {
  parameters: OpenApiParameter[];
  doc: OpenApiDoc | null;
  group: string;
}) => {
  if (parameters.length === 0) return null;
  return (
    <div>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {group} parameters
      </h4>
      <div className="rounded-md border bg-card">
        {parameters.map((p) => (
          <div key={`${p.in}:${p.name}`} className="border-b border-border/50 px-3 py-2 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <code className="font-mono text-[12.5px] font-medium text-foreground">{p.name}</code>
              <code className="font-mono text-[11px] text-muted-foreground">{typeLabel(p.schema)}</code>
              {p.required && (
                <Badge variant="outline" className="h-4 border-destructive/40 px-1.5 text-[9.5px] font-medium uppercase tracking-wide text-destructive">
                  required
                </Badge>
              )}
              <Badge variant="outline" className="h-4 px-1.5 text-[9.5px] font-medium uppercase tracking-wide">
                {p.in}
              </Badge>
            </div>
            {p.description && (
              <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{p.description}</p>
            )}
            {p.example !== undefined && (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                example: <span className="text-foreground/70">{JSON.stringify(p.example)}</span>
              </p>
            )}
            {p.schema?.enum && p.schema.enum.length > 0 && (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                enum: {p.schema.enum.map((e) => JSON.stringify(e)).join(", ")}
              </p>
            )}
            {/* Nested object/array schemas: render inline. */}
            {(() => {
              const s = dereference(doc, p.schema);
              if (s?.properties || (Array.isArray(s?.type) ? s?.type[0] : s?.type) === "array") {
                return (
                  <div className="mt-2">
                    <SchemaTree schema={p.schema} doc={doc} />
                  </div>
                );
              }
              return null;
            })()}
          </div>
        ))}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Endpoint detail pane.
// ────────────────────────────────────────────────────────────────────────────

const splitParameters = (
  ep: Endpoint,
): { path: OpenApiParameter[]; query: OpenApiParameter[]; header: OpenApiParameter[] } => {
  // Operation params override path-level params by name+in.
  const merged = new Map<string, OpenApiParameter>();
  for (const p of ep.inheritedParameters) merged.set(`${p.in}:${p.name}`, p);
  for (const p of ep.operation.parameters ?? []) merged.set(`${p.in}:${p.name}`, p);
  const all = Array.from(merged.values());
  return {
    path: all.filter((p) => p.in === "path"),
    query: all.filter((p) => p.in === "query"),
    header: all.filter((p) => p.in === "header"),
  };
};

const pickJsonMedia = (
  content: Record<string, OpenApiMediaType> | undefined,
): { type: string; media: OpenApiMediaType } | null => {
  if (!content) return null;
  const jsonish = Object.keys(content).find((k) => /json/i.test(k));
  if (jsonish) return { type: jsonish, media: content[jsonish]! };
  const first = Object.entries(content)[0];
  return first ? { type: first[0], media: first[1] } : null;
};

const OverviewTab = ({
  ep,
  doc,
}: {
  ep: Endpoint;
  doc: OpenApiDoc | null;
}) => {
  const security = ep.operation.security ?? [];
  const schemes = doc?.components?.securitySchemes ?? {};
  return (
    <div className="flex flex-col gap-4">
      {ep.operation.summary && (
        <p className="text-sm font-medium text-foreground">{ep.operation.summary}</p>
      )}
      {ep.operation.description && (
        <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {ep.operation.description}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          tags
        </span>
        {(ep.operation.tags ?? []).length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          (ep.operation.tags ?? []).map((t) => (
            <Badge key={t} variant="secondary" className="font-mono text-[10.5px]">
              {t}
            </Badge>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          security
        </span>
        {security.length === 0 ? (
          <span className="text-xs text-muted-foreground">none (public)</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {security.map((req, i) => {
              const names = Object.keys(req);
              return (
                <Badge key={i} variant="outline" className="font-mono text-[10.5px]">
                  {names.length === 0 ? "(empty)" : names.join(" + ")}
                </Badge>
              );
            })}
          </div>
        )}
      </div>
      {Object.keys(schemes).length > 0 && security.length > 0 && (
        <div className="rounded-md border bg-muted/30 p-3">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Resolved schemes
          </h4>
          <div className="flex flex-col gap-1.5 text-[12px]">
            {Array.from(new Set(security.flatMap((s) => Object.keys(s)))).map((name) => {
              const def = schemes[name];
              if (!def) {
                return (
                  <div key={name} className="font-mono text-muted-foreground">
                    {name} <span className="text-foreground/40">(not defined)</span>
                  </div>
                );
              }
              return (
                <div key={name} className="font-mono">
                  <span className="text-foreground">{name}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    — {String(def.type)}
                    {def.scheme ? ` (${String(def.scheme)})` : ""}
                    {def.in ? ` in:${String(def.in)}` : ""}
                    {def.name ? ` name:${String(def.name)}` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const RequestTab = ({
  ep,
  doc,
}: {
  ep: Endpoint;
  doc: OpenApiDoc | null;
}) => {
  const { path: pathParams, query, header } = splitParameters(ep);
  const body = ep.operation.requestBody;
  const json = pickJsonMedia(body?.content);
  return (
    <div className="flex flex-col gap-5">
      <ParametersTable parameters={pathParams} doc={doc} group="path" />
      <ParametersTable parameters={query} doc={doc} group="query" />
      <ParametersTable parameters={header} doc={doc} group="header" />
      {body && (
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              request body
            </h4>
            {json && (
              <code className="font-mono text-[10.5px] text-muted-foreground">{json.type}</code>
            )}
            {body.required && (
              <Badge variant="outline" className="h-4 border-destructive/40 px-1.5 text-[9.5px] font-medium uppercase tracking-wide text-destructive">
                required
              </Badge>
            )}
          </div>
          {body.description && (
            <p className="mb-2 text-[12px] text-muted-foreground">{body.description}</p>
          )}
          {json ? (
            <div className="rounded-md border bg-card px-3">
              <SchemaTree schema={json.media.schema} doc={doc} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No JSON content defined.</p>
          )}
        </div>
      )}
      {!body && pathParams.length === 0 && query.length === 0 && header.length === 0 && (
        <p className="text-sm text-muted-foreground">No parameters or body.</p>
      )}
    </div>
  );
};

const ResponseSection = ({
  status,
  response,
  doc,
  defaultOpen,
}: {
  status: string;
  response: OpenApiResponse;
  doc: OpenApiDoc | null;
  defaultOpen: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const json = pickJsonMedia(response.content);
  const code = Number(status);
  const tone: "ok" | "client" | "server" | "info" | "other" =
    !Number.isFinite(code)
      ? "other"
      : code >= 200 && code < 300
        ? "ok"
        : code >= 400 && code < 500
          ? "client"
          : code >= 500
            ? "server"
            : code >= 100 && code < 200
              ? "info"
              : "other";
  const toneClass =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "client"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "server"
          ? "text-destructive"
          : "text-muted-foreground";
  return (
    <div className="rounded-md border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <code className={cn("font-mono text-[12px] font-semibold tabular-nums", toneClass)}>{status}</code>
        <span className="text-[12px] text-muted-foreground">{response.description ?? "—"}</span>
        {json && (
          <code className="ml-auto font-mono text-[10.5px] text-muted-foreground">{json.type}</code>
        )}
      </button>
      {open && (
        <div className="border-t px-3 py-2">
          {json ? (
            <SchemaTree schema={json.media.schema} doc={doc} />
          ) : (
            <p className="text-sm text-muted-foreground">No content schema.</p>
          )}
        </div>
      )}
    </div>
  );
};

const ResponseTab = ({
  ep,
  doc,
}: {
  ep: Endpoint;
  doc: OpenApiDoc | null;
}) => {
  const responses = ep.operation.responses ?? {};
  const entries = Object.entries(responses).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No responses defined.</p>;
  }
  // Default-open the first 2xx; collapse the rest.
  const firstOk = entries.find(([s]) => /^2\d\d$/.test(s))?.[0];
  return (
    <div className="flex flex-col gap-2">
      {entries.map(([status, response]) => (
        <ResponseSection
          key={status}
          status={status}
          response={response}
          doc={doc}
          defaultOpen={status === firstOk}
        />
      ))}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Try-it tab — drives the actual fetch.
// ────────────────────────────────────────────────────────────────────────────

interface TryResult {
  status: number;
  statusText: string;
  ok: boolean;
  durationMs: number;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
}

const renderToBody = (val: string, schema?: OpenApiSchema): unknown => {
  // For path/query params: coerce based on the schema if possible.
  const t = Array.isArray(schema?.type) ? schema?.type[0] : schema?.type;
  if (val === "" && !schema?.required) return undefined;
  if (t === "integer" || t === "number") {
    const n = Number(val);
    return Number.isFinite(n) ? n : val;
  }
  if (t === "boolean") {
    if (val === "true") return true;
    if (val === "false") return false;
  }
  return val;
};

const TryItTab = ({
  ep,
  doc,
  baseUrl,
}: {
  ep: Endpoint;
  doc: OpenApiDoc | null;
  baseUrl: string;
}) => {
  const { path: pathParams, query, header } = splitParameters(ep);
  const body = ep.operation.requestBody;
  const json = pickJsonMedia(body?.content);

  // Re-key all local state by endpoint id so switching endpoints resets it.
  const epKey = ep.id;

  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [bodyText, setBodyText] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);

  // Reset form whenever endpoint changes.
  const lastKey = useRef<string>("");
  useEffect(() => {
    if (lastKey.current === epKey) return;
    lastKey.current = epKey;
    const initPath: Record<string, string> = {};
    for (const p of pathParams) {
      initPath[p.name] = p.example !== undefined ? String(p.example) : "";
    }
    const initQuery: Record<string, string> = {};
    for (const p of query) {
      initQuery[p.name] = p.example !== undefined ? String(p.example) : "";
    }
    const initHeader: Record<string, string> = {};
    for (const p of header) {
      initHeader[p.name] = p.example !== undefined ? String(p.example) : "";
    }
    setPathValues(initPath);
    setQueryValues(initQuery);
    setHeaderValues(initHeader);
    if (json) {
      // Prefer an explicit example on the media type or schema; fall back to
      // the generated example.
      const ex =
        json.media.example ??
        (json.media.examples ? Object.values(json.media.examples)[0]?.value : undefined) ??
        exampleFromSchema(doc, json.media.schema);
      setBodyText(JSON.stringify(ex ?? {}, null, 2));
    } else {
      setBodyText("");
    }
    setResult(null);
  }, [epKey, pathParams, query, header, json, doc]);

  const resolvedPath = useMemo(() => {
    let out = ep.path;
    for (const [k, v] of Object.entries(pathValues)) {
      out = out.replace(`{${k}}`, encodeURIComponent(v));
    }
    return out;
  }, [ep.path, pathValues]);

  const queryString = useMemo(() => {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(queryValues)) {
      if (v === "") continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }, [queryValues]);

  const fullUrl = `${baseUrl}${resolvedPath}${queryString}`;

  const send = useCallback(async () => {
    setRunning(true);
    setResult(null);
    const started = performance.now();
    try {
      const init: RequestInit = {
        method: ep.method.toUpperCase(),
        credentials: "include",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...Object.fromEntries(
            Object.entries(headerValues).filter(([, v]) => v !== ""),
          ),
        },
      };
      const allowsBody = !["get", "head"].includes(ep.method);
      if (allowsBody && bodyText.trim()) {
        init.body = bodyText;
      }
      const res = await fetch(`${resolvedPath}${queryString}`, init);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : "";
      } catch {
        parsed = text;
      }
      const headersOut: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headersOut[key] = value;
      });
      setResult({
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        durationMs: Math.round(performance.now() - started),
        headers: headersOut,
        body: parsed,
        bodyText: text,
      });
    } catch (e) {
      notifyError(e, `while calling ${ep.method.toUpperCase()} ${ep.path}`);
      setResult({
        status: 0,
        statusText: "Network error",
        ok: false,
        durationMs: Math.round(performance.now() - started),
        headers: {},
        body: { error: (e as Error).message },
        bodyText: (e as Error).message,
      });
    } finally {
      setRunning(false);
    }
  }, [ep, bodyText, resolvedPath, queryString, headerValues]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11.5px] break-all">
        <span className="text-muted-foreground">{ep.method.toUpperCase()}</span>{" "}
        <span className="text-foreground">{fullUrl}</span>
      </div>

      {pathParams.length > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            path
          </h4>
          <div className="flex flex-col gap-2">
            {pathParams.map((p) => (
              <div key={p.name} className="flex flex-col gap-1">
                <label className="flex items-baseline gap-2 font-mono text-[11.5px]">
                  <span className="text-foreground">{p.name}</span>
                  <span className="text-muted-foreground">{typeLabel(p.schema)}</span>
                  {p.required && <span className="text-destructive">*</span>}
                </label>
                <Input
                  value={pathValues[p.name] ?? ""}
                  onChange={(e) =>
                    setPathValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                  }
                  placeholder={p.description ?? `{${p.name}}`}
                  className="font-mono text-[12.5px]"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {query.length > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            query
          </h4>
          <div className="flex flex-col gap-2">
            {query.map((p) => (
              <div key={p.name} className="flex flex-col gap-1">
                <label className="flex items-baseline gap-2 font-mono text-[11.5px]">
                  <span className="text-foreground">{p.name}</span>
                  <span className="text-muted-foreground">{typeLabel(p.schema)}</span>
                  {p.required && <span className="text-destructive">*</span>}
                </label>
                <Input
                  value={queryValues[p.name] ?? ""}
                  onChange={(e) =>
                    setQueryValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                  }
                  placeholder={p.description ?? ""}
                  className="font-mono text-[12.5px]"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {header.length > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            headers
          </h4>
          <div className="flex flex-col gap-2">
            {header.map((p) => (
              <div key={p.name} className="flex flex-col gap-1">
                <label className="flex items-baseline gap-2 font-mono text-[11.5px]">
                  <span className="text-foreground">{p.name}</span>
                  <span className="text-muted-foreground">{typeLabel(p.schema)}</span>
                  {p.required && <span className="text-destructive">*</span>}
                </label>
                <Input
                  value={headerValues[p.name] ?? ""}
                  onChange={(e) =>
                    setHeaderValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                  }
                  className="font-mono text-[12.5px]"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {json && !["get", "head"].includes(ep.method) && (
        <div>
          <h4 className="mb-2 flex items-baseline gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              body
            </span>
            <code className="font-mono text-[10.5px] text-muted-foreground">{json.type}</code>
          </h4>
          <CodeEditor
            value={bodyText}
            onChange={(next) => setBodyText(next)}
            language="json"
            minHeight="180px"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" onClick={send} disabled={running}>
          <SendIcon className="size-4" />
          {running ? "Sending…" : "Send"}
        </Button>
        {result && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {result.durationMs} ms
          </span>
        )}
      </div>

      {result && (
        <div className="flex flex-col gap-3">
          <Separator />
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={result.ok ? "default" : "destructive"}
              className="font-mono tabular-nums"
            >
              {result.status} {result.statusText}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowHeaders((v) => !v)}
            >
              {showHeaders ? "Hide headers" : "Show headers"} ({Object.keys(result.headers).length})
            </Button>
          </div>
          {showHeaders && (
            <JsonBlock label="response headers" value={result.headers} maxHeight={200} />
          )}
          <JsonBlock label="response body" value={result.body} maxHeight={420} />
        </div>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Endpoint detail wrapper (tabs).
// ────────────────────────────────────────────────────────────────────────────

const EndpointDetail = ({
  ep,
  doc,
  baseUrl,
}: {
  ep: Endpoint;
  doc: OpenApiDoc | null;
  baseUrl: string;
}) => {
  const [tab, setTab] = useState<"overview" | "request" | "response" | "try">("overview");
  // Reset to overview when switching endpoints.
  useEffect(() => {
    setTab("overview");
  }, [ep.id]);
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <MethodBadge method={ep.method} size="md" />
          <CardTitle className="font-mono text-base break-all">{ep.path}</CardTitle>
          {ep.operation.deprecated && (
            <Badge variant="destructive" className="font-mono text-[10px] uppercase">
              deprecated
            </Badge>
          )}
        </div>
        {ep.operation.summary && (
          <p className="text-sm text-muted-foreground">{ep.operation.summary}</p>
        )}
      </CardHeader>
      <Separator />
      <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="px-4 pt-4">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="request">Request</TabsTrigger>
              <TabsTrigger value="response">Response</TabsTrigger>
              <TabsTrigger value="try">Try it</TabsTrigger>
            </TabsList>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <TabsContent value="overview" className="mt-0">
              <OverviewTab ep={ep} doc={doc} />
            </TabsContent>
            <TabsContent value="request" className="mt-0">
              <RequestTab ep={ep} doc={doc} />
            </TabsContent>
            <TabsContent value="response" className="mt-0">
              <ResponseTab ep={ep} doc={doc} />
            </TabsContent>
            <TabsContent value="try" className="mt-0">
              <TryItTab ep={ep} doc={doc} baseUrl={baseUrl} />
            </TabsContent>
          </div>
        </Tabs>
      </CardContent>
    </Card>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Endpoint list (left rail).
// ────────────────────────────────────────────────────────────────────────────

interface EndpointListProps {
  endpoints: Endpoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (next: string) => void;
  onRefetch: () => void;
  loading: boolean;
}

const EndpointList = ({
  endpoints,
  selectedId,
  onSelect,
  search,
  onSearch,
  onRefetch,
  loading,
}: EndpointListProps) => {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return endpoints;
    return endpoints.filter((ep) => {
      const hay = [
        ep.path,
        ep.method,
        ep.tag,
        ep.operation.summary ?? "",
        ep.operation.description ?? "",
        ep.operation.operationId ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [endpoints, search]);

  const grouped = useMemo(() => {
    const m = new Map<string, Endpoint[]>();
    for (const ep of filtered) {
      const list = m.get(ep.tag) ?? [];
      list.push(ep);
      m.set(ep.tag, list);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <Card className="flex h-full max-h-[calc(100vh-220px)] flex-col overflow-hidden">
      <CardHeader className="gap-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Filter endpoints…"
              className="h-8 pl-7 text-[12.5px]"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRefetch}
            disabled={loading}
            title="Refetch /api/openapi.json"
          >
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
        <div className="flex items-baseline justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{filtered.length} endpoints</span>
          <span>{grouped.length} tags</span>
        </div>
      </CardHeader>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
        {loading && endpoints.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">Loading…</p>
        )}
        {!loading && filtered.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">No matches.</p>
        )}
        {grouped.map(([tag, eps]) => (
          <div key={tag} className="mb-3">
            <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {tag}
            </div>
            <ul className="flex flex-col">
              {eps.map((ep) => {
                const active = ep.id === selectedId;
                return (
                  <li key={ep.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(ep.id)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                        active ? "bg-muted" : "hover:bg-muted/50",
                      )}
                    >
                      <MethodBadge method={ep.method} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[12px] text-foreground">
                          {ep.path}
                        </div>
                        {ep.operation.summary && (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {ep.operation.summary}
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        </div>
      </ScrollArea>
    </Card>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Page entry.
// ────────────────────────────────────────────────────────────────────────────

export const RestExplorerPage = () => {
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  // Deep-link from Collections cards: `/rest-explorer?slug=<slug>` jumps to
  // the first endpoint under `/api/items/<slug>`. Consumed once on load.
  const deepLinkSlug = searchParams.get("slug");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fetched = await api<OpenApiDoc>("/api/openapi.json");
      setDoc(fetched);
    } catch (e) {
      notifyError(e, "while loading /api/openapi.json");
      setDoc(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const endpoints = useMemo(() => flattenEndpoints(doc), [doc]);

  // Auto-select the first endpoint once loaded; preserve selection across
  // refetches when the id still exists. If a `?slug=` deep-link is present,
  // prefer the first endpoint under `/api/items/<slug>` and clear the param.
  useEffect(() => {
    if (endpoints.length === 0) {
      setSelectedId(null);
      return;
    }
    if (deepLinkSlug) {
      const prefix = `/api/items/${deepLinkSlug}`;
      const match = endpoints.find((ep) => ep.path === prefix || ep.path.startsWith(`${prefix}/`));
      if (match) {
        setSelectedId(match.id);
        setSearch(prefix);
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete("slug");
          return next;
        }, { replace: true });
        return;
      }
    }
    setSelectedId((prev) => {
      if (prev && endpoints.some((ep) => ep.id === prev)) return prev;
      return endpoints[0]!.id;
    });
  }, [endpoints, deepLinkSlug, setSearchParams]);

  const selected = useMemo(
    () => endpoints.find((ep) => ep.id === selectedId) ?? null,
    [endpoints, selectedId],
  );

  // For the URL preview on Try-it. Same-origin in browsers.
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader
        title="REST Explorer"
        description="Live browser for every endpoint under /api. Built from the OpenAPI doc your workspace exposes at /api/openapi.json — including the dynamic /api/items/{slug} routes for your collections."
        actions={
          doc?.info?.version ? (
            <Badge variant="outline" className="font-mono text-[10.5px]">
              v{doc.info.version}
            </Badge>
          ) : null
        }
      />
      <div
        className="grid min-h-0 flex-1 gap-4"
        style={{ gridTemplateColumns: "320px minmax(0, 1fr)" }}
      >
        <EndpointList
          endpoints={endpoints}
          selectedId={selectedId}
          onSelect={setSelectedId}
          search={search}
          onSearch={setSearch}
          onRefetch={() => void load()}
          loading={loading}
        />
        <div className="min-h-0 max-h-[calc(100vh-220px)] overflow-auto">
          {selected ? (
            <EndpointDetail ep={selected} doc={doc} baseUrl={baseUrl} />
          ) : (
            <Card className="flex h-full items-center justify-center">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                {loading
                  ? "Loading OpenAPI doc…"
                  : "Select an endpoint on the left to inspect it."}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};
