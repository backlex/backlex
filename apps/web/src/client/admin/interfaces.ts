// interface catalog.
//
// Each entry pairs a friendly UI "interface" (how a value is edited) with the
// physical storage type the backend supports. The Add Field dialog renders
// these as a categorized, searchable grid; the chosen `id` is persisted as
// `field.interface` so the item editor / list views can pick the matching
// editor. New interfaces fall through to the type-based default editor until a
// dedicated one is wired up — adding to this list is always safe.
import type { IconKey } from "./icons";

/** Physical column types accepted by `POST/PATCH /api/collections`. */
export type StorageType =
  | "text"
  | "longtext"
  | "integer"
  | "number"
  | "boolean"
  | "json"
  | "timestamp"
  | "uuid"
  | "relation"
  | "relation_many"
  | "geo"
  | "money"
  | "phone"
  | "email"
  | "url"
  | "hash"
  // Presentational-only — render in the form but own no column / value.
  | "divider"
  | "notice";

export type InterfaceGroup =
  | "Text & Numbers"
  | "Selection"
  | "Relational"
  | "Presentation & Other"
  // Dynamic — populated from enabled extensions' `fieldEditors` contributions
  // (see `extensionFieldInterfaces` below), never from the static catalog.
  | "Extensions";

export interface FieldInterfaceDef {
  /** Persisted as `field.interface`. Unique across the catalog. */
  id: string;
  label: string;
  /** One-line description shown under the label in the picker. */
  sub: string;
  group: InterfaceGroup;
  icon: IconKey;
  /** Physical column type created for this interface. */
  type: StorageType;
  /** Show the choices editor in step 2 (value · label · color rows). */
  hasChoices?: boolean;
  /** Show the relation-target picker in step 2 and require `to`. */
  hasRelation?: boolean;
  /** Show the rollup editor in step 2 and require a complete `rollup` spec.
   *  The column's storage type is decided by the chosen aggregate rather than
   *  by this entry (`count` is whole, everything else decimal), so `type` here
   *  is only the starting point. */
  hasRollup?: boolean;
  /** Show the numbering editor in step 2 and require a usable `sequence` spec.
   *  The column is always `text` — the value is a rendered string, not a bare
   *  counter — so unlike `hasRollup` this never moves the storage type. */
  hasSequence?: boolean;
  /** Show the location editor in step 2 — which address columns a missing point
   *  is geocoded from, and where the map opens. Every part of it is optional:
   *  a bare `geo` field is a coordinate pair someone types or picks. */
  hasGeo?: boolean;
  /** Show the currency editor in step 2 and require a usable `money` spec —
   *  a money field with no currency is an integer nobody can interpret, so
   *  unlike `hasGeo` this config is mandatory rather than optional. */
  hasMoney?: boolean;
  /** Show the phone editor in step 2 — which country a national-form number is
   *  read as, and which countries are allowed at all. Optional like `hasGeo`:
   *  a bare phone field takes numbers written in international form. */
  hasPhone?: boolean;
  /** Show the email editor in step 2 — whether the local part keeps its case,
   *  and which domains are acceptable at all. Optional like `hasGeo`, and more
   *  so: a bare email field already does the thing the type exists for. */
  hasEmail?: boolean;
  /** Show the URL editor in step 2 — whether the column holds a whole address or
   *  a bare domain, which schemes are acceptable, and which hosts are. Optional
   *  like `hasEmail`, and for the same reason: a bare url field already does the
   *  thing the type exists for. */
  hasUrl?: boolean;
  /** Show the period editor in step 2 — which sibling column ends the period,
   *  and whether a shared endpoint counts as a clash. Declared over columns that
   *  already exist, so unlike every other capability flag this one adds no value
   *  editor: both fields keep rendering as the date inputs they already are. */
  hasRange?: boolean;
  /** Show the lifecycle editor in step 2 — which value may follow which, who
   *  may make each move, and what the row must carry for it. Only meaningful on
   *  an interface that stores ONE of a fixed set of values: the graph is drawn
   *  between `options.choices`, and a multi-select column holds a list, which
   *  has no "the value it is changing from". Entirely optional, like `hasGeo`. */
  hasTransitions?: boolean;
  /** Extra search keywords beyond label + id. */
  keywords?: string[];
}

export const INTERFACE_GROUPS: InterfaceGroup[] = [
  "Text & Numbers",
  "Selection",
  "Relational",
  "Presentation & Other",
  "Extensions",
];

