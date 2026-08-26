import { AppError, type PdfAdapter, type PdfPageOptions } from "@backlex/core";
import type { Env } from "../env";
import { cloudPost } from "../lib/cloud-report";
import { assertMargins, formatOf, marginsOf, printBackgroundOf } from "./pdf.shared";

/**
 * Managed-cloud PDF adapter.
 *
 * A provisioned cloud project has no environment of its own to put credentials
 * in — its Worker bindings are written by the provisioner — so the honest
 * self-host instruction ("set PDF_CF_ACCOUNT_ID + PDF_CF_API_TOKEN, or
 * PDF_GOTENBERG_URL") is advice a managed customer cannot act on. Until this
 * existed, a Pro-tier tenant got the same 422 from BOTH document generation and
 * e-signature — freezing a document for signing is a render, so
 * `POST /api/admin/signatures` failed with a message about PDF environment
 * variables it had never heard of and could not set.
 *
 * The platform's Cloudflare credentials stay on the control plane and the HTML
 * comes to them, rather than the credentials going out to every tenant worker:
 * a token in a tenant binding is one sandbox escape away from being someone
 * else's, and it would be the platform's. Same rail as managed AI
 * (`embedding.cloud.ts`) and managed email — `cloudPost` signs with the
 * project's `CLOUD_REPORT_SECRET`, so an instance can only render as itself.
 *
 * Selected only when the operator has configured nothing themselves: a tenant
 * that brings its own renderer keeps it (see `selectPdfAdapter`).
 */
export const cloudPdf = (env: Env): PdfAdapter => ({
  name: "cloud-gateway",
  async render(html: string, opts?: PdfPageOptions): Promise<Uint8Array> {
    const margin = marginsOf(opts?.margin);
    assertMargins(margin);
    // Normalised here, not on the gateway: the gateway forwards only the keys
    // it recognises, so anything it does not understand is simply dropped, and
    // a page option that silently stopped applying is the kind of bug that
    // shows up as "the margins are wrong" months later.
    const options: Record<string, unknown> = {
      format: formatOf(opts).toLowerCase(),
      printBackground: printBackgroundOf(opts),
      margin,
    };
    if (opts?.landscape !== undefined) options.landscape = opts.landscape;
    if (opts?.headerHtml || opts?.footerHtml) {
      options.displayHeaderFooter = true;
      options.headerTemplate = opts.headerHtml ?? "<span></span>";
      options.footerTemplate = opts.footerHtml ?? "<span></span>";
    }

    let res: Response;
    try {
      res = await cloudPost(env, "/api/internal/pdf/render", { html, options });
    } catch (e) {
      throw new AppError(
        "INTERNAL",
        `Managed PDF gateway unreachable: ${e instanceof Error ? e.message : "error"}`,
      );
    }
    if (!res.ok) {
      let message = `Managed PDF gateway returned ${res.status}`;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j?.error?.message) message = j.error.message;
      } catch {
        // keep the status-based message
      }
      // 429 (throttled) and 413 (too large) are the operator's to act on;
      // everything else is ours.
      throw new AppError(res.status === 429 || res.status === 413 ? "VALIDATION" : "INTERNAL", message);
    }
    return new Uint8Array(await res.arrayBuffer());
  },
});
