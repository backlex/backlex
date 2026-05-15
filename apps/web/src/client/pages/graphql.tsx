import { useState, type FormEvent } from "react";
import { PlayIcon } from "lucide-react";
import { Button } from "@workeros/ui/components/button";
import { Textarea } from "@workeros/ui/components/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Badge } from "@workeros/ui/components/badge";
import { PageHeader } from "@/components/page-header";
import { notifyError } from "@/lib/error";

const SAMPLE_QUERIES: { label: string; query: string }[] = [
  {
    label: "Introspect — root fields",
    query: `{
  __schema {
    queryType { fields { name description } }
    mutationType { fields { name } }
  }
}`,
  },
  {
    label: "List Posts (first 5)",
    query: `{
  posts(limit: 5) {
    id
    title
    createdAt
  }
}`,
  },
  {
    label: "Empty placeholder",
    query: "{ _empty }",
  },
];

interface GraphQLResult {
  data?: unknown;
  errors?: { message: string; path?: (string | number)[] }[];
}

export const GraphqlPage = () => {
  const [query, setQuery] = useState<string>(SAMPLE_QUERIES[0]!.query);
  const [variables, setVariables] = useState<string>("{}");
  const [result, setResult] = useState<GraphQLResult | null>(null);
  const [running, setRunning] = useState(false);
  const [tookMs, setTookMs] = useState<number | null>(null);

  const execute = async (e?: FormEvent) => {
    e?.preventDefault();
    setRunning(true);
    setResult(null);
    setTookMs(null);
    const started = performance.now();
    try {
      let parsedVars: unknown = undefined;
      const trimmedVars = variables.trim();
      if (trimmedVars) {
        try {
          parsedVars = JSON.parse(trimmedVars);
        } catch {
          throw new Error("Variables JSON is invalid.");
        }
      }
      const res = await fetch("/api/graphql", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables: parsedVars }),
      });
      const body = (await res.json()) as GraphQLResult;
      setResult(body);
      setTookMs(Math.round(performance.now() - started));
    } catch (err) {
      notifyError(err, "while executing GraphQL query");
      setResult({ errors: [{ message: (err as Error).message }] });
    } finally {
      setRunning(false);
    }
  };

  const status: "ok" | "errors" | "idle" =
    result ? (result.errors?.length ? "errors" : "ok") : "idle";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="GraphQL"
        description="POST to /api/graphql with the active session cookie or a bearer API key. Schema is generated from your collections at request time."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Query</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {SAMPLE_QUERIES.map((s) => (
                <Button
                  key={s.label}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setQuery(s.query)}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            <form onSubmit={execute} className="flex flex-1 flex-col gap-3">
              <Textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                className="min-h-[260px] flex-1 font-mono text-sm"
              />
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Variables (JSON)</summary>
                <Textarea
                  value={variables}
                  onChange={(e) => setVariables(e.target.value)}
                  spellCheck={false}
                  className="mt-2 min-h-[80px] font-mono text-sm"
                />
              </details>
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={running}>
                  <PlayIcon className="size-4" />
                  {running ? "Running…" : "Execute"}
                </Button>
                {tookMs !== null && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {tookMs} ms
                  </span>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Response</CardTitle>
            {status === "ok" && <Badge variant="default">ok</Badge>}
            {status === "errors" && <Badge variant="destructive">errors</Badge>}
            {status === "idle" && <Badge variant="outline">idle</Badge>}
          </CardHeader>
          <CardContent>
            <pre className="min-h-[260px] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {result ? JSON.stringify(result, null, 2) : "// Execute a query to see results here."}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
