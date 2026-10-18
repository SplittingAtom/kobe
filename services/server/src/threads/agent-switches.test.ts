import { describe, expect, it } from "vitest";
import { agentMarkerSchema, groupAgentSwitches, type AgentSwitchRun } from "./agent-switches.js";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

const sw = (from: number, to: number, runId: string | null, entry = "e-1"): AgentSwitchRun => ({
  fromVersion: from,
  toVersion: to,
  runId,
  userEntryId: runId === null ? null : entry,
  parentEntryId: null,
});

describe("groupAgentSwitches (KOBE-420: the switch marker)", () => {
  it("marks the first run after a switch with its versions", () => {
    const [marker] = groupAgentSwitches([sw(1, 3, RUN_A)]);
    expect(marker).toEqual({
      run_id: RUN_A,
      user_entry_id: "e-1",
      parent_entry_id: null,
      from_version: 1,
      to_version: 3,
    });
    expect(agentMarkerSchema.parse(marker)).toEqual(marker);
  });

  it("collapses switches before one run into the first from and the last to", () => {
    expect(groupAgentSwitches([sw(1, 2, RUN_A), sw(2, 3, RUN_A)])).toMatchObject([
      { run_id: RUN_A, from_version: 1, to_version: 3 },
    ]);
  });

  it("leaves out a round trip and switches no run has started after yet", () => {
    expect(groupAgentSwitches([sw(1, 2, RUN_A), sw(2, 1, RUN_A), sw(1, 4, null)])).toEqual([]);
  });

  it("keeps one marker per run, oldest first", () => {
    expect(
      groupAgentSwitches([sw(1, 2, RUN_A, "e-1"), sw(2, 3, RUN_B, "e-5")]).map((m) => [
        m.user_entry_id,
        m.from_version,
        m.to_version,
      ]),
    ).toEqual([
      ["e-1", 1, 2],
      ["e-5", 2, 3],
    ]);
  });
});