export const FIELD_INTERFACES: FieldInterfaceDef[] = [
  // ── Text & Numbers ───────────────────────────────────────────────
  { id: "input", label: "Input", sub: "Single-line text", group: "Text & Numbers", icon: "Type", type: "text" },
  { id: "autocomplete", label: "Autocomplete", sub: "Text with suggestions", group: "Text & Numbers", icon: "Search", type: "text", keywords: ["suggest", "typeahead"] },
  { id: "slug", label: "Slug", sub: "URL-safe key, kebab-case", group: "Text & Numbers", icon: "Hash", type: "text", keywords: ["permalink", "url"] },
  { id: "sequence", label: "Sequence", sub: "A document number backlex issues for you — INV-2026-0001", group: "Text & Numbers", icon: "Hash", type: "text", hasSequence: true, keywords: ["number", "invoice", "order", "counter", "serial", "autonumber", "auto number", "increment", "document number", "reference"] },
  { id: "textarea", label: "Textarea", sub: "Multi-line plain text", group: "Text & Numbers", icon: "Pencil", type: "longtext", keywords: ["multiline", "notes"] },
  { id: "markdown", label: "Markdown", sub: "Formatted text, stored as Markdown", group: "Text & Numbers", icon: "Braces", type: "longtext", keywords: ["md", "richtext"] },
  { id: "richtext", label: "Rich Text (WYSIWYG)", sub: "Formatted text, stored as HTML", group: "Text & Numbers", icon: "Eye", type: "longtext", keywords: ["wysiwyg", "html", "editor"] },
  { id: "code", label: "Code", sub: "Syntax-highlighted source / JSON string", group: "Text & Numbers", icon: "Code", type: "longtext", keywords: ["snippet", "monaco"] },
  { id: "integer", label: "Integer", sub: "Whole number", group: "Text & Numbers", icon: "Hash", type: "integer", keywords: ["int", "count"] },
  { id: "decimal", label: "Decimal", sub: "Floating-point number", group: "Text & Numbers", icon: "Hash", type: "number", keywords: ["float"] },
  { id: "money", label: "Money", sub: "An amount and the currency it is in — exact, and never added across currencies", group: "Text & Numbers", icon: "BarChart", type: "money", hasMoney: true, keywords: ["money", "price", "amount", "currency", "cost", "total", "salary", "fee", "budget", "payment", "balance", "revenue", "cash", "usd", "eur", "try", "lira", "dollar", "euro"] },
  { id: "phone", label: "Phone", sub: "A number stored the one way every machine can dial — typed any way, saved as +90…", group: "Text & Numbers", icon: "Phone", type: "phone", hasPhone: true, keywords: ["phone", "telephone", "mobile", "cell", "gsm", "msisdn", "whatsapp", "sms", "contact", "number", "e164", "telefon", "cep", "call", "dial"] },
  // Moved out of "Presentation & Other" and off `type: "text"`. It used to be a
  // rendering hint on a text column; it is a storage type now, and it belongs
  // next to phone because they are the same kind of thing — a value people type
  // a dozen ways that has exactly one form a machine accepts.
  { id: "email", label: "Email", sub: "An address stored the one way every mail server accepts — typed any way, saved folded", group: "Text & Numbers", icon: "Mail", type: "email", hasEmail: true, keywords: ["mail", "email", "e-mail", "contact", "address", "eposta", "e-posta", "inbox", "smtp", "recipient"] },
  { id: "url", label: "URL", sub: "A web address stored one way — type acme.com, saved as https://acme.com/", group: "Text & Numbers", icon: "ExternalLink", type: "url", hasUrl: true, keywords: ["link", "href", "website", "url", "site", "web", "adres", "bağlantı", "domain", "homepage", "endpoint"] },
  { id: "slider", label: "Slider", sub: "Number picked on a track", group: "Text & Numbers", icon: "Sliders", type: "number", keywords: ["range"] },
  { id: "rating", label: "Rating", sub: "Star rating, 0–5", group: "Text & Numbers", icon: "BarChart", type: "integer", keywords: ["stars", "score"] },

  // ── Selection ────────────────────────────────────────────────────
  { id: "toggle", label: "Toggle", sub: "On / off boolean", group: "Selection", icon: "ToggleLeft", type: "boolean", keywords: ["switch", "checkbox", "bool"] },
  { id: "dropdown", label: "Dropdown", sub: "One choice from a fixed list", group: "Selection", icon: "Filter", type: "text", hasChoices: true, hasTransitions: true, keywords: ["select", "enum", "status", "lifecycle", "workflow", "state", "stage", "transition"] },
  { id: "dropdown_multiple", label: "Dropdown (multiple)", sub: "Several choices from a list", group: "Selection", icon: "Filter", type: "json", hasChoices: true, keywords: ["multiselect", "tags"] },
  { id: "radio", label: "Radio Buttons", sub: "One choice, all options visible", group: "Selection", icon: "Check", type: "text", hasChoices: true, hasTransitions: true, keywords: ["select", "lifecycle", "workflow", "state"] },
  { id: "checkboxes", label: "Checkboxes", sub: "Multiple choices, all visible", group: "Selection", icon: "Check", type: "json", hasChoices: true, keywords: ["multiselect"] },
  { id: "tags", label: "Tags", sub: "Free-form list of labels", group: "Selection", icon: "Hash", type: "json", keywords: ["chips", "keywords"] },
  { id: "datetime", label: "Datetime", sub: "Date and time", group: "Selection", icon: "Calendar", type: "timestamp", keywords: ["date", "time", "timestamp"] , hasRange: true },
  { id: "date", label: "Date", sub: "Calendar date only", group: "Selection", icon: "Calendar", type: "timestamp", keywords: ["day"] , hasRange: true },
  { id: "color", label: "Color", sub: "Hex color picker", group: "Selection", icon: "Palette", type: "text", keywords: ["swatch", "hex", "theme"] },
  { id: "icon", label: "Icon", sub: "Pick a lucide icon name", group: "Selection", icon: "Bolt", type: "text", keywords: ["glyph", "symbol"] },

  // ── Relational ───────────────────────────────────────────────────
  { id: "relation", label: "Many to One", sub: "Reference a row in another collection", group: "Relational", icon: "Database", type: "relation", hasRelation: true, keywords: ["m2o", "foreign", "reference", "link"] },
  { id: "user", label: "User", sub: "Reference a workspace end-user (app_users)", group: "Relational", icon: "Users", type: "text", keywords: ["app user", "end-user", "account", "login", "member", "customer"] },
  { id: "relation_many", label: "Many to Many", sub: "Reference multiple rows in another collection (stored as a JSON array of ids)", group: "Relational", icon: "Database", type: "relation_many", hasRelation: true, keywords: ["m2m", "many to many", "multi-reference"] },
  { id: "rollup", label: "Rollup", sub: "A total, count or average of related rows — kept up to date for you", group: "Relational", icon: "BarChart", type: "number", hasRollup: true, keywords: ["sum", "total", "count", "aggregate", "subtotal", "average", "roll up", "summary"] },
  { id: "file", label: "File", sub: "Reference an uploaded file", group: "Relational", icon: "Folder", type: "text", keywords: ["upload", "attachment", "asset"] },
  { id: "image", label: "Image", sub: "Reference an uploaded image", group: "Relational", icon: "Upload", type: "text", keywords: ["photo", "picture", "asset"] },
  { id: "files", label: "Files (multiple)", sub: "List of uploaded file ids", group: "Relational", icon: "Folder", type: "json", keywords: ["gallery", "attachments"] },

  // ── Presentation & Other ─────────────────────────────────────────
  { id: "json", label: "JSON", sub: "Raw JSON object or array", group: "Presentation & Other", icon: "Braces", type: "json", keywords: ["object", "array", "raw"] },
  // `type` moved from `json` to `geo` when geo fields shipped. Collections
  // created before then still hold `type: "json"` in their stored metadata and
  // keep behaving exactly as they did — this catalog only decides what the Add
  // Field dialog creates NEXT. Converting an old one is a deliberate act (drop
  // and re-add), not something a catalog edit should do behind an operator's
  // back to a column that already has data in it.
  { id: "map", label: "Location", sub: "A point on the earth — searchable by distance", group: "Presentation & Other", icon: "Globe", type: "geo", hasGeo: true, keywords: ["location", "geo", "coordinates", "map", "address", "place", "latitude", "longitude", "near", "distance", "nearby", "gps", "pin"] },
  { id: "uuid", label: "UUID", sub: "Universally-unique identifier", group: "Presentation & Other", icon: "Shield", type: "uuid", keywords: ["id", "guid"] },
  { id: "hash", label: "Hash", sub: "One-way hashed secret — stored as a digest, never shown again", group: "Presentation & Other", icon: "Shield", type: "hash", keywords: ["password", "secret", "pin", "credential", "scrypt", "token"] },
  { id: "divider", label: "Divider", sub: "A labeled section rule — layout only, stores no data", group: "Presentation & Other", icon: "Minus", type: "divider", keywords: ["separator", "rule", "hr", "section", "break", "layout", "heading"] },
  { id: "notice", label: "Notice", sub: "An info callout for editors — layout only, stores no data", group: "Presentation & Other", icon: "Info", type: "notice", keywords: ["callout", "info", "warning", "banner", "message", "hint", "note"] },
];

