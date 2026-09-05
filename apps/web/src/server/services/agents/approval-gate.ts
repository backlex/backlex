/**
 * A tool call an agent may not make without a person's yes.
 *
 * What already bounded an agent answered "is this allowed at all": its own
 * admin-authored tool list, the caller's permission rules, and the caller's MCP
 * allowlist. None of them can say "allowed, but not unattended" — which is the
 * third leg of every current account of agent safety, after tool allowlisting
 * and identity binding, and the one this codebase was missing.
 *
 * ## Approve, then retry — deliberately not park-and-resume
 *
 * A flow that hits `approval.request` parks its remaining operations in the
 * request's `continuation` and is resumed by the settlement. An agent turn
 * could do the same, and that is the seamless design. This is not it, on
 * purpose:
 *
 *   - the settlement path and the expiry tick can both reach a parked
 *     continuation, and `approvals.ts` already carries a comment about running
 *     one twice. A continuation that is "the rest of an agent turn" is
 *     arbitrary tool calls — a second delete, a second payment;
 *   - the turn already persists every step to `agent_messages`, so re-asking
 *     costs one model call rather than a lost conversation.
 *
 * So the turn ENDS when it hits the gate, telling the model (and therefore the
 * reader) which request is waiting on whom. Once someone approves, the same
 * call in the same thread with the same arguments goes through. The cost is
 * that a human has to ask again; the gain is that no approval mechanism can
 * cause an operation to happen twice.
 *
 * ## What an approval covers
 *
 * Exactly one (thread, tool, arguments) triple. The same call with a different
 * row id is a different decision and asks again. It is not consumed on use —
 * the same call with the same arguments in the same conversation is the same
 * operation — and it expires on its own through the approvals service.
 */
import { matchesPattern } from "../../mcp/guards";
import { createApprovalRequest, listApprovalRequests } from "../approvals";
import { argsDigest } from "./canonical-args";
import type { Ctx } from "../../context";

/** The `subject.collection` every agent tool-call request is filed under, so
 *  the lookup is one indexed read rather than a scan of open requests. */
export const APPROVAL_SUBJECT = "agent.tool_call";

/**
 * Stable identity of one call: thread, tool, and a digest of the arguments
 * canonicalised at every depth.
 *
 * Keys are sorted so argument order cannot make the same call look like a new
 * one — the same reason the runner's per-turn duplicate guard sorts them — and
 * the sorting reaches nested objects, which is what the previous
 * replacer-array version could not do. See `canonical-args.ts`; approving one
 * `collections.batch` used to approve any other.
 */
export const callFingerprint = async (
  threadId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> => `${threadId}:${toolName}:${await argsDigest(args)}`;

/** Does this tool need a yes? Same glob grammar as an MCP allowlist, matched by
 *  the same function, so `collections.*` means the same thing in both places. */
export const requiresApproval = (toolName: string, patterns: string[] | null | undefined): boolean =>
  Array.isArray(patterns) && patterns.some((p) => matchesPattern(p, toolName));

export interface ApprovalGateInput {
  ctx: Ctx;
  tenantId: string;
  threadId: string;
  agentName: string;
  toolName: string;
  args: Record<string, unknown>;
  approvalTools: string[] | null | undefined;
  approvers: Array<{ email: string; name?: string }> | null | undefined;
  /** Who started the turn — recorded as the request's author. */
  userId: string | null;
}

/** The observation to hand the model instead of running the tool, or `null`
 *  when the call may proceed. */
export type GateResult = { text: string; isError: boolean } | null;

export const approvalGate = async (input: ApprovalGateInput): Promise<GateResult> => {
  const { ctx, tenantId, threadId, toolName, args } = input;
  if (!requiresApproval(toolName, input.approvalTools)) return null;

  const subject = {
    collection: APPROVAL_SUBJECT,
    id: await callFingerprint(threadId, toolName, args),
  };

  // Already said yes to this exact call in this conversation.
  const approved = await listApprovalRequests(ctx, tenantId, { status: "approved", subject, limit: 1 });
  if (approved.length > 0) return null;

  // Already asked and still waiting. Asking again on every turn would mail the
  // approvers once per attempt for one decision.
  const pending = await listApprovalRequests(ctx, tenantId, { status: "pending", subject, limit: 1 });
  if (pending.length > 0) {
    return {
      text:
        `${toolName} is waiting on approval request ${pending[0]?.id} and has not been run. ` +
        "Do not retry it; tell the person you are talking to that it needs a decision first.",
      isError: true,
    };
  }

  // A gate with nobody to ask is a gate that cannot open. Refusing is the only
  // safe reading: passing would mean "configured for approval, ran unapproved".
  const approvers = (input.approvers ?? []).filter((a) => a?.email);
  if (approvers.length === 0) {
    return {
      text:
        `${toolName} requires approval, but this agent has no approvers configured, ` +
        "so there is nobody who can grant it. The call was not run.",
      isError: true,
    };
  }

  const created = await createApprovalRequest(
    ctx,
    tenantId,
    {
      title: `${input.agentName} wants to run ${toolName}`,
      message:
        `The agent "${input.agentName}" reached a tool that needs a person's approval. ` +
        "It has not been run. Approving lets the agent make this exact call, with these " +
        "exact arguments, in this conversation.",
      approvers,
      subject,
      summary: [
        { label: "Tool", value: toolName },
        { label: "Arguments", value: clip(JSON.stringify(args)) },
      ],
    },
    input.userId,
  );

  return {
    text:
      `${toolName} needs approval before it can run, so it has NOT been run. ` +
      `Request ${created.request.id} was opened and sent to ${approvers.map((a) => a.email).join(", ")}. ` +
      "Say so plainly, and continue with whatever else you can do without it.",
    isError: true,
  };
};

/** Arguments go in front of a human in an email, so a huge payload is clipped
 *  rather than mailed in full. */
const clip = (s: string, max = 400): string => (s.length > max ? `${s.slice(0, max)}…` : s);
