import type { Config } from "@react-router/dev/config";

export default {
  // SSR on: the whole point of this example is that loaders and actions run on
  // the server, where the admin API key lives. A SPA build would have nowhere
  // to keep it.
  ssr: true,
} satisfies Config;