const BY_ID = new Map(FIELD_INTERFACES.map((i) => [i.id, i]));

export const getInterface = (id: string | undefined | null): FieldInterfaceDef | undefined =>
  id ? BY_ID.get(id) : undefined;

/** The interface a freshly-loaded field should display when it has no explicit
 *  `interface` — falls back to the plain editor for its storage type. */
export const defaultInterfaceFor = (type: string): FieldInterfaceDef => {
  const exact = FIELD_INTERFACES.find((i) => i.type === type);
  return exact ?? BY_ID.get("input")!;
};

/** Interfaces whose storage type matches `type` — used by the Edit Field
 *  dialog's interface-override list (type is immutable once created). */
export const interfacesForType = (type: string): FieldInterfaceDef[] =>
  FIELD_INTERFACES.filter((i) => i.type === type);

// ── Extension-contributed interfaces ─────────────────────────────────────────
// Enabled extensions can ship `fieldEditors` (sandboxed iframe editors). The
// helpers below turn those contributions into catalog-shaped defs so the Add
// Field / Edit Field pickers can merge them additively — the static catalog
// above never changes.

/** Structural view of an enabled extension row — kept local so this module
 *  stays free of api-client imports. `ApiExtension` satisfies it. */
export interface ExtensionInterfaceSource {
  name: string;
  manifest: {
    contributes?: {
      fieldEditors?: { interface: string; title: string; types?: string[]; entry: string }[];
    };
  };
}

