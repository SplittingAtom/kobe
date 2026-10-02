import { z } from "zod";
import {
  approvalModeSchema,
  BUILTIN_TOOLS,
  builtinToolDescriptor,
  connectorNameSchema,
  mcpServerSegment,
  parseMcpToolName,
  riskClassSchema,
  toolScopeSchema,
  type ApprovalMode,
  type ToolDescriptor,
} from "@kobe/protocol";
import type { AgentFrontmatter } from "@kobe/agent-file";
import { strictestApprovalMode } from "../policy/approval-floor.js";
import { checkAvailable } from "../policy/gates.js";
import { matchSubject, splitAgentToolEntry } from "../policy/patterns.js";
import { isRuleActive, type PolicyRule } from "../policy/rules.js";

/**
 * The frozen tool manifest of a published agent version (spec D19, D20 "frozen tool manifest →
 * tools"). Computed once at publish (or rollback) time and stored with the version, immutable.
 *
 * HARD CONTRACT (KOBE-45 decision 10): the manifest is a **ceiling, never a grant**. It is the
 * agent's own narrowing (`tools.allow` intersected with the server's tool registry, minus
 * `tools.deny`) intersected with the policy floor at publish time (whole-tool deny rules of the
 * install, plus the team's for team agents). At run time (KOBE-36/47) a call must be inside the
 * manifest (`manifestAllowsTool`) **and** pass the live policy engine with the version's
 * `tools_allow`/`tools_deny`, so:
 *   - a floor that tightens after publish applies at once (live rules, `effectiveApprovalMode`);
 *   - a floor that loosens after publish does not widen a published version: the builder
 *     republishes (or rolls back, which republishes) to pick it up;
 *   - tools added to the registry later (a Pi patch, a kobe-tool) never appear in old versions.
 * MCP tools are resolved at run time from the connector's pinned snapshot (D27, KOBE-59), limited
 * to the version's `connectors`; their exposure, drift and rules are live checks.
 */

export const TOOL_MANIFEST_FORMAT = 1;

/** Why a built-in is not in a version's manifest (shown in the builder and inventory). */
export const EXCLUSION_REASONS = [
  "agent_tools_deny",
  "agent_tools_allow",
  "install_deny_rule",
  "team_deny_rule",
  /** Not available in this version of Kobe (MCP resource tools, gates.ts). */
  "unavailable",
] as const;

const manifestToolSchema = z.strictObject({
  name: z.string().min(1).max(256),
  source: z.enum(["pi", "kobe"]),
  risk: riskClassSchema,
  scope: toolScopeSchema,
  open_world: z.boolean(),
});

export const toolManifestSchema = z.strictObject({
  format: z.literal(TOOL_MANIFEST_FORMAT),
  /** The floor it was computed against: install only (personal, gallery) or install + team. */
  floor: z.enum(["install", "team"]),
  /** Built-in tools (Pi and kobe-tools) this version may call, by name. */
  tools: z.array(manifestToolSchema),
  /** Connectors whose (pinned) MCP tools this version may call. */
  connectors: z.array(connectorNameSchema),
  /** The agent's own entries, kept for per-call checks (argument shorthands like `bash:ls *`). */
  tools_allow: z.array(z.string()),
  tools_deny: z.array(z.string()),
  excluded: z.array(
    z.strictObject({
      name: z.string(),
      reason: z.enum(EXCLUSION_REASONS),
      rule_id: z.uuid().optional(),
    }),
  ),
  approval_mode: z.strictObject({
    /** What the agent file asked for (null: the default, ask-on-write). */
    requested: approvalModeSchema.nullable(),
    /** The install floor at publish time. */
    floor: approvalModeSchema,
    /** The stricter of the two; never looser than the floor. */
    effective: approvalModeSchema,
  }),
});
export type ToolManifest = z.infer<typeof toolManifestSchema>;
type Excluded = ToolManifest["excluded"][number];

/** The policy floor a version is published against. */
export interface PublishFloor {
  /** `install` for personal and gallery agents (they run in many teams), `team` for team agents. */
  readonly scope: "install" | "team";
  readonly install: readonly PolicyRule[];
  /** The team's own rules; ignored unless `scope` is `team`. */
  readonly team: readonly PolicyRule[];
  readonly approvalFloor: ApprovalMode;
}

