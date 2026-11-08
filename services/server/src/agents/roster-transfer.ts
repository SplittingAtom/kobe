import {
  and,
  eq,
  inArray,
  isNull,
  siteAgents,
  siteSettings,
  sql,
  teamMembers,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { AgentTransfer, AgentTransferList, AgentTransferView } from "@kobe/protocol";
import { z } from "zod";
import { recordAudit } from "../audit/record.js";
import type { RosterActor } from "./access.js";
import { AGENT_CAPS, lockKey } from "./store.js";

/**
 * Transfer of a personal agent to another member of the same team (KOBE-568, agents-roster AR10,
 * §6.8): the owner offers it, the recipient accepts (or declines), the owner may cancel. On accept
 * the agent keeps its id, so its roster entries keep their rows and threads keep their pins; only
 * `site_agents.owner_user_id` moves. A bound agent goes only to a member of its bound team.
 *
 * A pending offer is ids and a timestamp, kept as one `site_settings` row per agent (key
 * `agent_transfer:<agentId>`, JSON value): no new table for a short-lived, at-most-one-per-agent
 * record. Every write runs inside `withTeam()` of the offer's team (membership is read there with
 * `team_id` explicit) and is audited with that team.
 */

const KEY_PREFIX = "agent_transfer:";
const keyOf = (agentId: string) => `${KEY_PREFIX}${agentId}`;

const storedSchema = z.object({
  fromUserId: z.uuid(),
  toUserId: z.uuid(),
  teamId: z.uuid(),
  requestedAt: z.iso.datetime({ offset: true }),
});

export type TransferError =
  | "agent_not_found"
  | "transfer_not_found"
  | "transfer_recipient_invalid"
  | "agent_bound_to_team"
  | "agent_archived"
  | "slug_taken"
  | "limit_reached";
export type TransferResult<T> = { ok: true; value: T } | { ok: false; error: TransferError };
const fail = (error: TransferError): { ok: false; error: TransferError } => ({ ok: false, error });

interface OwnedAgent {
  readonly id: string;
  readonly slug: string;
  readonly ownerUserId: string;
  readonly boundTeamId: string | null;
  readonly archivedAt: Date | null;
}

/** The personal agent, locked for the rest of `tx` (`FOR UPDATE`: ownership is changing). */
async function lockOwned(tx: KobeTx, agentId: string): Promise<OwnedAgent | null> {
  const [row] = await tx
    .select({
      id: siteAgents.id,
      slug: siteAgents.slug,
      ownerUserId: siteAgents.ownerUserId,
      boundTeamId: siteAgents.boundTeamId,
      archivedAt: siteAgents.archivedAt,
    })
    .from(siteAgents)
    .where(and(eq(siteAgents.id, agentId), eq(siteAgents.scope, "personal")))
    .for("update");
  return row?.ownerUserId ? { ...row, ownerUserId: row.ownerUserId } : null;
}

const parse = (agentId: string, value: string): AgentTransfer | null => {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return null;
  }
  const stored = storedSchema.safeParse(json);
  if (!stored.success) return null;
  return {
    agentId,
    ...stored.data,
    requestedAt: new Date(stored.data.requestedAt).toISOString(),
  };
};

/** The agent's pending transfer, if any. */
export async function pendingTransfer(
  db: KobeDb | KobeTx,
  agentId: string,
  lock = false,
): Promise<AgentTransfer | null> {
  const query = db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, keyOf(agentId)));
  const [row] = lock ? await query.for("update") : await query;
  return row ? parse(agentId, row.value) : null;
}

/** An active (not deactivated) member of `teamId`. Call inside `withTeam(db, teamId)`. */
async function activeMember(tx: KobeTx, teamId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, userId),
        isNull(users.deactivatedAt),
      ),
    );
  return row !== undefined;
}

const ref = (agent: OwnedAgent) => ({
  agentId: agent.id,
  scope: "personal" as const,
  slug: agent.slug,
});

/**
 * `POST /v1/agents/:id/transfer`: the owner offers their agent to another active member of the
 * active team. A new offer replaces a pending one.
 */
export async function requestTransfer(
  db: KobeDb,
  actor: RosterActor,
  agentId: string,
  toUserId: string,
): Promise<TransferResult<AgentTransfer>> {
  return withTeam(db, actor.teamId, async (tx) => {
    const agent = await lockOwned(tx, agentId);
    if (!agent || agent.ownerUserId !== actor.userId) return fail("agent_not_found");
    // An archived agent is retired (KOBE-46): unarchive it before handing it over.
    if (agent.archivedAt !== null) return fail("agent_archived");
    if (agent.boundTeamId !== null && agent.boundTeamId !== actor.teamId) {
      return fail("agent_bound_to_team");
    }
    if (toUserId === actor.userId || !(await activeMember(tx, actor.teamId, toUserId))) {
      return fail("transfer_recipient_invalid");
    }
    const requestedAt = new Date().toISOString();
    const value = JSON.stringify({
      fromUserId: actor.userId,
      toUserId,
      teamId: actor.teamId,
      requestedAt,
    });
    await tx
      .insert(siteSettings)
      .values({ key: keyOf(agentId), value })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
    await recordAudit(tx, {
      action: "agent.transfer.requested",
      teamId: actor.teamId,
      target: { ...ref(agent), fromUserId: actor.userId, toUserId },
    });
    return {
      ok: true,
      value: { agentId, fromUserId: actor.userId, toUserId, teamId: actor.teamId, requestedAt },
    };
  });
}

/**
 * Runs `fn` in the offer's team with the agent and the offer locked; `transfer_not_found` unless
 * `userId` is a party (`as`). A stale offer (the agent changed owner or is gone) is dropped.
 */
