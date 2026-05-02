import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface Match {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export const Vector = () => {
  const [raw, setRaw] = useState("");
  const [results, setResults] = useState<Match[]>([]);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setError(null);
    try {
      const values = raw
        .split(/[\s,]+/)
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      const res = await api<{ data: Match[] }>("/api/vector/query", {
        method: "POST",
        body: JSON.stringify({ values, topK: 10 }),
      });
      setResults(res.data);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-semibold">Vector search</h1>
      <Card>
        <CardHeader>
          <CardTitle>Query</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="0.12, 0.45, …"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <Button onClick={search}>Search</Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <ul className="space-y-1 text-sm">
            {results.map((m) => (
              <li key={m.id} className="flex justify-between border-b py-2">
                <span className="font-mono">{m.id}</span>
                <span className="text-muted-foreground">{m.score.toFixed(4)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};
