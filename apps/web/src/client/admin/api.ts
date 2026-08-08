/**
 * The admin's typed API client — one `xApi` namespace per admin domain, each
 * wrapping the shared `api()` helper so the pages only ever see domain-shaped
 * payloads.
 *
 * This file is the barrel. It was 3631 lines with all sixty-one namespaces and
 * their two hundred shapes inlined, which meant a change to `forms` and a
 * change to `booking` were edits to the same file. The namespaces now live one
 * domain per module in `api/`, named for the admin area they serve, and the
 * import sites (`import { formsApi } from "@/admin/api"`) are unchanged.
 */
export * from "./api/types";
export * from "./api/access";
export * from "./api/auth-config";
export * from "./api/automation";
export * from "./api/booking";
export * from "./api/collections";
export * from "./api/content";
export * from "./api/dashboards";
export * from "./api/documents";
export * from "./api/forms";
export * from "./api/messaging";
export * from "./api/migrate";
export * from "./api/observability";
export * from "./api/workspace";
