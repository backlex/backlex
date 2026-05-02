import { createApp } from "./app";
import type { Env } from "./env";

const env: Env = {
  APP_URL: process.env.APP_URL ?? "http://localhost:5173",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "dev-secret-change-me",
  DATABASE_URL: process.env.DATABASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

const app = createApp(env);
const port = Number(process.env.PORT ?? 3000);

console.log(`workeros api listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
