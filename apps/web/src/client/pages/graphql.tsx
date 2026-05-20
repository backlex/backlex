import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  PlayIcon,
  SearchIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ZapIcon,
  PencilIcon,
  BoxIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Badge } from "@workeros/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { cn } from "@workeros/ui/lib/utils";
import { CodeEditor } from "@/components/code-editor-lazy";
import { PageHeader } from "@/components/page-header";
import { JsonBlock } from "@/admin/ui";
import { notifyError } from "@/lib/error";

// ---------------------------------------------------------------------------
// Introspection types
// ---------------------------------------------------------------------------

type TypeKind =
  | "SCALAR"
  | "OBJECT"
  | "INTERFACE"
  | "UNION"
  | "ENUM"
  | "INPUT_OBJECT"
  | "LIST"
  | "NON_NULL";

interface TypeRef {
  name: string | null;
  kind: TypeKind;
  ofType?: TypeRef | null;
}

interface InputArg {
  name: string;
  type: TypeRef;
  defaultValue?: string | null;
}

interface FieldDef {
  name: string;
  description?: string | null;
  args: InputArg[];
  type: TypeRef;
}

interface ObjectFieldDef {
  name: string;
  type: TypeRef;
  description?: string | null;
}

interface InputFieldDef {
  name: string;
  type: TypeRef;
}

interface TypeDef {
  name: string;
  kind: TypeKind;
  description?: string | null;
  fields?: ObjectFieldDef[] | null;
  inputFields?: InputFieldDef[] | null;
  enumValues?: { name: string }[] | null;
}

interface IntrospectionResult {
  __schema: {
    queryType: { name: string; fields: FieldDef[] } | null;
    mutationType: { name: string; fields: FieldDef[] } | null;
    types: TypeDef[];
  };
}

interface GraphQLResponse {
  data?: unknown;
  errors?: { message: string; path?: (string | number)[] }[];
  extensions?: unknown;
}

// ---------------------------------------------------------------------------
// Introspection query
// ---------------------------------------------------------------------------

// Fragment for the recursive type ref (4 levels of ofType — plenty for
// `[Foo!]!` and `[[Foo!]!]!` patterns).
const TYPE_REF_FRAGMENT = `
  fragment TypeRef on __Type {
    name
    kind
    ofType {
      name
      kind
      ofType {
        name
        kind
        ofType { name kind }
      }
    }
  }
`;

const FIELD_FRAGMENT = `
  fragment FieldDef on __Field {
    name
    description
    args {
      name
      defaultValue
      type { ...TypeRef }
    }
    type { ...TypeRef }
  }
`;

const INTROSPECTION_QUERY = `query Introspect {
  __schema {
    queryType { name fields { ...FieldDef } }
    mutationType { name fields { ...FieldDef } }
    types {
      name
      kind
      description
      fields {
        name
        description
        type { ...TypeRef }
      }
      inputFields {
        name
        type { ...TypeRef }
      }
      enumValues { name }
    }
  }
}
${FIELD_FRAGMENT}
${TYPE_REF_FRAGMENT}
`;

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

