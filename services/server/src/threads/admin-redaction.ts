import {
  KOBE_ADMIN_RESULT_HIDDEN,
  mcpServerSegment,
  parseMcpToolName,
  type KobeEvent,
} from "@kobe/protocol";
import { sql, type KobeTx, type TeamRole } from "@kobe/db";
import { siteRoleAllows, teamRoleAllows, type SiteRole } from "../authz/permissions.js";
import { kobeBuiltinName } from "../kobe-mcp/access.js";
import { isKobeDocsToolName } from "../kobe-mcp/docs/index.js";
import { kobeToolByName } from "../kobe-mcp/tools/index.js";

/**
 * Shared threads hide Kobe admin results (KOBE-623, spec kobe-admin-mcp §8, decision KA6). A
 * teammate reading a thread shared with them sees that an admin tool ran, its input and its
 * approval card, but the tool's output is replaced by "Admin result hidden" unless they hold the
 * tool's own permission now (its console page's team or site permission). The thread's owner sees
 * everything. Enforced where the server serves a thread's tool output to a reader: the entry list,
 * the full-output route, the run event stream and a reader's fork.
 *
 * A Kobe tool is recognised by the built-in connector's Pi server segment (`kobe`, or
 * `kobe-builtin` when the name was taken); a name the catalog does not know (a tool of a newer or
 * older release) is hidden, the docs tools never are.
 */

export { KOBE_ADMIN_RESULT_HIDDEN };

export interface AdminResultGate {
  /** Whether this viewer must not see the output of `toolName` (a Pi tool name). */
  hides(toolName: string): boolean;
}

/** What decides a reader's gate: the built-in's segments and the reader's roles now. */
export interface AdminGateFacts {
  /** Pi server segments of the built-in connector (its current name, else both seed names). */
  readonly segments: readonly string[];
  readonly teamRole: TeamRole | null;
  readonly siteRole: SiteRole;
}

/** The gate from its facts (pure). */
export function adminResultGate(facts: AdminGateFacts): AdminResultGate {
  return {
    hides(toolName) {
      const parsed = parseMcpToolName(toolName);
      if (!parsed || !facts.segments.includes(parsed.server_segment)) return false;
      const name = parsed.tool_segment;
      if (isKobeDocsToolName(name)) return false;
      const tool = kobeToolByName(name);
      if (tool === undefined) return true;
      return tool.scope === "team"
        ? !teamRoleAllows(facts.teamRole, tool.permission)
        : !siteRoleAllows(facts.siteRole, tool.permission);
    },
  };
}

/**
 * The gate for `viewer` reading a thread owned by `ownerUserId`; undefined for the owner (nothing
 * is hidden). Reads inside the viewer's team transaction (the team role is a team table).
 */
export async function loadAdminResultGate(
  tx: Pick<KobeTx, "execute">,
  viewer: { readonly teamId: string; readonly userId: string },
  ownerUserId: string,
): Promise<AdminResultGate | undefined> {
  if (viewer.userId === ownerUserId) return undefined;
  const name = await kobeBuiltinName(tx);
  const res = await tx.execute<{ team_role: TeamRole | null; site_role: SiteRole }>(sql`
    SELECT (SELECT m.role FROM public.team_members m
             WHERE m.team_id = ${viewer.teamId} AND m.user_id = ${viewer.userId}) AS team_role,
           (SELECT r.role FROM public.site_roles r WHERE r.user_id = ${viewer.userId}) AS site_role`);
  const row = res.rows[0];
  return adminResultGate({
    segments: (name === undefined ? ["kobe", "kobe-builtin"] : [name]).map(mcpServerSegment),
    teamRole: row?.team_role ?? null,
    siteRole: row?.site_role ?? null,
  });
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * A stored Pi entry payload with a hidden tool result replaced (content and details), or
 * undefined when nothing is hidden from this viewer.
 */
export function redactEntryPayload(
  payload: unknown,
  gate: AdminResultGate | undefined,
): Record<string, unknown> | undefined {
  if (gate === undefined) return undefined;
  const entry = record(payload);
  const message = record(entry?.message);
  if (!entry || message?.role !== "toolResult") return undefined;
  const toolName = typeof message.toolName === "string" ? message.toolName : "";
  if (!gate.hides(toolName)) return undefined;
  const { details: _details, ...rest } = message;
  return {
    ...entry,
    message: { ...rest, content: [{ type: "text", text: KOBE_ADMIN_RESULT_HIDDEN }] },
  };
}

/** A thread entry as served, with its tool output hidden from this viewer where it must be. */
export function redactEntry<E extends { readonly payload: Record<string, unknown> }>(
  entry: E,
  gate: AdminResultGate | undefined,
): E {
  const payload = redactEntryPayload(entry.payload, gate);
  if (payload === undefined) return entry;
  const { payload_truncated: _cut, ...rest } = entry as E & { payload_truncated?: true };
  return { ...rest, payload, admin_result_hidden: true } as unknown as E;
}

/** A run event as a reader may see it: a hidden Kobe admin `tool.result` carries no output. */
export function redactEvent(event: KobeEvent, gate: AdminResultGate | undefined): KobeEvent {
  if (gate === undefined || event.type !== "tool.result" || !gate.hides(event.payload.tool)) {
    return event;
  }
  const { blob_ref: _ref, app: _app, ...payload } = event.payload;
  return {
    ...event,
    payload: { ...payload, preview: KOBE_ADMIN_RESULT_HIDDEN, truncated: false },
  };
}
