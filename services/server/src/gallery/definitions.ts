import { agentSlugSchema, parseAgentFile, type AgentDefinition } from "@kobe/agent-file";
import { ASSISTANT_FILE } from "./agents/assistant.js";
import { CODE_HELPER_FILE } from "./agents/code-helper.js";
import { DATA_ANALYST_FILE } from "./agents/data-analyst.js";
import { DOCUMENT_DRAFTER_FILE } from "./agents/document-drafter.js";
import { RESEARCHER_FILE } from "./agents/researcher.js";

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

/**
 * The five gallery agents (KOBE-89). None pins a model: they use the team default. Raise an entry's
 * generation with every change to its file.
 */
export const GALLERY_DEFINITIONS: readonly GalleryDefinition[] = [
  { key: "assistant", generation: 1, file: ASSISTANT_FILE },
  { key: "data-analyst", generation: 1, file: DATA_ANALYST_FILE },
  { key: "researcher", generation: 1, file: RESEARCHER_FILE },
  { key: "document-drafter", generation: 1, file: DOCUMENT_DRAFTER_FILE },
  { key: "code-helper", generation: 1, file: CODE_HELPER_FILE },
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
