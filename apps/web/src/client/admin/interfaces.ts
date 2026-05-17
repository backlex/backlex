// Directus-style interface catalog.
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
  | "relation_many";

export type InterfaceGroup =
  | "Text & Numbers"
  | "Selection"
  | "Relational"
  | "Presentation & Other";

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
  /** Extra search keywords beyond label + id. */
  keywords?: string[];
}

export const INTERFACE_GROUPS: InterfaceGroup[] = [
  "Text & Numbers",
  "Selection",
  "Relational",
  "Presentation & Other",
];

export const FIELD_INTERFACES: FieldInterfaceDef[] = [
  // ── Text & Numbers ───────────────────────────────────────────────
  { id: "input", label: "Input", sub: "Single-line text", group: "Text & Numbers", icon: "Type", type: "text" },
  { id: "autocomplete", label: "Autocomplete", sub: "Text with suggestions", group: "Text & Numbers", icon: "Search", type: "text", keywords: ["suggest", "typeahead"] },
  { id: "slug", label: "Slug", sub: "URL-safe key, kebab-case", group: "Text & Numbers", icon: "Hash", type: "text", keywords: ["permalink", "url"] },
  { id: "textarea", label: "Textarea", sub: "Multi-line plain text", group: "Text & Numbers", icon: "Pencil", type: "longtext", keywords: ["multiline", "notes"] },
  { id: "markdown", label: "Markdown", sub: "Formatted text, stored as Markdown", group: "Text & Numbers", icon: "Braces", type: "longtext", keywords: ["md", "richtext"] },
  { id: "richtext", label: "Rich Text (WYSIWYG)", sub: "Formatted text, stored as HTML", group: "Text & Numbers", icon: "Eye", type: "longtext", keywords: ["wysiwyg", "html", "editor"] },
  { id: "code", label: "Code", sub: "Syntax-highlighted source / JSON string", group: "Text & Numbers", icon: "Code", type: "longtext", keywords: ["snippet", "monaco"] },
  { id: "integer", label: "Integer", sub: "Whole number", group: "Text & Numbers", icon: "Hash", type: "integer", keywords: ["int", "count"] },
  { id: "decimal", label: "Decimal", sub: "Floating-point number", group: "Text & Numbers", icon: "Hash", type: "number", keywords: ["float", "money", "price"] },
  { id: "slider", label: "Slider", sub: "Number picked on a track", group: "Text & Numbers", icon: "Sliders", type: "number", keywords: ["range"] },
  { id: "rating", label: "Rating", sub: "Star rating, 0–5", group: "Text & Numbers", icon: "BarChart", type: "integer", keywords: ["stars", "score"] },

  // ── Selection ────────────────────────────────────────────────────
  { id: "toggle", label: "Toggle", sub: "On / off boolean", group: "Selection", icon: "ToggleLeft", type: "boolean", keywords: ["switch", "checkbox", "bool"] },
  { id: "dropdown", label: "Dropdown", sub: "One choice from a fixed list", group: "Selection", icon: "Filter", type: "text", hasChoices: true, keywords: ["select", "enum", "status"] },
  { id: "dropdown_multiple", label: "Dropdown (multiple)", sub: "Several choices from a list", group: "Selection", icon: "Filter", type: "json", hasChoices: true, keywords: ["multiselect", "tags"] },
  { id: "radio", label: "Radio Buttons", sub: "One choice, all options visible", group: "Selection", icon: "Check", type: "text", hasChoices: true, keywords: ["select"] },
  { id: "checkboxes", label: "Checkboxes", sub: "Multiple choices, all visible", group: "Selection", icon: "Check", type: "json", hasChoices: true, keywords: ["multiselect"] },
  { id: "tags", label: "Tags", sub: "Free-form list of labels", group: "Selection", icon: "Hash", type: "json", keywords: ["chips", "keywords"] },
  { id: "datetime", label: "Datetime", sub: "Date and time", group: "Selection", icon: "Calendar", type: "timestamp", keywords: ["date", "time", "timestamp"] },
  { id: "date", label: "Date", sub: "Calendar date only", group: "Selection", icon: "Calendar", type: "timestamp", keywords: ["day"] },
  { id: "color", label: "Color", sub: "Hex color picker", group: "Selection", icon: "Palette", type: "text", keywords: ["swatch", "hex", "theme"] },
  { id: "icon", label: "Icon", sub: "Pick a lucide icon name", group: "Selection", icon: "Bolt", type: "text", keywords: ["glyph", "symbol"] },

  // ── Relational ───────────────────────────────────────────────────
  { id: "relation", label: "Many to One", sub: "Reference a row in another collection", group: "Relational", icon: "Database", type: "relation", hasRelation: true, keywords: ["m2o", "foreign", "reference", "link"] },
  { id: "relation_many", label: "Many to Many", sub: "Reference multiple rows in another collection (stored as a JSON array of ids)", group: "Relational", icon: "Database", type: "relation_many", hasRelation: true, keywords: ["m2m", "many to many", "multi-reference"] },
  { id: "file", label: "File", sub: "Reference an uploaded file", group: "Relational", icon: "Folder", type: "text", keywords: ["upload", "attachment", "asset"] },
  { id: "image", label: "Image", sub: "Reference an uploaded image", group: "Relational", icon: "Upload", type: "text", keywords: ["photo", "picture", "asset"] },
  { id: "files", label: "Files (multiple)", sub: "List of uploaded file ids", group: "Relational", icon: "Folder", type: "json", keywords: ["gallery", "attachments"] },

  // ── Presentation & Other ─────────────────────────────────────────
  { id: "json", label: "JSON", sub: "Raw JSON object or array", group: "Presentation & Other", icon: "Braces", type: "json", keywords: ["object", "array", "raw"] },
  { id: "map", label: "Map", sub: "Geo point / GeoJSON", group: "Presentation & Other", icon: "Globe", type: "json", keywords: ["location", "geo", "coordinates"] },
  { id: "url", label: "URL", sub: "Link to a web address", group: "Presentation & Other", icon: "ExternalLink", type: "text", keywords: ["link", "href", "website"] },
  { id: "email", label: "Email", sub: "Email address", group: "Presentation & Other", icon: "Mail", type: "text", keywords: ["mail", "contact"] },
  { id: "uuid", label: "UUID", sub: "Universally-unique identifier", group: "Presentation & Other", icon: "Shield", type: "uuid", keywords: ["id", "guid"] },
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
