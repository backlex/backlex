/**
 * The address and parcel a carrier is given, and where an operator says it is.
 *
 * Lifted from EasyPost when UPS arrived wanting the same fifteen settings under
 * the same names. That is the rule this repo already follows for `./soap`: two
 * examples is when a shape stops being one provider's business. It is
 * deliberately NOT part of the engine — `provider.ts` knows nothing about
 * addresses, exactly as it knows nothing about SOAP — because a carrier is a
 * kind of provider, not the shape of one.
 *
 * ## What is shared, and what is emphatically not
 *
 * This is the **international** postal shape: a street, a city, a
 * state/province, a postcode and an ISO country. It is what EasyPost and UPS
 * both want, and both of them judge the result against the destination
 * country's own rules.
 *
 * The Turkish couriers here — Yurtiçi, Aras, PTT — want something genuinely
 * different: il and ilçe **by name**, and in Aras's case the mahalle too, with
 * no postcode and no country at all. They are not a third example of this shape
 * and must not be pushed into it. A shared abstraction that made a TR courier
 * describe Kadıköy as a "state/province" would be worse than the duplication it
 * removed.
 *
 * ## Why the keys are frozen
 *
 * Every key below is the one EasyPost already shipped — `fromName`,
 * `toNameField`, `weightField` and the rest. They are not names chosen here;
 * they are names already stored in live connections and flow steps. Renaming
 * one would silently blank a configured field on somebody's running flow, so
 * the keys are a contract and this file is where that contract now lives.
 *
 * ## Why the ship-from is config and the ship-to is a setting
 *
 * The ship-FROM address is the workspace's own and identical on every
 * consignment, so it belongs to the connection — putting it on the task would
 * mean re-typing a warehouse address onto every flow step that books anything.
 * The ship-TO is different on every row, so it is a per-invocation mapping onto
 * the columns that hold it.
 */

import type { IntegrationConfigField } from "./provider";

/** What a reader needs: the connection's config, the task's settings, the row. */
export interface FieldReader {
  row: Readonly<Record<string, unknown>>;
  str(key: string): string | null;
  setting(key: string): string | null;
}

/**
 * A postal address, in the one shape both international carriers here accept.
 *
 * Only `name` and `street1` are non-null: they are the two parts every carrier
 * needs — somebody to hand it to and somewhere to take it to — and the rest is
 * judged by the carrier against the destination country's rules, which it knows
 * far better than a check here could.
 */
export interface PostalAddress {
  name: string;
  company: string | null;
  street1: string;
  street2: string | null;
  city: string | null;
  state: string | null;
  /** Called `zip` on EasyPost's wire and `PostalCode` on UPS's. Neither here. */
  postcode: string | null;
  /** ISO 3166-1 alpha-2, upper-cased, or nothing. */
  country: string | null;
  phone: string | null;
}

/** What is in the box. Weight is the one thing no carrier will quote without. */
export interface Parcel {
  weight: number;
  length: number | null;
  width: number | null;
  height: number | null;
}

/**
 * The connection fields for the workspace's own ship-from address.
 *
 * A function rather than a shared constant so two providers cannot end up
 * holding one array between them — these are spread into the catalog, and a
 * frozen instance shared across providers is an unpleasant surprise the day
 * anything mutates it.
 */
export const shipFromConfigFields = (): IntegrationConfigField[] => [
  { key: "fromName", label: "Ship-from name" },
  { key: "fromCompany", label: "Ship-from company (optional)" },
  { key: "fromStreet1", label: "Ship-from street" },
  { key: "fromStreet2", label: "Ship-from street 2 (optional)" },
  { key: "fromCity", label: "Ship-from city" },
  { key: "fromState", label: "Ship-from state/province (optional)" },
  { key: "fromZip", label: "Ship-from postcode" },
  { key: "fromCountry", label: "Ship-from country", placeholder: "ISO 3166-1 alpha-2, e.g. US or TR" },
  { key: "fromPhone", label: "Ship-from phone (optional)" },
];

/** The task settings naming the columns the destination address lives in. */
export const shipToSettingFields = (): IntegrationConfigField[] => [
  { key: "toNameField", label: "Recipient name field", placeholder: "e.g. ship_to_name" },
  { key: "toStreet1Field", label: "Recipient street field", placeholder: "e.g. ship_to_street" },
  { key: "toStreet2Field", label: "Recipient street 2 field (optional)" },
  { key: "toCityField", label: "Recipient city field" },
  { key: "toStateField", label: "Recipient state/province field (optional)" },
  { key: "toZipField", label: "Recipient postcode field" },
  { key: "toCountryField", label: "Recipient country field", placeholder: "holds an ISO alpha-2 code" },
  { key: "toPhoneField", label: "Recipient phone field (optional)" },
];

