/**
 * The provider registry.
 *
 * `INTEGRATION_KINDS` stays a hand-written `as const` tuple because it is the
 * source of the `IntegrationKind` literal union that `z.enum` and every
 * consumer's type-level exhaustiveness depend on. `PROVIDERS` is typed as
 * `Record<IntegrationKind, …>`, so adding an id to the tuple without
 * registering its provider (or vice-versa) is a compile error rather than a
 * runtime hole.
 */
import type { IntegrationProvider } from "../provider";
import { algolia } from "./algolia";
import { datadog } from "./datadog";
import { discord } from "./discord";
import { elasticsearch } from "./elasticsearch";
import { github } from "./github";
import { jira } from "./jira";
import { linear } from "./linear";
import { meilisearch } from "./meilisearch";
import { opsgenie } from "./opsgenie";
import { pagerduty } from "./pagerduty";
import { posthog } from "./posthog";
import { segment } from "./segment";
import { sentry } from "./sentry";
import { slack } from "./slack";
import { teams } from "./teams";
import { telegram } from "./telegram";
import { typesense } from "./typesense";

export const INTEGRATION_KINDS = [
  // chat
  "slack",
  "discord",
  "teams",
  "telegram",
  // observability / alerting
  "datadog",
  "sentry",
  "pagerduty",
  "opsgenie",
  // analytics
  "posthog",
  "segment",
  // automation / issue tracking
  "github",
  "linear",
  "jira",
  // search sync
  "algolia",
  "meilisearch",
  "typesense",
  "elasticsearch",
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const PROVIDERS: Record<IntegrationKind, IntegrationProvider<IntegrationKind>> = {
  slack,
  discord,
  teams,
  telegram,
  datadog,
  sentry,
  pagerduty,
  opsgenie,
  posthog,
  segment,
  github,
  linear,
  jira,
  algolia,
  meilisearch,
  typesense,
  elasticsearch,
};

/** Look a provider up by id; `undefined` for anything unregistered. */
export const providerFor = (kind: string): IntegrationProvider<IntegrationKind> | undefined =>
  PROVIDERS[kind as IntegrationKind];