/** The mode a run uses when the agent file names none (D29). */
const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask-on-write";

/**
 * A rule that removes the whole tool for good: a non-expiring deny without an argument pattern.
 * Anything narrower (arguments, expiry, ask) stays a live check in the engine.
 */
function wholeToolDeny(rules: readonly PolicyRule[], name: string, now: Date) {
  return rules
    .filter(
      (r) =>
        r.effect === "deny" &&
        r.arg_pattern === undefined &&
        r.expires_at === undefined &&
        isRuleActive(r, now) &&
        matchSubject(r.tool_glob, name, "restrict"),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/** Why `tool` is left out, or undefined when the version keeps it. */
function exclusion(
  tool: ToolDescriptor,
  frontmatter: AgentFrontmatter,
  floor: PublishFloor,
  now: Date,
): Excluded | undefined {
  const name = tool.name;
  if (checkAvailable(tool).length > 0) return { name, reason: "unavailable" };
  const deny = frontmatter.tools?.deny ?? [];
  const wholeDeny = deny.some((entry) => {
    const { tool: glob, arg } = splitAgentToolEntry(entry);
    return arg === undefined && (glob === "" || matchSubject(glob, name, "restrict"));
  });
  if (wholeDeny) return { name, reason: "agent_tools_deny" };
  const allow = frontmatter.tools?.allow ?? [];
  const allowed =
    allow.length === 0 ||
    allow.some((entry) => {
      const { tool: glob } = splitAgentToolEntry(entry);
      return glob !== "" && matchSubject(glob, name, "loosen");
    });
  if (!allowed) return { name, reason: "agent_tools_allow" };
  const install = wholeToolDeny(floor.install, name, now);
  if (install) return { name, reason: "install_deny_rule", rule_id: install.id };
  const team = floor.scope === "team" ? wholeToolDeny(floor.team, name, now) : undefined;
  if (team) return { name, reason: "team_deny_rule", rule_id: team.id };
  return undefined;
}

/** Computes the manifest a version freezes (pure; deterministic for the same inputs). */
export function computeToolManifest(
  frontmatter: AgentFrontmatter,
  floor: PublishFloor,
  now: Date,
): ToolManifest {
  const tools: ToolManifest["tools"] = [];
  const excluded: Excluded[] = [];
  for (const name of Object.keys(BUILTIN_TOOLS).sort()) {
    const tool = builtinToolDescriptor(name);
    if (!tool || tool.source === "mcp") continue;
    const out = exclusion(tool, frontmatter, floor, now);
    if (out) {
      excluded.push(out);
    } else {
      const { source, risk, scope, open_world } = tool;
      tools.push({ name, source, risk, scope, open_world });
    }
  }
  const requested = frontmatter.approval_mode ?? null;
  return {
    format: TOOL_MANIFEST_FORMAT,
    floor: floor.scope,
    tools,
    connectors: [...(frontmatter.connectors ?? [])],
    tools_allow: [...(frontmatter.tools?.allow ?? [])],
    tools_deny: [...(frontmatter.tools?.deny ?? [])],
    excluded,
    approval_mode: {
      requested,
      floor: floor.approvalFloor,
      effective: strictestApprovalMode(requested ?? DEFAULT_APPROVAL_MODE, floor.approvalFloor),
    },
  };
}

/**
 * Whether a tool call is inside a version's frozen manifest (KOBE-36/47): a frozen built-in, or
 * an MCP tool of one of its connectors. Necessary, never sufficient: the policy engine decides.
 */
export function manifestAllowsTool(manifest: ToolManifest, toolName: string): boolean {
  if (manifest.tools.some((t) => t.name === toolName)) return true;
  const mcp = parseMcpToolName(toolName);
  if (!mcp) return false;
  return manifest.connectors.some((c) => mcpServerSegment(c) === mcp.server_segment);
}

/**
 * A pinned version's approval mode under today's floor: the floor may have been raised since
 * publish (applies at once); a lowered floor never loosens the version. KOBE-47 then takes the
 * strictest of this and the thread's/user's own choice.
 */
export function effectiveApprovalMode(
  manifest: ToolManifest,
  currentFloor: ApprovalMode,
): ApprovalMode {
  return strictestApprovalMode(manifest.approval_mode.effective, currentFloor);
}
