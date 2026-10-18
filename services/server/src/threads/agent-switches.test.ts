import { describe, expect, it } from "vitest";
import { agentChanges, agentMarkerSchema, type StartedRun } from "./agent-switches.js";

let n = 0;
const run = (version: number | null, entry: string | null = `e-${++n}`): StartedRun => ({
  runId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  version,
  userEntryId: entry,
  parentEntryId: null,
});

const shown = (runs: StartedRun[]) =>
  agentChanges(runs).map((m) => [m.user_entry_id, m.from_version, m.to_version]);

describe("agentChanges (KOBE-420: the version marker from runs.agent_version)", () => {
  it("marks the first run on another version than the run before", () => {
    const runs = [run(1, "a"), run(1, "b"), run(3, "c"), run(3, "d")];
    const [marker] = agentChanges(runs);
    expect(marker).toEqual({
      run_id: runs[2]?.runId,
      user_entry_id: "c",
      parent_entry_id: null,
      from_version: 1,
      to_version: 3,
    });
    expect(agentMarkerSchema.parse(marker)).toEqual(marker);
  });

  it("shows nothing for a thread that never changed, or only has unknown versions", () => {
    expect(shown([run(2), run(2)])).toEqual([]);
    expect(shown([run(null), run(null)])).toEqual([]);
    expect(shown([run(2)])).toEqual([]);
  });

  it("skips runs with no known version (compacted before the column, or no agent)", () => {
    expect(shown([run(1, "a"), run(null, "b"), run(2, "c")])).toEqual([["c", 1, 2]]);
    expect(shown([run(1, "a"), run(null, "b"), run(1, "c")])).toEqual([]);
  });

  it("passes a change on a run without a prompt entry to the next run that has one", () => {
    expect(shown([run(1, "a"), run(2, null), run(2, "c")])).toEqual([["c", 1, 2]]);
    // Changes that meet on one prompt are one; a round trip there shows none.
    expect(shown([run(1, "a"), run(2, null), run(3, "c")])).toEqual([["c", 1, 3]]);
    expect(shown([run(1, "a"), run(2, null), run(1, "c")])).toEqual([]);
  });

  it("marks each change, oldest first", () => {
    expect(shown([run(1, "a"), run(2, "b"), run(2, "c"), run(1, "d")])).toEqual([
      ["b", 1, 2],
      ["d", 2, 1],
    ]);
  });
});
