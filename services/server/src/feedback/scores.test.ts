import { describe, expect, it } from "vitest";
import { runTraceId } from "@kobe/protocol";
import { scoreOf } from "./scores.js";

const ROW = {
  id: "5d1c8b5e-6d0a-4f7e-9a43-5f7b0f2d1c11",
  runId: "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11",
  threadId: "1b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11",
  rating: "down" as const,
  reasons: ["wrong", "unsafe"],
  comment: "It made the number up.",
  agentScope: "team",
  agentId: "2b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11",
  agentVersion: 3,
  modelAlias: "fast",
};
const TEAM = "3b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";

describe("scoreOf (KOBE-275)", () => {
  it("names the run's trace, keeps the rating's id and holds ids and codes only", () => {
    const score = scoreOf(TEAM, ROW, false);
    expect(score).toEqual({
      id: ROW.id,
      traceId: runTraceId(ROW.runId),
      name: "answer_feedback",
      dataType: "BOOLEAN",
      value: 0,
      metadata: {
        rating: "down",
        reasons: ["wrong", "unsafe"],
        team_id: TEAM,
        thread_id: ROW.threadId,
        run_id: ROW.runId,
        agent_scope: "team",
        agent_id: ROW.agentId,
        agent_version: 3,
        model: "fast",
      },
    });
    expect(JSON.stringify(score)).not.toContain("made the number");
  });

  it("carries the comment only with content capture on", () => {
    expect(scoreOf(TEAM, ROW, true).comment).toBe("It made the number up.");
    expect(scoreOf(TEAM, { ...ROW, comment: null }, true)).not.toHaveProperty("comment");
    expect(scoreOf(TEAM, { ...ROW, rating: "up", reasons: [], comment: null }, true).value).toBe(1);
  });
});
