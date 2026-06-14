import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";

/** Dialect-aware getter for the tables this surface touches. Keeps the
 *  per-dialect schema picking in one place so the route handlers can stay
 *  dialect-agnostic. */
export const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
        permissions: pg.schema.permissions,
        users: pg.schema.users,
        sessions: pg.schema.sessions,
        tenantMembers: pg.schema.tenantMembers,
        accounts: pg.schema.accounts,
        platformExternalIdentities: pg.schema.platformExternalIdentities,
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        permissions: sqlite.schema.permissions,
        users: sqlite.schema.users,
        sessions: sqlite.schema.sessions,
        tenantMembers: sqlite.schema.tenantMembers,
        accounts: sqlite.schema.accounts,
        platformExternalIdentities: sqlite.schema.platformExternalIdentities,
      };
