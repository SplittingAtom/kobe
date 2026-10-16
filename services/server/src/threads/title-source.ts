import type { ServerCallRequest } from "@kobe/protocol";
import { sql, type AgentScope, type KobeTx } from "@kobe/db";
import { resolveRunModel } from "../runs/models.js";
import type { RunAgentResolver } from "../runs/seams.js";
import { firstAnswerAfter, firstUserMessage } from "./messages.js";
import { titleMessages } from "./title.js";

/** What a title call needs, read at call time (KOBE-234: the model is resolved then). */
export interface TitleSource {
  /** The member the run was leased to: the call's budget line and virtual key. */
  readonly userId: string;
  /** `<gateway provider>/<model>`. */
  readonly model: string;
  /** The site catalog marks the model as reasoning (KOBE-259; the call's headroom, KOBE-219). */
  readonly reasoning: boolean;
  readonly messages: ServerCallRequest["messages"];
}

/**
 * Why there is nothing to call: `titled` (titled or locked meanwhile), `no_lease`, `no_model` (no
 * enabled model resolves), `no_message` (no first user message with text).
 */
export type NoTitleSource = "titled" | "no_lease" | "no_model" | "no_message";

export type TitleSourceResult =
  | { readonly ok: true; readonly source: TitleSource }
  | { readonly ok: false; readonly reason: NoTitleSource };

type ThreadPin = {
  readonly owner_user_id: string;
  readonly agent_scope: AgentScope | null;
  readonly agent_id: string | null;
  readonly agent_version: number | null;
  readonly model_alias: string | null;
  readonly untitled: boolean;
  readonly user_id: string | null;
};

/**
 * The title call's member, model and prompt. The model is the thread's resolved one: an agent's
 * pin wins, then the thread's choice, else the team default (`resolveRunModel`, as `run.start`);
 * a model no longer enabled is a skip.
 */
export async function loadTitleSource(
  tx: KobeTx,
  agents: RunAgentResolver,
  ids: { readonly teamId: string; readonly runId: string; readonly threadId: string },
): Promise<TitleSourceResult> {
  const { teamId, runId, threadId } = ids;
  const res = await tx.execute<ThreadPin>(sql`
    SELECT t.owner_user_id, t.agent_scope, t.agent_id, t.agent_version, t.model_alias,
           (t.title IS NULL AND NOT t.title_locked) AS untitled, l.user_id
      FROM threads t
      LEFT JOIN sandbox_run_leases l
        ON l.team_id = t.team_id AND l.run_id = ${runId} AND l.thread_id = t.id
     WHERE t.team_id = ${teamId} AND t.id = ${threadId}`);
  const thread = res.rows[0];
  if (!thread?.untitled) return { ok: false, reason: "titled" };
  if (thread.user_id === null) return { ok: false, reason: "no_lease" };
  const pinned = await agents.pinnedModel?.(tx, {
    teamId,
    ownerUserId: thread.owner_user_id,
    threadId,
    agentScope: thread.agent_scope,
    agentId: thread.agent_id,
    agentVersion: thread.agent_version,
  });
  const resolution = await resolveRunModel(tx, teamId, pinned ?? thread.model_alias ?? undefined);
  if (!resolution.ok || resolution.model === undefined) return { ok: false, reason: "no_model" };
  const first = await firstUserMessage(tx, teamId, threadId);
  if (!first || first.text === "") return { ok: false, reason: "no_message" };
  const answer = await firstAnswerAfter(tx, teamId, threadId, first.seq);
  return {
    ok: true,
    source: {
      userId: thread.user_id,
      model: resolution.model.gateway_model,
      reasoning: resolution.limits?.reasoning === true,
      messages: titleMessages(first.text, answer),
    },
  };
}
