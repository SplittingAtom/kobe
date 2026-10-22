import { explicitToolNames } from "@kobe/agent-file";
import { sql, type KobeTx, type TeamRole } from "@kobe/db";
import { toolManifestSchema, withSiteNames } from "../agents/manifest.js";
import type { SiteRole } from "../authz/permissions.js";
import { mayUseDangerousMode } from "./dangerous-mode.js";

/**
 * The run's agent as the per-call policy check needs it (KOBE-481, KOBE-476), read inside the
 * run's team transaction on every call:
 *
 * - `toolsDeny`: the agent's own `tools.deny`, from the run's published version (its frozen
 *   manifest) or, for a draft's test chat, the draft. The engine denies a matching call in every
 *   mode, built-in or MCP.
 * - `dangerousTools`: when the published version is in Dangerous mode (AC1), the tools its
 *   `tools.allow` names one by one (never a glob). Empty unless the run is interactive (not
 *   scheduled, not a skill eval) and **whoever published that version** is still active and still
 *   a site admin or an admin of this team; otherwise the agent behaves as in its default mode.
 *   Drafts never run in Dangerous mode. The caller also requires an `auto` site floor.
 *
 * `tools.allow` is not returned for enforcement: it only decides which tools Dangerous may allow.
 * An unreadable version throws (the call is then denied).
 */
export interface RunAgentTools {
  readonly toolsDeny: readonly string[];
  readonly dangerousTools: readonly string[];
}

const NONE: RunAgentTools = { toolsDeny: [], dangerousTools: [] };

interface RunAgentRow extends Record<string, unknown> {
  readonly agent_scope: "team" | "personal" | "gallery" | null;
  readonly agent_id: string | null;
  readonly agent_version: number | null;
  readonly trigger: string;
  readonly skill_eval: boolean;
}

export async function loadRunAgentTools(
  tx: KobeTx,
  run: { readonly teamId: string; readonly runId: string },
): Promise<RunAgentTools> {
  const res = await tx.execute<RunAgentRow>(sql`
    SELECT t.agent_scope, t.agent_id, r.agent_version, r.trigger, t.skill_eval
      FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${run.teamId} AND r.id = ${run.runId}`);
  const row = res.rows[0];
  if (!row || row.agent_scope === null || row.agent_id === null) return NONE;
  if (row.agent_version === null) {
    return {
      toolsDeny: await draftDeny(tx, run.teamId, row.agent_scope, row.agent_id),
      dangerousTools: [],
    };
  }
  const version =
    row.agent_scope === "team"
      ? await tx.execute<{ tool_manifest: unknown; published_by: string | null }>(sql`
          SELECT tool_manifest, published_by FROM team_agent_versions
           WHERE team_id = ${run.teamId} AND agent_id = ${row.agent_id}
             AND version = ${row.agent_version}`)
      : await tx.execute<{ tool_manifest: unknown; published_by: string | null }>(sql`
          SELECT tool_manifest, published_by FROM site_agent_versions
           WHERE agent_id = ${row.agent_id} AND version = ${row.agent_version}`);
  const found = version.rows[0];
  const parsed = toolManifestSchema.safeParse(withSiteNames(found?.tool_manifest));
  if (!found || !parsed.success) throw new Error("the run's agent version can't be read");
  const manifest = parsed.data;
  const dangerous =
    manifest.approval_mode.dangerous === true &&
    row.trigger === "user" &&
    !row.skill_eval &&
    found.published_by !== null &&
    (await stillAdmin(tx, run.teamId, found.published_by));
  return {
    toolsDeny: manifest.tools_deny,
    dangerousTools: dangerous ? explicitToolNames(manifest.tools_allow) : [],
  };
}

/** A draft's `tools.deny` (a test chat runs the draft); entries that aren't strings are dropped. */
async function draftDeny(
  tx: KobeTx,
  teamId: string,
  scope: "team" | "personal" | "gallery",
  agentId: string,
): Promise<string[]> {
  const res =
    scope === "team"
      ? await tx.execute<{ deny: unknown }>(sql`
          SELECT frontmatter->'tools'->'deny' AS deny FROM team_agents
           WHERE team_id = ${teamId} AND id = ${agentId}`)
      : await tx.execute<{ deny: unknown }>(sql`
          SELECT frontmatter->'tools'->'deny' AS deny FROM site_agents WHERE id = ${agentId}`);
  const deny = res.rows[0]?.deny;
  return Array.isArray(deny) ? deny.filter((d): d is string => typeof d === "string") : [];
}

/** The publisher is active and a site admin or an admin of this team, now (AC1). */
async function stillAdmin(tx: KobeTx, teamId: string, userId: string): Promise<boolean> {
  const res = await tx.execute<{
    active: boolean;
    team_role: TeamRole | null;
    site_role: SiteRole;
  }>(sql`
    SELECT u.deactivated_at IS NULL AS active,
           (SELECT role FROM team_members WHERE team_id = ${teamId} AND user_id = u.id) AS team_role,
           (SELECT role FROM site_roles WHERE user_id = u.id) AS site_role
      FROM users u WHERE u.id = ${userId}`);
  const row = res.rows[0];
  return row !== undefined && row.active && mayUseDangerousMode(row.team_role, row.site_role);
}