const STORAGE_TYPE_SET: ReadonlySet<string> = new Set([
  "text", "longtext", "integer", "number", "boolean", "json", "timestamp",
  "uuid", "relation", "relation_many", "geo", "money", "phone", "email", "hash",
]);

/**
 * Catalog-shaped defs for every field editor contributed by enabled
 * extensions, grouped under "Extensions". Built-in ids win on collision (an
 * extension can't shadow `input`); across extensions, first contribution wins.
 * The def's storage `type` (the column Add Field creates) is the editor's
 * first declared type, falling back to `json` when unrestricted.
 */
export const extensionFieldInterfaces = (
  extensions: ExtensionInterfaceSource[],
): FieldInterfaceDef[] => {
  const out: FieldInterfaceDef[] = [];
  const seen = new Set<string>(FIELD_INTERFACES.map((i) => i.id));
  for (const ext of extensions) {
    for (const ed of ext.manifest?.contributes?.fieldEditors ?? []) {
      if (!ed.interface || seen.has(ed.interface)) continue;
      seen.add(ed.interface);
      const storage = (ed.types ?? []).find((x) => STORAGE_TYPE_SET.has(x)) as
        | StorageType
        | undefined;
      out.push({
        id: ed.interface,
        label: ed.title,
        sub: `Custom editor from the "${ext.name}" extension`,
        group: "Extensions",
        icon: "Puzzle",
        type: storage ?? "json",
        keywords: ["extension", ext.name],
      });
    }
  }
  return out;
};

/** Extension interfaces usable on a column of storage `type` — an editor with
 *  no `types` restriction accepts every type. Used by the Edit Field
 *  interface-override list (the type is immutable there). */
export const extensionInterfacesForType = (
  extensions: ExtensionInterfaceSource[],
  type: string,
): FieldInterfaceDef[] => {
  const restrictions = new Map<string, string[] | undefined>();
  for (const ext of extensions) {
    for (const ed of ext.manifest?.contributes?.fieldEditors ?? []) {
      if (!restrictions.has(ed.interface)) restrictions.set(ed.interface, ed.types);
    }
  }
  return extensionFieldInterfaces(extensions).filter((d) => {
    const ts = restrictions.get(d.id);
    return !ts || ts.length === 0 || ts.includes(type);
  });
};

/** Case-insensitive match against label, id and keywords. */
export const matchesInterfaceQuery = (i: FieldInterfaceDef, q: string): boolean => {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    i.label.toLowerCase().includes(needle) ||
    i.id.toLowerCase().includes(needle) ||
    i.sub.toLowerCase().includes(needle) ||
    i.type.toLowerCase().includes(needle) ||
    (i.keywords ?? []).some((k) => k.toLowerCase().includes(needle))
  );
};
