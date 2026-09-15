/**
 * The built-in email catalog (`@backlex/core/email-templates`) against the code
 * that actually sends mail.
 *
 * The admin's variable list for a built-in email is derived from the catalog,
 * and each send site `satisfies` the catalog's type, so a variable changed at a
 * send site is a compile error. What the type system cannot see is a send site
 * that never opted in: a NEW `sendTemplatedEmail` call with its own key and no
 * `satisfies`. Its template would show up in nobody's catalog, and an admin
 * would have to guess its variables — which is exactly where this started. So
 * that half is a source scan, with a floor so a scan that stops matching cannot
 * pass by finding nothing.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderTemplate, templatePathValue, EMAIL_TEMPLATE_KEY_PATTERN } from "@backlex/core";
import {
  BUILT_IN_EMAIL_KEYS,
  BUILT_IN_EMAIL_TEMPLATES,
  EMAIL_RENDER_CONTEXT_SAMPLES,
  templateVariableRefs,
  variablePathsOf,
} from "@backlex/core/email-templates";

const SERVER = join(import.meta.dir, "../../src/server");

const sources = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

/** The argument text of every `sendTemplatedEmail(…)` call, brace-balanced. */
const sendCalls = (): Array<{ file: string; args: string }> => {
  const out: Array<{ file: string; args: string }> = [];
  for (const file of sources(SERVER)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bsendTemplatedEmail\(/g)) {
      // Skip the definition itself and imports — only call sites have `ctx`.
      const open = m.index! + m[0].length - 1;
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) {
          out.push({ file: relative(SERVER, file), args: src.slice(open + 1, i) });
          break;
        }
      }
    }
  }
  return out;
};

describe("built-in send sites are in the catalog", () => {
  const calls = sendCalls();
  // A key written as a literal (`"form_invite"`) or a template literal
  // (`booking.${kind}`) is the sender's own. One read off an op or an input
  // (`op.templateKey`) is a caller's custom template and has no fixed variables.
  const literal = calls
    .map((c) => ({ ...c, key: /templateKey:\s*(["`])([^"`]+)\1/.exec(c.args)?.[2] }))
    .filter((c): c is typeof c & { key: string } => Boolean(c.key));

  test("the scan still finds the senders (else everything below passes vacuously)", () => {
    // forms ×2, signatures ×2, approvals ×2, booking ×1 — at the time of writing.
    expect(literal.length).toBeGreaterThanOrEqual(7);
  });

  test("every literal key names at least one catalog entry", () => {
    const missing = literal.filter(({ key }) => {
      // `approval_${outcome}` → /^approval_.+$/
      const pattern = new RegExp(`^${key.replace(/[.*+?^()|[\]\\]/g, "\\$&").replace(/\$\{[^}]+\}/g, ".+")}$`);
      return !BUILT_IN_EMAIL_KEYS.some((k) => pattern.test(k));
    });
    expect(missing.map((c) => `${c.file}: ${c.key}`)).toEqual([]);
  });

  test("every literal-keyed send site checks its vars against the catalog type", () => {
    const unchecked = literal.filter((c) => !/satisfies\s+BuiltInEmailVars\[/.test(c.args));
    expect(unchecked.map((c) => `${c.file}: ${c.key}`)).toEqual([]);
  });
});

describe("the catalog itself", () => {
  test("every key is one the template routes accept", () => {
    expect(BUILT_IN_EMAIL_KEYS.filter((k) => !EMAIL_TEMPLATE_KEY_PATTERN.test(k))).toEqual([]);
  });

  test("a starter only uses variables its sender passes", () => {
    const typos: string[] = [];
    for (const key of BUILT_IN_EMAIL_KEYS) {
      const { sample, starter } = BUILT_IN_EMAIL_TEMPLATES[key];
      for (const ref of templateVariableRefs(starter.subject, starter.bodyHtml)) {
        if (!templatePathValue(sample as Record<string, unknown>, ref).found) typos.push(`${key}: ${ref}`);
      }
    }
    expect(typos).toEqual([]);
  });

  test("a sample offers every variable a leaf at a time, arrays whole", () => {
    expect(variablePathsOf(BUILT_IN_EMAIL_TEMPLATES.signature_completed.sample as Record<string, unknown>)).toEqual([
      "title",
      "signers",
      "documentHash",
    ]);
    expect(variablePathsOf(EMAIL_RENDER_CONTEXT_SAMPLES.flow as Record<string, unknown>)).toEqual([
      "data.id",
      "$user.id",
      "$user.email",
      "$user.roles",
      "$last",
    ]);
  });
});

describe("placeholder helpers agree with the renderer", () => {
  const vars = { user: { email: "a@b.c", nick: null }, n: 0, list: [{ x: 1 }], $user: { id: "u1" } };

  test("refs are distinct, in first-seen order, across every text given", () => {
    expect(templateVariableRefs("{{ user.email }} {{n}}", "{{ user.email }} {{ $user.id }} {{ bad path }}")).toEqual([
      "user.email",
      "n",
      "$user.id",
    ]);
  });

  test("a path renders empty exactly when it is not found or null", () => {
    for (const path of ["user.email", "user.nick", "user.missing", "n", "list", "list.0.x", "nope", "$user.id"]) {
      const { found, value } = templatePathValue(vars, path);
      const rendered = renderTemplate(`{{ ${path} }}`, vars);
      expect(`${path}: ${rendered === ""}`).toBe(`${path}: ${!found || value == null}`);
    }
  });
});
