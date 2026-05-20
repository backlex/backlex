// Collaboration tab for the item edit sheet — share card + comment thread.
//
// Mock-only for now: the share token, comment list, and composer all live in
// local component state. Wire to /api/comments when that lands.
import { useState, type KeyboardEvent } from "react";
import { I } from "./icons";
import { Button } from "./ui";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";

interface Comment {
  id: string;
  who: string;
  initials: string;
  t: string;
  body: string;
}

// TODO(comments): replace with /api/comments when the endpoint lands.
const SEED_COMMENTS: Comment[] = [
  { id: "c_01", who: "kai", initials: "KT", t: "2m ago", body: "Can you confirm the cf-image fit param before I publish?" },
  { id: "c_02", who: "rana", initials: "RM", t: "1m ago", body: "Going with fit=cover for now — we can revisit when we ship the responsive image helper." },
  { id: "c_03", who: "priya", initials: "PR", t: "just now", body: "+1 — same call we made on the docs site." },
];

const SHARE_URL = "https://workeros.dev/s/01HZ7K8Q6XYZ?token=sv1_a4e2b9c1f0";
const SHARE_URL_DISPLAY = "https://workeros.dev/s/01HZ7K8Q6XYZ?token=sv1_a4e…";

export function ItemCommentsPanel({ pushToast }: { pushToast?: (m: string, type?: "success" | "error") => void }) {
  const [items, setItems] = useState<Comment[]>(SEED_COMMENTS);
  const [draft, setDraft] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setItems((arr) => [
      ...arr,
      {
        id: "c_" + Math.random().toString(36).slice(2, 6),
        who: "rana",
        initials: "RM",
        t: "just now",
        body: text,
      },
    ]);
    setDraft("");
    pushToast?.("Comment posted.");
  };

  const copyShare = () => {
    try {
      void navigator.clipboard.writeText(SHARE_URL);
      setShareCopied(true);
      pushToast?.("Share link copied.");
      setTimeout(() => setShareCopied(false), 1800);
    } catch {
      pushToast?.("Could not copy link.", "error");
    }
  };

  const onDraftKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Share */}
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Share size={13} />
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>share this record</span>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="field">
            <label className="field-label">Public read-only link</label>
            <div style={{ display: "flex", gap: 6 }}>
              <Input className="font-mono" readOnly value={SHARE_URL_DISPLAY} style={{ fontSize: 11.5, flex: 1 }} />
              <Button variant="outline" icon={shareCopied ? I.Check : I.Copy} onClick={copyShare}>
                {shareCopied ? "Copied" : "Copy"}
              </Button>
            </div>
            <span className="field-hint">
              Signed view token, expires in 7d · revocable from <span className="font-mono">api_keys</span>.
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="chip">
              <I.Eye size={11} /> read-only
            </span>
            <span className="chip">
              <I.Clock size={11} /> 7d expiry
            </span>
            <span className="chip">
              <I.Lock size={11} /> password off
            </span>
          </div>
        </div>
      </div>

      {/* Comments */}
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.MessageSquare size={13} />
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>comments</span>
          <span className="font-mono" style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>
            {items.length}
          </span>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((c) => (
            <div key={c.id} className="comment">
              <div className="avatar-xs">{c.initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>{c.who}</span>
                  <span className="font-mono" style={{ fontSize: 10.5, color: "var(--muted-foreground)" }}>
                    {c.t}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--foreground)", marginTop: 2 }}>{c.body}</div>
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            padding: 12,
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
          }}
        >
          <div className="avatar-xs" style={{ marginTop: 4 }}>RM</div>
          <Textarea
            placeholder="Write a comment · @-mention to notify · ⌘+Enter to send"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            rows={2}
            style={{ minHeight: 60, fontSize: 12.5, flex: 1 }}
          />
          <Button variant="primary" size="sm" icon={I.Send} onClick={send} disabled={!draft.trim()}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
