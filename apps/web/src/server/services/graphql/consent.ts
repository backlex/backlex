/**
 * Cookie consent over GraphQL.
 *
 * Static, admin-scoped surface mirroring REST `/api/admin/consent` + MCP
 * `consent.*` + SDK `client.consent.*` + CLI `backlex consent`. Every resolver
 * calls the same `services/consent` functions the REST routes do, so there is
 * exactly one place the rules live — including the refusal to invent a
 * compliance posture.
 *
 * `undecidedBehaviour` and `trackerCategory` are deliberately NOT
 * `GraphQLNonNull` on the input type even though the service requires them on a
 * first save. Making them non-null in the schema would force every caller
 * editing the banner copy to restate a decision it is not changing, and would
 * replace the service's explanatory error with GraphQL's "expected non-null" —
 * which teaches an operator nothing about why there is no default.
 */
import { AppError } from "@backlex/core";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import {
  deletePolicy,
  getPolicy,
  listPolicies,
  savePolicy,
  suggestedWording,
  type ConsentPolicyInput,
} from "../consent";

/** Consent configuration is workspace-wide, like the analytics settings it sits
 *  beside — the same admin gate. */
const requireConsentAdmin = requireFlowAdmin;

/**
 * yoga masks non-GraphQLError throws as "Unexpected error." — re-throw an
 * AppError with its code.
 *
 * This matters more here than almost anywhere else in the schema. The refusal
 * to invent a compliance posture is only useful because it EXPLAINS itself;
 * masked, it is indistinguishable from a crash and a caller's only remaining
 * move is to retry with a guess — which is the exact outcome having no default
 * exists to prevent.
 */
const surfacing = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/**
 * The vocabulary as real enums rather than bare strings.
 *
 * Enums cost nothing and give a caller the valid values without reading prose.
 * The two posture enums stay NULLABLE on the input type even so: nullability is
 * what lets an edit omit them, and the service is what refuses a first save
 * that does. Making them non-null here would move the refusal into GraphQL's
 * "expected non-null", which explains nothing.
 */
const ConsentCategoryEnum = new GraphQLEnumType({
  name: "ConsentCategory",
  description:
    "A category the banner may ask about. Strictly-necessary is absent by design — a site cannot run without it, so it is not a choice a visitor has.",
  values: {
    functional: { value: "functional" },
    analytics: { value: "analytics" },
    marketing: { value: "marketing" },
  },
});

const UndecidedBehaviourEnum = new GraphQLEnumType({
  name: "UndecidedBehaviour",
  description: "What happens between page load and the visitor's first answer.",
  values: {
    block: {
      value: "block",
      description:
        "Nothing optional fires until the visitor answers. Required under GDPR and ePrivacy; it costs measurement on visitors who ignore the banner.",
    },
    allow: {
      value: "allow",
      description:
        "Optional tags fire until the visitor declines. The CCPA/CPRA opt-out model, and not lawful in the EU.",
    },
  },
});

const TrackerCategoryEnum = new GraphQLEnumType({
  name: "TrackerCategory",
  description: "How backlex's own cookieless analytics tag is classified.",
  values: {
    none: {
      value: "none",
      description:
        "Strictly necessary — it measures everyone. Defensible because the tag stores nothing on the device and its visitor id is server-derived and rotates daily, but that is a legal position, not a fact.",
    },
    analytics: {
      value: "analytics",
      description: "Gated behind consent like any other analytics tag.",
    },
  },
});

const BannerPositionEnum = new GraphQLEnumType({
  name: "BannerPosition",
  values: {
    bottom: { value: "bottom" },
    top: { value: "top" },
    corner: { value: "corner" },
  },
});

const dbOf = (gqlCtx: GqlCtx) => ({
  db: gqlCtx.ctx.db,
  dialect: gqlCtx.ctx.dialect,
});

