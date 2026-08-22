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
  GraphQLFloat,
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
  listConsentVersions,
  listPolicies,
  savePolicy,
  suggestedPostures,
  suggestedWording,
  type ConsentPolicyInput,
} from "../consent";
import { listConsentRecords } from "../consent-records";

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

const SignalHandlingEnum = new GraphQLEnumType({
  name: "SignalHandling",
  description:
    "What Global Privacy Control and Do Not Track are allowed to govern on this site.",
  values: {
    tracker: {
      value: "tracker",
      description:
        "They stop backlex's own tag and nothing else. What every site does today, and the default — widening them cannot be a side effect of a deploy, because every tag is filed under marketing by default and live pixels would stop worldwide.",
    },
    all: {
      value: "all",
      description:
        "They additionally deny every optional category, so the tag manager refuses third-party tags too. The CCPA reading, where GPC is a legal opt-out rather than a preference.",
    },
    off: {
      value: "off",
      description:
        "Neither signal is read. Do Not Track is a standard the W3C retired, and an operator who does not want it deciding anything should be able to say so.",
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
    signalHandling: {
      type: new GraphQLNonNull(SignalHandlingEnum),
      description:
        "`tracker` lets GPC and Do Not Track stop backlex's own tag and nothing else (the default, and what every site does today); `all` widens them to deny every optional category so third-party tags stop too; `off` reads neither.",
    },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
    // `GraphQLFloat`, not `Int` — and this was a real bug, not a style choice.
    // These are epoch MILLISECONDS, so every value is past Int32's 2.1e9
    // ceiling and graphql-js threw "Int cannot represent non 32-bit signed
    // integer value" on serialization: selecting either field errored the whole
    // query. Every other timestamp in this schema layer already uses Float.
    createdAt: { type: new GraphQLNonNull(GraphQLFloat) },
    updatedAt: { type: new GraphQLNonNull(GraphQLFloat) },
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
    signalHandling: {
      type: SignalHandlingEnum,
      description:
        "`tracker` | `all` | `off`. Unlike the two above this HAS a default (`tracker`), because here one answer is safe — it is the behaviour already live.",
    },
    enabled: { type: GraphQLBoolean },
  },
});

const ConsentVersionType = new GraphQLObjectType({
  name: "ConsentVersion",
  description:
    "One artifact a site's consent policy compiled to. Immutable: a recorded consent points at the hash, so the text a visitor agreed to cannot be edited out from under the evidence.",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    hash: {
      type: new GraphQLNonNull(GraphQLString),
      description:
        "SHA-256 of the canonical artifact, and the ETag the public config route serves. Saving the same content twice reuses this rather than minting a duplicate, so a revert costs nothing.",
    },
    createdAt: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const ConsentRecordType = new GraphQLObjectType({
  name: "ConsentRecord",
  description:
    "One visitor's recorded decision. Append-only: a change of mind is a new row, so the newest for a subject is the standing answer.",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    siteId: { type: new GraphQLNonNull(GraphQLID) },
    subjectId: {
      type: new GraphQLNonNull(GraphQLString),
      description:
        "The durable id the visitor's own banner minted. A correlator, not an identity — it says two decisions came from the same browser and nothing about who that is.",
    },
    policyHash: { type: GraphQLString },
    versionId: { type: GraphQLID },
    hashGrade: {
      type: new GraphQLNonNull(GraphQLString),
      description:
        "`current`, `archived` or `unresolved` — whether the artifact the visitor named still resolves. An unresolved hash was never a reason to refuse the record.",
    },
    decision: { type: new GraphQLNonNull(GraphQLString) },
    grants: { type: JSONScalar },
    source: {
      type: new GraphQLNonNull(GraphQLString),
      description: "`banner` | `preferences` | `api` | `signal` — whether a human clicked anything.",
    },
    locale: { type: GraphQLString },
    country: { type: GraphQLString },
    userAgent: { type: GraphQLString },
    // Float, not Int: epoch ms is past Int32 and `Int` throws on serialization.
    createdAt: { type: new GraphQLNonNull(GraphQLFloat) },
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
  consentVersions: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ConsentVersionType))),
    description:
      "Artifacts this site's policy has compiled to, newest first. There is no publish step and no version number — the live policy is the one row — so this is a history of distinct content, not a log of saves.",
    args: {
      siteId: { type: new GraphQLNonNull(GraphQLID) },
      limit: { type: GraphQLInt },
    },
    resolve: async (_src, args, gqlCtx) =>
      surfacing(() =>
        listConsentVersions(
          dbOf(gqlCtx),
          requireConsentAdmin(gqlCtx),
          String((args as any).siteId),
          (args as any).limit ?? undefined,
        ),
      ),
  },
  consentRecords: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ConsentRecordType))),
    description:
      "Decisions visitors recorded on a site, newest first. The salted IP digest the server stores is deliberately not exposed.",
    args: {
      siteId: { type: new GraphQLNonNull(GraphQLID) },
      subjectId: { type: GraphQLString },
      limit: { type: GraphQLInt },
    },
    resolve: async (_src, args, gqlCtx) =>
      surfacing(() =>
        listConsentRecords(dbOf(gqlCtx), requireConsentAdmin(gqlCtx), {
          siteId: String((args as any).siteId),
          subjectId: (args as any).subjectId ?? undefined,
          limit: (args as any).limit ?? undefined,
        }),
      ),
  },
  consentSuggestedPostures: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Named readings of GDPR/ePrivacy, CCPA/CPRA and KVKK, as combinations of fields that already exist — a selector, not a posture. Never applied automatically and there is no mutation that applies one: spread `policy` into your own `consentSavePolicy` call, so the refusal on a first save stays the only way a posture is stored. `appliesTo` is prose for a person; nothing here is matched against a request, because backlex serves one policy per site and cannot serve two. Render `caveat` — the CCPA entry's says plainly that `allow` is not lawful in the EU.",
    resolve: async (_src, _args, gqlCtx) => {
      requireConsentAdmin(gqlCtx);
      return suggestedPostures();
    },
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
