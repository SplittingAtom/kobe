import { z } from "zod";
import { riskClassSchema, uuidSchema, type RiskClass } from "./common.js";

/**
 * Tool identity and risk. **The server derives every `ToolDescriptor` from its own registry; nothing
 * the sandbox says about a tool (source, annotations, risk) is used for a decision.** `policy.check`
 * carries only the tool name and input. Resolution (KOBE-35, KOBE-58/59):
 *   1. `BUILTIN_TOOLS[name]` — Pi 1.0.0 built-ins and kobe-tools, fixed below;
 *   2. `mcp__<server>__<tool>` — the install's pinned `tools/list` snapshot for that connector
 *      (D27, SHA-256 pinned; a drifted tool is disabled), annotations from the snapshot;
 *   3. anything else → unknown: the engine **denies** with reason `unknown_tool` (fail closed).
 */

/** MCP tool annotations (MCP 2025-11-25 / 2026-07-28 hint names; verified in Pi 1.0.0 too). */
export const toolAnnotationsSchema = z.strictObject({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;

/** `pi` = Pi built-ins; `kobe` = kobe-tools extension; `mcp` = connector tool via the MCP proxy. */
export const toolSourceSchema = z.enum(["pi", "kobe", "mcp"]);
export type ToolSource = z.infer<typeof toolSourceSchema>;

/**
 * Where a tool's effects land. `sandbox`: the user's own sandbox (/workspace, /tmp), bounded by
 * gVisor and the egress proxy — D29: "shell and file tools are bounded by the sandbox and egress
 * policy". `kobe`: Kobe-owned, team-scoped storage (artifacts, shared files, memory). `external`:
 * a third-party system via the MCP proxy. SPECULATIVE reading for KOBE-35: in `ask-on-write`,
 * `sandbox`/`kobe` tools are not prompted for by risk class alone (deny/ask rules and `ask-all`
 * still apply); `external` tools follow the risk class.
 */
export const toolScopeSchema = z.enum(["sandbox", "kobe", "external"]);
export type ToolScope = z.infer<typeof toolScopeSchema>;

export const toolDescriptorSchema = z.strictObject({
  /** Tool name as Pi sees it, e.g. `bash`, `mcp__jira__create_issue`. */
  name: z.string().min(1).max(256),
  source: toolSourceSchema,
  /** Registry id of the MCP connector when `source` is `mcp`. */
  connector_id: uuidSchema.optional(),
  risk: riskClassSchema,
  open_world: z.boolean(),
  scope: toolScopeSchema,
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

export interface BuiltinTool {
  readonly source: "pi" | "kobe";
  readonly risk: RiskClass;
  readonly open_world: boolean;
  readonly scope: ToolScope;
  /** Input pointer an agent-file shorthand like `bash:rm -rf*` matches against (KOBE-45). */
  readonly primary_arg?: string;
  readonly note?: string;
}

/**
 * Built-in risk table. Pi names VERIFIED in `@earendil-works/pi-coding-agent@1.0.0`
 * (dist/core/tools, docs/mcp.md, docs/codemode.md). kobe-tools names from spec D13; their risk is
 * SPECULATIVE until KOBE-55/56 (D24: personal `remember` needs no approval — that is an engine
 * allow rule, not a lower risk class).
 */
export const BUILTIN_TOOLS: Readonly<Record<string, BuiltinTool>> = {
  read: { source: "pi", risk: "read", scope: "sandbox", open_world: false, primary_arg: "/path" },
  grep: {
    source: "pi",
    risk: "read",
    scope: "sandbox",
    open_world: false,
    primary_arg: "/pattern",
  },
  find: {
    source: "pi",
    risk: "read",
    scope: "sandbox",
    open_world: false,
    primary_arg: "/pattern",
  },
  ls: { source: "pi", risk: "read", scope: "sandbox", open_world: false, primary_arg: "/path" },
  edit: { source: "pi", risk: "write", scope: "sandbox", open_world: false, primary_arg: "/path" },
  write: { source: "pi", risk: "write", scope: "sandbox", open_world: false, primary_arg: "/path" },
  bash: {
    source: "pi",
    risk: "destructive",
    scope: "sandbox",
    open_world: true,
    primary_arg: "/command",
  },
  powershell: {
    source: "pi",
    risk: "destructive",
    scope: "sandbox",
    open_world: true,
    primary_arg: "/command",
  },
  codemode: {
    source: "pi",
    scope: "sandbox",
    risk: "read",
    open_world: false,
    note: "orchestrates other tools; each nested call is checked on its own (Pi 1.0.0 runs nested calls through tool_call handlers with ids <parent>/<n>)",
  },
  tool_search: { source: "pi", risk: "read", scope: "sandbox", open_world: false },
  list_mcp_resources: { source: "pi", risk: "read", scope: "external", open_world: true },
  list_mcp_resource_templates: { source: "pi", risk: "read", scope: "external", open_world: true },
  read_mcp_resource: { source: "pi", risk: "read", scope: "external", open_world: true },
  create_artifact: { source: "kobe", risk: "write", scope: "kobe", open_world: false },
  update_artifact: { source: "kobe", risk: "write", scope: "kobe", open_world: false },
  share_file: {
    source: "kobe",
    risk: "write",
    scope: "kobe",
    open_world: false,
    primary_arg: "/path",
  },
  remember: { source: "kobe", risk: "write", scope: "kobe", open_world: false },
  recall: { source: "kobe", risk: "read", scope: "kobe", open_world: false },
};

/**
 * D29 risk rule for MCP tools from the pinned snapshot: readOnly → read; explicit
 * `destructiveHint: false` → write; otherwise (incl. unannotated) → destructive.
 */
export function riskFromAnnotations(annotations: ToolAnnotations): RiskClass {
  if (annotations.readOnlyHint === true) return "read";
  if (annotations.destructiveHint === false) return "write";
  return "destructive";
}

/** Unannotated tools count as open-world (MCP default). */
export function isOpenWorld(annotations: ToolAnnotations): boolean {
  return annotations.openWorldHint ?? true;
}

/** Server-side resolution of a tool name. `undefined` = unknown tool → deny. */
export interface ToolRegistry {
  resolve(teamId: string, toolName: string): Promise<ToolDescriptor | undefined>;
}

/** Descriptor for a built-in, or `undefined` if the name is not built in. */
export function builtinToolDescriptor(name: string): ToolDescriptor | undefined {
  const tool = Object.hasOwn(BUILTIN_TOOLS, name) ? BUILTIN_TOOLS[name] : undefined;
  if (tool === undefined) return undefined;
  return {
    name,
    source: tool.source,
    risk: tool.risk,
    open_world: tool.open_world,
    scope: tool.scope,
  };
}
