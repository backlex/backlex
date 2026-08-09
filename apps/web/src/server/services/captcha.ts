/**
 * Captcha — the gate in front of the endpoints a stranger can reach.
 *
 * We already have rate limiting and sign-in lockout. Both bound how FAST an
 * attacker goes; neither asks whether there is a person there at all. That is
 * the gap: a public sign-up form, a password-reset that mails a real person,
 * and a public form-builder submission are all endpoints where the cost of
 * abuse lands on somebody other than the abuser.
 *
 * ## The decisions
 *
 * **Three providers, one verification shape.** Turnstile, hCaptcha and
 * reCAPTCHA all take `{ secret, response, remoteip }` as a form POST and answer
 * `{ success: boolean }`. The differences are the URL and one score field, so
 * the code that differs is a table rather than three implementations.
 *
 * **`onError` is stored, not defaulted, and the docs say why.** A captcha that
 * fails open protects nothing precisely when the provider is having a bad day —
 * which is a plausible thing for an attacker to arrange. A captcha that fails
 * closed turns the provider's outage into an outage of your sign-up. Neither is
 * safe to pick for an operator, so the choice is theirs, and it is written down
 * next to the consequence.
 *
 * **The secret is encrypted at rest** with `AUTH_SECRET`, and never leaves the
 * server — the site key is the public half and the only one an admin API
 * returns.
 *
 * **What is protected is a LIST, not a global switch.** The endpoints have
 * genuinely different costs: a sign-up creates a row, a password reset sends
 * mail to somebody who did not ask for it, a form submission can be the abuse
 * itself. An operator turning one on should not be forced to turn on the ones
 * that would break their own integration.
 */
import { AppError } from "@backlex/core";
import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/crypto";
import type { Ctx } from "../context";
import type { Env } from "../env";

type AnyDb = any;

const table = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.authConfig : sqlite.schema.authConfig) as typeof pg.schema.authConfig;

export const CAPTCHA_PROVIDERS = ["turnstile", "hcaptcha", "recaptcha"] as const;
export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number];

/** Endpoints a captcha can be put in front of. Each is a place a stranger can
 *  reach and make the workspace pay for it. */
export const CAPTCHA_TARGETS = [
  "sign-up",
  "sign-in",
  "password-reset",
  "forms",
] as const;
export type CaptchaTarget = (typeof CAPTCHA_TARGETS)[number];

const VERIFY_URL: Record<CaptchaProvider, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  hcaptcha: "https://api.hcaptcha.com/siteverify",
  recaptcha: "https://www.google.com/recaptcha/api/siteverify",
};

/** Ceiling on the provider round trip. A person is waiting on a sign-in. */
const VERIFY_TIMEOUT_MS = 4_000;

export interface CaptchaConfig {
  provider: CaptchaProvider;
  /** The public half — safe to hand to a browser, and the admin API returns it. */
  siteKey: string;
  /** `enc:v1:…`. Never returned by any read surface. */
  secretKey: string;
  protect: CaptchaTarget[];
  /**
   * What happens when the provider cannot answer. No default — see the header.
   * `deny` refuses the request; `allow` lets it through unverified.
   */
  onError: "allow" | "deny";
  enabled: boolean;
}

/** What an admin surface may read back. */
export interface CaptchaView {
  provider: CaptchaProvider | null;
  siteKey: string;
  protect: CaptchaTarget[];
  onError: "allow" | "deny";
  enabled: boolean;
  /** Presence only — the secret has no read-back path. */
  hasSecret: boolean;
}

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Read a stored captcha config.
 *
 * Three answers, as always: absent, readable, or present and unusable. The
 * third returns `null` — "no captcha" — rather than a partially-understood
 * config, because a half-read config would gate some endpoints and not others
 * with no way for the operator to tell which.
 */
export const readCaptchaConfig = (raw: unknown): CaptchaConfig | null => {
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const provider = o.provider;
  if (typeof provider !== "string" || !(CAPTCHA_PROVIDERS as readonly string[]).includes(provider)) {
    return null;
  }
  const siteKey = typeof o.siteKey === "string" ? o.siteKey : "";
  const secretKey = typeof o.secretKey === "string" ? o.secretKey : "";
  if (!siteKey || !secretKey) return null;
  const protect = Array.isArray(o.protect)
    ? o.protect.filter((t): t is CaptchaTarget =>
        (CAPTCHA_TARGETS as readonly string[]).includes(t as string),
      )
    : [];
  const onError = o.onError === "allow" ? "allow" : o.onError === "deny" ? "deny" : null;
  // A stored config with no `onError` is one written before the field existed
  // or by hand. `deny` is the reading that keeps the gate a gate.
  return {
    provider: provider as CaptchaProvider,
    siteKey,
    secretKey,
    protect,
    onError: onError ?? "deny",
    enabled: o.enabled !== false,
  };
};

export const toCaptchaView = (config: CaptchaConfig | null): CaptchaView => ({
  provider: config?.provider ?? null,
  siteKey: config?.siteKey ?? "",
  protect: config?.protect ?? [],
  onError: config?.onError ?? "deny",
  enabled: Boolean(config?.enabled),
  hasSecret: Boolean(config?.secretKey),
});

export const loadCaptchaConfig = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
): Promise<CaptchaConfig | null> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ captcha: t.captcha })
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .limit(1)) as Array<{ captcha: unknown }>;
  return readCaptchaConfig(rows[0]?.captcha ?? null);
};

