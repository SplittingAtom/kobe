import type { AppCallReason, PinnedTool } from "@kobe/db";
import type { JsonObject } from "@kobe/protocol";
import { appVisible } from "../connectors/visibility.js";
import { describePinnedTool, type TeamConnector } from "../mcp/catalog.js";
import { matchingRules, type PolicyRuleSet } from "../policy/rules.js";
import type { SchemaValidator, Validation } from "./validate-pool.js";

/**
 * The server's decision for an MCP App's own `tools/call` (KOBE-436, spec §6 and MA5). Pure:
 * the caller loads the team connector and the rules.
 *
 * - Rules 1-2 ({@link checkAppTool}): a pinned (not drifted) tool of the app's own connector,
 *   `readOnlyHint: true`, visible to apps, and in the team's exposure (`custom`: ticked). App
 *   visibility, not model visibility: an app-only tool is callable here.
 * - Rule 3 ({@link validateArguments}): a JSON object of at most 64 KiB that validates against
 *   the pinned `inputSchema` (JSON Schema 2020-12; an interpreter, no generated code), in a
 *   worker pool with a hard deadline (`validate-pool.ts`, review HIGH-1).
 * - Rule 4 ({@link appBridgeDecision}), MA5's order at the `app_bridge` enforcement point:
 *   site deny → team deny → site or team ask (→ deny `app_no_prompt`: the browser principal has
 *   no run and is never prompted) → risk class (anything but `read` → deny `app_read_only`) →
 *   allow. User rules are never consulted, and no allow rule of any scope widens it (ac-4).
 *   It reuses the policy engine's own rule matching (`matchingRules`) over the same descriptor
 *   (`describePinnedTool`); the engine's `PolicyInput` needs a run, which an app call has not.
 */
export type ToolCheck =
  | { readonly ok: true; readonly tool: PinnedTool }
  | { readonly ok: false; readonly reason: AppCallReason };

/** The team's exposure rule (D27), without model visibility (apps, not agents, are asking). */
export function exposedToApps(connector: TeamConnector, tool: PinnedTool): boolean {
  if (connector.exposure === "all") return true;
  if (connector.exposure === "read_only") return tool.annotations.readOnlyHint === true;
  return connector.enabledTools.includes(tool.pi_name);
}

export function checkAppTool(connector: TeamConnector, name: string): ToolCheck {
  const tool = connector.tools.find((t) => t.name === name);
  if (!tool) return { ok: false, reason: "tool_not_in_app" };
  if (tool.status !== "pinned") return { ok: false, reason: "tool_drifted" };
  if (tool.annotations.readOnlyHint !== true) return { ok: false, reason: "tool_not_read_only" };
  if (!appVisible(tool)) return { ok: false, reason: "tool_not_app_visible" };
  if (!exposedToApps(connector, tool)) return { ok: false, reason: "connector_exposure" };
  return { ok: true, tool };
}

/** Largest serialized arguments an app may send (spec T10). */
export const APP_ARGUMENTS_MAX_BYTES = 64 * 1024;

/**
 * Rule 3: at most 64 KiB, valid against the pinned schema. The schema runs only in the worker
 * pool with a deadline (review HIGH-1): a timeout or failure refuses the call.
 */
export async function validateArguments(
  validator: SchemaValidator,
  tool: PinnedTool,
  args: JsonObject,
  owner: string,
): Promise<Validation> {
  if (Buffer.byteLength(JSON.stringify(args), "utf8") > APP_ARGUMENTS_MAX_BYTES) return "invalid";
  return validator.validate(tool.input_schema, args, owner);
}

export type BridgeDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: AppCallReason };

export function appBridgeDecision(
  connectorId: string,
  tool: PinnedTool,
  args: JsonObject,
  rules: PolicyRuleSet,
  now: Date,
): BridgeDecision {
  const descriptor = describePinnedTool(connectorId, tool);
  if (matchingRules(rules.site, "deny", descriptor, args, now).length > 0) {
    return { allowed: false, reason: "site_deny_rule" };
  }
  if (matchingRules(rules.team, "deny", descriptor, args, now).length > 0) {
    return { allowed: false, reason: "team_deny_rule" };
  }
  const asks = [
    ...matchingRules(rules.site, "ask", descriptor, args, now),
    ...matchingRules(rules.team, "ask", descriptor, args, now),
  ];
  if (asks.length > 0) return { allowed: false, reason: "app_no_prompt" };
  if (descriptor.risk !== "read") return { allowed: false, reason: "app_read_only" };
  return { allowed: true };
}
