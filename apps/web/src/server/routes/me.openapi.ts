import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const TAG = "me";

const MeRow = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    roles: z.array(z.string()),
    isAdmin: z.boolean(),
    tenantId: z.string().nullable(),
  })
  .openapi("Me");

apiRegistry.registerPath({
  method: "get",
  path: "/api/me",
  tags: [TAG],
  summary: "Who am I",
  description: "Minimal identity surface for the admin SPA header — id, name, email, image, roles, active workspace.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: MeRow }) } } },
    ...errorResponses,
  },
});
