/**
 * Report delivery — a dashboard, printed and posted.
 *
 * Every part of this already existed. Dashboards run their panels (#6), a
 * renderer turns HTML into a PDF (#28), and mail carries attachments (#27).
 * What was missing was the join: nothing walked from "this dashboard" to "a
 * file in an inbox on the first of the month", so the numbers only reached
 * whoever remembered to open the admin.
 *
 * The whole feature is this one function plus a flow op that calls it. It runs
 * the dashboard with the CALLER's identity — a report is not an embed, and
 * there is no anonymous path into it — builds the page with the pure builder in
 * `@backlex/core`, renders, stores, and optionally mails.
 *
 * ## Where the artefact lands, and why it matters
 *
 * Under `documents/<tenant>/<uuid>/<name>.pdf`, the same prefix a
 * `document.render` op writes to. That is not tidiness: `emailAttachments` in
 * `services/flows.ts` refuses to attach a key outside the running workspace's
 * document prefix, and that check is what stops a flow mailing out another
 * tenant's contract. Writing reports anywhere else would mean either a second
 * prefix in that guard or a report that cannot be attached by a later `email`
 * op — so it shares the one prefix and the one guard.
 */
import {
  AppError,
  buildReportHtml,
  type AuthSubject,
  type PdfPageOptions,
  type ReportPanel,
} from "@backlex/core";
import type { Ctx } from "../context";
import { getDashboard, runDashboard, type PanelResult } from "./dashboards";
import { renderDocument, safeFilename } from "./documents";
import { sendTemplatedEmail } from "./email";
import { loadAppSettings } from "./settings";

/** Deliberately permissive but structural — matches `services/signatures.ts`,
 *  because the address has to survive being put in a `To:` header. */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** One report may not be mailed to an arbitrary list. A flow that resolved its
 *  recipients from a row could otherwise turn a scheduled report into a bulk
 *  send with the workspace's own data as the payload. */
export const MAX_REPORT_RECIPIENTS = 25;

export interface ReportEmailInput {
  /** One address, or several separated by commas. */
  to: string;
  subject?: string;
  /** An `email_templates` key for the covering message. Without one the body
   *  falls back to a plain sentence naming the dashboard. */
  templateKey?: string;
}

export interface DeliverReportInput {
  dashboardId: string;
  /** Overrides the default `<dashboard-name>-<date>.pdf`. */
  filename?: string;
  pageOptions?: PdfPageOptions;
  /** Omit to render + store only. The key comes back either way, so a flow can
   *  attach it to a mail it composes itself. */
  email?: ReportEmailInput;
}

export interface DeliveredReport {
  /** Storage key of the stored PDF — attachable by a later `email` op. */
  key: string;
  filename: string;
  size: number;
  renderer: string;
  dashboard: { id: string; name: string };
  panels: number;
  /** Panels that ran but failed. Reported rather than swallowed: the PDF prints
   *  the error, and a caller watching a scheduled run should see it too. */
  failedPanels: number;
  /** Addresses the report was mailed to. Empty when `email` was omitted. */
  sentTo: string[];
  /** True when the configured transport cannot carry attachments (the managed
   *  cloud gateway). The covering mail still went — WITHOUT the report. */
  attachmentsDropped?: boolean;
}

export const parseRecipients = (raw: string): string[] => {
  const list = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw new AppError("VALIDATION", "A report email needs at least one recipient");
  if (list.length > MAX_REPORT_RECIPIENTS) {
    throw new AppError(
      "VALIDATION",
      `A report goes to at most ${MAX_REPORT_RECIPIENTS} recipients (got ${list.length})`,
    );
  }
  for (const email of list) {
    if (!EMAIL_RE.test(email)) throw new AppError("VALIDATION", `"${email}" is not a valid recipient`);
  }
  return list;
};

/** `2026-08-02` in the workspace's zone — a report named for the day it covers
 *  in the reader's calendar, not the server's. */
const dateSlug = (at: Date, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
};

const toReportPanel = (p: PanelResult): ReportPanel => ({
  name: p.name,
  viz: p.viz,
  subtitle: describePanel(p),
  data: Array.isArray(p.data) ? p.data : [],
  note: p.note ?? null,
  error: p.error ?? null,
});

/** The same one-liner the admin shows under a panel title, rebuilt server-side
 *  from the panel's own config so the printed page reads like the screen. */
