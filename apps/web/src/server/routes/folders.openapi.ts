import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const FolderInput = z
  .object({
    name: z.string().min(1),
    parentId: z.string().nullable().optional(),
  })
  .openapi("FolderInput");

const FolderRow = z
  .object({
    id: z.string(),
    name: z.string(),
    parentId: z.string().nullable(),
    ownerId: z.string().nullable(),
    tenantId: z.string().nullable(),
  })
  .openapi("FolderRow");

const tags = ["folders"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/folders",
  tags,
  summary: "List folders",
  description: "Returns every folder in the active workspace, scoped by `read` permission on the files collection.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(FolderRow) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/folders",
  tags,
  summary: "Create folder",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: FolderInput } } } },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ data: FolderRow }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/folders/{id}",
  tags,
  summary: "Update folder",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { "application/json": { schema: FolderInput.partial() } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/folders/{id}",
  tags,
  summary: "Delete folder",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

export const _FolderInput = FolderInput;
export const _FolderRow = FolderRow;
