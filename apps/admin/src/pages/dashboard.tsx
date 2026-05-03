import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

interface Health {
  ok: boolean;
  dialect: string;
  ts: number;
}

export const Dashboard = () => {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Health>("/health").then(setHealth).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>API</CardTitle>
          </CardHeader>
          <CardContent>
            {error && <p className="text-destructive text-sm">{error}</p>}
            {health && (
              <ul className="text-sm text-muted-foreground">
                <li>status: {health.ok ? "ok" : "down"}</li>
                <li>dialect: {health.dialect}</li>
                <li>ts: {new Date(health.ts).toLocaleTimeString()}</li>
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
