/**
 * OpenAPI metadata for the resumable-upload (TUS) endpoints.
 *
 * `routes/uploads.ts` is a plain `Hono` router with no `.openapi()` calls, so
 * it never reached `SUBAPPS` and never reached the published document — while
 * answering `200` on every live instance and being the surface `docs/resumable-
 * uploads.md` tells customers to build against. Described here through the
 * sibling-metadata pattern (see `graphql.openapi.ts`) rather than by converting
 * the router, because the protocol verbs carry their contract in HEADERS, and
 * those are what a client actually needs written down.
 */
import { apiRegistry, errorResponses, SECURITY, z } from "../lib/openapi";

const Upload = z
  .object({
    id: z.string(),
    key: z.string().openapi({ description: "Logical object key the finished file lands on." }),
    size: z.number().int().openapi({ description: "Total declared size in bytes." }),
    offset: z.number().int().openapi({ description: "Bytes durably received so far — resume from here." }),
    status: z.string().openapi({ example: "in_progress" }),
    contentType: z.string().nullable(),
    folderId: z.string().nullable(),
    parts: z.number().int().openapi({ description: "Chunks stored so far." }),
    createdAt: z.unknown(),
    updatedAt: z.unknown(),
    expiresAt: z.unknown().openapi({ description: "An abandoned upload is reaped after this." }),
  })
  .openapi("Upload");

const TUS_NOTE =
  "Speaks the TUS 1.0.0 resumable-upload protocol, so the contract is in the headers rather than the body.";

apiRegistry.registerPath({
  method: "post",
  path: "/api/uploads",
  tags: ["uploads"],
  summary: "Create a resumable upload",
  description:
    `${TUS_NOTE} Send \`Upload-Length\` (total bytes) and \`Upload-Metadata\` carrying at least ` +
    "`filename` or `key`, plus optional `contentType` and `folderId`. A first chunk may ride along " +
    "(creation-with-upload). Refused with `413` when the declared size exceeds the instance limit, " +
    "and with `VALIDATION` when it would take the workspace past its storage cap — TUS declares the " +
    "full size up front, so that check is exact rather than a guess part-way through.",
  security: SECURITY,
  responses: {
    201: {
      description: "Created. `Location` carries the upload URL and `Upload-Offset` the bytes accepted so far.",
      content: { "application/json": { schema: Upload } },
    },
    413: { description: "Declared size exceeds the instance upload limit." },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/uploads",
  tags: ["uploads"],
  summary: "List uploads in progress",
  description:
    "The management view — what is unfinished, how far each got, and when it expires. Distinct from the " +
    "protocol's own `HEAD /api/uploads/{id}` offset probe.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ uploads: z.array(Upload) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/uploads/{id}",
  tags: ["uploads"],
  summary: "Read one upload",
  description:
    `${TUS_NOTE} \`GET\` returns the JSON view; **\`HEAD\` on this same path is the protocol's offset ` +
    "probe** — a client HEADs before resuming and reads `Upload-Offset` from the response headers. Both " +
    "verbs are registered on one handler so Hono's auto-HEAD cannot shadow the protocol one.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Upload } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/uploads/{id}",
  tags: ["uploads"],
  summary: "Append a chunk",
  description:
    `${TUS_NOTE} Send the chunk as \`application/offset+octet-stream\` with \`Upload-Offset\` set to the ` +
    "offset this chunk starts at. The upload finalizes on its own once the offset reaches the declared " +
    "`Upload-Length`. The response's `Upload-Offset` is the new durable offset — resume from that, not " +
    "from what the client believes it sent.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Chunk stored. `Upload-Offset` carries the new durable offset." },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/uploads/{id}",
  tags: ["uploads"],
  summary: "Abort an upload",
  description: "Discards the parts stored so far. Abandoned uploads are also reaped at `expiresAt`.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: { 204: { description: "Aborted." }, ...errorResponses },
});