/**
 * The task settings naming the columns the parcel's measurements live in.
 *
 * `weightHint` and `lengthHint` are the units, and they are a parameter rather
 * than a constant because the two carriers differ: EasyPost fixes ounces and
 * inches, while UPS carries the unit in the request and lets the operator pick.
 * A placeholder naming the wrong unit is how a 5 kg parcel gets booked as 5 lb.
 */
export const parcelSettingFields = (hints: { weight: string; length: string }): IntegrationConfigField[] => [
  { key: "weightField", label: "Weight field", placeholder: `the row field holding weight in ${hints.weight}` },
  { key: "lengthField", label: `Length field, ${hints.length} (optional)` },
  { key: "widthField", label: `Width field, ${hints.length} (optional)` },
  { key: "heightField", label: `Height field, ${hints.length} (optional)` },
];

/** Where it is coming from — the connection's own address. */
export const readShipFrom = (ctx: FieldReader, who: string): PostalAddress => {
  const name = ctx.str("fromName");
  const street1 = ctx.str("fromStreet1");
  if (!name || !street1) {
    throw new Error(`The ${who} connection has no ship-from name and street — add them to the connection`);
  }
  return {
    name,
    company: ctx.str("fromCompany"),
    street1,
    street2: ctx.str("fromStreet2"),
    city: ctx.str("fromCity"),
    state: ctx.str("fromState"),
    postcode: ctx.str("fromZip"),
    country: isoCountry(ctx.str("fromCountry"), who),
    phone: ctx.str("fromPhone"),
  };
};

/**
 * Where it is going.
 *
 * Only the two parts every carrier needs are validated up front. Everything
 * else the carrier judges against the country's own rules.
 */
export const readShipTo = (ctx: FieldReader, who: string): PostalAddress => {
  const name = text(fromRow(ctx, "toNameField"));
  const street1 = text(fromRow(ctx, "toStreet1Field"));
  if (!name || !street1) {
    throw new Error(
      "The row has no recipient name and street — point the task's recipient fields at the columns that hold them",
    );
  }
  return {
    name,
    company: null,
    street1,
    street2: text(fromRow(ctx, "toStreet2Field")),
    city: text(fromRow(ctx, "toCityField")),
    state: text(fromRow(ctx, "toStateField")),
    // A postcode column is often numeric, and a leading zero survives only as
    // text — so this is stringified rather than read as a number.
    postcode: scalar(fromRow(ctx, "toZipField")),
    country: isoCountry(text(fromRow(ctx, "toCountryField")), who),
    phone: scalar(fromRow(ctx, "toPhoneField")),
  };
};

/**
 * What is in the box.
 *
 * Dimensions are optional because a predefined package replaces them — a
 * flat-rate envelope has no dimensions to give.
 */
export const readParcel = (ctx: FieldReader, weightHint: string): Parcel => {
  const weight = numeric(fromRow(ctx, "weightField"));
  if (weight === null || weight <= 0) {
    throw new Error(`The row has no parcel weight — point the task's weight field at a column holding ${weightHint}`);
  }
  return {
    weight,
    length: numeric(fromRow(ctx, "lengthField")),
    width: numeric(fromRow(ctx, "widthField")),
    height: numeric(fromRow(ctx, "heightField")),
  };
};

/**
 * An ISO 3166-1 alpha-2 code, upper-cased, or nothing.
 *
 * **Throws rather than dropping**, and that is deliberate. A country column
 * holding "United States" is a mapping pointed at the display name; sending it
 * would have the carrier reject the address with a message about the country
 * field, and quietly sending nothing would have it reject the address with no
 * message about the country at all. Naming the column is the only answer that
 * tells the operator what to go and fix.
 */
export const isoCountry = (raw: string | null, who: string): string | null => {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(`"${raw}" is not a country code — ${who} wants ISO alpha-2, like US or TR`);
  }
  return code;
};

// ── Reading a row ────────────────────────────────────────────────────────────

const fromRow = (ctx: FieldReader, setting: string): unknown => {
  const field = ctx.setting(setting);
  return field ? ctx.row[field] : null;
};

const text = (v: unknown): string | null => (typeof v === "string" ? v.trim() || null : null);

/**
 * A scalar column as a string, without losing its shape.
 *
 * A postcode stored as a number is still a postcode and `String(90277)` is the
 * right answer — but a JSON or relation column reaching here would stringify to
 * `[object Object]` and be sent as an address line, so anything non-scalar is
 * nothing.
 */
const scalar = (v: unknown): string | null => {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return text(v);
};

const numeric = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = text(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
