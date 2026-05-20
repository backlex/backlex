// Collaboration tab for the item edit sheet — share card + comment thread.
//
// Both halves are real: the comment thread reads/writes /api/comments and
// the share card mints/revokes public read-only links via /api/shared-links.
import { useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { I } from "./icons";
import { Button, relativeTime } from "./ui";
import { authorById } from "./items";
import { commentsApi, sharedLinksApi, type ApiComment } from "./api";
import {
  useComments,
  useMe,
  useSharedLinks,
  queryKeys,
} from "./queries";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { Skeleton } from "@workeros/ui/components/skeleton";

/**
 * Public read-only share-link card. A signed-in user mints a `/s/<token>`
 * link to this record; the plaintext token is only returned at creation, so
 * for a link that already existed before this sheet opened we can only show
 * that one is active (with Revoke + Create-new actions), not the URL itself.
 */
function ShareLinkCard({
  collection,
  itemId,
  pushToast,
}: {
  collection: string;
  itemId: string;
  pushToast?: (m: string, type?: "success" | "error") => void;
}) {
  const qc = useQueryClient();
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const linksQuery = useSharedLinks(collection, itemId);
  const activeLink = linksQuery.data?.data[0] ?? null;

  const invalidate = () => {
    void qc.invalidateQueries({
      queryKey: queryKeys.sharedLinks(collection, itemId),
    });
  };

  const createMut = useMutation({
    mutationFn: () => sharedLinksApi.create({ collection, itemId }),
    onSuccess: (res) => {
      setFreshUrl(`${window.location.origin}${res.data.url}`);
      invalidate();
      pushToast?.("Share link created.");
    },
    onError: () => pushToast?.("Could not create share link.", "error"),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => sharedLinksApi.revoke(id),
    onSuccess: () => {
      setFreshUrl(null);
      invalidate();
      pushToast?.("Share link revoked.");
    },
    onError: () => pushToast?.("Could not revoke share link.", "error"),
  });

  const copy = (url: string) => {
    try {
      void navigator.clipboard.writeText(url);
      setCopied(true);
      pushToast?.("Share link copied.");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      pushToast?.("Could not copy link.", "error");
    }
  };

  return (
    <div className="card">
      <div
        className="card-section"
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        <I.Share size={13} />
        <span style={{ fontSize: 12.5, fontWeight: 500 }}>
          share this record
        </span>
      </div>
      <div
        style={{
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {linksQuery.isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : freshUrl ? (
          // Just-minted link — the only moment we can show the full URL.
          <div className="field">
            <label className="field-label">Public read-only link</label>
            <div style={{ display: "flex", gap: 6 }}>
              <Input
                className="font-mono"
                readOnly
                value={freshUrl}
                style={{ fontSize: 11.5, flex: 1 }}
              />
              <Button
                variant="outline"
                icon={copied ? I.Check : I.Copy}
                onClick={() => copy(freshUrl)}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <span className="field-hint">
              Anyone with this link can view the record — copy it now, the
              token is shown only once.
            </span>
          </div>
        ) : activeLink ? (
          // A link already exists but its token is no longer recoverable.
          <div className="field">
            <label className="field-label">Public read-only link</label>
            <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
              An active share link exists for this record. For security the
              link URL is shown only once, at creation. Revoke it and create a
              new one if you need a fresh copyable URL.
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <Button
                variant="outline"
                icon={I.Trash}
                onClick={() => revokeMut.mutate(activeLink.id)}
                disabled={revokeMut.isPending}
              >
                {revokeMut.isPending ? "Revoking…" : "Revoke"}
              </Button>
              <Button
                variant="outline"
                icon={I.Plus}
                onClick={() => createMut.mutate()}
                disabled={createMut.isPending || revokeMut.isPending}
              >
                Create new link
              </Button>
            </div>
          </div>
        ) : (
          // No link yet — offer to mint one.
          <div className="field">
            <label className="field-label">Public read-only link</label>
            <div
              style={{
                fontSize: 12,
                color: "var(--muted-foreground)",
                marginBottom: 2,
              }}
            >
              Mint a public link that shows this record read-only — no sign-in
              required to view it.
            </div>
            <Button
              variant="primary"
              icon={I.Share}
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
            >
              {createMut.isPending ? "Creating…" : "Create share link"}
            </Button>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span className="chip">
            <I.Eye size={11} /> read-only
          </span>
          <span className="chip">
            <I.Trash size={11} /> revocable anytime
          </span>
        </div>
      </div>
    </div>
  );
}

export function ItemCommentsPanel({
  collection,
  itemId,
  pushToast,
}: {
  collection: string;
  itemId: string;
  pushToast?: (m: string, type?: "success" | "error") => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const meQuery = useMe();
  const myUserId = meQuery.data?.data.id ?? null;
  const isAdmin = meQuery.data?.data.isAdmin ?? false;

  const commentsQuery = useComments(collection, itemId);
  const comments: ApiComment[] = commentsQuery.data?.data ?? [];
  // Server returns newest-first; render oldest-first so the thread reads
  // top-to-bottom like a conversation.
  const ordered = [...comments].reverse();

  const invalidate = () => {
    void qc.invalidateQueries({
      queryKey: queryKeys.comments(collection, itemId),
    });
  };

  const createMut = useMutation({
    mutationFn: (body: string) =>
      commentsApi.create({ collection, itemId, body }),
    onSuccess: () => {
      setDraft("");
      invalidate();
      pushToast?.("Comment posted.");
    },
    onError: () => pushToast?.("Could not post comment.", "error"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => commentsApi.remove(id),
    onSuccess: () => {
      invalidate();
      pushToast?.("Comment deleted.");
    },
    onError: () => pushToast?.("Could not delete comment.", "error"),
  });

  const send = () => {
    const text = draft.trim();
    if (!text || createMut.isPending) return;
    createMut.mutate(text);
  };

  const onDraftKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  const myAuthor = authorById(myUserId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Share — real, backed by /api/shared-links. */}
      <ShareLinkCard
        collection={collection}
        itemId={itemId}
        pushToast={pushToast}
      />

      {/* Comments — real, backed by /api/comments. */}
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.MessageSquare size={13} />
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>comments</span>
          <span className="font-mono" style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>
            {comments.length}
          </span>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {commentsQuery.isLoading ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : ordered.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", padding: "8px 0" }}>
              No comments yet — start the thread below.
            </div>
          ) : (
            ordered.map((c) => {
              const author = authorById(c.userId);
              const canDelete = isAdmin || (!!myUserId && c.userId === myUserId);
              return (
                <div key={c.id} className="comment">
                  <div className="avatar-xs">{author.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{author.name}</span>
                      <span className="font-mono" style={{ fontSize: 10.5, color: "var(--muted-foreground)" }}>
                        {relativeTime(c.createdAt)}
                      </span>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={I.Trash}
                          onClick={() => deleteMut.mutate(c.id)}
                          disabled={deleteMut.isPending}
                          style={{ marginLeft: "auto" }}
                        />
                      )}
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--foreground)", marginTop: 2 }}>{c.body}</div>
                  </div>
                </div>
              );
            })
          )}
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
          <div className="avatar-xs" style={{ marginTop: 4 }}>{myAuthor.initials}</div>
          <Textarea
            placeholder="Write a comment · ⌘+Enter to send"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            rows={2}
            style={{ minHeight: 60, fontSize: 12.5, flex: 1 }}
          />
          <Button
            variant="primary"
            size="sm"
            icon={I.Send}
            onClick={send}
            disabled={!draft.trim() || createMut.isPending}
          >
            {createMut.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