function typeRefToString(t: TypeRef | null | undefined): string {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${typeRefToString(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeRefToString(t.ofType)}]`;
  return t.name ?? "?";
}

/** Strip NON_NULL/LIST wrappers and return the underlying named type ref. */
function unwrapType(t: TypeRef | null | undefined): TypeRef | null {
  if (!t) return null;
  if (t.kind === "NON_NULL" || t.kind === "LIST") return unwrapType(t.ofType ?? null);
  return t;
}

function isLeafKind(kind: TypeKind): boolean {
  return kind === "SCALAR" || kind === "ENUM";
}

/**
 * Walk an OBJECT type's fields and return the names of scalar/enum leaves —
 * one level deep, so nested objects are emitted as a hint comment instead.
 */
function collectLeafFields(
  obj: TypeDef | undefined,
): { leaves: string[]; nestedNames: string[] } {
  if (!obj || !obj.fields) return { leaves: [], nestedNames: [] };
  const leaves: string[] = [];
  const nested: string[] = [];
  for (const f of obj.fields) {
    const named = unwrapType(f.type);
    if (!named || !named.name) continue;
    if (isLeafKind(named.kind)) {
      leaves.push(f.name);
    } else if (named.kind === "OBJECT") {
      nested.push(f.name);
    }
  }
  return { leaves, nestedNames: nested };
}

// ---------------------------------------------------------------------------
// Snippet generator
// ---------------------------------------------------------------------------

interface SnippetResult {
  query: string;
  variables: string;
  operationName: string;
}

function generateSnippet(
  field: FieldDef,
  kind: "query" | "mutation",
  typesByName: Map<string, TypeDef>,
): SnippetResult {
  const opName = `${field.name.charAt(0).toUpperCase()}${field.name.slice(1)}Op`;
  const required = field.args.filter((a) => a.type.kind === "NON_NULL");
  const optional = field.args.filter((a) => a.type.kind !== "NON_NULL");

  // Variable declarations on the operation
  const varDeclList: string[] = [];
  const argList: string[] = [];
  const variableObj: Record<string, unknown> = {};

  const buildArgVar = (arg: InputArg, includeOptional: boolean): void => {
    const named = unwrapType(arg.type);
    if (!named || !named.name) return;
    if (!includeOptional && arg.type.kind !== "NON_NULL") return;
    varDeclList.push(`$${arg.name}: ${typeRefToString(arg.type)}`);
    argList.push(`${arg.name}: $${arg.name}`);
    // Variable stub
    if (named.kind === "INPUT_OBJECT") {
      const nested = typesByName.get(named.name);
      variableObj[arg.name] = buildInputStub(nested, typesByName, 0);
    } else if (named.kind === "ENUM") {
      const enumDef = typesByName.get(named.name);
      variableObj[arg.name] = enumDef?.enumValues?.[0]?.name ?? null;
    } else if (named.name === "Int" || named.name === "Float") {
      variableObj[arg.name] = 0;
    } else if (named.name === "Boolean") {
      variableObj[arg.name] = false;
    } else {
      variableObj[arg.name] = "";
    }
  };

  // Include all required args; for mutations also include any obvious "input"
  // optional arg (Directus-style create/update mutations often take `input`).
  for (const a of required) buildArgVar(a, false);
  for (const a of optional) {
    if (a.name === "input" || a.name === "data" || a.name === "values") {
      buildArgVar(a, true);
    }
  }

  const opSignature = varDeclList.length > 0
    ? `${kind} ${opName}(${varDeclList.join(", ")})`
    : `${kind} ${opName}`;

  const argsStr = argList.length > 0 ? `(${argList.join(", ")})` : "";

  // Return-type body
  const returnNamed = unwrapType(field.type);
  let body = "";
  if (returnNamed && returnNamed.kind === "OBJECT") {
    const obj = typesByName.get(returnNamed.name ?? "");
    const { leaves, nestedNames } = collectLeafFields(obj);
    const parts: string[] = [];
    if (leaves.length > 0) {
      parts.push(...leaves.map((l) => `    ${l}`));
    }
    for (const n of nestedNames) {
      parts.push(`    # ${n} — nested object, expand if needed`);
    }
    if (parts.length === 0) {
      parts.push("    __typename");
    }
    body = ` {\n${parts.join("\n")}\n  }`;
  } else if (returnNamed && (returnNamed.kind === "INTERFACE" || returnNamed.kind === "UNION")) {
    body = ` {\n    __typename\n  }`;
  } else {
    // Scalar / enum return — no selection set
    body = "";
  }

  const query = `${opSignature} {\n  ${field.name}${argsStr}${body}\n}\n`;
  const variables = Object.keys(variableObj).length > 0
    ? JSON.stringify(variableObj, null, 2)
    : "{}";

  return { query, variables, operationName: opName };
}

