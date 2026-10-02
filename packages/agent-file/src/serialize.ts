import { stringify } from "yaml";
import { FRONTMATTER_KEYS, type AgentDefinition } from "./schema.js";

/**
 * Canonical export of an agent (spec §6.3): frontmatter keys in schema order, YAML 1.2 block
 * style without line folding, then the prompt and one trailing newline. Byte-identical for equal
 * definitions, and `parseAgentFile` reads it back unchanged.
 */
export function serializeAgentFile(definition: AgentDefinition): string {
  const source = definition.frontmatter as Readonly<Record<string, unknown>>;
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEYS) {
    if (source[key] !== undefined) ordered[key] = source[key];
  }
  const yaml = stringify(ordered, {
    version: "1.2",
    lineWidth: 0,
    minContentWidth: 0,
    aliasDuplicateObjects: false,
  });
  const prompt = definition.prompt;
  return `---\n${yaml}---\n${prompt === "" ? "" : `${prompt}\n`}`;
}
