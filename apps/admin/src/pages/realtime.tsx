import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const Realtime = () => {
  const [channel, setChannel] = useState("demo");
  const [messages, setMessages] = useState<string[]>([]);
  const [text, setText] = useState("");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/realtime/${channel}/subscribe`);
    es.addEventListener("message", (e) => {
      setMessages((m) => [...m, e.data]);
    });
    esRef.current = es;
    return () => es.close();
  }, [channel]);

  const send = async () => {
    await fetch(`/api/realtime/${channel}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setText("");
  };

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-semibold">Realtime</h1>
      <Card>
        <CardHeader>
          <CardTitle>Channel: {channel}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={channel} onChange={(e) => setChannel(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Message"
            />
            <Button onClick={send}>Publish</Button>
          </div>
          <ul className="max-h-64 space-y-1 overflow-auto text-sm">
            {messages.map((m, i) => (
              <li key={i} className="font-mono">
                {m}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};
