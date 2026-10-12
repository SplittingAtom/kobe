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
  type JsonObject,
  type ToolDescriptor,
} from "@kobe/protocol";
import { ALL_CONNECTORS, agentConnectors, type AgentFrontmatter } from "@kobe/agent-file";
import { strictestApprovalMode } from "../policy/approval-floor.js";
import { checkAvailable } from "../policy/gates.js";
import { matchAgentToolEntry, matchSubject, splitAgentToolEntry } from "../policy/patterns.js";
import { isRuleActive, type PolicyRule } from "../policy/rules.js";

/**
 * The frozen tool manifest of a published agent version (spec D19, D20 "frozen tool manifest →
 * tools"). Computed once at publish (or rollback) time and stored with the version, immutable.
 *
 * HARD CONTRACT (KOBE-45 decision 10): the manifest is a **ceiling, never a grant**. It is the
 * agent's own narrowing (`tools.allow` intersected with the server's tool registry, minus
 * `tools.deny`) intersected with the policy floor at publish time (whole-tool deny rules of the
 * site, plus the team's for team agents). At run time (KOBE-36/47) a call must be inside the
 * manifest (`manifestAllowsTool`) **and** pass the live policy engine with the version's
 * `tools_allow`/`tools_deny`, so:
 *   - a floor that tightens after publish applies at once (live rules, `effectiveApprovalMode`);
 *   - a floor that loosens after publish does not widen a published version: the builder
 *     republishes (or rolls back, which republishes) to pick it up;
 *   - tools added to the registry later (a Pi patch, a kobe-tool) never appear in old versions.
 * MCP tools are resolved at run time from the connector's pinned snapshot (D27, KOBE-59), limited
 * to the version's `connectors`; their exposure, drift and rules are live checks.
 *
 * BLOCKING for KOBE-47: `versionAllowsCall` (or at least `manifestAllowsTool`) and
 * `effectiveApprovalMode` must sit on the run-start path, reading the pin (`resolvePinnedAgent`)
 * under the thread row lock inside the run-start transaction; otherwise the manifest is advisory.
 */

export const TOOL_MANIFEST_FORMAT = 1;

/** Why a built-in is not in a version's manifest (shown in the builder and inventory). */
export const EXCLUSION_REASONS = [
  "agent_tools_deny",
  "agent_tools_allow",
  "site_deny_rule",
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
  /** The floor it was computed against: site only (personal, gallery) or site + team. */
  floor: z.enum(["site", "team"]),
  /** Built-in tools (Pi and kobe-tools) this version may call, by name. */
  tools: z.array(manifestToolSchema),
  /**
   * Connectors whose (pinned) MCP tools this version may call, or `all` (KOBE-254): whichever the
   * team enables at run time. Either way the run start intersects it with the team's enablement
   * and the user's grants, and exposure and drift stay live checks.
   */
  connectors: z.union([z.array(connectorNameSchema), z.literal(ALL_CONNECTORS)]),
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
    /** The site floor at publish time. */
    floor: approvalModeSchema,
    /** The stricter of the two; never looser than the floor. */
    effective: approvalModeSchema,
  }),
});
export type ToolManifest = z.infer<typeof toolManifestSchema>;
type Excluded = ToolManifest["excluded"][number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A stored manifest with today's names. Versions published before KOBE-256 froze `floor: "install"`
 * and the exclusion reason `install_deny_rule` for the site; their rows are never rewritten, so a
 * reader renames them to `site` / `site_deny_rule` before parsing (same content, same content key).
 */
export function withSiteNames(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  const excluded = Array.isArray(stored.excluded)
    ? {
        excluded: stored.excluded.map((e: unknown) =>
          isRecord(e) && e.reason === "install_deny_rule" ? { ...e, reason: "site_deny_rule" } : e,
        ),
      }
    : {};
  const floor = stored.floor === "install" ? { floor: "site" } : {};
  return { ...stored, ...floor, ...excluded };
}

/** The policy floor a version is published against. */
export interface PublishFloor {
  /** `site` for personal and gallery agents (they run in many teams), `team` for team agents. */
  readonly scope: "site" | "team";
  readonly site: readonly PolicyRule[];
  /** The team's own rules; ignored unless `scope` is `team`. */
  readonly team: readonly PolicyRule[];
  /** The site's approval floor (site-wide only, D6; `policy/approval-floor.ts`). */
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
  const site = wholeToolDeny(floor.site, name, now);
  if (site) return { name, reason: "site_deny_rule", rule_id: site.id };
  const team = floor.scope === "team" ? wholeToolDeny(floor.team, name, now) : undefined;
  if (team) return { name, reason: "team_deny_rule", rule_id: team.id };
  return undefined;
}

function frozenConnectors(frontmatter: AgentFrontmatter): ToolManifest["connectors"] {
  const { all, names } = agentConnectors(frontmatter);
  return all ? ALL_CONNECTORS : [...names];
}

/**
 * The connector names a manifest covers, given the team's enabled ones: the frozen list, or for
 * `all` the team's own list (so never a connector the team has not enabled).
 */
export function manifestConnectorNames(
  manifest: Pick<ToolManifest, "connectors">,
  teamConnectors: readonly string[],
): string[] {
  return manifest.connectors === ALL_CONNECTORS ? [...teamConnectors] : [...manifest.connectors];
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
    connectors: frozenConnectors(frontmatter),
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
  if (manifest.connectors === ALL_CONNECTORS) return true;
  return manifest.connectors.some((c) => mcpServerSegment(c) === mcp.server_segment);
}

/**
 * Whether a version may make this call at all (KOBE-36/47 run-time gate): inside the manifest
 * (`manifestAllowsTool`) and through the version's own `tools.deny` (deny wins, argument
 * shorthands on the prepared input) and `tools.allow` (only narrows), with the policy engine's
 * matchers and fail-closed bias. Still not sufficient: every allowed call goes on to the engine.
 */
export function versionAllowsCall(
  manifest: ToolManifest,
  tool: ToolDescriptor,
  input: JsonObject,
): boolean {
  if (!manifestAllowsTool(manifest, tool.name)) return false;
  if (manifest.tools_deny.some((e) => matchAgentToolEntry(e, tool, input, "restrict"))) {
    return false;
  }
  return (
    manifest.tools_allow.length === 0 ||
    manifest.tools_allow.some((e) => matchAgentToolEntry(e, tool, input, "loosen"))
  );
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
