import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface Collection {
  slug: string;
  fields: Array<{ name: string; type: string }>;
  ownerScoped: boolean;
}

export const Collections = () => {
  const [items, setItems] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    api<{ data: Collection[] }>("/api/collections")
      .then((r) => setItems(r.data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Collections</h1>
        <Button onClick={refresh}>Refresh</Button>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <Card key={c.slug}>
            <CardHeader>
              <CardTitle className="font-mono text-sm">{c.slug}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {c.fields.map((f) => (
                  <li key={f.name}>
                    <span className="font-medium text-foreground">{f.name}</span>{" "}
                    <span className="text-xs">({f.type})</span>
                  </li>
                ))}
              </ul>
              {c.ownerScoped && (
                <p className="mt-2 text-xs text-muted-foreground">owner-scoped</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};
