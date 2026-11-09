import { describe, expect, it } from "vitest";
import { groupAgents } from "./agent-groups";
import type { RunnableAgent } from "./types";

const agent = (id: string, scope: RunnableAgent["scope"], group?: RunnableAgent["group"]) =>
  ({ id, scope, name: id, model: null, ...(group ? { group } : {}) }) as RunnableAgent;

describe("agent picker groups (AR15, KOBE-571)", () => {
  it("orders Personal, Team, Site and drops empty groups, keeping the server's order inside", () => {
    const groups = groupAgents([
      agent("kobe", "gallery", "site"),
      agent("lent-b", "personal", "team"),
      agent("owned", "team", "team"),
    ]);
    expect(groups.map((g) => [g.label, g.agents.map((a) => a.id)])).toEqual([
      ["Team", ["lent-b", "owned"]],
      ["Site", ["kobe"]],
    ]);
  });

  it("falls back to the scope for an older server", () => {
    expect(
      groupAgents([agent("g", "gallery"), agent("p", "personal"), agent("t", "team")]).map(
        (g) => g.id,
      ),
    ).toEqual(["personal", "team", "site"]);
  });
});
