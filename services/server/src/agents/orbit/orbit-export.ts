import { mcpServerSegment, parseMcpToolName } from "@kobe/protocol";
import { slugFromName, type AgentDefinition } from "@kobe/agent-file";
import { stringify } from "yaml";
import type { ToolManifest } from "../manifest.js";
import {
  ORBIT_TOOL_NAME,
  orbitExperimentSchema,
  type OrbitAgentSpec,
  type OrbitExperiment,
} from "./orbit-schema.js";

/**
 * Orbit export (spec §Orbit, KOBE-51a/KOBE-90): a PURE mapping from a published agent version to
 * Orbit's YAML setup layer (no database, no network; KOBE-91 adds the endpoint).
 *
 * Contract:
 *   - Tools come from the version's FROZEN manifest, never from the agent file's `tools.allow`
 *     (the manifest is the ceiling that was true at publish time, D19).
 *   - MCP tools are plain Inspect tool names (`mcp__<server>__<tool>`, as Pi names them). The
 *     manifest only freezes connector names, so the caller passes the names from the connectors'
 *     pinned snapshots (D27); a name from a connector the version does not list is refused.
 *   - Orbit validates names but does not resolve them: the eval Job binds implementations.
 *   - Kobe model aliases (`fast`, `smart`) mean nothing to Orbit; only provider ids
 *     (`provider/model`) are carried over, an alias is dropped with a warning.
 */

export interface OrbitExportInput {
  readonly definition: AgentDefinition;
  readonly toolManifest: ToolManifest;
  readonly version: number;
  /** Pi-style names of the MCP tools to expose, from the pinned connector snapshots. */
  readonly mcpTools?: readonly string[];
}

export interface OrbitExport {
  readonly config: OrbitExperiment;
  /** Things left out of the export on purpose; show them to the person exporting. */
  readonly warnings: readonly string[];
}

const DEFAULT_ROLE = "assistant";

function mapModel(model: string | undefined, warnings: string[]): { model?: string } {
  if (model === undefined) return {};
  if (model.includes("/")) return { model };
  warnings.push(
    `model "${model}" is a Kobe catalog alias, not a provider model id; Orbit uses its task model`,
  );
  return {};
}

function mapMcpTools(
  names: readonly string[],
  connectors: readonly string[],
  warnings: string[],
): string[] {
  const segments = new Set(connectors.map(mcpServerSegment));
  const mapped = new Set<string>();
  for (const name of names) {
    const parsed = parseMcpToolName(name);
    if (parsed === undefined || !segments.has(parsed.server_segment)) {
      throw new Error(`MCP tool "${name}" is not from a connector of this agent version`);
    }
    if (!ORBIT_TOOL_NAME.test(name)) {
      warnings.push(
        `MCP tool "${name}" left out: Orbit tool names allow 1-64 letters, digits, _ or -`,
      );
      continue;
    }
    mapped.add(name);
  }
  return [...mapped].sort();
}

/** Maps one published agent version to an Orbit experiment config. Throws on an invalid result. */
export function mapAgentVersionToOrbit(input: OrbitExportInput): OrbitExport {
  const { definition, toolManifest, version } = input;
  const { frontmatter } = definition;
  const warnings: string[] = [];
  const slug = slugFromName(frontmatter.name);
  const tools = [
    ...toolManifest.tools.map((t) => t.name),
    ...mapMcpTools(input.mcpTools ?? [], toolManifest.connectors, warnings),
  ];
  const agent: OrbitAgentSpec = {
    name: slug,
    role: frontmatter.role ?? DEFAULT_ROLE,
    ...mapModel(frontmatter.model, warnings),
    system_prompt: definition.prompt,
    tools,
  };
  const config: OrbitExperiment = {
    name: `kobe-${slug}-v${version}`,
    ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
    setup: { agents: [agent], edges: [] },
    metadata: {
      kobe: {
        agent_version: version,
        approval_mode: toolManifest.approval_mode.effective,
        connectors: [...toolManifest.connectors],
        manifest_format: toolManifest.format,
      },
    },
  };
  const checked = orbitExperimentSchema.safeParse(config);
  if (!checked.success) {
    const detail = checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`agent version cannot be exported to Orbit: ${detail}`);
  }
  return { config: checked.data, warnings };
}

/** Canonical YAML for an export (block style, no folding), as written for Orbit's loader. */
export function orbitExportToYaml(result: OrbitExport): string {
  return stringify(result.config, { version: "1.2", lineWidth: 0, minContentWidth: 0 });
}
