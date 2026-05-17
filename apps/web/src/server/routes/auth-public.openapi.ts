import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const TAG = "auth-public";

const AuthProvider = z
  .object({
    id: z.string(),
    label: z.string(),
    enabled: z.boolean(),
  })
  .passthrough()
  .openapi("AuthProvider");

const AuthSurface = z
  .object({
    providers: z.array(AuthProvider),
    policy: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .openapi("AuthSurface");

apiRegistry.registerPath({
  method: "get",
  path: "/api/auth/providers",
  tags: [TAG],
  summary: "Public auth surface",
  description:
    "Unauthenticated discovery endpoint — returns the active workspace's sign-in providers and non-secret policy flags. The workspace is resolved from `X-Workeros-Tenant` / cookie / default.",
  security: [],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: AuthSurface }) } },
    },
    ...errorResponses,
  },
});
