/**
 * JWT signing keys, as rows with a life cycle.
 *
 * See the schema comment for the four states. This file is the machine that
 * moves between them, plus the two things that make the feature safe to turn
 * on: a precedence rule that cannot strand an existing deployment, and a cache
 * whose staleness is bounded and STATED.
 *
 * ## Precedence — an env deployment keeps working
 *
 * If there are no rows, nothing changes: `AUTH_JWT_PRIVATE_KEY` signs, exactly
 * as before. If there IS a row in `in_use`, it signs — and the env key is still
 * published as a verify-only key, because tokens it already minted are in the
 * wild and their `exp` is the only thing that ends them.
 *
 * ## The asymmetry that is the point of the design
 *
 * An external verifier reads `/.well-known/jwks.json` and caches it, so
 * revoking a key reaches them whenever their cache expires — minutes, and not
 * something we control. Our OWN verification does not read that document: it
 * reads these rows, behind a {@link KEY_CACHE_TTL_MS} cache that any transition
 * clears in the isolate that made it.
 *
 * So revocation is effective here within ten seconds instance-wide (immediately
 * in the isolate that performed it) while external verifiers stay cache-fast.
 * That is the whole reason internal verification does not just fetch its own
 * JWKS, and it is stated rather than implied because ten seconds is not zero:
 * a key revocation is a coarse instrument, and revoking a SESSION is still the
 * instant one.
 */
import { and, asc, eq, ne } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import {
  describePublicKey,
  importPrivatePem,
  importPublicPem,
  pemFromKey,
  registerSigningKeySource,
  verifierForJwk,
  type JwtAlg,
  type KeyMaterial,
  type PublicJwk,
} from "../lib/jwt-keys";
import type { Ctx } from "../context";
import type { Env } from "../env";

type AnyDb = any;

const table = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.signingKeys : sqlite.schema.signingKeys) as typeof pg.schema.signingKeys;

export const KEY_STATUSES = ["standby", "in_use", "previously_used", "revoked"] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

/** How long resolved key material is reused before the rows are re-read. Short,
 *  because it bounds how long a revoked key keeps verifying here. */
export const KEY_CACHE_TTL_MS = 10_000;

export interface SigningKeyRow {
  id: string;
  kid: string;
  alg: string;
  privateKey: string;
  publicKey: string;
  status: string;
  note: string | null;
  createdAt: Date | number | null;
  activatedAt: Date | number | null;
  retiredAt: Date | number | null;
  revokedAt: Date | number | null;
}

/** What an admin surface reads back. The private half never appears. */
export interface SigningKeyView {
  id: string;
  kid: string;
  alg: JwtAlg;
  status: KeyStatus;
  note: string | null;
  createdAt: number | null;
  activatedAt: number | null;
  retiredAt: number | null;
  revokedAt: number | null;
  /** True while this key's public half is in `/.well-known/jwks.json`. */
  published: boolean;
}

const ms = (v: Date | number | null): number | null =>
  v === null ? null : v instanceof Date ? v.getTime() : v;

const asStatus = (raw: string): KeyStatus =>
  (KEY_STATUSES as readonly string[]).includes(raw) ? (raw as KeyStatus) : "revoked";

/** A status we do not recognise reads as `revoked`: an unusable row must not
 *  sign anything and must not verify anything. */
export const toView = (row: SigningKeyRow): SigningKeyView => {
  const status = asStatus(row.status);
  return {
    id: row.id,
    kid: row.kid,
    alg: row.alg === "RS256" ? "RS256" : "ES256",
    status,
    note: row.note,
    createdAt: ms(row.createdAt),
    activatedAt: ms(row.activatedAt),
    retiredAt: ms(row.retiredAt),
    revokedAt: ms(row.revokedAt),
    published: status !== "revoked",
  };
};

// --- cache ------------------------------------------------------------------

