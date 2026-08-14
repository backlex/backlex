import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { AppError } from "@backlex/core";
import { type GqlCtx, JSONScalar, writeEnvOf } from "./core";
import { loadCollection } from "../items/collection-loader";
import { setRetired } from "../items/retirement";
import { resolvePermission } from "../permissions";

/**
 * Taking a row out of play, over GraphQL.
 *
 * Collection-generic rather than one mutation per collection, for the same
 * reason `reorderItem` is: the arguments do not depend on what the rows are.
 *
 * It delegates to the SAME service the REST route calls, which is the whole
 * point — this file has hand-built its own SQL and its own encoders for
 * rollups, sequences, geo points and money, and been the surface that quietly
 * lacked the guard every single time. `retirement-surfaces.test.ts` is the
 * gate that says so out loud.
 */

const RetireResultType = new GraphQLObjectType({
  name: "RetireResult",
  fields: {
    /** The flag column that was written. */
    field: { type: new GraphQLNonNull(GraphQLString) },
    /** Where the row ended up. */
    retired: { type: new GraphQLNonNull(GraphQLBoolean) },
    /** The updated row, projected through the caller's READ grant. */
    data: { type: new GraphQLNonNull(JSONScalar) },
  },
});

/** Surface an AppError as the GraphQL error the REST route would have made a
 *  4xx, rather than an opaque 500 masked to "Unexpected error.". */
const asGql = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

export const retirementMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  retireItem: {
    type: new GraphQLNonNull(RetireResultType),
    description:
      "Set the collection's retirement flag on one row — the boolean declared with `retire`. `restore: true` puts the row back in play. Retirement never hides the row from a read: existing references still resolve and the row is still returned. What changes is that it stops being offered for new work. Requires `update` on the collection, covering the flag column. Mirrors REST `POST /api/items/{slug}/{id}/retire`.",
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      id: { type: new GraphQLNonNull(GraphQLID) },
      restore: { type: GraphQLBoolean },
    },
    resolve: async (_src, args, gqlCtx) =>
      asGql(async () => {
        const { ctx, auth, permCache } = gqlCtx;
        const slug = args.collection as string;
        const perm = await resolvePermission(ctx, auth, slug, "update", permCache);
        if (!perm.allowed) {
          throw new GraphQLError(
            auth.userId ? `No update permission for ${slug}` : "Sign in required",
            { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
          );
        }
        const collection = await loadCollection(ctx, auth.tenantId ?? undefined, slug);
        const env = await writeEnvOf(gqlCtx, collection);
        // The row scope and the update FIELD allow-list are both enforced
        // inside `setRetired` → `performUpdate`, not restated here. Restating
        // them is how the two surfaces drift.
        return setRetired(env, String(args.id), args.restore !== true, {
          whereSql: perm.whereSql,
          fields: perm.fields,
        });
      }),
  },
};
