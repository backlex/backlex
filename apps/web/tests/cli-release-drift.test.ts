/**
 * The same tripwire as `sdk-release-drift.test.ts`, for `@backlex/cli`.
 *
 * The CLI stopped being released on the *same day* the SDK did, 2026-07-03,
 * and for the same structural reason: a feature commit ships the docs page and
 * the command together, merging publishes the docs, and nothing publishes the
 * package. By 2026-08-26 npm's `@backlex/cli@0.3.0` offered **31** commands
 * while this build offers **53** — missing `booking`, `payments`, `consent`,
 * `forms`, `documents`, `signatures`, `approvals` and fifteen more, every one
 * of them a feature whose documentation is already live. `docs/sdk-and-cli.md`
 * tells a customer to run `npx @backlex/cli`.
 *
 * The surface here is the **help text**, not the internal `switch` — that is
 * the contract the CLI states to its users, and it is the one thing both a
 * source build and a published bundle can be asked for. Like the SDK guard,
 * this checks intent rather than the registry: CI cannot reach npm, and a
 * version bump is what makes an owed release visible in the diff.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP } from "../../../packages/cli/src/help";

const CLI_DIR = join(import.meta.dir, "../../../packages/cli");
const read = <T>(f: string): T => JSON.parse(readFileSync(join(CLI_DIR, f), "utf8")) as T;

/** Every `backlex <command>` the help text offers, deduped. */
const commandsFrom = (help: string): string[] =>
  [...new Set([...help.matchAll(/^ {2}backlex ([a-z][a-z0-9-]*)/gm)].map((m) => m[1] as string))].sort();

describe("CLI release drift", () => {
  const pkg = read<{ version: string }>("package.json");
  const recorded = read<{ version: string; commands: string[] }>("published-surface.json");
  const live = commandsFrom(HELP);

  test("a command-list change comes with a version bump", () => {
    const added = live.filter((c) => !recorded.commands.includes(c));
    const removed = recorded.commands.filter((c) => !live.includes(c));
    if (added.length === 0 && removed.length === 0) return;

    const detail = [
      added.length ? `added: ${added.join(", ")}` : "",
      removed.length ? `REMOVED (breaking): ${removed.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    expect(
      pkg.version,
      `The CLI's command list has moved since ${recorded.version} was published (${detail}), ` +
        "but packages/cli/package.json still says the same version. Bump it, then run " +
        "`bun run --cwd packages/cli surface:record`. Publishing is a separate step " +
        "(push a `cli-v<version>` tag); this only asks that the owed release be visible. " +
        "docs/sdk-and-cli.md tells customers to run `npx @backlex/cli`, so a command that " +
        "exists only here is a documented command they cannot run.",
    ).not.toBe(recorded.version);
  });

  test("the recorded surface is a real snapshot, not an empty placeholder", () => {
    expect(recorded.commands.length).toBeGreaterThan(5);
    expect(recorded.commands).toContain("login");
    expect(recorded.commands).toContain("whoami");
    expect(/^\d+\.\d+\.\d+$/.test(recorded.version)).toBe(true);
  });

  test("the help text is parseable at all", () => {
    // A formatting change that stopped the regex matching would silently empty
    // the live list and make every comparison above pass.
    expect(live.length).toBeGreaterThan(20);
    expect(live).toContain("login");
  });
});
