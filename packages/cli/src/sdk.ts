/**
 * `backlex sdk [lang]` — discover the official native client SDKs.
 *
 * backlex ships hand-written, idiomatic clients for ten ecosystems (all wrap the
 * same REST + SSE wire format). This command surfaces the install command and a
 * one-line quickstart per language, and points at `gen-openapi` for the
 * optional generated typed models. It does not generate the clients — they're
 * published packages, not codegen output.
 */
import { has, printTable } from "./client";

interface SdkInfo {
  lang: string;
  install: string;
  /** A minimal "create a client" line in that language. */
  quickstart: string;
}

const SDKS: SdkInfo[] = [
  { lang: "typescript", install: "npm install backlex", quickstart: 'createClient({ url, apiKey })' },
  { lang: "python", install: "pip install backlex", quickstart: "Client(url, api_key=...)" },
  { lang: "go", install: "go get github.com/backlex/backlex-go", quickstart: "backlex.New(url, ...)" },
  { lang: "dotnet", install: "dotnet add package Backlex", quickstart: "new Client(url, ...)" },
  { lang: "java", install: "com.backlex:backlex:0.0.1 (Maven Central)", quickstart: "BacklexClient.builder()..." },
  { lang: "kotlin", install: "com.backlex:backlex-kotlin:0.0.1", quickstart: "BacklexClient.builder()..." },
  { lang: "swift", install: "SPM: backlex/backlex-swift", quickstart: "Client(url: ...)" },
  { lang: "ruby", install: "gem install backlex", quickstart: "Backlex::Client.new(url, ...)" },
  { lang: "php", install: "composer require backlex/backlex", quickstart: "new Client(url, ...)" },
  { lang: "dart", install: "dart pub add backlex", quickstart: "Client(url, ...)" },
  { lang: "rust", install: "cargo add backlex", quickstart: "Client::builder()..." },
];

const SDK_HELP = `backlex sdk [lang]

  (no arg)   list every official client SDK + install command
  <lang>     install + quickstart for one language

Languages: ${SDKS.map((s) => s.lang).join(", ")}
`;

export const runSdk = (args: string[]): void => {
  const lang = args.find((a) => !a.startsWith("-"));
  const json = has(args, "--json");

  if (args[0] === "help" || args[0] === "--help") {
    process.stdout.write(SDK_HELP);
    return;
  }

  if (!lang) {
    if (json) {
      process.stdout.write(`${JSON.stringify(SDKS, null, 2)}\n`);
    } else {
      printTable(SDKS.map((s) => ({ lang: s.lang, install: s.install })));
    }
    return;
  }

  const sdk = SDKS.find((s) => s.lang === lang.toLowerCase());
  if (!sdk) {
    process.stderr.write(`no SDK for "${lang}". Known: ${SDKS.map((s) => s.lang).join(", ")}\n`);
    process.exit(1);
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(sdk, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${sdk.lang}\n` +
      `  install:    ${sdk.install}\n` +
      `  quickstart: ${sdk.quickstart}\n` +
      `\nTyped models (optional): backlex gen-openapi --out openapi.json\n` +
      `  then: openapi-generator generate -g ${sdk.lang} -i openapi.json\n`,
  );
};
