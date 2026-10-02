import { approvalModeSchema, connectorNameSchema, globSchema } from "@kobe/protocol";
import { z } from "zod";

export { APPROVAL_MODES, type ApprovalMode } from "@kobe/protocol";

/**
 * Limits for an agent file (spec D19, §6.3). Agent files are untrusted input (imports, API), so
 * every field is bounded. Byte limits count UTF-8 bytes of the canonical export.
 */
export const AGENT_FILE_LIMITS = {
  /** Whole file as uploaded (checked before parsing) and as exported. */
  fileBytes: 128 * 1024,
  /** YAML frontmatter, as uploaded and in canonical form. */
  frontmatterBytes: 16 * 1024,
  /** Body (the system prompt). */
  promptBytes: 100 * 1024,
  name: 80,
  role: 300,
  description: 1000,
  icon: 48,
  model: 128,
  skills: 32,
  connectors: 32,
  toolGlobs: 100,
  starters: 8,
  starter: 300,
} as const;

/** Frontmatter keys in canonical (export) order, as written in the file. */
export const FRONTMATTER_KEYS = [
  "name",
  "role",
  "description",
  "icon",
  "model",
  "skills",
  "connectors",
  "tools",
  "approval_mode",
  "starters",
] as const;

// Lone UTF-16 surrogates: not valid Unicode; Postgres jsonb rejects them and UTF-8 mangles them.
const LONE_SURROGATE =
  "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]";
// C0 controls except tab and newline, plus DEL (Postgres text can't store NUL at all), or a lone
// surrogate.
export const FORBIDDEN_CONTROL = new RegExp(
  `[\\u0000-\\u0008\\u000B-\\u001F\\u007F]|${LONE_SURROGATE}`,
);
const ANY_CONTROL = new RegExp(`[\\u0000-\\u001F\\u007F]|${LONE_SURROGATE}`);

/** Single-line text: trimmed, no control characters at all. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(max, `must be at most ${max} characters`)
    .refine(
      (s) => !ANY_CONTROL.test(s),
      "must be a single line without control characters or invalid Unicode",
    );

/** Multi-line text: trimmed, newlines and tabs allowed. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(max, `must be at most ${max} characters`)
    .refine(
      (s) => !FORBIDDEN_CONTROL.test(s),
      "must not contain control characters or invalid Unicode",
    );

const uniqueList = <T extends z.ZodType<string>>(item: T, max: number) =>
  z
    .array(item)
    .max(max, `must list at most ${max} entries`)
    .refine((list) => new Set(list).size === list.length, "must not repeat an entry");

/** Skill references: lowercase slugs like SKILL.md names. */
export const skillSlugSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/, "must be a lowercase slug (a-z, 0-9, -)");

/** A model catalog alias (`fast`, `smart`, `local`) or a provider model id (D30). */
const modelSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/,
    "must be a model alias or id (letters, digits, . _ : / @ -)",
  )
  .max(AGENT_FILE_LIMITS.model);

/** An icon name (`bar-chart`) or a short emoji sequence; never a URL (no remote loads). */
const iconSchema = z
  .string()
  .max(AGENT_FILE_LIMITS.icon)
  .regex(
    /^(?:[a-z0-9][a-z0-9-]*|(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️){1,16})$/u,
    "must be an icon name (a-z, 0-9, -) or an emoji",
  );

const skillListSchema = uniqueList(skillSlugSchema, AGENT_FILE_LIMITS.skills);

/**
 * Skills (D22): a list is unioned with the user's enabled skills; `{ exclusive: [...] }` uses only
 * the listed skills; `exclusive` alone is shorthand for `{ exclusive: [] }` (no skills at all).
 */
const skillsSchema = z.union([
  skillListSchema,
  z.object({ exclusive: skillListSchema }).strict(),
  z.literal("exclusive").transform(() => ({ exclusive: [] as string[] })),
]);

/** Policy glob grammar (@kobe/protocol glob.ts), on a single line. */
const toolGlobSchema = globSchema.refine(
  (s) => !ANY_CONTROL.test(s),
  "must be a single line without control characters or invalid Unicode",
);

/** Tool allow/deny globs, matched by the policy engine (D29, KOBE-35). */
const toolsSchema = z
  .object({
    allow: uniqueList(toolGlobSchema, AGENT_FILE_LIMITS.toolGlobs).optional(),
    deny: uniqueList(toolGlobSchema, AGENT_FILE_LIMITS.toolGlobs).optional(),
  })
  .strict();

/** The agent file's frontmatter (spec §6.3); unknown keys are rejected. */
export const agentFrontmatterSchema = z
  .object({
    name: line(AGENT_FILE_LIMITS.name),
    role: text(AGENT_FILE_LIMITS.role).optional(),
    description: text(AGENT_FILE_LIMITS.description).optional(),
    icon: iconSchema.optional(),
    model: modelSchema.optional(),
    skills: skillsSchema.optional(),
    /** Connector registry names (D27); same format as @kobe/protocol `connectorNameSchema`. */
    connectors: uniqueList(connectorNameSchema, AGENT_FILE_LIMITS.connectors).optional(),
    tools: toolsSchema.optional(),
    approval_mode: approvalModeSchema.optional(),
    starters: uniqueList(text(AGENT_FILE_LIMITS.starter), AGENT_FILE_LIMITS.starters).optional(),
  })
  .strict();

export type AgentFrontmatter = z.output<typeof agentFrontmatterSchema>;

/** A parsed agent: frontmatter plus body (the system prompt). */
export interface AgentDefinition {
  readonly frontmatter: AgentFrontmatter;
  readonly prompt: string;
}

/** One problem with an agent file; `path` is e.g. `frontmatter.skills.0` or `prompt`. */
export interface AgentFileIssue {
  readonly path: string;
  readonly message: string;
}

export type AgentFileResult =
  | { readonly ok: true; readonly definition: AgentDefinition }
  | { readonly ok: false; readonly issues: readonly AgentFileIssue[] };

/** Effective-skill inputs of an agent (D22), for run-time resolution. */
export function agentSkills(frontmatter: AgentFrontmatter): {
  names: readonly string[];
  exclusive: boolean;
} {
  const skills = frontmatter.skills;
  if (skills === undefined) return { names: [], exclusive: false };
  if (Array.isArray(skills)) return { names: skills, exclusive: false };
  return { names: skills.exclusive, exclusive: true };
}
