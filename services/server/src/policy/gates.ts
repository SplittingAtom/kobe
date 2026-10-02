import type { JsonObject, PolicyInput, PolicyReason, ToolDescriptor } from "@kobe/protocol";
import { matchAgentToolEntry } from "./patterns.js";

export type ConnectorExposure = "read_only" | "all" | "custom";

/**
 * A connector's state in the active team (D27), from the server's own records (KOBE-58/59 own the
 * tables). The engine never takes enablement or exposure from the sandbox.
 */
export interface ConnectorPolicyState {
  readonly enabled: boolean;
  readonly exposure: ConnectorExposure;
  /** Pi tool names enabled under `custom` exposure. */
  readonly enabled_tools: readonly string[];
  /** Pi tool names whose pinned snapshot changed and await re-approval (D27). */
  readonly drifted_tools: readonly string[];
}

/**
 * Agent frontmatter `tools.deny` / `tools.allow` (D19), part of the team-deny stage. `tools.deny`
 * entries deny; a non-empty `tools.allow` restricts the agent to the listed tools (anything else
 * is denied). Neither ever removes a prompt: an agent file is written by a builder, not the user.
 */
export function checkAgentTools(
  agent: PolicyInput["agent"],
  tool: ToolDescriptor,
  input: JsonObject,
): PolicyReason[] {
  const denied = agent.tools_deny.find((e) => matchAgentToolEntry(e, tool, input, "restrict"));
  if (denied !== undefined) {
    return [
      {
        code: "agent_tool_deny",
        stage: "team_deny",
        message: `This agent may not use ${tool.name} (tools.deny: ${denied.slice(0, 200)}).`,
      },
    ];
  }
  if (
    agent.tools_allow.length > 0 &&
    !agent.tools_allow.some((e) => matchAgentToolEntry(e, tool, input, "loosen"))
  ) {
    return [
      {
        code: "agent_tool_deny",
        stage: "team_deny",
        message: `${tool.name} is not in this agent's tools.allow list.`,
      },
    ];
  }
  return [];
}

function exposureAllows(
  exposure: ConnectorExposure,
  tool: ToolDescriptor,
  state: ConnectorPolicyState,
): boolean {
  if (exposure === "all") return true;
  if (exposure === "read_only") return tool.risk === "read";
  return state.enabled_tools.includes(tool.name);
}

/**
 * MCP tools only (D27): the connector must be enabled in the team, the tool must not have drifted,
 * and the team's exposure must include it. The exposure in the input (filled by the caller) and
 * the server's state must both allow the call.
 */
export function checkConnector(
  input: PolicyInput,
  tool: ToolDescriptor,
  state: ConnectorPolicyState | undefined,
): PolicyReason[] {
  if (tool.source !== "mcp") return [];
  if (state === undefined || !state.enabled || tool.connector_id === undefined) {
    return [
      {
        code: "connector_not_enabled",
        stage: "team_deny",
        message: "This connector is not enabled in your team.",
      },
    ];
  }
  if (state.drifted_tools.includes(tool.name)) {
    return [
      {
        code: "tool_drifted",
        stage: "team_deny",
        message: `${tool.name} changed since it was approved and is disabled until an admin re-approves it.`,
      },
    ];
  }
  const claimed = input.context.connector_exposure ?? "read_only";
  const allowed = [state.exposure, claimed].every((e) => exposureAllows(e, tool, state));
  if (!allowed) {
    return [
      {
        code: "connector_exposure",
        stage: "team_deny",
        message: `${tool.name} is not exposed to agents in your team (${state.exposure.replace("_", "-")}).`,
      },
    ];
  }
  return [];
}
