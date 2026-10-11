import { agentSlugSchema, parseAgentFile, type AgentDefinition } from "@kobe/agent-file";
import { KOBE_FILE } from "./agents/kobe.js";

/**
 * One gallery agent as it is kept in the repo (KOBE-87): a stable `key` (also its slug) and the
 * agent file text (spec §6.3). `GALLERY_DEFINITIONS` is the list the server seeds at start; to add
 * or change a gallery agent, add or edit an entry and ship a release.
 * Frontmatter `skills` may name built-in skills (KOBE-88) like any skill slug.
 */
export interface GalleryDefinition {
  readonly key: string;
  /**
   * Monotonic positive integer: raise it with every change to `file`. A definition is published
   * only when its generation is newer than the one seeded, so a replica still running an older
   * release (rollout, rollback) never overwrites a newer definition.
   */
  readonly generation: number;
  readonly file: string;
}

/** Key of the one gallery agent, Kobe (KOBE-254); the web preselects it for new chats. */
export const KOBE_GALLERY_KEY = "kobe";

/**
 * The gallery (KOBE-254, user decision 2026-10-11): one general-purpose agent, Kobe. It pins no
 * model (team default). The five agents it replaced are archived on upgrade by the seed, since
 * their keys are no longer listed here. Raise an entry's generation with every change to its file.
 */
export const GALLERY_DEFINITIONS: readonly GalleryDefinition[] = [
  { key: KOBE_GALLERY_KEY, generation: 2, file: KOBE_FILE },
];

export interface ParsedGalleryDefinition {
  readonly key: string;
  readonly generation: number;
  readonly definition: AgentDefinition;
}

/** Parses every definition; any error fails fast (a broken release must not start half-seeded). */
export function parseGalleryDefinitions(
  definitions: readonly GalleryDefinition[],
): ParsedGalleryDefinition[] {
  const seen = new Set<string>();
  return definitions.map(({ key, generation, file }) => {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error(`gallery definition "${key}" needs a positive integer generation`);
    }
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
    return { key, generation, definition: parsed.definition };
  });
}