const describePanel = (p: PanelResult): string | null => {
  const cfg = (p.config ?? {}) as { collection?: string; agg?: string; field?: string; groupBy?: string; metric?: string };
  if (p.kind === "items-aggregate") {
    const fn = !cfg.agg || cfg.agg === "count" ? "count" : `${cfg.agg}(${cfg.field ?? "?"})`;
    return `${cfg.collection ?? "collection"} · ${fn}${cfg.groupBy ? ` by ${cfg.groupBy}` : ""}`;
  }
  if (p.kind === "analytics") return `analytics · ${cfg.metric ?? "series"}`;
  if (p.kind === "sql") return "sql";
  return p.kind || null;
};

/**
 * Render a dashboard to a PDF, store it, and optionally mail it.
 *
 * `now` is a parameter so a test can pin the stamp; every caller in production
 * passes nothing and gets the real clock.
 */
export async function deliverReport(
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  input: DeliverReportInput,
  now: Date = new Date(),
): Promise<DeliveredReport> {
  const dashboardId = String(input.dashboardId ?? "").trim();
  if (!dashboardId) throw new AppError("VALIDATION", "A report needs a dashboardId");

  const dashboard = await getDashboard(ctx, tenantId, dashboardId);
  if (!dashboard) throw new AppError("NOT_FOUND", `Dashboard "${dashboardId}" not found`);

  // Validated BEFORE the render. A bad address should not cost a PDF nobody
  // will receive — and on a cron flow, cost one every hour.
  const recipients = input.email ? parseRecipients(input.email.to) : [];

  const settings = await loadAppSettings(ctx.db, ctx.dialect, tenantId || null);
  const panels = await runDashboard(ctx, auth, tenantId, dashboardId);

  const html = buildReportHtml({
    title: dashboard.name,
    description: dashboard.description,
    generatedAt: now,
    timeZone: settings.timezone,
    locale: settings.i18nDefaultLocale,
    panels: panels.map(toReportPanel),
  });

  const filename = safeFilename(
    input.filename?.trim() || `${dashboard.name}-${dateSlug(now, settings.timezone)}`,
  );

  const rendered = await renderDocument(ctx, tenantId || null, {
    html,
    filename,
    // The page is already built. See `RenderDocumentInput.interpolate` — a row
    // that legitimately contains `{{ … }}` must reach the reader unchanged.
    interpolate: false,
    ...(input.pageOptions ? { pageOptions: input.pageOptions } : {}),
  });

  // Random key, tenant-prefixed. Same rule as `document.render`: the filename
  // is derived from a dashboard NAME an operator typed, so deriving the object
  // path from it would let that name choose where the object lands.
  const key = `documents/${tenantId || "shared"}/${crypto.randomUUID()}/${rendered.filename}`;
  const stored = await ctx.storage.put({
    key,
    body: rendered.bytes,
    contentType: rendered.contentType,
  });

  const out: DeliveredReport = {
    key,
    filename: rendered.filename,
    size: stored.size,
    renderer: rendered.renderer,
    dashboard: { id: dashboard.id, name: dashboard.name },
    panels: panels.length,
    failedPanels: panels.filter((p) => p.error).length,
    sentTo: [],
  };

  if (!input.email) return out;

  const subject = input.email.subject?.trim() || `${dashboard.name} — report`;
  const attachment = {
    filename: rendered.filename,
    content: toBase64(rendered.bytes),
    contentType: rendered.contentType,
  };
  // One mail per recipient rather than one with everyone in `To:` — a monthly
  // report is internal, but the address list is not something the requester
  // asked to publish to the others on it.
  let attachmentsDropped = false;
  for (const to of recipients) {
    const res = await sendTemplatedEmail(ctx, {
      to,
      ...(input.email.templateKey ? { templateKey: input.email.templateKey } : {}),
      tenantId: tenantId || null,
      vars: {
        dashboard: { id: dashboard.id, name: dashboard.name, description: dashboard.description },
        report: { filename: rendered.filename, panels: panels.length, generatedAt: now.toISOString() },
      },
      fallback: {
        subject,
        html: `<p>${escapeText(dashboard.name)} is attached as a PDF.</p>`,
        text: `${dashboard.name} is attached as a PDF.`,
      },
      attachments: [attachment],
    });
    if (res.attachmentsDropped) attachmentsDropped = true;
    out.sentTo.push(to);
  }
  if (attachmentsDropped) out.attachmentsDropped = true;
  return out;
}

const escapeText = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

/** Chunked so a multi-megabyte report does not blow the argument limit the
 *  spread form of `String.fromCharCode` has. */
const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
};
