import { z } from "zod";
import { agentRosterEntrySchema } from "./agent-roster.js";
import { timestampSchema, uuidSchema } from "./common.js";

/**
 * Fork, transfer and adopt (KOBE-568, spec `docs/specs/agents-roster.md` AR8, AR10, AR16, §6.7).
 *
 * REST (team-scoped like every agent request unless noted):
 * - `POST /v1/agents/{id}/fork` `{slug?}` → 201 `{agent, boundTeamId, warnings}`: always a personal
 *   agent of the caller's ({@link agentForkResultSchema} is the part this contract adds). A `scope`
 *   in the body is ignored with the warning {@link AGENT_FORK_SCOPE_IGNORED}.
 * - `POST /v1/agents/{id}/transfer` {@link transferAgentRequestSchema} → 201
 *   {@link agentTransferResponseSchema} (the owner offers the agent to a member of the active team)
 * - `POST /v1/agents/{id}/transfer/accept` → 200 {@link agentTransferAcceptedSchema} (the recipient)
 * - `DELETE /v1/agents/{id}/transfer` → 204 (the owner cancels or the recipient declines)
 * - `GET /v1/agents/transfers` → {@link agentTransferListSchema} (pending, both directions)
 * - `POST /v1/team/agent-roster/{agentId}/adopt` (team admins) and
 *   `POST /v1/site/agent-roster/{agentId}/adopt` (site admins, no team) → 201
 *   {@link agentAdoptResponseSchema}
 *
 * Errors are `{code, message}` with the roster codes (`AGENT_ROSTER_ERROR_CODES`).
 */

/** The warning a fork answers with when the body still names a `scope` (AR16). */
export const AGENT_FORK_SCOPE_IGNORED = {
  path: "scope",
  message: "ignored: a fork is always your own agent, in Personal",
} as const;

/** What a fork's response adds to the agent: the team the copy is bound to (AR8), or null. */
export const agentForkResultSchema = z.object({ boundTeamId: uuidSchema.nullable() });
export type AgentForkResult = z.infer<typeof agentForkResultSchema>;

export const transferAgentRequestSchema = z.strictObject({ toUserId: uuidSchema });
export type TransferAgentRequest = z.infer<typeof transferAgentRequestSchema>;

/** A pending transfer: ids and a timestamp (the new owner must accept, AR10). */
export const agentTransferSchema = z.strictObject({
  agentId: uuidSchema,
  fromUserId: uuidSchema,
  toUserId: uuidSchema,
  /** The team both are members of when it was offered; the recipient must still be one. */
  teamId: uuidSchema,
  requestedAt: timestampSchema,
});
export type AgentTransfer = z.infer<typeof agentTransferSchema>;

export const agentTransferResponseSchema = z.strictObject({ transfer: agentTransferSchema });
export type AgentTransferResponse = z.infer<typeof agentTransferResponseSchema>;

/** A pending transfer with the agent's slug and name, for the two parties' lists. */
export const agentTransferViewSchema = agentTransferSchema.extend({
  slug: z.string(),
  name: z.string(),
});
export type AgentTransferView = z.infer<typeof agentTransferViewSchema>;

export const agentTransferListSchema = z.strictObject({
  incoming: z.array(agentTransferViewSchema),
  outgoing: z.array(agentTransferViewSchema),
});
export type AgentTransferList = z.infer<typeof agentTransferListSchema>;

/** Accepted: the agent (same id, roster entries and pins kept) now belongs to the caller. */
export const agentTransferAcceptedSchema = z.strictObject({
  agentId: uuidSchema,
  ownerUserId: uuidSchema,
  fromUserId: uuidSchema,
});
export type AgentTransferAccepted = z.infer<typeof agentTransferAcceptedSchema>;

/**
 * Adopted: a new team-owned (team) or site-owned gallery (site) agent holding the entry's agent's
 * current published version as its draft, with fork provenance; the entry is removed.
 */
export const agentAdoptResponseSchema = z.strictObject({
  agent: z.strictObject({
    id: uuidSchema,
    scope: z.enum(["team", "gallery"]),
    slug: z.string(),
    forkedFrom: z.strictObject({ agentId: uuidSchema, version: z.number().int().positive() }),
  }),
  entry: agentRosterEntrySchema,
});
export type AgentAdoptResponse = z.infer<typeof agentAdoptResponseSchema>;
