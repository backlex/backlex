import type { EnvSpec } from "@backlex-examples/shared";

/**
 * The one variable only this example reads.
 *
 * Everything else lives in `@backlex-examples/shared` — the shared list is a
 * description of what EVERY example needs, and widening it for a demo only
 * this app has would make three other setup screens ask for something they
 * never use.
 */
export const EXTRA_ENV: EnvSpec[] = [
  {
    key: "VITE_BACKLEX_VAPID_PUBLIC_KEY",
    required: false,
    value: import.meta.env.VITE_BACKLEX_VAPID_PUBLIC_KEY,
    example: "(empty) · BEl62iUYgUivxIkv69y…",
    description:
      "VAPID public key for the Web Push demo in the Messaging panel. Public by design (it ships in the bundle) — copy it from the admin → Push settings. Leave empty to skip browser push; SMS registration still works.",
  },
];

/** VAPID public key for Web Push — empty string means the push demo is off. */
export const VAPID_PUBLIC_KEY: string =
  import.meta.env.VITE_BACKLEX_VAPID_PUBLIC_KEY ?? "";
