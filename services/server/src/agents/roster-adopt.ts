import { and, eq, siteAgentVersions, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { validateAgentDefinition } from "@kobe/agent-file";
import { recordAudit } from "../audit/record.js";
import type { RosterTarget } from "./access.js";
import { siteEntry, teamEntry, type RosterEntryRecord } from "./roster.js";
import { audit, lockPersonalAgent, lockRoster, writeEntry } from "./roster-writes.js";
import { insertAgent, type AgentLocation, type AgentRecord, type CreateError } from "./store.js";
import { publishDraftIn } from "./versions.js";

/**
 * Adopt (KOBE-568, agents-roster AR10): a roster's admin copies an assigned entry's agent, at its
 * current published version, into an agent the roster owns, and the entry is removed, in one
 * transaction. Team roster → a team-owned agent (team admins; the adopter is its creator); site
 * roster → a site-owned gallery agent without a repository key (site admins), which the seed never
 * touches. The copy carries fork provenance and is published as its v1 in the same transaction, so
 * the roster never loses the agent it ran (AR10: the published version is copied). A bound agent is
 * adopted only into its own team. Allowed whether or not the owner is still around.
 */

export type AdoptError =
  | "roster_entry_not_found"
  | "invalid_transition"
  | "agent_bound_to_team"
  | "agent_not_published"
  | "invalid_agent"
  | CreateError;
export type AdoptResult =
  | { ok: true; value: { agent: AgentRecord; entry: RosterEntryRecord } }
  | { ok: false; error: AdoptError };

const fail = (error: AdoptError): { ok: false; error: AdoptError } => ({ ok: false, error });

export interface AdoptInput {
  readonly agentId: string;
  /** The adopting admin: creator of a team-owned copy, actor of the audit. */
  readonly userId: string;
  readonly target: RosterTarget;
  /** The team roster's team (target team only). */
  readonly teamId: string | null;
}

/** Thrown inside the transaction when the copy can't be published: rolls the adopt back. */
class AdoptPublishError extends Error {}

export async function adoptEntry(db: KobeDb, input: AdoptInput): Promise<AdoptResult> {
  const run = (tx: KobeTx) => adoptIn(tx, input);
  if (input.target === "team" && input.teamId === null) {
    throw new Error("adopt: a team roster adopt needs a team");
  }
  try {
    return input.target === "site"
      ? await db.transaction(run)
      : await withTeam(db, input.teamId ?? "", run);
  } catch (err) {
    if (err instanceof AdoptPublishError) return fail("invalid_agent");
    throw err;
  }
}

async function adoptIn(tx: KobeTx, input: AdoptInput): Promise<AdoptResult> {
  const { target, agentId, teamId } = input;
  await lockRoster(tx, target, teamId);
  const agent = await lockPersonalAgent(tx, agentId);
  if (!agent) return fail("roster_entry_not_found");
  const entry =
    target === "team"
      ? await teamEntry(tx, teamId ?? "", agentId, true)
      : await siteEntry(tx, agentId, true);
  if (!entry) return fail("roster_entry_not_found");
  // Only an assigned entry (not a proposal, not removed: adopted already) is adopted.
  if (entry.state !== "active" && entry.state !== "suspended") return fail("invalid_transition");
  // A bound agent stays in its team (AR8): never adopted into the site or another team.
  if (agent.boundTeamId !== null && (target === "site" || agent.boundTeamId !== teamId)) {
    return fail("agent_bound_to_team");
  }
  if (agent.currentVersion === null) return fail("agent_not_published");
  const [version] = await tx
    .select({ frontmatter: siteAgentVersions.frontmatter, prompt: siteAgentVersions.prompt })
    .from(siteAgentVersions)
    .where(
      and(
        eq(siteAgentVersions.agentId, agentId),
        eq(siteAgentVersions.version, agent.currentVersion),
      ),
    );
  const definition = version ? validateAgentDefinition(version) : null;
  if (!definition?.ok) return fail("invalid_agent");
  const location: AgentLocation =
    target === "team" ? { scope: "team", teamId: teamId ?? "" } : { scope: "gallery" };
  const created = await insertAgent(tx, location, {
    definition: definition.definition,
    baseSlug: agent.slug,
    ownerUserId: target === "team" ? input.userId : null,
    source: "adopt",
    forkedFrom: agentId,
    forkedFromVersion: agent.currentVersion,
  });
  if (!created.ok) return fail(created.error);
  const published = await publishDraftIn(tx, location, created.value.id, {
    publishedBy: input.userId,
    expectedRevision: undefined,
  });
  if (!published.ok) throw new AdoptPublishError(published.error);
  const now = new Date();
  const removed = await writeEntry(
    tx,
    target,
    teamId,
    agentId,
    { state: "removed", removedAt: now, decidedBy: input.userId, decidedAt: now },
    false,
  );
  await audit(tx, "removed", target, teamId, agent);
  const copy = published.value.agent;
  await recordAudit(tx, {
    action: "agent.adopted",
    teamId: target === "team" ? teamId : null,
    target: {
      agentId: copy.id,
      scope: target === "team" ? "team" : "gallery",
      slug: copy.slug,
      roster: target,
      fromAgentId: agentId,
      fromVersion: agent.currentVersion,
    },
  });
  return { ok: true, value: { agent: copy, entry: removed } };
}
