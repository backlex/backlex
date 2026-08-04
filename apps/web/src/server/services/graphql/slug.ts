import {
  GraphQLBoolean,
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
import { sql, type SQL } from "drizzle-orm";
import type { GqlCtx } from "./core";
import { loadCollection } from "../items/collection-loader";
import { backfillSlugs, slugFieldsOf } from "../items/slug";
import { deletedFilter, tenantFilter } from "../items/sql-helpers";
import { resolvePermission } from "../permissions";

/**
 * Filling in missing URL slugs, over GraphQL.
 *
 * Collection-generic rather than one mutation per collection, for the same
 * reason `reorder` is: the arguments are identical whatever the rows hold. It
 * delegates to the SAME service the REST route calls, so the fold, the
 * collision search and the scope restatement cannot drift between the two
 * surfaces — `slug-surfaces.test.ts` is the gate, and the gate has caught this
 * file's neighbours out on every previous field feature.
 *
 * The ordinary create/update mutations fold slugs too; that lives in `core.ts`
 * beside the INSERT it has to reach. This is only the maintenance pass.
 */

const SlugBackfillEntryType = new GraphQLObjectType({
  name: "SlugBackfillEntry",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const SlugBackfillFieldType = new GraphQLObjectType({
  name: "SlugBackfillField",
  fields: {
    field: { type: new GraphQLNonNull(GraphQLString) },
    examined: { type: new GraphQLNonNull(GraphQLInt) },
    filled: { type: new GraphQLNonNull(GraphQLInt) },
    unfoldable: { type: new GraphQLNonNull(GraphQLInt) },
    entries: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SlugBackfillEntryType))),
    },
  },
});

const SlugBackfillResultType = new GraphQLObjectType({
  name: "SlugBackfillResult",
  fields: {
    dryRun: { type: new GraphQLNonNull(GraphQLBoolean) },
    fields: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SlugBackfillFieldType))),
    },
  },
});

/** Resolve the collection and assert `update` on it, returning the caller's
 *  row-level condition — which every statement the service emits restates. */
const requireUpdate = async (gqlCtx: GqlCtx, slug: string) => {
  const { ctx, auth, permCache } = gqlCtx;
  const collection = await loadCollection(ctx, auth.tenantId, slug);
  const perm = await resolvePermission(ctx, auth, collection.slug, "update", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(auth.userId ? `No update permission for ${slug}` : "Sign in required", {
      extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" },
    });
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

export const slugMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  backfillSlugs: {
    type: new GraphQLNonNull(SlugBackfillResultType),
    description:
      "Fold a URL slug out of each row's source column for every row whose slug field is empty. Rows that already have one are never touched. A DRY RUN unless `apply` is true. Omit `field` to do every slug field. Requires update on the collection covering the slug column.",
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      field: { type: GraphQLString },
      apply: { type: GraphQLBoolean },
    },
    resolve: async (_src, args, gqlCtx) =>
      asGql(async () => {
        const { ctx, auth, collection, perm } = await requireUpdate(
          gqlCtx,
          args.collection as string,
        );
        const all = slugFieldsOf(collection.fields);
        let targets = all;
        if (args.field) {
          const hit = all.find((f) => f.name === args.field);
          if (!hit) {
            throw new AppError(
              "VALIDATION",
              `"${args.field}" is not a slug field on this collection`,
            );
          }
          targets = [hit];
        }
        // The field allow-list is a refusal on this surface too. Re-deriving
        // the guard here rather than sharing it with the route is exactly the
        // mistake the parity gate exists to catch, so this is the same
        // condition in the same words — and the test asserts both surfaces
        // refuse the same role.
        for (const f of targets) {
          if (perm.fields && !perm.fields.has(f.name)) {
            throw new AppError("FORBIDDEN", `No permission to write field "${f.name}"`);
          }
        }
        const scope = sql`${sql.join(
          [perm.whereSql, tenantFilter(collection, auth), deletedFilter(collection), sql`1=1`].filter(
            (f): f is SQL => f != null,
          ),
          sql` AND `,
        )}`;
        const dryRun = args.apply !== true;
        const fields = [];
        for (const f of targets) {
          fields.push(await backfillSlugs(ctx, collection, f, { scope, dryRun }));
        }
        return { dryRun, fields };
      }),
  },
};
