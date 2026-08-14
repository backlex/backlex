import type { ClientCore } from "../core";

/** One folder in the file tree. */
export interface Folder {
  id: string;
  name: string;
  /** `null` at the top level. */
  parentId: string | null;
  ownerId: string | null;
  tenantId: string | null;
}

/**
 * Folders for stored files (`/api/folders`).
 *
 * A folder is metadata, not a path: an object's key is whatever it was
 * uploaded as, and `folderId` says where it is filed. Renaming a folder
 * therefore moves nothing and breaks no URL, which is the reason it is
 * modelled this way rather than as a key prefix.
 */
export interface FoldersClient {
  /** Every folder the caller can see, as a flat list — `parentId` is the tree. */
  list(): Promise<{ data: Folder[] }>;
  /** Create a folder, optionally inside another. */
  create(input: { name: string; parentId?: string | null }): Promise<{ data: Folder }>;
  /** Rename it, or move it under a different parent. Acknowledges rather than
   *  echoing the row back — call `list()` if you need the new shape. */
  update(id: string, patch: { name?: string; parentId?: string | null }): Promise<{ ok: boolean }>;
  /**
   * Delete a folder.
   *
   * The files in it are not deleted — a folder is a label, so removing it
   * unfiles its contents rather than destroying them. Deleting files is
   * `storage.delete`, deliberately a separate decision.
   */
  delete(id: string): Promise<{ ok: boolean }>;
}

export const makeFolders = (core: ClientCore): FoldersClient => {
  const base = "/api/folders";
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: () => core.request<{ data: Folder[] }>("GET", base),
    create: (input) => core.request<{ data: Folder }>("POST", base, input),
    update: (id, patch) => core.request<{ ok: boolean }>("PATCH", one(id), patch),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", one(id)),
  };
};
