import {
  APPROVAL_MODES,
  connectorNameSchema,
  globSchema,
  SYSTEM_PROMPT_MAX_BYTES,
} from "@kobe/protocol";
import { z } from "zod";

export { APPROVAL_MODES, type ApprovalMode } from "@kobe/protocol";

/**
 * Admin-only agent mode (spec docs/specs/agent-creator.md AC1, approved by Chris 2026-10-22): the
 * agent's allowed tools run without an approval card. It is an agent setting only, never a thread
 * or run mode (`APPROVAL_MODES` stays the three D29 modes), and only the server decides whether it
 * applies: who may set it (site and team admins) is enforced at save, publish and fork, and the
 * policy engine still decides every call.
 */
export const DANGEROUS_APPROVAL_MODE = "dangerous";

/** The modes an agent file may name: the D29 thread modes plus {@link DANGEROUS_APPROVAL_MODE}. */
export const AGENT_APPROVAL_MODES = [...APPROVAL_MODES, DANGEROUS_APPROVAL_MODE] as const;
export const agentApprovalModeSchema = z.enum(AGENT_APPROVAL_MODES);
export type AgentApprovalMode = z.infer<typeof agentApprovalModeSchema>;

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
  promptBytes: SYSTEM_PROMPT_MAX_BYTES,
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

/**
 * Connectors (D27, KOBE-254): a list of connector registry names, or `all` for every connector the
 * team enables at run time. Either way it is a request: the team's enablement, exposure, drift
 * checks and each user's grants still decide, and `all` never names a connector the team has not
 * enabled. `[all]` is a list holding a connector named `all`, not this form.
 */
export const ALL_CONNECTORS = "all";
const connectorsSchema = z.union([
  uniqueList(connectorNameSchema, AGENT_FILE_LIMITS.connectors),
  z.literal(ALL_CONNECTORS),
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

/**
 * The agent file's frontmatter (spec §6.3); unknown keys are rejected.
 *
 * HARD CONTRACT for run-time resolution and policy (KOBE-35, KOBE-46, KOBE-47): any member can
 * write any value here in a personal agent, so these fields are requests, never grants.
 *   - `tools.allow` only RESTRICTS: the effective tool set is the intersection of the agent's allow
 *     list with what the team and install expose. It never adds a tool or removes a prompt.
 *   - `tools.deny`, site/team deny rules and ask rules always win over `tools.allow`.
 *   - `approval_mode` is clamped to the team/site floor: it can only make a run stricter (D19,
 *     D29); `auto` below an `ask-on-write` floor runs as `ask-on-write`. The one exception is
 *     `dangerous` (AC1): the server refuses it from anyone but a site or team admin, and honours
 *     it only under an `auto` site floor, as a policy-engine outcome.
 *   - `model`, `skills`, `connectors` are opaque names intersected with the team's settings;
 *     `connectors: all` is the team's enabled list itself, still under exposure, drift and grants.
 * `agentWarnings` flags the broad values at save time, but enforcement is the policy engine's.
 */
export const agentFrontmatterSchema = z
  .object({
    name: line(AGENT_FILE_LIMITS.name),
    role: text(AGENT_FILE_LIMITS.role).optional(),
    description: text(AGENT_FILE_LIMITS.description).optional(),
    icon: iconSchema.optional(),
    model: modelSchema.optional(),
    skills: skillsSchema.optional(),
    /** Connector registry names (D27; @kobe/protocol `connectorNameSchema`) or `all`. */
    connectors: connectorsSchema.optional(),
    tools: toolsSchema.optional(),
    approval_mode: agentApprovalModeSchema.optional(),
    starters: uniqueList(text(AGENT_FILE_LIMITS.starter), AGENT_FILE_LIMITS.starters).optional(),
  })
  .strict()
  .superRefine((fm, ctx) => {
    // AC1: Dangerous auto-allows only tools the agent names one by one, so it needs some.
    if (
      fm.approval_mode === DANGEROUS_APPROVAL_MODE &&
      explicitToolNames(fm.tools?.allow).length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tools", "allow"],
        message:
          "must name at least one tool (no wildcards) in Dangerous mode: only the tools listed one by one run without asking",
      });
    }
  });

/** A plain tool name (built-in or `mcp__<server>__<tool>`): no glob, escape or argument part. */
const EXPLICIT_TOOL_NAME = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * The allow-list entries that name one tool exactly (AC1): the only tools a Dangerous agent may
 * run without asking. Globs (`mcp__jira__*`, `*`) and argument shorthands (`bash:ls *`) never
 * count.
 */
export function explicitToolNames(allow: readonly string[] | undefined): string[] {
  return (allow ?? []).filter((entry) => EXPLICIT_TOOL_NAME.test(entry));
}

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

/**
 * Connector inputs of an agent (D27) for run-time resolution: `all` (every connector the team
 * enables, KOBE-254) or the listed names; none when the key is absent.
 */
export function agentConnectors(frontmatter: AgentFrontmatter): {
  all: boolean;
  names: readonly string[];
} {
  const connectors = frontmatter.connectors;
  if (connectors === ALL_CONNECTORS) return { all: true, names: [] };
  return { all: false, names: connectors ?? [] };
}

/** Whether the agent asks for Dangerous mode (AC1); whether it applies is the server's call. */
export function isDangerousMode(frontmatter: Pick<AgentFrontmatter, "approval_mode">): boolean {
  return frontmatter.approval_mode === DANGEROUS_APPROVAL_MODE;
}

/** A glob that matches every tool name (only `*` wildcards). */
const MATCHES_EVERYTHING = /^\*+$/;

/**
 * Non-blocking save-time warnings for broad policy requests (allow-everything globs, `auto`
 * approval). They change nothing at run time: see the contract on `agentFrontmatterSchema`.
 */
export function agentWarnings(frontmatter: AgentFrontmatter): AgentFileIssue[] {
  const warnings: AgentFileIssue[] = [];
  (frontmatter.tools?.allow ?? []).forEach((glob, i) => {
    if (MATCHES_EVERYTHING.test(glob)) {
      warnings.push({
        path: `frontmatter.tools.allow.${i}`,
        message:
          "allows every tool; allow lists only narrow what the team exposes and never skip approvals",
      });
    }
  });
  if (frontmatter.approval_mode === DANGEROUS_APPROVAL_MODE) {
    warnings.push({
      path: "frontmatter.approval_mode",
      message:
        "dangerous runs the agent's allowed tools without asking for approval; only site and team admins may set it",
    });
  }
  if (frontmatter.approval_mode === "auto") {
    warnings.push({
      path: "frontmatter.approval_mode",
      message:
        "auto runs only allow-listed tools and denies the rest; it never loosens the team's floor",
    });
  }
  return warnings;
}