/**
 * Keyed by the DATABASE, not module-global.
 *
 * A single `let` would be shared by every context an isolate ever builds — one
 * database's key material answering another's reads. That is a real hazard in
 * the test suite (a harness per spec) and a latent one anywhere a process
 * serves more than one database, and a WeakMap costs nothing to avoid it.
 */
const caches = new WeakMap<
  object,
  { at: number; material: KeyMaterial | null; gen: number }
>();

/** Drop the memoized material. Called by every transition, and exported so a
 *  test can prove a transition takes effect rather than waiting out the TTL.
 *  Clears EVERY database's entry: a transition is rare, and a caller that had
 *  to name the right database would eventually name the wrong one. */
export const invalidateSigningKeys = (): void => {
  generation += 1;
};

/** Bumped by {@link invalidateSigningKeys}; a cache entry from an older
 *  generation is ignored. Cheaper and more total than walking a WeakMap. */
let generation = 0;

// --- reading ----------------------------------------------------------------

const listRows = async (ctx: {
  db: unknown;
  dialect: "pg" | "sqlite";
}): Promise<SigningKeyRow[]> => {
  const t = table(ctx.dialect);
  try {
    return (await (ctx.db as AnyDb)
      .select()
      .from(t)
      .orderBy(asc(t.createdAt))) as SigningKeyRow[];
  } catch {
    // The table may predate the migration on an older instance. No rows means
    // "env keys only", which is exactly the pre-feature behaviour.
    return [];
  }
};

export const listSigningKeys = async (ctx: Ctx): Promise<SigningKeyView[]> =>
  (await listRows(ctx)).map(toView);

/**
 * Build key material from the rows, or `null` when there are none.
 *
 * `null` — not an empty material — is what lets `jwtKeyMaterial` fall back to
 * the env keys. An empty material would mean "this instance has no asymmetric
 * keys", which for a deployment with `AUTH_JWT_PRIVATE_KEY` set would silently
 * downgrade every token to HS256.
 */
export const dbKeyMaterial = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite"; env: Env },
): Promise<KeyMaterial | null> => {
  const now = Date.now();
  const key = ctx.db as object;
  const hit = caches.get(key);
  if (hit && hit.gen === generation && now - hit.at < KEY_CACHE_TTL_MS) return hit.material;
  const rows = await listRows(ctx);
  if (rows.length === 0) {
    caches.set(key, { at: now, material: null, gen: generation });
    return null;
  }
  const material: KeyMaterial = { signing: null, verify: new Map(), jwks: [] };
  for (const row of rows) {
    const status = asStatus(row.status);
    // A revoked key is not published and does not verify. That is the entire
    // effect of the state, so it is applied before anything is imported.
    if (status === "revoked") continue;
    let jwk: PublicJwk;
    try {
      const pub = await importPublicPem(row.publicKey);
      jwk = (await describePublicKey(pub.alg, pub.key)).jwk;
    } catch {
      // An unreadable public half cannot verify anything; skipping it is the
      // fail-closed reading. Logged, because a key nobody can parse is a
      // configuration problem somebody has to see.
      console.error(`[signing-keys] public key ${row.kid} could not be parsed`);
      continue;
    }
    material.jwks.push(jwk);
    material.verify.set(jwk.kid, { alg: jwk.alg, key: await verifierForJwk(jwk) });
    if (status !== "in_use") continue;
    const pem = await decryptSecret(row.privateKey, ctx.env.AUTH_SECRET);
    if (!pem) {
      // The deployment's AUTH_SECRET changed. Signing with nothing is better
      // than signing with a key we cannot read — and the verify half above
      // still stands, so tokens already out there keep working.
      console.error(`[signing-keys] private key ${row.kid} could not be decrypted`);
      continue;
    }
    try {
      const priv = await importPrivatePem(pem);
      material.signing = { alg: priv.alg, kid: jwk.kid, key: priv.key };
    } catch {
      console.error(`[signing-keys] private key ${row.kid} could not be imported`);
    }
  }
  caches.set(key, { at: now, material, gen: generation });
  return material;
};

