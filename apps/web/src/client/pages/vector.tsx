import { useState } from "react";
import { SparklesIcon, SearchIcon } from "lucide-react";
import { Card, CardContent } from "@workeros/ui/components/card";
import { Input } from "@workeros/ui/components/input";
import { Button } from "@workeros/ui/components/button";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface Match {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export const Vector = () => {
  const [raw, setRaw] = useState("");
  const [topK, setTopK] = useState(10);
  const [results, setResults] = useState<Match[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true);
    try {
      const values = raw
        .split(/[\s,]+/)
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      if (values.length === 0) {
        notifyError("Provide a vector — comma- or whitespace-separated numbers");
        return;
      }
      const res = await api<{ data: Match[] }>("/api/vector/query", {
        method: "POST",
        body: JSON.stringify({ values, topK }),
      });
      setResults(res.data);
    } catch (e) {
      notifyError(e, "Querying vector index");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Vector search"
        description="Cosine-similarity query against the embeddings index. Adapter auto-selected: Vectorize on Workers, pgvector on Postgres."
      />

      <Card className="mb-4">
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="vec">Query vector</Label>
              <Input
                id="vec"
                placeholder="0.12, 0.45, -0.31, …"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Values can be comma- or whitespace-separated. Dimension must
                match the index (configured at index-create time).
              </p>
            </div>
            <div className="flex items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="topk">Top K</Label>
                <Input
                  id="topk"
                  type="number"
                  min={1}
                  max={100}
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value) || 10)}
                  className="w-24"
                />
              </div>
              <Button type="submit" disabled={busy}>
                <SearchIcon /> {busy ? "Searching…" : "Search"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {results === null ? (
            <EmptyState
              icon={SparklesIcon}
              title="No query yet"
              description="Run a query above to see nearest neighbours by cosine similarity."
            />
          ) : results.length === 0 ? (
            <EmptyState
              icon={SearchIcon}
              title="No matches"
              description="Either the index is empty or the query vector dimension doesn't match."
            />
          ) : (
            <ul className="divide-y">
              {results.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs">{m.id}</span>
                  <Badge variant="outline" className="font-mono tabular-nums">
                    {m.score.toFixed(4)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