const ConsentPolicyType = new GraphQLObjectType({
  name: "ConsentPolicy",
  description: "What a site asks its visitors, and what it withholds until they answer.",
  fields: {
    siteId: { type: new GraphQLNonNull(GraphQLID) },
    categoriesOffered: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ConsentCategoryEnum))),
      description:
        "Optional categories the banner asks about. Strictly-necessary is never among them — it is not a choice a visitor has.",
    },
    undecidedBehaviour: {
      type: new GraphQLNonNull(UndecidedBehaviourEnum),
      description:
        "`block` withholds every optional tag until the visitor answers (required under GDPR/ePrivacy); `allow` fires them until the visitor declines (the CCPA/CPRA model, and not lawful in the EU).",
    },
    trackerCategory: {
      type: new GraphQLNonNull(TrackerCategoryEnum),
      description:
        "`none` treats backlex's own cookieless tag as strictly necessary; `analytics` gates it like any other tag.",
    },
    wording: {
      type: JSONScalar,
      description:
        "Per-locale banner copy. Server-owned: the page never supplies it, so the text a visitor was held to is the text the workspace published.",
    },
    defaultLocale: { type: new GraphQLNonNull(GraphQLString) },
    policyUrl: { type: GraphQLString },
    position: { type: new GraphQLNonNull(BannerPositionEnum) },
    theme: { type: JSONScalar },
    cookieMaxAgeDays: {
      type: new GraphQLNonNull(GraphQLInt),
      description: "How long a decision stands before the visitor is asked again.",
    },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
    createdAt: { type: new GraphQLNonNull(GraphQLInt) },
    updatedAt: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const ConsentPolicyInputType = new GraphQLInputObjectType({
  name: "ConsentPolicyInput",
  fields: {
    categoriesOffered: { type: new GraphQLList(new GraphQLNonNull(ConsentCategoryEnum)) },
    undecidedBehaviour: {
      type: UndecidedBehaviourEnum,
      description:
        "`block` | `allow`. No default — required on a first save, carried forward if omitted later. See ConsentPolicy for what each does.",
    },
    trackerCategory: {
      type: TrackerCategoryEnum,
      description: "`none` | `analytics`. No default, for the same reason.",
    },
    wording: { type: JSONScalar },
    defaultLocale: { type: GraphQLString },
    policyUrl: { type: GraphQLString },
    position: { type: BannerPositionEnum },
    theme: { type: JSONScalar },
    cookieMaxAgeDays: { type: GraphQLInt },
    enabled: { type: GraphQLBoolean },
  },
});

export const consentQueryFields: Record<
  string,
  GraphQLFieldConfig<unknown, GqlCtx>
> = {
  consentPolicies: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ConsentPolicyType))),
    description:
      "Every site with a consent policy (admin-only). A site without one is absent, not returned empty — no policy means nothing is asked and nothing is blocked.",
    resolve: async (_src, _args, gqlCtx) =>
      listPolicies(dbOf(gqlCtx), requireConsentAdmin(gqlCtx)),
  },
  consentPolicy: {
    type: ConsentPolicyType,
    description: "One site's consent policy, or null when it has never been configured.",
    args: { siteId: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) =>
      getPolicy(dbOf(gqlCtx), requireConsentAdmin(gqlCtx), String((args as any).siteId)),
  },
  consentSuggestedWording: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Suggested banner copy, as a starting point. Never applied automatically — a policy with no wording renders the banner's built-in strings rather than a legal statement nobody reviewed.",
    resolve: async (_src, _args, gqlCtx) => {
      requireConsentAdmin(gqlCtx);
      return suggestedWording();
    },
  },
};

export const consentMutationFields: Record<
  string,
  GraphQLFieldConfig<unknown, GqlCtx>
> = {
  consentSavePolicy: {
    type: new GraphQLNonNull(ConsentPolicyType),
    description:
      "Create or replace a site's consent policy (admin-only). A first save must carry `undecidedBehaviour` and `trackerCategory`; both encode a posture where neither answer is safe everywhere, so the server refuses rather than choosing.",
    args: {
      siteId: { type: new GraphQLNonNull(GraphQLID) },
      input: { type: new GraphQLNonNull(ConsentPolicyInputType) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireConsentAdmin(gqlCtx);
      const a = args as { siteId: string; input: ConsentPolicyInput };
      return surfacing(() =>
        savePolicy(dbOf(gqlCtx), tenantId, String(a.siteId), a.input),
      );
    },
  },
  consentDeletePolicy: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      "Stop serving the banner for a site. Consent already recorded is evidence and is left alone — it goes through the erasure surface, never a site reconfiguration.",
    args: { siteId: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireConsentAdmin(gqlCtx);
      await surfacing(() =>
        deletePolicy(dbOf(gqlCtx), tenantId, String((args as any).siteId)),
      );
      return true;
    },
  },
};
