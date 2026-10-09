import type { PinnedTool, ProposedTool } from "@kobe/db";
import { snapshotHash } from "./pin.js";

/**
 * Drift (KOBE-102, spec D27): compares a connector's stored snapshot with a fresh one built from
 * the live `tools/list`. Pure; nothing here touches the database. The per-tool rules:
 *
 * - unchanged (same SHA-256): stays `pinned`;
 * - changed (name stays, description or schema differ): `drifted`; the entry keeps the approved
 *   definition and carries the live one as `proposed`;
 * - new upstream: `drifted` with the live definition and no `proposed`;
 * - gone upstream: removed from the snapshot, so nothing offers it any more;
 * - a drifted tool whose live definition equals the approved one again: `pinned` again.
 *
 * `drifted` tools are never offered or callable (catalog, policy gate, proxy), so a change takes
 * effect as "disabled" until an install admin approves it.
 */
export interface DriftResult {
  readonly tools: PinnedTool[];
  /** Tools newly drifted or drifted further this pass: names only, never content. */
  readonly changed: string[];
  readonly added: string[];
  readonly removed: string[];
}

const proposalOf = (live: PinnedTool): ProposedTool => ({
  ...(live.title === undefined ? {} : { title: live.title }),
  description: live.description,
  input_schema: live.input_schema,
  ...(live.output_schema === undefined ? {} : { output_schema: live.output_schema }),
  annotations: live.annotations,
  sha256: live.sha256,
});

/** The approved fields of an entry, without any proposal. */
function approvedOf(tool: PinnedTool): PinnedTool {
  const { proposed: _proposal, ...rest } = tool;
  return { ...rest, status: "pinned" };
}

export function applyDrift(
  current: readonly PinnedTool[],
  live: readonly PinnedTool[],
): DriftResult {
  const liveByName = new Map(live.map((t) => [t.name, t]));
  const known = new Set(current.map((t) => t.name));
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const tools: PinnedTool[] = [];

  for (const tool of current) {
    const now = liveByName.get(tool.name);
    if (!now) {
      removed.push(tool.name);
      continue;
    }
    if (tool.status === "drifted" && tool.proposed === undefined) {
      // New upstream and not yet approved: it follows the live definition.
      tools.push(tool.sha256 === now.sha256 ? tool : { ...now, status: "drifted" });
      continue;
    }
    if (now.sha256 === tool.sha256) {
      tools.push(approvedOf(tool));
    } else if (tool.proposed?.sha256 === now.sha256) {
      tools.push(tool);
    } else {
      tools.push({ ...approvedOf(tool), status: "drifted", proposed: proposalOf(now) });
      changed.push(tool.name);
    }
  }
  for (const now of live) {
    if (known.has(now.name)) continue;
    tools.push({ ...now, status: "drifted" });
    added.push(now.name);
  }
  return { tools, changed, added, removed };
}

/** `tools_hash` after drift: over approved definitions only (new, unapproved tools excluded). */
export function approvedHash(tools: readonly PinnedTool[]): string {
  return snapshotHash(tools.filter((t) => t.status === "pinned" || t.proposed !== undefined));
}

export interface ApprovalRequest {
  readonly name: string;
  /** The SHA-256 of the live definition the admin reviewed (`proposed.sha256`, or the new tool's). */
  readonly sha256: string;
}

export type ApprovalResult =
  | { readonly ok: true; readonly tools: PinnedTool[]; readonly approved: string[] }
  | {
      readonly ok: false;
      readonly error: "not_pending" | "stale";
      readonly tool: string;
    };

/**
 * Accepts the reviewed definitions. All or nothing: a tool that is not awaiting approval, or whose
 * live definition is no longer the one the admin saw, refuses the whole request.
 */
export function approveTools(
  current: readonly PinnedTool[],
  requests: readonly ApprovalRequest[],
): ApprovalResult {
  const wanted = new Map(requests.map((r) => [r.name, r.sha256]));
  for (const [name, sha256] of wanted) {
    const tool = current.find((t) => t.name === name);
    if (!tool || tool.status !== "drifted") return { ok: false, error: "not_pending", tool: name };
    if ((tool.proposed?.sha256 ?? tool.sha256) !== sha256) {
      return { ok: false, error: "stale", tool: name };
    }
  }
  const approved: string[] = [];
  const tools = current.map((tool): PinnedTool => {
    if (!wanted.has(tool.name)) return tool;
    approved.push(tool.name);
    const { proposed, ...rest } = tool;
    return { ...rest, ...(proposed ?? {}), status: "pinned" };
  });
  return { ok: true, tools, approved };
}