/**
 * Point `jwtKeyMaterial` at this instance's rows.
 *
 * Registered once per isolate from `buildContext`, because `signAccessToken`
 * takes only an `Env` — threading a database handle through every caller of a
 * function that signs a token would touch a great deal of code to say one
 * thing. The source closes over THIS context's db, which is sound because a
 * deployment has one database; a second registration simply replaces the first.
 */
// NB the name: anything starting with `use` reads as a React hook to the
// linter, and this is called from `buildContext`.
export const bindSigningKeysToDatabase = (ctx: {
  db: unknown;
  dialect: "pg" | "sqlite";
  env: Env;
}): void => {
  registerSigningKeySource(() => dbKeyMaterial(ctx));
};

// --- transitions ------------------------------------------------------------

const load = async (ctx: Ctx, id: string): Promise<SigningKeyRow> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.id, id))
    .limit(1)) as SigningKeyRow[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Signing key not found");
  return rows[0];
};

const setStatus = async (
  ctx: Ctx,
  id: string,
  status: KeyStatus,
  stamps: Partial<Record<"activatedAt" | "retiredAt" | "revokedAt", Date | null>> = {},
): Promise<void> => {
  const t = table(ctx.dialect);
  await (ctx.db as AnyDb).update(t).set({ status, ...stamps }).where(eq(t.id, id));
};

export interface GenerateInput {
  alg?: JwtAlg;
  note?: string | null;
}

/**
 * Generate a key pair and store it as `standby`.
 *
 * Standby rather than in use, always. A verifier caches the JWKS, so a key that
 * started signing the moment it existed would produce tokens nobody could
 * verify until their cache expired. Publishing first and promoting second is
 * the whole reason the state exists, and making it the only way to create a key
 * means the safe order is not something an operator has to remember.
 */
