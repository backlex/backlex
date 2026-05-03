import { createWorkerosAuthClient } from "@workeros/auth/client";

export const auth = createWorkerosAuthClient(
  import.meta.env.VITE_API_URL ?? window.location.origin,
);
