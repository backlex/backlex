// Worker-only shim for the `postgres` driver. CF instances are D1-only, so
// createPgClient() is never called — this exists only to satisfy static import
// resolution and keep the postgres-js wire driver out of the bundle.
const postgres = () => {
  throw new Error("postgres (postgres-js) is not available on Cloudflare Workers (D1-only instance)");
};
export default postgres;
