import { createAuthClient } from "better-auth/react";

export const createWorkerosAuthClient = (baseURL: string) =>
  createAuthClient({
    baseURL,
  });

export type WorkerosAuthClient = ReturnType<typeof createWorkerosAuthClient>;
