import { agentSlugSchema, parseAgentFile, type AgentDefinition } from "@kobe/agent-file";

/**
 * One gallery agent as it is kept in the repo (KOBE-87): a stable `key` (also its slug) and the
 * agent file text (spec §6.3). `GALLERY_DEFINITIONS` is the list the server seeds at start; to add
 * or change a gallery agent, add or edit an entry and ship a release (KOBE-89 writes the five).
 * Frontmatter `skills` may name built-in skills (KOBE-88) like any skill slug.
 */
export interface GalleryDefinition {
  readonly key: string;
  readonly file: string;
}

export const GALLERY_DEFINITIONS: readonly GalleryDefinition[] = [];

export interface ParsedGalleryDefinition {
  readonly key: string;
  readonly definition: AgentDefinition;
}

/** Parses every definition; any error fails fast (a broken release must not start half-seeded). */
export function parseGalleryDefinitions(
  definitions: readonly GalleryDefinition[],
): ParsedGalleryDefinition[] {
  const seen = new Set<string>();
  return definitions.map(({ key, file }) => {
    if (!agentSlugSchema.safeParse(key).success) {
      throw new Error(`gallery definition key "${key}" is not a valid slug`);
    }
    if (seen.has(key)) throw new Error(`gallery definition key "${key}" is used twice`);
    seen.add(key);
    const parsed = parseAgentFile(file);
    if (!parsed.ok) {
      const first = parsed.issues[0];
      throw new Error(
        `gallery definition "${key}" is invalid: ${first ? `${first.path} ${first.message}` : "unknown"}`,
      );
    }
    return { key, definition: parsed.definition };
  });
}
