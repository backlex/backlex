import { defineProvider } from "../provider";

/**
 * HubSpot — keep contacts in step with a collection.
 *
 * The first provider here that needs the ROW rather than the fact that one
 * changed: a CRM cannot upsert a contact from `{collection, event, id}`. Hence
 * `recordPayload`, and hence the warning the connect dialog shows — row
 * contents leave the instance for this one, and the event filter is how an
 * admin scopes which collections that applies to.
 *
 * Writes go through the batch upsert keyed on `email`, so re-delivering the
 * same event updates the same contact instead of creating a second one. That
 * matters because the queue retries.
 */

/** Which record field carries the address, tried in order. */
const EMAIL_KEYS = ["email", "emailAddress", "email_address", "contactEmail"] as const;

/** Fields worth carrying across, mapped to HubSpot's own property names. */
const PROPERTY_MAP: Record<string, string> = {
  firstName: "firstname",
  first_name: "firstname",
  lastName: "lastname",
  last_name: "lastname",
  name: "firstname",
  phone: "phone",
  company: "company",
  website: "website",
  jobTitle: "jobtitle",
  job_title: "jobtitle",
};

const emailOf = (record: Record<string, unknown>): string | null => {
  for (const key of EMAIL_KEYS) {
    const v = record[key];
    if (typeof v === "string" && v.includes("@")) return v.trim().toLowerCase();
  }
  return null;
};

export const hubspot = defineProvider({
  id: "hubspot",
  label: "HubSpot",
  category: "crm",
  capabilities: ["sink"],
  // Without the row there is nothing to sync; see the note above.
  recordPayload: true,
  configFields: [
    {
      key: "accessToken",
      label: "Private app access token",
      placeholder: "pat-eu1-…",
      secret: true,
    },
  ],
  async deliver(ctx) {
    const token = ctx.str("accessToken");
    if (!token) return null;
    const record = ctx.event.record;
    // A delete carries no row, and there is no address to key an upsert on.
    // Reported as delivered-with-nothing-to-do rather than as a failure, which
    // would trip the breaker on every delete.
    if (!record) return { ok: true, status: 204 };
    const email = emailOf(record);
    if (!email) return { ok: true, status: 204 };

    const properties: Record<string, unknown> = { email };
    for (const [from, to] of Object.entries(PROPERTY_MAP)) {
      const v = record[from];
      // Only scalars: HubSpot rejects an object outright, and stringifying one
      // would put `[object Object]` in a customer-facing CRM field.
      if (v !== null && v !== undefined && typeof v !== "object") properties[to] = v;
    }

    return ctx.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert",
      // Keyed on the address, so a retry updates rather than duplicates.
      { inputs: [{ idProperty: "email", id: email, properties }] },
      { Authorization: `Bearer ${token}` },
    );
  },
});
