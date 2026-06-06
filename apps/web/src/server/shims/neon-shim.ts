// Worker-only shim for @neondatabase/serverless. D1-only instances never use
// the Neon HTTP/WebSocket driver; keeps it out of the bundle.
export const neon = () => {
  throw new Error("@neondatabase/serverless is not available on Cloudflare Workers (D1-only instance)");
};
export const neonConfig = {};
export class Pool { constructor() { throw new Error("neon Pool unavailable on Workers"); } }
export class Client { constructor() { throw new Error("neon Client unavailable on Workers"); } }
export const types = {};
export default { neon, neonConfig, Pool, Client, types };
