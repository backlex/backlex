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
import { airtable } from "./airtable";
import { bigquery } from "./bigquery";
import { algolia } from "./algolia";
import { amazon } from "./amazon";
import { amplitude } from "./amplitude";
import { aras } from "./aras";
import { ciceksepeti } from "./ciceksepeti";
import { clickhouse } from "./clickhouse";
import { contentful } from "./contentful";
import { datadog } from "./datadog";
import { dhl } from "./dhl";
import { discord } from "./discord";
import { easypost } from "./easypost";
import { elasticsearch } from "./elasticsearch";
import { github } from "./github";
import { googleCalendar } from "./google-calendar";
import { googleChat } from "./google-chat";
import { googleDrive } from "./google-drive";
import { googleSheets } from "./google-sheets";
import { hepsiburada } from "./hepsiburada";
import { hubspot } from "./hubspot";
import { jira } from "./jira";
import { klaviyo } from "./klaviyo";
import { linear } from "./linear";
import { mailchimp } from "./mailchimp";
import { meilisearch } from "./meilisearch";
import { mixpanel } from "./mixpanel";
import { n11 } from "./n11";
import { notion } from "./notion";
import { opsgenie } from "./opsgenie";
import { pagerduty } from "./pagerduty";
import { posthog } from "./posthog";
import { ptt } from "./ptt";
import { quickbooks } from "./quickbooks";
import { segment } from "./segment";
import { sentry } from "./sentry";
import { slack } from "./slack";
import { teams } from "./teams";
import { telegram } from "./telegram";
import { trendyol } from "./trendyol";
import { xero } from "./xero";
import { yurtici } from "./yurtici";
import { typesense } from "./typesense";
import { ups } from "./ups";

export const INTEGRATION_KINDS = [
  // chat
  "slack",
  "discord",
  "teams",
  "telegram",
  "google-chat",
  // observability / alerting
  "datadog",
  "sentry",
  "pagerduty",
  "opsgenie",
  // analytics
  "posthog",
  "segment",
  "mixpanel",
  "amplitude",
  // automation / issue tracking
  "github",
  "linear",
  "jira",
  // crm
  "hubspot",
  // marketing lists (two-way: rows out, consent back)
  "mailchimp",
  "klaviyo",
  // search sync
  "algolia",
  "meilisearch",
  "typesense",
  "elasticsearch",
  // productivity (OAuth-connected)
  "notion",
  "google-sheets",
  "google-drive",
  "google-calendar",
  "airtable",
  "contentful",
  // accounting (OAuth-connected sources)
  "quickbooks",
  "xero",
  // warehouse destinations
  "clickhouse",
  "bigquery",
  // marketplaces (orders in, stock & price out, status back)
  "trendyol",
  "hepsiburada",
  "n11",
  "ciceksepeti",
  "amazon",
  // carriers (book a shipment, read where it is, cancel it)
  "easypost",
  "yurtici",
  "aras",
  "dhl",
  "ptt",
  "ups",
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const PROVIDERS: Record<IntegrationKind, IntegrationProvider<IntegrationKind>> = {
  slack,
  discord,
  teams,
  telegram,
  "google-chat": googleChat,
  datadog,
  sentry,
  pagerduty,
  opsgenie,
  posthog,
  segment,
  mixpanel,
  amplitude,
  github,
  linear,
  jira,
  hubspot,
  mailchimp,
  klaviyo,
  algolia,
  meilisearch,
  typesense,
  elasticsearch,
  notion,
  "google-sheets": googleSheets,
  "google-drive": googleDrive,
  "google-calendar": googleCalendar,
  airtable,
  contentful,
  quickbooks,
  xero,
  clickhouse,
  bigquery,
  trendyol,
  hepsiburada,
  n11,
  ciceksepeti,
  amazon,
  easypost,
  yurtici,
  aras,
  dhl,
  ptt,
  ups,
};

/** Look a provider up by id; `undefined` for anything unregistered. */
export const providerFor = (kind: string): IntegrationProvider<IntegrationKind> | undefined =>
  PROVIDERS[kind as IntegrationKind];
