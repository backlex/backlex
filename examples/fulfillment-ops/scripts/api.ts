/** Shared HTTP helper for the provisioning / seeding / reset scripts. */

export const URL_BASE = (process.env.BACKLEX_URL ?? "http://localhost:5173").replace(/\/$/, "");
export const TENANT = process.env.BACKLEX_TENANT ?? "sevkiyat";
const KEY = process.env.BACKLEX_API_KEY ?? "";

export const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Origin: URL_BASE,
  "X-Backlex-Tenant": TENANT,
};
if (KEY) headers.Authorization = `Bearer ${KEY}`;

export type ApiResult = { ok: boolean; status: number; json: any };

export async function api(
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<ApiResult> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { ...headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, json };
}

/** Throw with the server's own words rather than a bare status. */
export async function must(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
  const r = await api(method, path, body, extra);
  if (!r.ok) {
    throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 600)}`);
  }
  return r.json;
}
