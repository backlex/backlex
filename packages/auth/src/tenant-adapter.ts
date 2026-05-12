import type { BetterAuthOptions, DBAdapter, Where } from "better-auth";

/**
 * Models that belong to the workspace end-user pool (i.e. live in the
 * tenant-scoped `app_users` / `app_sessions` / `app_accounts` /
 * `app_verifications` tables). For these models, the wrapper appends a
 * `tenantId = <fixed>` clause to every read/update/delete and stamps the same
 * field on every create — so a per-tenant better-auth instance physically
 * cannot see or write rows belonging to another workspace.
 *
 * Anything outside this set (a plugin-added model that doesn't carry a
 * `tenantId` column) passes through untouched.
 */
const TENANT_SCOPED_MODELS = new Set(["user", "session", "account", "verification"]);

type AdapterFactory = (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>;

const tenantClause = (tenantId: string): Where => ({
  field: "tenantId",
  value: tenantId,
  operator: "eq",
  connector: "AND",
});

/**
 * Wrap an already-built adapter so every read/write on the workspace end-user
 * models is forcibly scoped to one tenant. Both the top-level adapter and the
 * `trx` passed into transactions go through this — better-auth uses
 * AsyncLocalStorage to swap to the transactional adapter inside hooks, so if
 * the trx isn't wrapped, `createUser` etc. end up calling the bare drizzle
 * adapter and the `tenant_id` column is never populated.
 */
const wrapAdapter = (
  inner: DBAdapter<BetterAuthOptions>,
  tenantId: string,
): DBAdapter<BetterAuthOptions> => {
  const clause = tenantClause(tenantId);
  const scopeWhere = (where: Where[] | undefined): Where[] => [
    ...(where ?? []),
    clause,
  ];
  const stampData = <T extends Record<string, unknown>>(data: T): T =>
    ({ ...data, tenantId } as T);

  const wrapped: DBAdapter<BetterAuthOptions> = {
    ...inner,
    create: async (data) => {
      if (TENANT_SCOPED_MODELS.has(data.model)) {
        return inner.create({ ...data, data: stampData(data.data) });
      }
      return inner.create(data);
    },
    findOne: async (data) => {
      if (TENANT_SCOPED_MODELS.has(data.model)) {
        return inner.findOne({ ...data, where: scopeWhere(data.where) });
      }
      return inner.findOne(data);
    },
    findMany: async (data) => {
      if (TENANT_SCOPED_MODELS.has(data.model)) {
        return inner.findMany({ ...data, where: scopeWhere(data.where) });
      }
      return inner.findMany(data);
    },
    count: async (data) => {
      if (TENANT_SCOPED_MODELS.has(data.model)) {
        return inner.count({ ...data, where: scopeWhere(data.where) });
      }
      return inner.count(data);
    },
    update: async (data) => {
      if (TENANT_SCOPED_MODELS.has(data.model)) {
        return inner.update({ ...data, where: scopeWhere(data.where) });
      }
      return inner.update(data);
    },
    updateMany: async (data) => {
      if (TENANT_SCOPED_MODELS.has(data.model)) {
        return inner.updateMany({ ...data, where: scopeWhere(data.where) });
      }
      return inner.updateMany(data);
    },
    delete: async (data) => {
      if (TENANT_SCOPED_MODELS.has(data.model)) {
        return inner.delete({ ...data, where: scopeWhere(data.where) });
      }
      return inner.delete(data);
    },
    deleteMany: async (data) => {
      if (TENANT_SCOPED_MODELS.has(data.model)) {
        return inner.deleteMany({ ...data, where: scopeWhere(data.where) });
      }
      return inner.deleteMany(data);
    },
    transaction: async (cb) => {
      // Re-wrap the transactional adapter handed to the callback so
      // operations inside the transaction (where better-auth swaps its
      // AsyncLocalStorage `currentAdapter` to this `trx`) still go through
      // the tenant scoping. Without this, `createUser` ends up on the bare
      // drizzle adapter inside its create.before/after hooks and the
      // `tenant_id` column is never populated.
      return inner.transaction((trx) =>
        // Nested transactions never happen in better-auth's call paths, so
        // re-using `wrapAdapter` (which adds a `transaction` method back) is
        // safe even though `trx` itself doesn't expose one — the wrapped
        // trx's `transaction` is never invoked.
        cb(wrapAdapter(trx as unknown as DBAdapter<BetterAuthOptions>, tenantId)),
      );
    },
  };
  return wrapped;
};

/**
 * Wrap a better-auth DB adapter *factory* (e.g. `drizzleAdapter(db, …)`) so
 * the resulting adapter is tenant-scoped.
 */
export const withTenantScope = (
  base: AdapterFactory,
  tenantId: string,
): AdapterFactory => {
  return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> =>
    wrapAdapter(base(options), tenantId);
};