export interface CaptchaInput {
  provider: CaptchaProvider;
  siteKey: string;
  /** Plaintext. Omit on update to keep the stored one. */
  secretKey?: string | null;
  protect: CaptchaTarget[];
  onError: "allow" | "deny";
  enabled?: boolean;
}

export const saveCaptchaConfig = async (
  ctx: Ctx,
  tenantId: string,
  input: CaptchaInput,
): Promise<CaptchaView> => {
  if (!(CAPTCHA_PROVIDERS as readonly string[]).includes(input.provider)) {
    throw new AppError("VALIDATION", `provider must be one of: ${CAPTCHA_PROVIDERS.join(", ")}`);
  }
  if (input.onError !== "allow" && input.onError !== "deny") {
    throw new AppError(
      "VALIDATION",
      "`onError` is required and has no safe default: `allow` means the gate stops working " +
        "exactly when the provider is having a bad day, `deny` turns their outage into yours.",
    );
  }
  if (!input.siteKey?.trim()) throw new AppError("VALIDATION", "`siteKey` is required");
  const existing = await loadCaptchaConfig(ctx, tenantId);
  const secretPlain = input.secretKey?.trim();
  if (!secretPlain && !existing?.secretKey) {
    throw new AppError("VALIDATION", "`secretKey` is required the first time");
  }
  const secretKey = secretPlain
    ? await encryptSecret(secretPlain, ctx.env.AUTH_SECRET)
    : existing!.secretKey;
  const unknownTargets = input.protect.filter(
    (t) => !(CAPTCHA_TARGETS as readonly string[]).includes(t),
  );
  if (unknownTargets.length) {
    // Refused rather than dropped: an operator who typed a target we do not
    // know has protected nothing and would not be told.
    throw new AppError(
      "VALIDATION",
      `Unknown captcha target(s): ${unknownTargets.join(", ")}. Valid: ${CAPTCHA_TARGETS.join(", ")}`,
    );
  }
  const config: CaptchaConfig = {
    provider: input.provider,
    siteKey: input.siteKey.trim(),
    secretKey,
    protect: input.protect,
    onError: input.onError,
    enabled: input.enabled ?? true,
  };
  const t = table(ctx.dialect);
  const stored = ctx.dialect === "pg" ? config : JSON.stringify(config);
  await (ctx.db as AnyDb)
    .insert(t)
    .values({ tenantId, captcha: stored, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: t.tenantId,
      set: { captcha: stored, updatedAt: new Date() },
    });
  return toCaptchaView(config);
};

export const clearCaptchaConfig = async (ctx: Ctx, tenantId: string): Promise<void> => {
  const t = table(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({ captcha: null, updatedAt: new Date() })
    .where(eq(t.tenantId, tenantId));
};

export type CaptchaVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "rejected" | "unreachable" };

/**
 * Ask the provider whether this token represents a person.
 *
 * The three providers agree on the wire format, so the only per-provider thing
 * is the URL. `remoteip` is sent when known — every provider uses it to score,
 * and omitting it makes a farm of tokens harder to spot.
 */
export const verifyCaptchaToken = async (
  env: Env,
  config: CaptchaConfig,
  token: string | null,
  remoteIp?: string | null,
): Promise<CaptchaVerdict> => {
  if (!token) return { ok: false, reason: "missing" };
  const secret = isEncryptedSecret(config.secretKey)
    ? await decryptSecret(config.secretKey, env.AUTH_SECRET)
    : config.secretKey;
  if (!secret) {
    // The stored secret cannot be decrypted — the deployment's AUTH_SECRET
    // changed. That is "the gate cannot run", not "the gate passed".
    return { ok: false, reason: "unreachable" };
  }
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(VERIFY_URL[config.provider], {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const json = (await res.json()) as { success?: unknown };
    return json.success === true ? { ok: true } : { ok: false, reason: "rejected" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
};

/**
 * Enforce the gate for one target, or do nothing when it is not configured.
 *
 * Throws `AppError` so the refusal travels the same path as every other one.
 * The message never distinguishes "rejected" from "unreachable" to the CALLER
 * — one is the person's problem and the other is ours, and telling an attacker
 * which is which tells them when the gate is down.
 */
export const enforceCaptcha = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  target: CaptchaTarget,
  token: string | null,
  remoteIp?: string | null,
): Promise<void> => {
  if (!tenantId) return;
  const config = await loadCaptchaConfig(ctx, tenantId);
  if (!config || !config.enabled || !config.protect.includes(target)) return;
  const verdict = await verifyCaptchaToken(ctx.env, config, token, remoteIp);
  if (verdict.ok) return;
  if (verdict.reason === "unreachable" && config.onError === "allow") {
    // The operator chose this, knowing what it means. Logged so the choice is
    // visible in hindsight rather than only in a config page.
    console.warn(`[captcha] ${config.provider} unreachable — allowing "${target}" per onError`);
    return;
  }
  throw new AppError("FORBIDDEN", "Captcha verification failed");
};

/** Pull the token out of a request. A header keeps it out of the body a
 *  caller's own schema validates, and out of logs that echo request bodies;
 *  the body field exists because a plain HTML form post has no other way. */
export const captchaTokenFrom = (
  req: Request,
  body?: Record<string, unknown> | null,
): string | null => {
  const header = req.headers.get("x-captcha-token");
  if (header) return header;
  const fromBody = body?.captchaToken;
  return typeof fromBody === "string" && fromBody ? fromBody : null;
};
