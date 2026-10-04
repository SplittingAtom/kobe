import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { AgentDefinition } from "@kobe/agent-file";
import { computeToolManifest, type PublishFloor, type ToolManifest } from "../manifest.js";
import { mapAgentVersionToOrbit, orbitExportToYaml } from "./orbit-export.js";
import { orbitExperimentSchema } from "./orbit-schema.js";

const NOW = new Date("2026-10-02T12:00:00Z");
const FLOOR: PublishFloor = { scope: "team", install: [], team: [], approvalFloor: "auto" };

const definition = (
  frontmatter: Partial<AgentDefinition["frontmatter"]> = {},
  prompt = "You are a careful analyst.",
): AgentDefinition => ({ frontmatter: { name: "Data Analyst", ...frontmatter }, prompt });

const manifestFor = (def: AgentDefinition): ToolManifest =>
  computeToolManifest(def.frontmatter, FLOOR, NOW);

const exportOf = (
  def: AgentDefinition,
  extra: { mcpTools?: readonly string[]; version?: number } = {},
) =>
  mapAgentVersionToOrbit({ definition: def, toolManifest: manifestFor(def), version: 3, ...extra });

describe("mapAgentVersionToOrbit (KOBE-90)", () => {
  it("maps role, prompt and one agent into Orbit's setup layer", () => {
    const def = definition({ role: "Analyst", description: "Crunches numbers" });
    const { config } = exportOf(def);
    expect(config.name).toBe("kobe-data-analyst-v3");
    expect(config.description).toBe("Crunches numbers");
    expect(config.setup.agents).toHaveLength(1);
    expect(config.setup.agents[0]).toMatchObject({
      name: "data-analyst",
      role: "Analyst",
      system_prompt: "You are a careful analyst.",
    });
    expect(config.setup.edges).toEqual([]);
  });

  it("falls back to a neutral role", () => {
    expect(exportOf(definition()).config.setup.agents[0]?.role).toBe("assistant");
  });

  it("ac-2: tools are exactly the frozen manifest's, not the agent file's request", () => {
    const def = definition({ tools: { allow: ["read", "grep", "bash"], deny: ["bash"] } });
    const manifest = manifestFor(def);
    const { config } = mapAgentVersionToOrbit({
      definition: def,
      toolManifest: manifest,
      version: 1,
    });
    expect(config.setup.agents[0]?.tools).toEqual(manifest.tools.map((t) => t.name));
    expect(config.setup.agents[0]?.tools).toEqual(["grep", "read"]);
  });

  it("passes MCP tools of the version's connectors as plain tool names", () => {
    const def = definition({ connectors: ["github-prod"], tools: { allow: ["read"] } });
    const { config, warnings } = exportOf(def, {
      mcpTools: ["mcp__github_prod__list_issues", "mcp__github_prod__get_pr"],
    });
    expect(config.setup.agents[0]?.tools).toEqual([
      "read",
      "mcp__github_prod__get_pr",
      "mcp__github_prod__list_issues",
    ]);
    expect(warnings).toEqual([]);
  });

  it("refuses MCP tools of a connector the version does not list", () => {
    const def = definition({ connectors: ["github"] });
    expect(() => exportOf(def, { mcpTools: ["mcp__slack__post"] })).toThrow(/connector/);
  });

  it("drops MCP tools Orbit cannot name and says so", () => {
    const def = definition({ connectors: ["github"] });
    const long = `mcp__github__${"x".repeat(60)}`;
    const { config, warnings } = exportOf(def, { mcpTools: [long, "mcp__github__ok.tool"] });
    expect(config.setup.agents[0]?.tools.some((t) => t.startsWith("mcp__"))).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it("keeps a provider model id and drops a Kobe catalog alias with a warning", () => {
    const withId = exportOf(definition({ model: "ollama/qwen3:32b" }));
    expect(withId.config.setup.agents[0]?.model).toBe("ollama/qwen3:32b");
    const alias = exportOf(definition({ model: "smart" }));
    expect(alias.config.setup.agents[0]).not.toHaveProperty("model");
    expect(alias.warnings.join()).toMatch(/smart/);
  });

  it("records provenance in metadata", () => {
    const def = definition({ connectors: ["github"], approval_mode: "ask-on-write" });
    const { config } = exportOf(def);
    expect(config.metadata).toEqual({
      kobe: {
        agent_version: 3,
        approval_mode: "ask-on-write",
        connectors: ["github"],
        manifest_format: 1,
      },
    });
  });

  it("is pure: inputs are not mutated and output is deterministic", () => {
    const def = definition({ connectors: ["github"] });
    const manifest = manifestFor(def);
    const before = JSON.stringify([def, manifest]);
    const a = mapAgentVersionToOrbit({ definition: def, toolManifest: manifest, version: 2 });
    const b = mapAgentVersionToOrbit({ definition: def, toolManifest: manifest, version: 2 });
    expect(JSON.stringify([def, manifest])).toBe(before);
    expect(orbitExportToYaml(a)).toBe(orbitExportToYaml(b));
  });

  it("output satisfies the captured Orbit schema, and YAML round-trips", () => {
    const def = definition({ role: "Analyst", model: "openai/gpt-4o", connectors: ["github"] });
    const result = exportOf(def, { mcpTools: ["mcp__github__list_issues"] });
    expect(orbitExperimentSchema.parse(result.config)).toEqual(result.config);
    expect(parse(orbitExportToYaml(result))).toEqual(result.config);
  });

  it("preserves awkward prompts (multi-line, YAML-significant, unicode)", () => {
    const prompt = "line one\n\n- not a list: really\n# not a comment\n'quoted' \"double\" ünï ✓";
    const { config } = exportOf(definition({}, prompt));
    expect(parse(orbitExportToYaml({ config, warnings: [] })).setup.agents[0].system_prompt).toBe(
      prompt,
    );
  });

  it("rejects a schema-invalid export (a tool Orbit reserves)", () => {
    const def = definition();
    const manifest = manifestFor(def);
    const bad = {
      ...manifest,
      tools: [{ ...(manifest.tools[0] as ToolManifest["tools"][number]), name: "submit" }],
    };
    expect(() =>
      mapAgentVersionToOrbit({ definition: def, toolManifest: bad, version: 1 }),
    ).toThrow(/submit/);
  });

  it("fixtures match the mapper (CI loads them with Orbit's real loader)", () => {
    const full = definition(
      {
        role: "Analyst",
        description: "Crunches numbers",
        model: "openai/gpt-4o",
        connectors: ["github"],
        tools: { allow: ["read", "grep", "bash"], deny: ["bash"] },
        approval_mode: "ask-on-write",
      },
      "Be precise.\n\nCite sources: always.",
    );
    const cases: Record<string, ReturnType<typeof exportOf>> = {
      minimal: exportOf(definition(), { version: 1 }),
      full: mapAgentVersionToOrbit({
        definition: full,
        toolManifest: manifestFor(full),
        version: 7,
        mcpTools: ["mcp__github__list_issues"],
      }),
    };
    for (const [name, result] of Object.entries(cases)) {
      const file = new URL(`./fixtures/${name}.yaml`, import.meta.url);
      // KOBE_UPDATE_FIXTURES=1 regenerates them; review the diff, CI loads them in Orbit.
      if (process.env.KOBE_UPDATE_FIXTURES === "1") writeFileSync(file, orbitExportToYaml(result));
      expect(readFileSync(file, "utf8"), name).toBe(orbitExportToYaml(result));
    }
  });
});
