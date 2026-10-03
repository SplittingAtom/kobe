import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, builtinToolDescriptor, type ToolDescriptor } from "@kobe/protocol";
import type { AgentFrontmatter } from "@kobe/agent-file";
import type { PolicyRule } from "../policy/rules.js";
import {
  computeToolManifest,
  effectiveApprovalMode,
  manifestAllowsTool,
  toolManifestSchema,
  versionAllowsCall,
  type PublishFloor,
} from "./manifest.js";

const NOW = new Date("2026-10-02T12:00:00Z");
const RULE_A = "00000000-0000-4000-8000-00000000000a";
const RULE_B = "00000000-0000-4000-8000-00000000000b";

const floor = (extra: Partial<PublishFloor> = {}): PublishFloor => ({
  scope: "team",
  install: [],
  team: [],
  approvalFloor: "auto",
  ...extra,
});

const rule = (extra: Partial<PolicyRule> & Pick<PolicyRule, "tool_glob">): PolicyRule => ({
  id: RULE_A,
  scope: "install",
  effect: "deny",
  ...extra,
});

const fm = (extra: Partial<AgentFrontmatter> = {}): AgentFrontmatter => ({ name: "A", ...extra });
const names = (m: { tools: readonly { name: string }[] }) => m.tools.map((t) => t.name);
const AVAILABLE = Object.keys(BUILTIN_TOOLS)
  .filter(
    (n) => !["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(n),
  )
  .sort();

describe("computeToolManifest (D19 frozen tool manifest)", () => {
  it("freezes every available built-in for an agent without tool settings", () => {
    const m = computeToolManifest(fm(), floor(), NOW);
    expect(names(m)).toEqual(AVAILABLE);
    expect(m.tools.find((t) => t.name === "bash")).toEqual({
      name: "bash",
      source: "pi",
      risk: "destructive",
      scope: "sandbox",
      open_world: true,
    });
    expect(m.excluded.map((e) => e.reason)).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(toolManifestSchema.parse(m)).toEqual(m);
  });

  it("narrows to tools.allow and never adds anything (allow is a restriction)", () => {
    const m = computeToolManifest(
      fm({ tools: { allow: ["read", "grep", "made_up_tool", "bash:ls *"] } }),
      floor(),
      NOW,
    );
    expect(names(m)).toEqual(["bash", "grep", "read"]);
    expect(m.excluded).toContainEqual({ name: "write", reason: "agent_tools_allow" });
    expect(names(m)).not.toContain("made_up_tool");
  });

  it("an allow-everything glob still exposes only the registry's built-ins", () => {
    const m = computeToolManifest(fm({ tools: { allow: ["*"] } }), floor(), NOW);
    expect(names(m)).toEqual(AVAILABLE);
  });

  it("drops tools the agent denies outright; argument denies stay live checks", () => {
    const m = computeToolManifest(
      fm({ tools: { allow: ["*"], deny: ["write", "bash:rm -rf*"] } }),
      floor(),
      NOW,
    );
    expect(names(m)).not.toContain("write");
    expect(names(m)).toContain("bash");
    expect(m.excluded).toContainEqual({ name: "write", reason: "agent_tools_deny" });
    expect(m.tools_deny).toEqual(["write", "bash:rm -rf*"]);
  });

  it("deny wins over allow for the same tool", () => {
    const m = computeToolManifest(fm({ tools: { allow: ["bash"], deny: ["bash"] } }), floor(), NOW);
    expect(names(m)).toEqual([]);
  });

  it("applies the install floor's and the team's whole-tool deny rules", () => {
    const m = computeToolManifest(
      fm(),
      floor({
        install: [rule({ tool_glob: "bash" })],
        team: [rule({ id: RULE_B, scope: "team", tool_glob: "power*" })],
      }),
      NOW,
    );
    expect(names(m)).not.toContain("bash");
    expect(names(m)).not.toContain("powershell");
    expect(m.excluded).toContainEqual({
      name: "bash",
      reason: "install_deny_rule",
      rule_id: RULE_A,
    });
    expect(m.excluded).toContainEqual({
      name: "powershell",
      reason: "team_deny_rule",
      rule_id: RULE_B,
    });
  });

  it("ignores team rules for an install-floor manifest (personal and gallery agents)", () => {
    const m = computeToolManifest(
      fm(),
      floor({ scope: "install", team: [rule({ scope: "team", tool_glob: "bash" })] }),
      NOW,
    );
    expect(names(m)).toContain("bash");
    expect(m.floor).toBe("install");
  });

  it("keeps rules that only restrict arguments, expire, ask or allow as live checks", () => {
    const m = computeToolManifest(
      fm(),
      floor({
        install: [
          rule({ tool_glob: "bash", arg_pattern: { "/command": "rm*" } }),
          rule({ tool_glob: "write", expires_at: "2027-01-01T00:00:00.000Z" }),
          rule({ tool_glob: "edit", effect: "ask" }),
          rule({ tool_glob: "read", effect: "allow" }),
        ],
      }),
      NOW,
    );
    expect(names(m)).toEqual(expect.arrayContaining(["bash", "write", "edit", "read"]));
  });

  it("ignores an already expired deny rule", () => {
    const m = computeToolManifest(
      fm(),
      floor({ install: [rule({ tool_glob: "bash", expires_at: "2026-01-01T00:00:00.000Z" })] }),
      NOW,
    );
    expect(names(m)).toContain("bash");
  });

  it("fails closed on a malformed deny glob (it covers everything)", () => {
    const m = computeToolManifest(fm(), floor({ install: [rule({ tool_glob: "\\" })] }), NOW);
    expect(names(m)).toEqual([]);
  });

  it("records the requested connectors and the agent's globs for per-call checks", () => {
    const m = computeToolManifest(
      fm({ connectors: ["github", "jira"], tools: { allow: ["mcp__github__*"] } }),
      floor(),
      NOW,
    );
    expect(m.connectors).toEqual(["github", "jira"]);
    expect(m.tools_allow).toEqual(["mcp__github__*"]);
    expect(names(m)).toEqual([]);
  });

  it.each([
    [undefined, "auto", "ask-on-write"],
    ["auto", "auto", "auto"],
    ["auto", "ask-on-write", "ask-on-write"],
    ["ask-all", "ask-on-write", "ask-all"],
    ["ask-on-write", "ask-all", "ask-all"],
  ] as const)("approval_mode %s under floor %s → %s", (requested, approvalFloor, effective) => {
    const m = computeToolManifest(
      fm(requested ? { approval_mode: requested } : {}),
      floor({ approvalFloor }),
      NOW,
    );
    expect(m.approval_mode).toEqual({
      requested: requested ?? null,
      floor: approvalFloor,
      effective,
    });
  });
});

describe("run-time helpers for KOBE-47", () => {
  const manifest = computeToolManifest(
    fm({ connectors: ["github", "my-jira"], tools: { allow: ["read", "mcp__*"] } }),
    floor(),
    NOW,
  );

  it("manifestAllowsTool: frozen built-ins and the version's connectors only", () => {
    expect(manifestAllowsTool(manifest, "read")).toBe(true);
    expect(manifestAllowsTool(manifest, "bash")).toBe(false);
    expect(manifestAllowsTool(manifest, "mcp__github__create_issue")).toBe(true);
    expect(manifestAllowsTool(manifest, "mcp__my_jira__search")).toBe(true);
    expect(manifestAllowsTool(manifest, "mcp__slack__post")).toBe(false);
    expect(manifestAllowsTool(manifest, "mcp__github")).toBe(false);
    expect(manifestAllowsTool(manifest, "brand_new_builtin")).toBe(false);
  });

  it("versionAllowsCall: the manifest, then the agent's own deny (wins) and allow (narrows)", () => {
    const m = computeToolManifest(
      fm({
        connectors: ["github"],
        tools: { allow: ["read", "bash:ls *", "mcp__github__*"], deny: ["mcp__github__delete_*"] },
      }),
      floor(),
      NOW,
    );
    const mcp = (name: string): ToolDescriptor => ({
      name,
      source: "mcp",
      connector_id: "00000000-0000-4000-8000-0000000000c1",
      risk: "destructive",
      open_world: true,
      scope: "external",
    });
    const builtin = (name: string) => {
      const d = builtinToolDescriptor(name);
      if (!d) throw new Error(name);
      return d;
    };
    expect(versionAllowsCall(m, builtin("read"), { path: "/workspace/a" })).toBe(true);
    expect(versionAllowsCall(m, builtin("bash"), { command: "ls -la" })).toBe(true);
    expect(versionAllowsCall(m, builtin("bash"), { command: "rm -rf /" })).toBe(false);
    expect(versionAllowsCall(m, builtin("write"), { path: "/workspace/a", content: "" })).toBe(
      false,
    );
    expect(versionAllowsCall(m, mcp("mcp__github__create_issue"), {})).toBe(true);
    expect(versionAllowsCall(m, mcp("mcp__github__delete_repo"), {})).toBe(false);
    expect(versionAllowsCall(m, mcp("mcp__slack__post"), {})).toBe(false);
  });

  it("effectiveApprovalMode: a floor raised after publish applies; a lowered one doesn't loosen", () => {
    const pinned = computeToolManifest(fm({ approval_mode: "auto" }), floor(), NOW);
    expect(effectiveApprovalMode(pinned, "auto")).toBe("auto");
    expect(effectiveApprovalMode(pinned, "ask-all")).toBe("ask-all");
    const strict = computeToolManifest(
      fm({ approval_mode: "auto" }),
      floor({ approvalFloor: "ask-on-write" }),
      NOW,
    );
    expect(effectiveApprovalMode(strict, "auto")).toBe("ask-on-write");
  });

  it("toolManifestSchema rejects unknown keys and future formats", () => {
    expect(toolManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
    expect(toolManifestSchema.safeParse({ ...manifest, format: 2 }).success).toBe(false);
  });
});
