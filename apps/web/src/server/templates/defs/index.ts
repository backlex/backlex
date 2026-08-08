import type { SchemaTemplate } from "../types";
import { blog } from "./blog";
import { ecommerce } from "./ecommerce";
import { saas } from "./saas";
import { crm } from "./crm";
import { support } from "./support";
import { hr } from "./hr";
import { projects } from "./projects";
import { events } from "./events";
import { inventory } from "./inventory";
import { realEstate } from "./real-estate";
import { restaurant } from "./restaurant";
import { lms } from "./lms";
import { ats } from "./ats";
import { marketplace } from "./marketplace";
import { nonprofit } from "./nonprofit";
import { forms } from "./forms";
import { invoicing } from "./invoicing";
import { appointments } from "./appointments";
import { fieldService } from "./field-service";
import { rental } from "./rental";
import { fleet } from "./fleet";
import { maintenance } from "./maintenance";
import { manufacturing } from "./manufacturing";
import { fitness } from "./fitness";
import { legal } from "./legal";
import { clinic } from "./clinic";

/**
 * Schema template catalog — vertical "starter" collection sets seeded into a
 * new project. The cloud control plane passes a template `id` (via the
 * `SEED_TEMPLATE` worker var); this repo owns the actual definitions and
 * materializes them with the normal collection engine. Ids are the contract
 * with cloud — keep them stable.
 *
 * Collections are listed in dependency order (relation targets before the
 * collections that point at them) so `applyTemplate` can create them top-down.
 *
 * Templates are authored to a "professional" bar on two axes.
 *
 * DATA MODEL — each vertical mirrors the entity model of the strongest platform
 * in its space rather than being invented: ecommerce → Shopify / Vendure /
 * Medusa / BigCommerce, saas → Stripe, crm → Salesforce / HubSpot / SuiteCRM,
 * support → Zendesk / Chatwoot, hr → Workday / BambooHR / ERPNext HRMS,
 * projects → Jira / Linear / OpenProject, ats → Greenhouse / Lever,
 * lms → Canvas / Teachable, inventory + manufacturing → NetSuite / ERPNext,
 * invoicing → Invoice Ninja, appointments → Cal.com, blog → WordPress / Ghost,
 * nonprofit → CiviCRM, clinic → FHIR / OpenEMR.
 *
 * Of those, the ones actually read from a published schema (and therefore the
 * ones to trust and to re-check first when extending) are: Vendure and Medusa
 * entity/module listings, Shopify's Storefront `QueryRoot`, BigCommerce's
 * GraphQL `site`, SuiteCRM modules, Zendesk's resource list, Chatwoot models,
 * ERPNext stock + manufacturing doctypes, frappe/hrms doctypes, OpenProject
 * and Canvas models, Greenhouse Harvest, Invoice Ninja models, Cal.com's
 * Prisma schema, Ghost models, CiviCRM core DAOs. The rest are modelled from
 * domain knowledge — treat them as the weaker claim. Vendor doc portals are
 * mostly unfetchable; go to the open-source schema when you need ground truth.
 *
 * Foreign keys and status/date columns are `indexed`,
 * status fields use colored `dropdown` choices, money/email/url/rating fields
 * carry soft `validation`, content-heavy collections enable `fts`, and every
 * collection ships realistic `samples` so a fresh workspace is demo-ready.
 *
 * FORM LAYOUT — every collection is laid out with the field-organization
 * primitives, not left as a flat column of inputs. The house rules live with
 * the `sec` / `half` / `tabbed` / `stacked` / `divider` / `hint` helpers below;
 * the short version is that record size picks the container (flat → stacked
 * sections → tabs), naturally-paired scalars sit side by side at `half` width,
 * optional trailing sections (SEO, internal notes) start folded, and a `hint`
 * callout is spent only where the form would otherwise mislead an operator
 * (e.g. a total that is maintained from line items rather than typed).
 */

/** The catalog as authored, in picker order. `TEMPLATES` (see `../catalog`) is
 *  this with each vertical's bundled KPI definitions attached. */
export const BASE_TEMPLATES: SchemaTemplate[] = [
  { id: "blank", label: "Blank", description: "No collections — start from scratch.", collections: [] },
  blog,
  ecommerce,
  saas,
  crm,
  support,
  hr,
  projects,
  events,
  inventory,
  realEstate,
  restaurant,
  lms,
  ats,
  marketplace,
  nonprofit,
  forms,
  invoicing,
  appointments,
  fieldService,
  rental,
  fleet,
  maintenance,
  manufacturing,
  fitness,
  legal,
  clinic,
];
