/**
 * Agent skills — reusable procedural knowledge, in the open format.
 *
 * An agent already had a system prompt. A skill differs in two ways that matter:
 * it belongs to the WORKSPACE rather than to one agent, and it is paid for only
 * when used. Only `name` and `description` reach the prompt; the body is
 * fetched through a tool once the model decides it wants it. That is what makes
 * a 3,000-word runbook affordable to have and pointless to inline.
 *
 * ## Why the format is not ours
 *
 * The columns are the Agent Skills shape — a `SKILL.md` with `name` and
 * `description` in YAML frontmatter and markdown after it — because the whole
 * value is that a tenant can paste a skill written for some other agent tool and
 * have it work here. A bespoke shape would have been marginally tidier and would
 * have thrown that away, at which point this is just a second prompt field.
 *
 * So `parseSkillMarkdown` accepts a raw `SKILL.md` and pulls the three fields
 * out of it. Frontmatter is parsed narrowly on purpose — two known scalar keys,
 * no YAML engine — because this input arrives from outside and a full parser is
 * a much larger surface than the two strings we actually read.
 */
import { and, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg/schema";
import * as sqlite from "@backlex/db/sqlite/schema";
import type { Ctx } from "../../context";

type AnyDb = any;

const table = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.agentSkills : sqlite.agentSkills) as typeof pg.agentSkills;

export interface SkillRow {
  id: string;
  tenantId: string | null;
  name: string;
  description: string;
  body: string;
  active: boolean;
  createdAt: Date | number;
  updatedAt: Date | number;
}

export interface SkillInput {
  name?: string;
  description?: string;
  body?: string;
  active?: boolean;
}

/** A skill name is addressed by the model, so it has to be typeable and
 *  unambiguous: the same charset the Agent Skills spec constrains a directory
 *  name to. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const assertValidName = (name: string): void => {
  if (!NAME_RE.test(name)) {
    throw new AppError(
      "VALIDATION",
      "skill name must be lowercase letters, digits and dashes (1–64 chars), starting with a letter or digit",
    );
  }
};

/**
 * Pull `name`, `description` and the body out of a raw `SKILL.md`.
 *
 * Deliberately not a YAML parser. The frontmatter contract we care about is two
 * scalar keys, and everything else a real skill file may carry (`license`,
 * `metadata`, `allowed-tools`) is either irrelevant here or something we must
 * NOT act on — `allowed-tools` in particular is a capability grant, and honouring
 * one that arrived in pasted text would let a skill widen what an agent may do.
 * Unknown keys are read past, not obeyed.
 */
export const parseSkillMarkdown = (
  raw: string,
): { name?: string; description?: string; body: string } => {
  const text = raw.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text.trim() };
  const fm = m[1] ?? "";
  const scalar = (key: string): string | undefined => {
    const line = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(fm);
    const v = line?.[1]?.trim();
    if (!v) return undefined;
    // Strip one layer of matching quotes, which is how a description containing
    // a colon has to be written.
    return v.replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1").trim() || undefined;
  };
  return {
    name: scalar("name"),
    description: scalar("description"),
    body: text.slice(m[0].length).trim(),
  };
};

export const listSkills = async (ctx: Ctx, tenantId: string): Promise<SkillRow[]> => {
  const t = table(ctx.dialect);
  return (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(t.name)) as SkillRow[];
};

export const getSkillByName = async (
  ctx: Ctx,
  tenantId: string,
  name: string,
): Promise<SkillRow | null> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.name, name)))
    .limit(1)) as SkillRow[];
  return rows[0] ?? null;
};

export const createSkill = async (
  ctx: Ctx,
  tenantId: string,
  input: SkillInput,
): Promise<SkillRow> => {
  const name = (input.name ?? "").trim();
  const description = (input.description ?? "").trim();
  const body = (input.body ?? "").trim();
  if (!name) throw new AppError("VALIDATION", "skill needs a name");
  assertValidName(name);
  // The description is what the model decides on — a skill without one is
  // invisible to it, so an empty one is a broken skill rather than a sparse one.
  if (!description) throw new AppError("VALIDATION", "skill needs a description");
  if (!body) throw new AppError("VALIDATION", "skill needs a body");
  if (await getSkillByName(ctx, tenantId, name)) {
    throw new AppError("CONFLICT", `a skill named '${name}' already exists`);
  }
  const t = table(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    name,
    description,
    body,
    active: input.active ?? true,
    createdAt: now,
    updatedAt: now,
  } as unknown as SkillRow;
  await (ctx.db as AnyDb).insert(t).values(row);
  return row;
};

export const updateSkill = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  input: SkillInput,
): Promise<void> => {
  const t = table(ctx.dialect);
  if (input.name !== undefined) assertValidName(input.name.trim());
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body.trim() } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
    })
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

export const deleteSkill = async (ctx: Ctx, tenantId: string, id: string): Promise<void> => {
  const t = table(ctx.dialect);
  await (ctx.db as AnyDb).delete(t).where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

/**
 * The skills an agent may consult, resolved by name and narrowed to the active
 * ones. A name that no longer resolves is dropped rather than raised: a skill
 * deleted after an agent was authored should quietly stop being offered, the
 * same way a removed tool does.
 */
export const skillsForAgent = async (
  ctx: Ctx,
  tenantId: string,
  names: string[] | null | undefined,
): Promise<SkillRow[]> => {
  if (!Array.isArray(names) || names.length === 0) return [];
  const wanted = new Set(names);
  return (await listSkills(ctx, tenantId)).filter((s) => s.active && wanted.has(s.name));
};