export const generateSigningKey = async (
  ctx: Ctx,
  input: GenerateInput = {},
): Promise<SigningKeyView> => {
  const alg: JwtAlg = input.alg === "RS256" ? "RS256" : "ES256";
  const pair = (await crypto.subtle.generateKey(
    alg === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privatePem = await pemFromKey(pair.privateKey, "pkcs8");
  const publicPem = await pemFromKey(pair.publicKey, "spki");
  const { kid } = await describePublicKey(alg, pair.publicKey);
  return storeKey(ctx, { alg, kid, privatePem, publicPem, note: input.note ?? null });
};

/**
 * Import a PKCS#8 PEM the operator already has — including the one currently in
 * `AUTH_JWT_PRIVATE_KEY`, which is how a deployment moves off env vars without
 * invalidating a single live token.
 */
export const importSigningKey = async (
  ctx: Ctx,
  privatePem: string,
  note?: string | null,
): Promise<SigningKeyView> => {
  let imported: { alg: JwtAlg; key: CryptoKey };
  try {
    imported = await importPrivatePem(privatePem);
  } catch {
    throw new AppError(
      "VALIDATION",
      "Expected a PKCS#8 PEM private key (EC P-256 for ES256, or RSA for RS256)",
    );
  }
  const jwkPublic = await crypto.subtle.exportKey("jwk", imported.key);
  // Re-import the public half so the stored SPKI is derived from the private
  // key rather than taken on trust from a second pasted blob.
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { ...jwkPublic, d: undefined, key_ops: ["verify"], ext: true } as JsonWebKey,
    imported.alg === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  );
  const publicPem = await pemFromKey(publicKey, "spki");
  const { kid } = await describePublicKey(imported.alg, publicKey);
  return storeKey(ctx, {
    alg: imported.alg,
    kid,
    privatePem: privatePem.trim(),
    publicPem,
    note: note ?? null,
  });
};

const storeKey = async (
  ctx: Ctx,
  input: { alg: JwtAlg; kid: string; privatePem: string; publicPem: string; note: string | null },
): Promise<SigningKeyView> => {
  const t = table(ctx.dialect);
  const existing = (await (ctx.db as AnyDb)
    .select({ id: t.id })
    .from(t)
    .where(eq(t.kid, input.kid))
    .limit(1)) as Array<{ id: string }>;
  if (existing[0]) {
    // The `kid` is derived from the key, so a collision means the same key —
    // naming that is more useful than a unique-index driver error.
    throw new AppError("VALIDATION", "That key is already stored");
  }
  const row: SigningKeyRow = {
    id: crypto.randomUUID(),
    kid: input.kid,
    alg: input.alg,
    privateKey: await encryptSecret(input.privatePem, ctx.env.AUTH_SECRET),
    publicKey: input.publicPem,
    status: "standby",
    note: input.note,
    createdAt: new Date(),
    activatedAt: null,
    retiredAt: null,
    revokedAt: null,
  };
  await (ctx.db as AnyDb).insert(t).values(row);
  invalidateSigningKeys();
  return toView(row);
};

/**
 * Make this key the one that signs.
 *
 * Demoting the incumbent to `previously_used` is part of the same operation,
 * not a separate step an operator could forget: two keys in `in_use` would make
 * "which one signs" a question about row order.
 */
export const promoteSigningKey = async (ctx: Ctx, id: string): Promise<SigningKeyView> => {
  const row = await load(ctx, id);
  const status = asStatus(row.status);
  if (status === "revoked") {
    throw new AppError(
      "VALIDATION",
      "A revoked key cannot sign. Restore it first — which is deliberate: promoting it silently " +
        "would undo a revocation without saying so.",
    );
  }
  if (status === "in_use") return toView(row);
  const t = table(ctx.dialect);
  const now = new Date();
  await (ctx.db as AnyDb)
    .update(t)
    .set({ status: "previously_used", retiredAt: now })
    .where(and(eq(t.status, "in_use"), ne(t.id, id)));
  await setStatus(ctx, id, "in_use", { activatedAt: now, retiredAt: null });
  invalidateSigningKeys();
  return toView({ ...row, status: "in_use", activatedAt: now, retiredAt: null });
};

/**
 * Take a key out of the JWKS. Tokens it signed stop verifying — here within the
 * cache TTL, and for external verifiers whenever their JWKS cache expires.
 */
export const revokeSigningKey = async (ctx: Ctx, id: string): Promise<SigningKeyView> => {
  const row = await load(ctx, id);
  if (asStatus(row.status) === "in_use") {
    // Refused, not cascaded: revoking the key that signs would leave the
    // instance minting HS256 tokens (or none) without anyone asking for that.
    throw new AppError(
      "VALIDATION",
      "This key is in use. Promote another key first, then revoke this one.",
    );
  }
  const now = new Date();
  await setStatus(ctx, id, "revoked", { revokedAt: now });
  invalidateSigningKeys();
  return toView({ ...row, status: "revoked", revokedAt: now });
};

/** Put a revoked key back. Every transition is reversible — that is the reason
 *  the states exist rather than a delete button. */
export const restoreSigningKey = async (ctx: Ctx, id: string): Promise<SigningKeyView> => {
  const row = await load(ctx, id);
  if (asStatus(row.status) !== "revoked") return toView(row);
  // Back to `previously_used` when it ever signed, `standby` when it did not.
  const next: KeyStatus = row.activatedAt ? "previously_used" : "standby";
  await setStatus(ctx, id, next, { revokedAt: null });
  invalidateSigningKeys();
  return toView({ ...row, status: next, revokedAt: null });
};

/** Delete a revoked key for good. Only a revoked one: anything else is still
 *  load-bearing for a token somebody is holding. */
export const deleteSigningKey = async (ctx: Ctx, id: string): Promise<void> => {
  const row = await load(ctx, id);
  if (asStatus(row.status) !== "revoked") {
    throw new AppError(
      "VALIDATION",
      "Only a revoked key can be deleted — anything else still verifies tokens in the wild.",
    );
  }
  const t = table(ctx.dialect);
  await (ctx.db as AnyDb).delete(t).where(eq(t.id, id));
  invalidateSigningKeys();
};
