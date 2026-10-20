import type { KobeTx } from "@kobe/db";
import type { z } from "zod";
import { launchAppCardBodySchema } from "@kobe/protocol";
import { defaultNewThreadPin } from "../agents/default-agent.js";
import { resolveAgentPin, type AgentPin } from "../agents/versions.js";
import { checkConnectorsOff, turnOffAtCreation } from "../connectors/thread-connectors.js";
import { createThreadBodySchema } from "../threads/schemas.js";

/**
 * A rail launch from the new-conversation view (KOBE-458 review MEDIUM-1) starts the thread the
 * member was about to start: the agent chosen there (`agent_id`; null = No agent; absent = the
 * shared default, `defaultNewThreadPin`) and the connectors turned off there (`connectors_off`).
 * Both use `POST /v1/threads`'s own fields and checks: `resolveAgentPin` and `checkConnectorsOff`,
 * written with `turnOffAtCreation`. A launch into an existing thread takes neither (strict body).
 */
export const launchNewThreadBodySchema = launchAppCardBodySchema.extend({
  agent_id: createThreadBodySchema.shape.agent_id,
  connectors_off: createThreadBodySchema.shape.connectors_off,
});
export type LaunchNewThreadBody = z.infer<typeof launchNewThreadBodySchema>;

export interface NewThreadDraft {
  /** Absent: the new-conversation default; null: no agent. */
  readonly agentId?: string | null;
  readonly connectorsOff: readonly string[];
}

export const draftOf = (body: LaunchNewThreadBody): NewThreadDraft => ({
  ...(body.agent_id === undefined ? {} : { agentId: body.agent_id }),
  connectorsOff: body.connectors_off ?? [],
});

export type DraftRefusal =
  "agent_not_found" | "agent_unavailable" | "connector_not_found" | "connector_not_working";

/** The new thread's pin, checked as thread creation checks it; or why the draft is refused. */
export async function checkNewThreadDraft(
  tx: KobeTx,
  viewer: { readonly teamId: string; readonly userId: string },
  draft: NewThreadDraft,
): Promise<{ ok: true; pin: AgentPin | null } | { ok: false; error: DraftRefusal }> {
  const off = await checkConnectorsOff(tx, viewer, draft.connectorsOff);
  if (off !== null) return { ok: false, error: off };
  if (draft.agentId === undefined) return { ok: true, pin: await defaultNewThreadPin(tx, viewer) };
  const pin = await resolveAgentPin(tx, viewer, draft.agentId);
  if (pin.ok) return { ok: true, pin: pin.value };
  // `resolveAgentPin` names no version, so it never refuses with `version_not_found`.
  return { ok: false, error: pin.error === "agent_unavailable" ? pin.error : "agent_not_found" };
}

/** Writes the draft's off connectors on the thread just created (same transaction). */
export const writeDraftOff = (
  tx: KobeTx,
  viewer: { readonly teamId: string; readonly userId: string },
  threadId: string,
  draft: NewThreadDraft,
): Promise<void> => turnOffAtCreation(tx, viewer, threadId, draft.connectorsOff);
