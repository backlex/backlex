import { useState } from "react";
import { SparklesIcon, SearchIcon } from "lucide-react";
import { Card, CardContent } from "@workeros/ui/components/card";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { Button } from "@workeros/ui/components/button";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workeros/ui/components/tabs";
import { EMBEDDING_MODELS, type EmbeddingModel } from "@workeros/core";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface Match {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

const MODELS = Object.entries(EMBEDDING_MODELS) as [
  EmbeddingModel,
  (typeof EMBEDDING_MODELS)[EmbeddingModel],
][];

export const Vector = () => {
  const [model, setModel] = useState<EmbeddingModel>("openai-3-small");
  const [text, setText] = useState("");
  const [raw, setRaw] = useState("");
  const [topK, setTopK] = useState(10);
  const [results, setResults] = useState<Match[] | null>(null);
  const [busy, setBusy] = useState(false);

  const dim = EMBEDDING_MODELS[model].dimensions;

  const searchByText = async () => {
    setBusy(true);
    try {
      if (!text.trim()) {
        notifyError("Provide a text query");
        return;
      }
      const res = await api<{ data: Match[] }>("/api/vector/search", {
        method: "POST",
        body: JSON.stringify({ model, text, topK }),
      });
      setResults(res.data);
    } catch (e) {
      notifyError(e, "Searching");
    } finally {
      setBusy(false);
    }
  };

  const searchByVector = async () => {
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
      if (values.length !== dim) {
        notifyError(`Vector must have ${dim} dimensions for ${model}, got ${values.length}`);
        return;
      }
      const res = await api<{ data: Match[] }>("/api/vector/query", {
        method: "POST",
        body: JSON.stringify({ model, values, topK }),
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
        description="Cosine-similarity query against per-model embedding indexes. Search by text (server embeds it for you) or by raw vector."
      />

      <Card className="mb-4">
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="model">Model</Label>
              <Select value={model} onValueChange={(v) => setModel(v as EmbeddingModel)}>
                <SelectTrigger id="model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map(([key, def]) => (
                    <SelectItem key={key} value={key}>
                      {def.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
          </div>

          <Tabs defaultValue="text">
            <TabsList>
              <TabsTrigger value="text">By text</TabsTrigger>
              <TabsTrigger value="vector">By vector</TabsTrigger>
            </TabsList>
            <TabsContent value="text">
              <form
                className="space-y-3 pt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  searchByText();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="text">Query text</Label>
                  <Textarea
                    id="text"
                    rows={3}
                    placeholder="Sorgu metnini yazın…"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Server embeds the text with the selected model and queries
                    its index. Requires the model's provider to be configured
                    (Workers AI for bge-m3, OPENAI_API_KEY for openai-3-small).
                  </p>
                </div>
                <Button type="submit" disabled={busy}>
                  <SearchIcon /> {busy ? "Searching…" : "Search"}
                </Button>
              </form>
            </TabsContent>
            <TabsContent value="vector">
              <form
                className="space-y-3 pt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  searchByVector();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="vec">Query vector</Label>
                  <Textarea
                    id="vec"
                    rows={3}
                    placeholder="0.12, 0.45, -0.31, …"
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma- or whitespace-separated floats. Must be exactly{" "}
                    <span className="font-mono">{dim}</span> values for{" "}
                    <span className="font-mono">{model}</span>.
                  </p>
                </div>
                <Button type="submit" disabled={busy}>
                  <SearchIcon /> {busy ? "Searching…" : "Search"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
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
              description="Either the index is empty for this model, or the query had no neighbours."
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
