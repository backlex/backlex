import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("jobs", "routes/jobs.tsx"),
  route("flows", "routes/flows.tsx"),
  route("agents", "routes/agents.tsx"),
  route("permissions", "routes/permissions.tsx"),
] satisfies RouteConfig;
