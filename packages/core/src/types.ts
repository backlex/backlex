export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[];

export type Id = string;

/*
 * ## Four types used to live here, and every one of them lied
 *
 * `CollectionFieldType`, `CollectionField`, `CollectionDefinition` and
 * `ListQuery` described the shape of an API that has not existed for a long
 * time. Nothing imported any of them — a census of all 68 `from
 * "@backlex/core"` import sites named none — so they cost nothing to keep and
 * were never corrected. That is exactly what made them dangerous: they were
 * the FIRST types a reader finds, in the package whose whole job is to be the
 * shared vocabulary.
 *
 * What they claimed, measured against what the server does:
 *
 *  - `ListQuery` named `orderBy` / `order` / `where`. The REST surface takes
 *    `sort` and `filter`. A query written against this type does not fail — it
 *    is accepted and the unknown key is ignored, so `?where={"kind":"kurumsal"}`
 *    answered with ALL five rows where `?filter=` answered with the correct
 *    two. An ignored filter returns MORE rows than it should, which is the one
 *    direction a silent failure must never go.
 *  - `CollectionFieldType` listed `string` and `vector`, neither of which is a
 *    field type, and omitted twelve that are: `relation`, `relation_many`,
 *    `file`, `money`, `phone`, `email`, `url`, `hash`, `geo`, `longtext`,
 *    `divider`, `notice`.
 *  - `CollectionField` / `CollectionDefinition` were built on that enum.
 *
 * The real shapes are owned where they are enforced, and both are exported:
 * `FieldType` / `FIELD_TYPES` in `@backlex/db` (with a compile-time
 * exhaustiveness guard, so the list cannot drift again), and `ListQuery` in
 * the `backlex` SDK (`packages/client/src/types.ts`), whose `limit` even
 * carries its 1-200 ceiling. Deleting rather than fixing is deliberate: a
 * second copy of a vocabulary is a second thing to keep in step, and this one
 * proves what happens when nobody does.
 */

export interface AuthContext {
  userId: Id | null;
  email: string | null;
  roles: string[];
}
