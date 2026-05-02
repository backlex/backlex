import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
}

export const Storage = () => {
  const [items, setItems] = useState<StoredObject[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    api<{ data: StoredObject[] }>("/api/storage")
      .then((r) => setItems(r.data))
      .catch((e: Error) => setError(e.message));
  };

  useEffect(refresh, []);

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Storage</h1>
        <Button onClick={refresh}>Refresh</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Card>
        <CardHeader>
          <CardTitle>Objects ({items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {items.map((o) => (
              <li key={o.key} className="flex items-center justify-between py-2 text-sm">
                <span className="font-mono">{o.key}</span>
                <span className="text-muted-foreground">{o.size} bytes</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};
