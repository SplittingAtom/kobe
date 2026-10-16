import type { AgentScope, KobeTx } from "@kobe/db";
import { sql } from "@kobe/db";
import { resolveDraftAgent, resolvePinnedAgent } from "../agents/versions.js";

/**
 * The agent prompt the run's `run.start` carried (`config.system_prompt`, KOBE-290): the pinned
 * agent version's prompt (immutable once published; a test thread's draft only at the revision the
 * run started with), as the run-start resolver (`runs/agents.ts`) sends it. Null when the run had
 * no agent or an empty prompt; undefined when the server can no longer say (agent or version gone,
 * draft edited since): then no `system` entry is accepted for the run.
 */
export async function sentAgentPrompt(
  tx: KobeTx,
  teamId: string,
  runId: string,
  threadId: string,
): Promise<string | null | undefined> {
  const started = await tx.execute<{
    agent_id: string | null;
    agent_version: number | null;
    draft_revision: number | null;
  }>(sql`
    SELECT payload ->> 'agent_id' AS agent_id,
           (payload ->> 'agent_version')::int AS agent_version,
           (payload ->> 'draft_revision')::int AS draft_revision
      FROM run_events
     WHERE team_id = ${teamId} AND run_id = ${runId} AND type = 'run.started'
     ORDER BY seq LIMIT 1`);
  const run = started.rows[0];
  if (run === undefined) return undefined;
  if (run.agent_id === null) return null;
  const thread = await tx.execute<{ owner_user_id: string; agent_scope: AgentScope | null }>(sql`
    SELECT owner_user_id, agent_scope FROM threads WHERE team_id = ${teamId} AND id = ${threadId}`);
  const row = thread.rows[0];
  if (row?.agent_scope === null || row === undefined) return undefined;
  const owner = { teamId, userId: row.owner_user_id };
  const pin = { agentScope: row.agent_scope, agentId: run.agent_id };
  const pinned =
    run.agent_version === null
      ? await resolveDraftAgent(tx, owner, pin)
      : await resolvePinnedAgent(tx, owner, { ...pin, agentVersion: run.agent_version });
  if (!pinned.ok) return undefined;
  if (run.agent_version === null && pinned.version.draftRevision !== run.draft_revision) {
    return undefined;
  }
  const prompt = pinned.version.definition.prompt;
  return prompt.trim() === "" ? null : prompt;
}
