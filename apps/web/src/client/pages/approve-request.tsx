// Public, unauthenticated decision page — `/approve/:token`.
//
// The approver has no account and never gets one. The token in the URL is the
// whole grant, so this page talks only to `/api/public/approve/:token`.
//
// Two things here are deliberate rather than stylistic:
//
// - The page is self-styled with a `<style>` block rather than the admin
//   design system, exactly like the public signing and form pages: somebody
//   answering one question in an email should not be loading the admin
//   bundle's theme, and a fixed light/dark pair is stable regardless of what
//   the workspace runs.
// - The summary is rendered as ESCAPED TEXT in a plain table, never as markup.
//   It is frozen row data chosen by an operator, and this page has no reason to
//   let it bring its own HTML.
import { useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { approvePublicApi, type ApiApprovalDecisionView } from "@/admin/api";

const CSS = `
.bxa { --bg:#f4f4f7; --card:#fff; --text:#16151f; --muted:#5f5c72; --line:#e2e0ea;
  --accent:#4c39d4; --accent-fg:#fff; --ok:#15803d; --danger:#b3261e; --pad:#fbfbfd;
  min-height:100dvh; background:var(--bg); color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
@media (prefers-color-scheme: dark){ .bxa{ --bg:#0b0a12; --card:#141222; --text:#eceaf7;
  --muted:#a09bbd; --line:#282343; --accent:#8b7bff; --accent-fg:#100c22; --ok:#4ade80;
  --danger:#ff8a80; --pad:#1b1830; } }
.bxa-wrap{ max-width:620px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
.bxa-card{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; }
.bxa h1{ font-size:20px; margin:0 0 4px; font-weight:650; letter-spacing:-.01em; }
.bxa-sub{ color:var(--muted); font-size:13px; margin:0; }
.bxa-sum{ width:100%; border-collapse:collapse; margin:14px 0 0; font-size:14px; }
.bxa-sum td{ padding:7px 0; border-top:1px solid var(--line); vertical-align:top; }
.bxa-sum td:first-child{ color:var(--muted); width:40%; padding-right:14px; }
.bxa-row{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.bxa-btn{ appearance:none; border:1px solid var(--line); background:transparent; color:var(--text);
  border-radius:9px; padding:10px 14px; font:inherit; font-weight:550; cursor:pointer; }
.bxa-btn:disabled{ opacity:.5; cursor:not-allowed; }
.bxa-btn-primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxa-btn-danger{ color:var(--danger); border-color:var(--danger); }
.bxa-input{ width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:9px;
  background:var(--pad); color:var(--text); font:inherit; padding:10px 12px; }
.bxa-err{ color:var(--danger); font-size:13px; margin:0; }
.bxa-note{ color:var(--muted); font-size:12px; margin:0; }
.bxa-badge{ display:inline-block; border:1px solid var(--line); border-radius:999px;
  padding:3px 10px; font-size:12px; color:var(--muted); }
.bxa-ok{ color:var(--ok); }
.bxa-no{ color:var(--danger); }
.bxa-skel{ background:var(--line); border-radius:8px; animation:bxa-pulse 1.4s ease-in-out infinite; }
@keyframes bxa-pulse{ 0%,100%{opacity:.55} 50%{opacity:.95} }
@media (max-width:640px){ .bxa{ padding:10px; } .bxa-card{ padding:14px; border-radius:12px; }
  .bxa-row{ justify-content:flex-end; } .bxa-row .bxa-grow{ margin-right:auto; } }
`;

const Skeleton = () => (
  <div className="bxa-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div className="bxa-skel" style={{ height: 22, width: "58%" }} />
    <div className="bxa-skel" style={{ height: 14, width: "38%" }} />
    <div className="bxa-skel" style={{ height: 96, width: "100%" }} />
    <div className="bxa-skel" style={{ height: 40, width: "45%" }} />
  </div>
);

export function ApproveRequest() {
  const { token = "" } = useParams();
  const { t } = useLingui();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ outcome: string } | null>(null);

  const q = useQuery({
    queryKey: ["public-approval", token],
    queryFn: () => approvePublicApi.get(token),
    retry: false,
  });

  const view: ApiApprovalDecisionView | undefined = q.data?.data;

  const decide = async (decision: "approve" | "reject") => {
    setError(null);
    // Refused before the round-trip so the message lands next to the box the
    // approver has to fill in, rather than as a 422 from somewhere else.
    if (decision === "reject" && !reason.trim()) {
      setError(t`Please say why you are rejecting this.`);
      return;
    }
    setBusy(decision);
    try {
      const out = await approvePublicApi.decide(token, decision, reason.trim() || undefined);
      setDone({ outcome: out.data.outcome });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bxa">
      <style>{CSS}</style>
      <div className="bxa-wrap">
        {q.isPending ? (
          <Skeleton />
        ) : q.isError || !view ? (
          <div className="bxa-card">
            <h1><Trans>This link is not valid</Trans></h1>
            <p className="bxa-sub">
              <Trans>It may have been withdrawn, already used, or replaced by a newer one.</Trans>
            </p>
          </div>
        ) : done ? (
          <div className="bxa-card">
            <h1>
              {done.outcome === "approved" ? (
                <span className="bxa-ok"><Trans>Approved</Trans></span>
              ) : done.outcome === "rejected" ? (
                <span className="bxa-no"><Trans>Rejected</Trans></span>
              ) : (
                <Trans>Thank you — your answer is recorded</Trans>
              )}
            </h1>
            <p className="bxa-sub">
              <Trans>Your decision has been recorded. You can close this page.</Trans>
            </p>
          </div>
        ) : (
          <>
            <div className="bxa-card">
              <h1>{view.title}</h1>
              <p className="bxa-sub">
                {view.you.of > 1 ? (
                  <Trans>
                    You are approver {view.you.position} of {view.you.of}.
                  </Trans>
                ) : (
                  <Trans>You have been asked to approve this.</Trans>
                )}
                {view.you.role ? ` · ${view.you.role}` : ""}
              </p>
              {view.message ? <p style={{ marginTop: 10 }}>{view.message}</p> : null}
              {view.summary.length > 0 ? (
                <table className="bxa-sum">
                  <tbody>
                    {view.summary.map((row, i) => (
                      <tr key={i}>
                        <td>{row.label}</td>
                        <td>{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>

            {view.blocked ? (
              <div className="bxa-card">
                <p className="bxa-sub">{view.blocked}</p>
              </div>
            ) : (
              <div className="bxa-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label htmlFor="bxa-reason" className="bxa-sub">
                    <Trans>Reason — required to reject, optional to approve</Trans>
                  </label>
                  <input
                    id="bxa-reason"
                    className="bxa-input"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t`Add a note`}
                    maxLength={1000}
                  />
                </div>
                {error ? <p className="bxa-err">{error}</p> : null}
                <div className="bxa-row">
                  <span className="bxa-badge bxa-grow">{view.you.email}</span>
                  <button
                    type="button"
                    className="bxa-btn bxa-btn-danger"
                    disabled={busy != null}
                    onClick={() => decide("reject")}
                  >
                    {busy === "reject" ? t`Rejecting…` : t`Reject`}
                  </button>
                  <button
                    type="button"
                    className="bxa-btn bxa-btn-primary"
                    disabled={busy != null}
                    onClick={() => decide("approve")}
                  >
                    {busy === "approve" ? t`Approving…` : t`Approve`}
                  </button>
                </div>
                {view.ordered ? (
                  <p className="bxa-note">
                    <Trans>This request is decided in order — the next person is asked once you answer.</Trans>
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
