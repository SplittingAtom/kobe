import { parse } from "yaml";

/** The skill's name is its slug: lowercase words joined by hyphens, at most 64 characters. */
export const SKILL_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
export const SKILL_DESCRIPTION_MAX = 1024;
/**
 * Half the database check (32 KiB of jsonb text): jsonb's text form adds a space after every `:`
 * and `,`, which grows dense JSON by at most 1.5x, so valid input never trips the check.
 */
const FRONTMATTER_MAX_BYTES = 16 * 1024;
const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface SkillMd {
  readonly name: string;
  readonly description: string;
  /** The whole frontmatter, as plain JSON. */
  readonly frontmatter: Record<string, unknown>;
}

/** Parses SKILL.md's YAML frontmatter; returns a short reason on failure (shown to the uploader). */
export function parseSkillMd(bytes: Uint8Array): SkillMd | string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "SKILL.md must be UTF-8 text.";
  }
  const match = FENCE.exec(text.replace(/^\uFEFF/, ""));
  if (!match?.[1]) return "SKILL.md must start with a YAML frontmatter block between --- lines.";
  let data: unknown;
  try {
    // Core schema: no timestamps, binary or custom tags; few aliases (no expansion bombs).
    data = parse(match[1], { schema: "core", maxAliasCount: 10 });
  } catch {
    return "The SKILL.md frontmatter is not valid YAML.";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return "The SKILL.md frontmatter must be a mapping with name and description.";
  const frontmatter = toPlainJson(data);
  if (!frontmatter)
    return "The SKILL.md frontmatter must be plain data (strings, numbers, lists, maps).";
  const { name, description } = frontmatter;
  if (typeof name !== "string" || !SKILL_NAME.test(name))
    return "name must be lowercase letters, digits and hyphens (up to 64 characters).";
  if (
    typeof description !== "string" ||
    description.trim() === "" ||
    description.length > SKILL_DESCRIPTION_MAX
  )
    return `description is required (up to ${SKILL_DESCRIPTION_MAX} characters).`;
  return { name, description, frontmatter };
}

function toPlainJson(data: object): Record<string, unknown> | null {
  try {
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > FRONTMATTER_MAX_BYTES) return null;
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
