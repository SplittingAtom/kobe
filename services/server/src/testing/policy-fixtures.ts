import {
  builtinToolDescriptor,
  type ApprovalMode,
  type JsonObject,
  type PolicyInput,
  type ToolDescriptor,
} from "@kobe/protocol";
import type { ConnectorPolicyState } from "../policy/gates.js";
import type { PolicyRule, PolicyRuleSet } from "../policy/rules.js";

// Shared fixtures for the policy unit tests (not shipped: imported by *.test.ts only).

export const IDS = {
  user: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
  connector: "55555555-5555-4555-8555-555555555555",
} as const;

export const NOW = new Date("2026-10-02T12:00:00.000Z");

export function builtin(name: string): ToolDescriptor {
  const tool = builtinToolDescriptor(name);
  if (!tool) throw new Error(`not a built-in: ${name}`);
  return tool;
}

export function mcpTool(name: string, risk: ToolDescriptor["risk"]): ToolDescriptor {
  return {
    name,
    source: "mcp",
    connector_id: IDS.connector,
    risk,
    open_world: true,
    scope: "external",
  };
}

export interface InputOptions {
  readonly mode?: ApprovalMode;
  readonly kind?: "user" | "schedule";
  readonly toolsAllow?: string[];
  readonly toolsDeny?: string[];
  readonly exposure?: "read_only" | "all" | "custom";
  readonly enforcement?: "sandbox" | "mcp_proxy";
}

export function policyInput(
  tool: ToolDescriptor,
  input: JsonObject = {},
  options: InputOptions = {},
): PolicyInput {
  return {
    actor: { user_id: IDS.user, kind: options.kind ?? "user" },
    team_id: IDS.team,
    agent: {
      agent_id: null,
      version: null,
      tools_allow: options.toolsAllow ?? [],
      tools_deny: options.toolsDeny ?? [],
    },
    run: { run_id: IDS.run, thread_id: IDS.thread, approval_mode: options.mode ?? "ask-on-write" },
    tool,
    tool_call_id: "toolu_01",
    input,
    context: {
      enforcement_point: options.enforcement ?? "sandbox",
      ...(tool.source === "mcp" ? { connector_exposure: options.exposure ?? "all" } : {}),
    },
  };
}

let nextId = 0;
/** A rule with a deterministic, sortable uuid. */
export function rule(
  scope: PolicyRule["scope"],
  effect: PolicyRule["effect"],
  toolGlob: string,
  extra: Partial<Pick<PolicyRule, "arg_pattern" | "expires_at" | "id">> = {},
): PolicyRule {
  nextId += 1;
  const id = `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
  return { id, scope, effect, tool_glob: toolGlob, ...extra };
}

export function ruleSet(rules: readonly PolicyRule[]): PolicyRuleSet {
  return {
    install: rules.filter((r) => r.scope === "install"),
    team: rules.filter((r) => r.scope === "team"),
    user: rules.filter((r) => r.scope === "user"),
  };
}

export const ENABLED_ALL: ConnectorPolicyState = {
  enabled: true,
  exposure: "all",
  enabled_tools: [],
  drifted_tools: [],
};

/** A valid input for every built-in (strict Pi 1.0.0 schemas; kobe-tools accept any object). */
export const SAMPLE_INPUTS: Readonly<Record<string, JsonObject>> = {
  read: { path: "notes.md" },
  write: { path: "notes.md", content: "x" },
  edit: { path: "notes.md", edits: [{ oldText: "a", newText: "b" }] },
  bash: { command: "ls" },
  powershell: { command: "Get-ChildItem" },
  ls: {},
  grep: { pattern: "TODO" },
  find: { pattern: "*.md" },
  codemode: { code: "1" },
  tool_search: { query: "jira" },
  create_artifact: { kind: "markdown", title: "Notes", content: "# Notes" },
  update_artifact: { artifact_id: "5b1c0f52-8f6e-4a34-9d57-3a6e0c1f2b44", content: "# Notes v2" },
};

export function sampleInput(tool: ToolDescriptor): JsonObject {
  return SAMPLE_INPUTS[tool.name] ?? {};
}