async function withOffer<T>(
  db: KobeDb,
  agentId: string,
  userId: string,
  as: "either" | "recipient",
  fn: (tx: KobeTx, agent: OwnedAgent, offer: AgentTransfer) => Promise<TransferResult<T>>,
): Promise<TransferResult<T>> {
  const seen = await pendingTransfer(db, agentId);
  const party = (o: AgentTransfer) =>
    o.toUserId === userId || (as === "either" && o.fromUserId === userId);
  if (!seen || !party(seen)) return fail("transfer_not_found");
  return withTeam(db, seen.teamId, async (tx) => {
    const agent = await lockOwned(tx, agentId);
    const offer = await pendingTransfer(tx, agentId, true);
    if (!offer || offer.teamId !== seen.teamId || !party(offer)) return fail("transfer_not_found");
    if (!agent || agent.ownerUserId !== offer.fromUserId) {
      await tx.delete(siteSettings).where(eq(siteSettings.key, keyOf(agentId)));
      return fail("transfer_not_found");
    }
    return fn(tx, agent, offer);
  });
}

/** `DELETE /v1/agents/:id/transfer`: the owner cancels, or the recipient declines. */
export async function cancelTransfer(
  db: KobeDb,
  userId: string,
  agentId: string,
): Promise<TransferResult<AgentTransfer>> {
  return withOffer(db, agentId, userId, "either", async (tx, agent, offer) => {
    await tx.delete(siteSettings).where(eq(siteSettings.key, keyOf(agentId)));
    await recordAudit(tx, {
      action: "agent.transfer.cancelled",
      teamId: offer.teamId,
      target: {
        ...ref(agent),
        fromUserId: offer.fromUserId,
        toUserId: offer.toUserId,
        by: offer.fromUserId === userId ? "owner" : "recipient",
      },
    });
    return { ok: true, value: offer };
  });
}

/**
 * `POST /v1/agents/:id/transfer/accept`: the recipient, still an active member of the offer's team
 * (and of the bound team), becomes the owner. Their slug and agent cap apply, serialized with their
 * own creates.
 */
export async function acceptTransfer(
  db: KobeDb,
  userId: string,
  agentId: string,
): Promise<TransferResult<AgentTransfer>> {
  return withOffer(db, agentId, userId, "recipient", async (tx, agent, offer) => {
    if (agent.archivedAt !== null) return fail("agent_archived");
    if (agent.boundTeamId !== null && agent.boundTeamId !== offer.teamId) {
      return fail("agent_bound_to_team");
    }
    if (!(await activeMember(tx, offer.teamId, userId))) return fail("transfer_recipient_invalid");
    const location = { scope: "personal" as const, ownerUserId: userId };
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(location)}, 0))`);
    const theirs = await tx
      .select({ slug: siteAgents.slug, archivedAt: siteAgents.archivedAt })
      .from(siteAgents)
      .where(and(eq(siteAgents.scope, "personal"), eq(siteAgents.ownerUserId, userId)));
    if (theirs.some((a) => a.slug === agent.slug)) return fail("slug_taken");
    if (theirs.filter((a) => a.archivedAt === null).length >= AGENT_CAPS.personal) {
      return fail("limit_reached");
    }
    await tx
      .update(siteAgents)
      .set({ ownerUserId: userId, updatedAt: new Date() })
      .where(and(eq(siteAgents.id, agentId), eq(siteAgents.scope, "personal")));
    await tx.delete(siteSettings).where(eq(siteSettings.key, keyOf(agentId)));
    await recordAudit(tx, {
      action: "agent.transferred",
      teamId: offer.teamId,
      target: { ...ref(agent), fromUserId: offer.fromUserId, toUserId: userId },
    });
    return { ok: true, value: offer };
  });
}

/** `GET /v1/agents/transfers`: the caller's pending offers, both ways, with slug and name. */
export async function listTransfers(db: KobeDb, userId: string): Promise<AgentTransferList> {
  const rows = await db
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings)
    .where(sql`${siteSettings.key} LIKE ${`${KEY_PREFIX}%`}`);
  const mine = rows
    .map((r) => parse(r.key.slice(KEY_PREFIX.length), r.value))
    .filter((t): t is AgentTransfer => t !== null)
    .filter((t) => t.fromUserId === userId || t.toUserId === userId);
  if (mine.length === 0) return { incoming: [], outgoing: [] };
  const agents = await db
    .select({
      id: siteAgents.id,
      slug: siteAgents.slug,
      ownerUserId: siteAgents.ownerUserId,
      frontmatter: siteAgents.frontmatter,
    })
    .from(siteAgents)
    .where(
      and(
        eq(siteAgents.scope, "personal"),
        inArray(
          siteAgents.id,
          mine.map((t) => t.agentId),
        ),
      ),
    );
  const byId = new Map(agents.map((a) => [a.id, a]));
  const views: AgentTransferView[] = [];
  for (const t of mine) {
    const agent = byId.get(t.agentId);
    // A stale offer (the agent changed owner or is gone) is not shown; accept drops it.
    if (!agent || agent.ownerUserId !== t.fromUserId) continue;
    const name = typeof agent.frontmatter.name === "string" ? agent.frontmatter.name : agent.slug;
    views.push({ ...t, slug: agent.slug, name });
  }
  const byTime = (a: AgentTransferView, b: AgentTransferView) =>
    a.requestedAt.localeCompare(b.requestedAt);
  return {
    incoming: views.filter((t) => t.toUserId === userId).sort(byTime),
    outgoing: views.filter((t) => t.fromUserId === userId).sort(byTime),
  };
}
