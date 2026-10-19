import { parse, stringify } from "yaml";

/** SKILL.md as the Workbench's frontmatter form edits it (moved from the KOBE-83 editor). */

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface SkillMdParts {
  readonly name: string;
  readonly description: string;
  /** Every other frontmatter key, as YAML text (empty when there are none). */
  readonly other: string;
  readonly body: string;
}

export const SKILL_MD = "SKILL.md";
const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Splits SKILL.md into its name, description, remaining frontmatter and body. */
export function splitSkillMd(text: string): Result<SkillMdParts> {
  const clean = text.replace(/^\uFEFF/, "");
  const match = FENCE.exec(clean);
  if (!match?.[1])
    return fail("SKILL.md must start with a YAML frontmatter block between --- lines.");
  let data: unknown;
  try {
    data = parse(match[1], { schema: "core", maxAliasCount: 10 });
  } catch {
    return fail("The SKILL.md frontmatter is not valid YAML.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return fail("The SKILL.md frontmatter must be a mapping with name and description.");
  const { name, description, ...rest } = data as Record<string, unknown>;
  return {
    ok: true,
    value: {
      name: typeof name === "string" ? name : "",
      description: typeof description === "string" ? description : "",
      other: Object.keys(rest).length > 0 ? stringify(rest) : "",
      body: clean.slice(match[0].length),
    },
  };
}

/** Writes SKILL.md from its parts: name and description first, then the other keys. */
export function composeSkillMd(parts: SkillMdParts): string {
  const head = stringify({ name: parts.name, description: parts.description });
  return `---\n${head}${parts.other.trim() === "" ? "" : `${parts.other.trimEnd()}\n`}---\n${parts.body}`;
}

/** What is wrong with the "other frontmatter" YAML of the form; null when fine. */
export function otherFrontmatterProblem(other: string): string | null {
  if (other.trim() === "") return null;
  let data: unknown;
  try {
    data = parse(other, { schema: "core", maxAliasCount: 10 });
  } catch {
    return "The other frontmatter is not valid YAML.";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return "The other frontmatter must be key: value lines.";
  if ("name" in data || "description" in data)
    return "Set name and description in their own fields, not here.";
  return null;
}
