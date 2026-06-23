import { createClient } from "backlex";
import { API_URL, WORKSPACE } from "./env";

// ── Config (from .env — see .env.example, validated by SetupCheck.tsx) ───────
// Empty `url` = same-origin: the SDK issues relative `/api/...` requests that
// the Vite dev proxy (vite.config.ts) forwards to the backend. Set
// VITE_BACKLEX_URL to your deployed API origin for a cross-origin production
// build. A missing workspace is surfaced by the in-app setup check rather than
// crashing here, so the user sees what to fix.
const url = API_URL;
const workspace = WORKSPACE;

// ── Session-token persistence ───────────────────────────────────────────────
// In "app mode" (a `workspace` is set) the SDK captures the workspace session
// token returned by signIn/signUp and replays it as a bearer on every request.
// We stash it in localStorage so a page reload stays signed in, and hand it
// back to `createClient({ token })` on boot.
const TOKEN_KEY = `backlex.token.${workspace}`;

export const backlex = createClient({
  url,
  workspace,
  token: localStorage.getItem(TOKEN_KEY) ?? undefined,
});

/** Mirror the SDK's current token into localStorage (call after sign-in/out). */
export function persistToken(): void {
  const token = backlex.auth.getToken();
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// ── Collection row types ────────────────────────────────────────────────────
// These match the collections you create in the admin UI (see README). Money
// is stored as an **integer number of cents** (never floats) so arithmetic is
// exact; the UI formats it as $X.XX via `formatPrice`. The
// `& Record<string, unknown>` satisfies the SDK's row-type constraint;
// `backlex gen-types --sdk` can generate these for you.

/** A product in the catalog. `image_key` is the backlex storage object key of
 *  the uploaded photo — we resolve it to an object URL at render time. */
export type Product = {
  id: string;
  name: string;
  description?: string;
  /** Price in cents (integer). */
  price: number;
  stock?: number;
  /** backlex storage key of the product photo (e.g. `products/<uuid>-shoe.png`). */
  image_key?: string;
  category?: string;
  created_at?: string;
} & Record<string, unknown>;

/** An order header. The line items live in the child `order_items` collection,
 *  written in one batch at checkout. `total` is in cents. */
export type Order = {
  id: string;
  /** Order total in cents (integer). */
  total: number;
  status?: string;
  created_at?: string;
} & Record<string, unknown>;

/** One line of an order — a snapshot of the product at purchase time so later
 *  catalog edits don't rewrite history. `unit_price` is in cents. */
export type OrderItem = {
  id: string;
  order_id: string;
  product_id: string;
  name: string;
  /** Unit price in cents (integer), captured at checkout. */
  unit_price: number;
  qty: number;
} & Record<string, unknown>;

/** The typed CRUD handle for the `products` collection. */
export const products = backlex.from<Product>("products");

/** The typed CRUD handle for the `orders` collection (order headers). */
export const orders = backlex.from<Order>("orders");

/** The typed CRUD handle for the `order_items` collection (order lines). */
export const orderItems = backlex.from<OrderItem>("order_items");