function buildInputStub(
  type: TypeDef | undefined,
  typesByName: Map<string, TypeDef>,
  depth: number,
): unknown {
  if (!type || type.kind !== "INPUT_OBJECT" || !type.inputFields) return {};
  if (depth > 1) return {};
  const out: Record<string, unknown> = {};
  for (const f of type.inputFields) {
    const named = unwrapType(f.type);
    const required = f.type.kind === "NON_NULL";
    if (!required && depth >= 1) continue;
    if (!named || !named.name) continue;
    if (named.kind === "INPUT_OBJECT") {
      out[f.name] = buildInputStub(typesByName.get(named.name), typesByName, depth + 1);
    } else if (named.kind === "ENUM") {
      const enumDef = typesByName.get(named.name);
      out[f.name] = enumDef?.enumValues?.[0]?.name ?? null;
    } else if (named.name === "Int" || named.name === "Float") {
      out[f.name] = 0;
    } else if (named.name === "Boolean") {
      out[f.name] = false;
    } else {
      out[f.name] = "";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fallback snippets — kept minimal; the real value is the per-field generator
// ---------------------------------------------------------------------------

const FALLBACK_SNIPPETS: { label: string; query: string; variables: string }[] = [
  {
    label: "Introspect — root fields",
    query: `{
  __schema {
    queryType { name fields { name } }
    mutationType { name fields { name } }
  }
}
`,
    variables: "{}",
  },
  {
    label: "Typename ping",
    query: `{
  __typename
}
`,
    variables: "{}",
  },
];

// ---------------------------------------------------------------------------
// Tree row component
// ---------------------------------------------------------------------------

interface SchemaTreeRowProps {
  label: string;
  typeLabel?: string;
  description?: string | null;
  onClick: () => void;
  active?: boolean;
  indent?: number;
}

const SchemaTreeRow = ({
  label,
  typeLabel,
  description,
  onClick,
  active,
  indent = 0,
}: SchemaTreeRowProps) => (
  <button
    type="button"
    onClick={onClick}
    title={description ?? undefined}
    className={cn(
      "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-mono transition-colors",
      "hover:bg-accent hover:text-accent-foreground",
      active && "bg-accent text-accent-foreground",
    )}
    style={{ paddingLeft: 8 + indent * 10 }}
  >
    <span className="truncate">{label}</span>
    {typeLabel && (
      <span className="ml-auto shrink-0 truncate text-muted-foreground">
        {typeLabel}
      </span>
    )}
  </button>
);

interface SectionHeaderProps {
  icon: ReactNode;
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}

const SectionHeader = ({ icon, title, count, open, onToggle }: SectionHeaderProps) => (
  <button
    type="button"
    onClick={onToggle}
    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/40"
  >
    {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
    {icon}
    <span>{title}</span>
    <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground">
      {count}
    </span>
  </button>
);

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

interface ActiveSelection {
  kind: "query" | "mutation" | "type" | "fallback";
  name: string;
}

const MAX_TYPES_INITIAL = 40;

export const GraphqlPage = () => {
  // Editor state
  const [query, setQuery] = useState<string>(FALLBACK_SNIPPETS[0]!.query);
  const [variables, setVariables] = useState<string>("{}");
  const [operationName, setOperationName] = useState<string | undefined>(undefined);

  // Execution state
  const [result, setResult] = useState<GraphQLResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [variablesOpen, setVariablesOpen] = useState(false);

  // Schema state
  const [schema, setSchema] = useState<IntrospectionResult["__schema"] | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(true);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // UI state
  const [filter, setFilter] = useState("");
  const [openSection, setOpenSection] = useState<Record<string, boolean>>({
    fallbacks: true,
    queries: true,
    mutations: true,
    types: false,
  });
  const [active, setActive] = useState<ActiveSelection | null>(null);
  const [showAllTypes, setShowAllTypes] = useState(false);

  const introspectAbort = useRef<AbortController | null>(null);

  // -------------------------------------------------------------------------
  // Introspection load
  // -------------------------------------------------------------------------
  const loadSchema = useCallback(async () => {
    introspectAbort.current?.abort();
    const ctrl = new AbortController();
    introspectAbort.current = ctrl;
    setSchemaLoading(true);
    setSchemaError(null);
    try {
      const res = await fetch("/api/graphql", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query: INTROSPECTION_QUERY,
          operationName: "Introspect",
        }),
        signal: ctrl.signal,
      });
      const body = (await res.json()) as GraphQLResponse;
      if (body.errors?.length) {
        throw new Error(body.errors.map((e) => e.message).join("; "));
      }
      const data = body.data as IntrospectionResult | undefined;
      if (!data?.__schema) {
        throw new Error("Introspection response missing __schema.");
      }
      setSchema(data.__schema);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg = (err as Error).message ?? "Failed to load schema";
      setSchemaError(msg);
      notifyError(err, "while introspecting GraphQL schema");
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchema();
    return () => introspectAbort.current?.abort();
  }, [loadSchema]);

  // -------------------------------------------------------------------------
  // Type indexes
  // -------------------------------------------------------------------------
  const typesByName = useMemo(() => {
    const m = new Map<string, TypeDef>();
    if (schema) for (const t of schema.types) if (t.name) m.set(t.name, t);
    return m;
  }, [schema]);

  const queryFields = useMemo<FieldDef[]>(
    () => schema?.queryType?.fields ?? [],
    [schema],
  );
  const mutationFields = useMemo<FieldDef[]>(
    () => schema?.mutationType?.fields ?? [],
    [schema],
  );

  // Custom object types (skip introspection internals + the root Query/Mutation
  // types — those are already represented by the root field lists).
  const customObjectTypes = useMemo<TypeDef[]>(() => {
    if (!schema) return [];
    const queryName = schema.queryType?.name;
    const mutationName = schema.mutationType?.name;
    return schema.types
      .filter((t) => {
        if (!t.name) return false;
        if (t.name.startsWith("__")) return false;
        if (t.name === queryName || t.name === mutationName) return false;
        return t.kind === "OBJECT" || t.kind === "INPUT_OBJECT" || t.kind === "ENUM";
      })
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [schema]);

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------
  const matchesFilter = useCallback(
    (label: string): boolean => {
      if (!filter.trim()) return true;
      return label.toLowerCase().includes(filter.trim().toLowerCase());
    },
    [filter],
  );

  const filteredQueries = useMemo(
    () => queryFields.filter((f) => matchesFilter(f.name)),
    [queryFields, matchesFilter],
  );
  const filteredMutations = useMemo(
    () => mutationFields.filter((f) => matchesFilter(f.name)),
    [mutationFields, matchesFilter],
  );
  const filteredTypes = useMemo(
    () => customObjectTypes.filter((t) => matchesFilter(t.name ?? "")),
    [customObjectTypes, matchesFilter],
  );

  const visibleTypes = useMemo(() => {
    if (showAllTypes || filter.trim()) return filteredTypes;
    return filteredTypes.slice(0, MAX_TYPES_INITIAL);
  }, [filteredTypes, showAllTypes, filter]);

  // -------------------------------------------------------------------------
  // Apply snippet → editor
  // -------------------------------------------------------------------------
  const applyFieldSnippet = useCallback(
    (field: FieldDef, kind: "query" | "mutation") => {
      const snippet = generateSnippet(field, kind, typesByName);
      setQuery(snippet.query);
      setVariables(snippet.variables);
      setOperationName(snippet.operationName);
      setVariablesOpen(snippet.variables !== "{}");
      setActive({ kind, name: field.name });
    },
    [typesByName],
  );

  const applyTypePreview = useCallback(
    (t: TypeDef) => {
      // For OBJECT / INPUT_OBJECT / ENUM, emit a focused introspection query
      // so the admin can see the type's shape via the schema itself.
      const q = `query InspectType {
  __type(name: "${t.name}") {
    name
    kind
    description
    fields {
      name
      description
      type { name kind ofType { name kind ofType { name kind } } }
    }
    inputFields {
      name
      type { name kind ofType { name kind ofType { name kind } } }
    }
    enumValues { name }
  }
}
`;
      setQuery(q);
      setVariables("{}");
      setOperationName("InspectType");
      setVariablesOpen(false);
      setActive({ kind: "type", name: t.name });
    },
    [],
  );

  const applyFallback = useCallback(
    (s: (typeof FALLBACK_SNIPPETS)[number]) => {
      setQuery(s.query);
      setVariables(s.variables);
      setOperationName(undefined);
      setVariablesOpen(false);
      setActive({ kind: "fallback", name: s.label });
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Execute
  // -------------------------------------------------------------------------
  const execute = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      setRunning(true);
      setResult(null);
      setTookMs(null);
      const started = performance.now();
      let parsedVars: unknown;
      const trimmedVars = variables.trim();
      if (trimmedVars && trimmedVars !== "{}") {
        try {
          parsedVars = JSON.parse(trimmedVars);
        } catch {
          setRunning(false);
          const msg = "Variables JSON is invalid.";
          notifyError(new Error(msg), "while executing GraphQL query");
          setResult({ errors: [{ message: msg }] });
          return;
        }
      }
      try {
        const res = await fetch("/api/graphql", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query,
            variables: parsedVars,
            operationName,
          }),
        });
        // Render whatever shape comes back — GraphQL can return 200 + errors.
        let body: GraphQLResponse;
        try {
          body = (await res.json()) as GraphQLResponse;
        } catch {
          body = {
            errors: [
              {
                message: `Non-JSON response (HTTP ${res.status} ${res.statusText})`,
              },
            ],
          };
        }
        setResult(body);
        setTookMs(Math.round(performance.now() - started));
      } catch (err) {
        notifyError(err, "while executing GraphQL query");
        setResult({ errors: [{ message: (err as Error).message }] });
      } finally {
        setRunning(false);
      }
    },
    [query, variables, operationName],
  );

  // Keyboard shortcut: Ctrl/Cmd+Enter to execute.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void execute();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [execute]);

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------
  const status: "ok" | "errors" | "idle" = result
    ? result.errors?.length
      ? "errors"
      : "ok"
    : "idle";

  const toggleSection = (key: string) =>
    setOpenSection((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="GraphQL"
        description="Introspection-driven explorer for /api/graphql. Schema is generated from your workspace's collections at request time — click a query or mutation in the tree to drop a runnable snippet into the editor."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadSchema()}
            disabled={schemaLoading}
          >
            <RefreshCwIcon
              className={cn("size-4", schemaLoading && "animate-spin")}
            />
            Reload schema
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Left: schema tree */}
        <Card className="flex h-fit max-h-[calc(100vh-220px)] flex-col overflow-hidden lg:sticky lg:top-4">
          <CardHeader className="gap-2">
            <CardTitle className="flex items-center justify-between text-sm">
              <span>Schema</span>
              {schema && (
                <Badge variant="outline" className="font-mono text-[10px]">
                  {queryFields.length}q · {mutationFields.length}m
                </Badge>
              )}
            </CardTitle>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter fields & types…"
                className="h-8 pl-7 pr-7 text-xs"
              />
              {filter && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setFilter("")}
                  className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground"
                  aria-label="Clear filter"
                >
                  <XIcon className="size-3" />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto p-2 pt-0">
            {schemaLoading && (
              <div className="flex flex-col gap-2 p-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-full" />
              </div>
            )}

            {schemaError && !schemaLoading && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                {schemaError}
              </div>
            )}

            {!schemaLoading && !schemaError && (
              <div className="flex flex-col gap-1">
                {/* Fallback snippets */}
                <SectionHeader
                  icon={<ZapIcon className="size-3" />}
                  title="Snippets"
                  count={FALLBACK_SNIPPETS.length}
                  open={openSection.fallbacks ?? true}
                  onToggle={() => toggleSection("fallbacks")}
                />
                {openSection.fallbacks &&
                  FALLBACK_SNIPPETS.map((s) => (
                    <SchemaTreeRow
                      key={s.label}
                      label={s.label}
                      onClick={() => applyFallback(s)}
                      active={active?.kind === "fallback" && active.name === s.label}
                      indent={1}
                    />
                  ))}

                {/* Queries */}
                <SectionHeader
                  icon={<ZapIcon className="size-3" />}
                  title="Queries"
                  count={filteredQueries.length}
                  open={openSection.queries ?? true}
                  onToggle={() => toggleSection("queries")}
                />
                {openSection.queries && filteredQueries.length === 0 && (
                  <div className="px-3 py-1 text-[11px] text-muted-foreground">
                    {queryFields.length === 0 ? "No queries." : "No matches."}
                  </div>
                )}
                {openSection.queries &&
                  filteredQueries.map((f) => (
                    <SchemaTreeRow
                      key={f.name}
                      label={f.name}
                      typeLabel={typeRefToString(f.type)}
                      description={f.description}
                      onClick={() => applyFieldSnippet(f, "query")}
                      active={active?.kind === "query" && active.name === f.name}
                      indent={1}
                    />
                  ))}

                {/* Mutations */}
                <SectionHeader
                  icon={<PencilIcon className="size-3" />}
                  title="Mutations"
                  count={filteredMutations.length}
                  open={openSection.mutations ?? true}
                  onToggle={() => toggleSection("mutations")}
                />
                {openSection.mutations && filteredMutations.length === 0 && (
                  <div className="px-3 py-1 text-[11px] text-muted-foreground">
                    {mutationFields.length === 0 ? "No mutations." : "No matches."}
                  </div>
                )}
                {openSection.mutations &&
                  filteredMutations.map((f) => (
                    <SchemaTreeRow
                      key={f.name}
                      label={f.name}
                      typeLabel={typeRefToString(f.type)}
                      description={f.description}
                      onClick={() => applyFieldSnippet(f, "mutation")}
                      active={active?.kind === "mutation" && active.name === f.name}
                      indent={1}
                    />
                  ))}

                {/* Types */}
                <SectionHeader
                  icon={<BoxIcon className="size-3" />}
                  title="Types"
                  count={filteredTypes.length}
                  open={openSection.types ?? false}
                  onToggle={() => toggleSection("types")}
                />
                {openSection.types && visibleTypes.length === 0 && (
                  <div className="px-3 py-1 text-[11px] text-muted-foreground">
                    No types.
                  </div>
                )}
                {openSection.types &&
                  visibleTypes.map((t) => (
                    <SchemaTreeRow
                      key={t.name}
                      label={t.name ?? "?"}
                      typeLabel={t.kind.toLowerCase()}
                      description={t.description}
                      onClick={() => applyTypePreview(t)}
                      active={active?.kind === "type" && active.name === t.name}
                      indent={1}
                    />
                  ))}
                {openSection.types &&
                  !filter.trim() &&
                  !showAllTypes &&
                  filteredTypes.length > MAX_TYPES_INITIAL && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAllTypes(true)}
                      className="mx-2 mt-1 h-7 justify-start text-[11px] text-muted-foreground"
                    >
                      Show {filteredTypes.length - MAX_TYPES_INITIAL} more…
                    </Button>
                  )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right: editor + response */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <span>Query</span>
                {operationName && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {operationName}
                  </Badge>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setVariablesOpen((v) => !v)}
                >
                  {variablesOpen ? "Hide variables" : "Show variables"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void execute()}
                  disabled={running}
                >
                  <PlayIcon className="size-4" />
                  {running ? "Running…" : "Execute"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <form onSubmit={execute} className="flex flex-col gap-3">
                <CodeEditor
                  value={query}
                  onChange={setQuery}
                  language="plain"
                  minHeight="260px"
                />
                {variablesOpen && (
                  <div className="flex flex-col gap-1">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Variables (JSON)
                    </div>
                    <CodeEditor
                      value={variables}
                      onChange={setVariables}
                      language="json"
                      minHeight="100px"
                    />
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                      ⌘
                    </kbd>{" "}
                    +{" "}
                    <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                      ↵
                    </kbd>{" "}
                    to execute
                  </span>
                  {tookMs !== null && (
                    <span className="ml-auto tabular-nums">{tookMs} ms</span>
                  )}
                </div>
                {/* Hidden submit so Enter inside non-CodeMirror inputs still works. */}
                <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
              </form>
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <span>Response</span>
                {status === "ok" && <Badge variant="default">ok</Badge>}
                {status === "errors" && <Badge variant="destructive">errors</Badge>}
                {status === "idle" && <Badge variant="outline">idle</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {result ? (
                <Tabs defaultValue="data">
                  <TabsList>
                    <TabsTrigger value="data">Data</TabsTrigger>
                    <TabsTrigger value="errors" disabled={!result.errors?.length}>
                      Errors
                      {result.errors?.length ? (
                        <Badge variant="destructive" className="ml-1 font-mono text-[10px]">
                          {result.errors.length}
                        </Badge>
                      ) : null}
                    </TabsTrigger>
                    <TabsTrigger value="raw">Raw</TabsTrigger>
                  </TabsList>
                  <TabsContent value="data" className="pt-3">
                    <JsonBlock
                      label="data"
                      value={result.data ?? null}
                      maxHeight={420}
                    />
                  </TabsContent>
                  <TabsContent value="errors" className="pt-3">
                    {result.errors?.length ? (
                      <JsonBlock
                        label="errors"
                        value={result.errors}
                        maxHeight={420}
                      />
                    ) : (
                      <div className="text-xs text-muted-foreground">No errors.</div>
                    )}
                  </TabsContent>
                  <TabsContent value="raw" className="pt-3">
                    <JsonBlock label="raw" value={result} maxHeight={420} />
                  </TabsContent>
                </Tabs>
              ) : (
                <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-8 text-center text-xs text-muted-foreground">
                  Execute a query to see results here.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};
