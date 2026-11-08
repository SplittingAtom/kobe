import { describe, expect, it } from "vitest";
import {
  TEAM_DEFAULT_AGENT_ERROR_CODES,
  TEAM_DEFAULT_AGENT_ERROR_STATUS,
  forkAgentRequestSchema,
  setTeamDefaultAgentRequestSchema,
  teamDefaultAgentSchema,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("team default agent contract (KOBE-571)", () => {
  it("takes an agent id or null (the site default)", () => {
    expect(setTeamDefaultAgentRequestSchema.safeParse({ agentId: ID }).success).toBe(true);
    expect(setTeamDefaultAgentRequestSchema.safeParse({ agentId: null }).success).toBe(true);
    expect(setTeamDefaultAgentRequestSchema.safeParse({ agentId: "kobe" }).success).toBe(false);
    expect(setTeamDefaultAgentRequestSchema.safeParse({}).success).toBe(false);
  });

  it("answers the choice with the roster's options", () => {
    expect(
      teamDefaultAgentSchema.safeParse({
        agentId: ID,
        unavailable: false,
        options: [{ agentId: ID, name: "Kobe", slug: "kobe", group: "site", versionInEffect: 1 }],
      }).success,
    ).toBe(true);
    expect(
      teamDefaultAgentSchema.safeParse({
        agentId: null,
        unavailable: false,
        options: [{ agentId: ID, name: "Mine", slug: "m", group: "personal", versionInEffect: 1 }],
      }).success,
    ).toBe(false);
  });

  it("maps every error code to a status", () => {
    expect(Object.keys(TEAM_DEFAULT_AGENT_ERROR_STATUS)).toEqual([
      ...TEAM_DEFAULT_AGENT_ERROR_CODES,
    ]);
    expect(TEAM_DEFAULT_AGENT_ERROR_STATUS.agent_not_eligible).toBe(422);
  });

  it("forks with an optional name and slug", () => {
    expect(forkAgentRequestSchema.safeParse({ name: "My copy", slug: "my-copy" }).success).toBe(
      true,
    );
    expect(forkAgentRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(forkAgentRequestSchema.safeParse({ owner: "x" }).success).toBe(false);
  });
});
