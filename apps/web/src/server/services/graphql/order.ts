import {
  GraphQLError,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { AppError } from "@backlex/core";
import type { GqlCtx } from "./core";
import { loadCollection } from "../items/collection-loader";
import {
  assertCanRearrange,
  normalizeOrderField,
  orderFieldsOf,
  reorderItem,
  requireOrderField,
} from "../items/order";
import { resolvePermission } from "../permissions";

/**
 * Moving a row within its hand-arranged list, over GraphQL.
 *
 * Collection-generic rather than one mutation per collection: the arguments are
 * the same whatever the rows are, and a schema that grew `reorderLesson`,
 * `reorderMenuItem`, `reorderPipelineStage` … would be longer without saying
 * anything more. Both mutations delegate to the SAME service the REST routes
 * call, so the shift arithmetic and the tie repair cannot drift between the two
 * surfaces — `order-surfaces.test.ts` is the gate.
 */

const ReorderResultType = new GraphQLObjectType({
  name: "ReorderResult",
  fields: {
    position: { type: new GraphQLNonNull(GraphQLInt) },
    shifted: { type: new GraphQLNonNull(GraphQLInt) },
    repaired: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const NormalizeOrderResultType = new GraphQLObjectType({
  name: "NormalizeOrderResult",
  fields: {
    scopes: { type: new GraphQLNonNull(GraphQLInt) },
    renumbered: { type: new GraphQLNonNull(GraphQLInt) },
    fields: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
  },
});

/** Resolve the collection and assert `update` on it, returning the caller's
 *  row-level condition — which every statement the services emit restates. */
const requireUpdate = async (gqlCtx: GqlCtx, slug: string) => {
  const { ctx, auth, permCache } = gqlCtx;
  const collection = await loadCollection(ctx, auth.tenantId, slug);
  const perm = await resolvePermission(ctx, auth, collection.slug, "update", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No update permission for ${slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  return { ctx, auth, collection, perm };
};

/** Surface an AppError as the GraphQL error the REST route would have been a
 *  4xx for, rather than an opaque 500. */
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

export const orderMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  reorderItem: {
    type: new GraphQLNonNull(ReorderResultType),
    description:
      "Move a row so it sits immediately before or after another in the same list. Exactly one of `before` / `after`. A list still holding duplicate positions is renumbered into the order it currently reads first, and the count comes back as `repaired`. Requires update on the collection.",
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      field: { type: new GraphQLNonNull(GraphQLString) },
      id: { type: new GraphQLNonNull(GraphQLID) },
      before: { type: GraphQLID },
      after: { type: GraphQLID },
    },
    resolve: async (_src, args, gqlCtx) => {
      const { before, after } = args as { before?: string; after?: string };
      if ((before === undefined || before === null) === (after === undefined || after === null)) {
        throw new GraphQLError('Send exactly one of "before" or "after"', {
          extensions: { code: "VALIDATION" },
        });
      }
      return asGql(async () => {
        const { ctx, auth, collection, perm } = await requireUpdate(
          gqlCtx,
          args.collection as string,
        );
        const orderField = requireOrderField(collection, args.field as string);
        // Same gate as the REST route — a move renumbers rows the caller never
        // named, so plain `update` on the collection is not enough.
        assertCanRearrange(collection, orderField, perm);
        return reorderItem(
          ctx,
          collection,
          auth.tenantId,
          orderField,
          {
            id: String(args.id),
            anchorId: String(before ?? after),
            place: before ? "before" : "after",
          },
          perm.whereSql,
        );
      });
    },
  },
  normalizeOrder: {
    type: new GraphQLNonNull(NormalizeOrderResultType),
    description:
      "Renumber a collection's order fields into dense 1…N within each list, preserving the order the rows currently read in. Omit `field` to do all of them. Requires update on the collection.",
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      field: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) =>
      asGql(async () => {
        const { ctx, auth, collection, perm } = await requireUpdate(
          gqlCtx,
          args.collection as string,
        );
        const targets = args.field
          ? [requireOrderField(collection, args.field as string)]
          : orderFieldsOf(collection.fields);
        for (const f of targets) assertCanRearrange(collection, f, perm);
        let scopes = 0;
        let renumbered = 0;
        for (const f of targets) {
          const r = await normalizeOrderField(ctx, collection, auth.tenantId, f);
          scopes += r.scopes;
          renumbered += r.renumbered;
        }
        return { scopes, renumbered, fields: targets.map((f) => f.name) };
      }),
  },
};
