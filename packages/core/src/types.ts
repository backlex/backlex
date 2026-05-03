export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[];

export type Id = string;

export type CollectionFieldType =
  | "string"
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "json"
  | "timestamp"
  | "uuid"
  | "vector";

export interface CollectionField {
  name: string;
  type: CollectionFieldType;
  required?: boolean;
  unique?: boolean;
  default?: Json;
  /** for vector fields */
  dimensions?: number;
}

export interface CollectionDefinition {
  slug: string;
  fields: CollectionField[];
  /** if true, RLS-style ownership column `owner_id` is enforced */
  ownerScoped?: boolean;
}

export interface ListQuery {
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: "asc" | "desc";
  where?: Record<string, Json>;
}

export interface AuthContext {
  userId: Id | null;
  email: string | null;
  roles: string[];
}
