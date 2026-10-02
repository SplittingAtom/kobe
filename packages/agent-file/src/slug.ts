import { z } from "zod";

/** Max length of an agent slug. */
export const AGENT_SLUG_MAX = 48;

/** An agent's slug: unique per scope, immutable, names its export file `<slug>.md`. */
export const agentSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/,
    `slug must be 1-${AGENT_SLUG_MAX} lowercase letters, digits or hyphens, starting and ending alphanumeric`,
  );

/** Derives a slug from an agent name: ASCII-folded, hyphenated; `agent` when nothing is left. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, AGENT_SLUG_MAX)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "agent" : slug;
}
