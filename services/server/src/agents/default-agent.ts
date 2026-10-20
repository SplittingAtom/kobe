import { and, eq, isNull, siteAgents, type AgentScope, type KobeTx } from "@kobe/db";
import { KOBE_GALLERY_KEY } from "../gallery/definitions.js";
import { resolveAgentPin, type AgentPin } from "./versions.js";

/**
 * The agent a new conversation starts with (KOBE-458; KOBE-254 user decision): the gallery agent
 * Kobe, when the member can start threads with it in this team (`resolveAgentPin`: visible, active
 * here, not archived, published); otherwise no agent. This is the one rule: the runnable list
 * marks that agent `default` for the composer, and a thread the server starts on the member's
 * behalf (a rail app launch) pins it. It never widens access: the pin goes through the same check
 * as `POST /v1/threads`, and runs still intersect the agent with the team and the thread.
 */
export const isDefaultNewThreadAgent = (agent: {
  readonly scope: AgentScope;
  readonly galleryKey?: string | null | undefined;
}): boolean => agent.scope === "gallery" && agent.galleryKey === KOBE_GALLERY_KEY;

/** The pin of the agent a new conversation starts with for this member, or null (no agent). */
export async function defaultNewThreadPin(
  tx: KobeTx,
  viewer: { readonly teamId: string; readonly userId: string },
): Promise<AgentPin | null> {
  const [kobe] = await tx
    .select({ id: siteAgents.id })
    .from(siteAgents)
    .where(
      and(
        eq(siteAgents.scope, "gallery"),
        eq(siteAgents.galleryKey, KOBE_GALLERY_KEY),
        isNull(siteAgents.archivedAt),
      ),
    );
  if (!kobe) return null;
  const pin = await resolveAgentPin(tx, viewer, kobe.id);
  return pin.ok ? pin.value : null;
}
