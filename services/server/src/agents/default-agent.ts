import { and, eq, isNull, siteAgents, type AgentScope, type KobeTx } from "@kobe/db";
import { KOBE_GALLERY_KEY } from "../gallery/definitions.js";
import { readTeamDefaultAgent } from "./team-default.js";
import { resolveAgentPin, type AgentPin } from "./versions.js";

/**
 * The agent a new conversation starts with (KOBE-458; KOBE-254 user decision): the team's default
 * agent from its roster when it has one (KOBE-567 hook, setting in KOBE-571), else the gallery agent
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

/**
 * The team's default agent for new threads, chosen by a team admin from its roster (agents-roster
 * §7.7; KOBE-567 hook, setting KOBE-571 in `team-default.ts`); null → the site default (Kobe).
 * Whatever it names still goes through `resolveAgentPin`, so a team default that is not runnable
 * for the member falls back to the site default.
 */
export async function teamDefaultAgentId(tx: KobeTx, teamId: string): Promise<string | null> {
  return readTeamDefaultAgent(tx, teamId);
}

/** The pin of the agent a new conversation starts with for this member, or null (no agent). */
export async function defaultNewThreadPin(
  tx: KobeTx,
  viewer: { readonly teamId: string; readonly userId: string },
): Promise<AgentPin | null> {
  const teamDefault = await teamDefaultAgentId(tx, viewer.teamId);
  if (teamDefault !== null) {
    const pin = await resolveAgentPin(tx, viewer, teamDefault);
    if (pin.ok && pin.value !== null) return pin.value;
  }
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
