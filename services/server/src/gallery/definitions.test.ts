import { describe, expect, it } from "vitest";
import { agentConnectors, agentSkills } from "@kobe/agent-file";
import { BUILTIN_SKILL_NAMES, BUILTIN_TOOLS } from "@kobe/protocol";
import { computeToolManifest, manifestAllowsTool } from "../agents/manifest.js";
import { KOBE_NO_SEARCH_NOTICE } from "./agents/kobe.js";
import { GALLERY_DEFINITIONS, KOBE_GALLERY_KEY, parseGalleryDefinitions } from "./definitions.js";

describe("the repo's gallery definitions", () => {
  it("all parse, with unique keys and positive generations", () => {
    expect(() => parseGalleryDefinitions(GALLERY_DEFINITIONS)).not.toThrow();
  });

  it("refuses a missing generation", () => {
    const file = "---\nname: X\n---\nx\n";
    expect(() => parseGalleryDefinitions([{ key: "x", generation: 0, file }])).toThrow(
      /generation/,
    );
  });
});

describe("the one gallery agent, Kobe (KOBE-254)", () => {
  const parsed = parseGalleryDefinitions(GALLERY_DEFINITIONS);
  const kobe = parsed[0]?.definition;
  if (!kobe) throw new Error("no gallery definition");
  const floor = { scope: "install", install: [], team: [], approvalFloor: "auto" } as const;
  const manifest = computeToolManifest(kobe.frontmatter, floor, new Date());

  it("ships exactly one gallery agent, Kobe, at generation 2", () => {
    // 2: the web-search notice is scoped to requests that need the web (review of #240).
    expect(parsed.map((p) => [p.key, p.generation])).toEqual([[KOBE_GALLERY_KEY, 2]]);
    expect(KOBE_GALLERY_KEY).toBe("kobe");
    expect(kobe.frontmatter.name).toBe("Kobe");
    expect(kobe.frontmatter.description).toBeTruthy();
    expect(kobe.frontmatter.starters?.length).toBeGreaterThan(0);
  });

  it("pins no model, narrows no tool and asks for every team connector", () => {
    expect(kobe.frontmatter.model).toBeUndefined();
    expect(kobe.frontmatter.tools).toBeUndefined();
    expect(kobe.frontmatter.approval_mode).toBeUndefined();
    expect(agentConnectors(kobe.frontmatter)).toEqual({ all: true, names: [] });
  });

  it("freezes every available built-in tool and `all` connectors (ac-1)", () => {
    const unavailable = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
    const available = Object.keys(BUILTIN_TOOLS)
      .filter((n) => !unavailable.includes(n))
      .sort();
    expect(manifest.tools.map((t) => t.name)).toEqual(available);
    expect(manifest.excluded.every((e) => e.reason === "unavailable")).toBe(true);
    expect(manifest.connectors).toBe("all");
    for (const tool of ["create_artifact", "update_artifact", "share_file", "web_search"]) {
      expect(manifestAllowsTool(manifest, tool), tool).toBe(true);
    }
  });

  it("lists every built-in skill, and only built-ins", () => {
    expect([...agentSkills(kobe.frontmatter).names].sort()).toEqual(
      [...BUILTIN_SKILL_NAMES].sort(),
    );
  });

  it("keeps the prompt general-purpose and concise", () => {
    expect(kobe.prompt.length).toBeGreaterThan(500);
    expect(new TextEncoder().encode(kobe.prompt).length).toBeLessThan(5000);
  });

  it("carries the research guidance: web_search with URLs, and says plainly when it is unavailable", () => {
    expect(kobe.prompt).toContain("web_search");
    expect(kobe.prompt).toMatch(/URL/);
    expect(kobe.prompt).toContain(KOBE_NO_SEARCH_NOTICE);
    // Only when a request needs the web: never as the opening of every reply.
    const notice = kobe.prompt.indexOf(KOBE_NO_SEARCH_NOTICE);
    const sentence = kobe.prompt.slice(kobe.prompt.lastIndexOf("Research:", notice), notice);
    expect(sentence).toMatch(/When a request needs current or external facts/);
    expect(sentence).not.toMatch(/begin your reply/);
  });

  it("carries the Document Drafter's Markdown preview artifact (KOBE-131) and share_file (KOBE-152)", () => {
    expect(kobe.prompt).toMatch(/docx/);
    expect(kobe.prompt).toMatch(/create_artifact with kind markdown/);
    expect(kobe.prompt).toMatch(/update_artifact/);
    expect(kobe.prompt).toMatch(/share_file/);
  });

  it("carries the data, code and artifact guidance of the agents it replaced", () => {
    expect(kobe.prompt).toMatch(/data-analysis skill/);
    expect(kobe.prompt).toMatch(/html artifact/);
    expect(kobe.prompt).toMatch(/xlsx/);
    expect(kobe.prompt).toMatch(/code-review skill/);
    expect(kobe.prompt).toMatch(/skill-creator skill/);
    for (const what of ["HTML", "diagram", "table", "code"]) expect(kobe.prompt).toContain(what);
  });
});
