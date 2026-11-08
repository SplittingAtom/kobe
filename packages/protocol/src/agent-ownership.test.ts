import { describe, expect, it } from "vitest";
import {
  AGENT_FORK_SCOPE_IGNORED,
  AGENT_ROSTER_ERROR_STATUS,
  agentAdoptResponseSchema,
  agentTransferListSchema,
  transferAgentRequestSchema,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-08T12:00:00.000Z";

describe("fork, transfer and adopt contract (KOBE-568)", () => {
  it("names the ignored scope in the fork warning", () => {
    expect(AGENT_FORK_SCOPE_IGNORED.path).toBe("scope");
  });

  it("takes a user id as the transfer recipient, nothing else", () => {
    expect(transferAgentRequestSchema.safeParse({ toUserId: ID }).success).toBe(true);
    expect(transferAgentRequestSchema.safeParse({ toUserId: "bob" }).success).toBe(false);
    expect(transferAgentRequestSchema.safeParse({ toUserId: ID, teamId: ID }).success).toBe(false);
  });

  it("lists pending transfers both ways with ids, slug and name", () => {
    const view = {
      agentId: ID,
      fromUserId: ID,
      toUserId: ID,
      teamId: ID,
      requestedAt: NOW,
      slug: "x",
      name: "X",
    };
    expect(agentTransferListSchema.parse({ incoming: [view], outgoing: [] }).incoming).toHaveLength(
      1,
    );
  });

  it("answers an adopt with the new agent's provenance and the removed entry", () => {
    const parsed = agentAdoptResponseSchema.safeParse({
      agent: {
        id: ID,
        scope: "gallery",
        slug: "x",
        currentVersion: 1,
        forkedFrom: { agentId: ID, version: 2 },
      },
      entry: {
        agentId: ID,
        target: "site",
        teamId: null,
        state: "removed",
        versionRule: "latest",
        pinnedVersion: null,
        assignedBy: ID,
        assignedAt: NOW,
        decidedBy: ID,
        decidedAt: NOW,
        note: null,
        removedAt: NOW,
      },
    });
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
  });

  it("gives the new error codes their statuses", () => {
    expect(AGENT_ROSTER_ERROR_STATUS.transfer_not_found).toBe(404);
    expect(AGENT_ROSTER_ERROR_STATUS.transfer_recipient_invalid).toBe(422);
    expect(AGENT_ROSTER_ERROR_STATUS.slug_taken).toBe(409);
  });
});
