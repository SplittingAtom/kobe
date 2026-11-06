/** KOBE-547 (CT10): Compare versions, the pure half. */
import { beforeEach, describe, expect, it } from "vitest";
import { assistant, branchMarker, entry, resetEntrySeq, text, user } from "./testing/entries";
import { projectThread } from "./tree";
import {
  choicesFor,
  initialPair,
  pickVersion,
  promptsDiffer,
  versionTitle,
  versionsOf,
} from "./compare";
import type { ThreadEntry } from "./types";

beforeEach(() => resetEntrySeq());

/** Three versions of the second prompt: two regenerates (same text) and an edit. */
const threeVersions = (): ThreadEntry[] => [
  entry("r0", null, null, "thinking_level_change"),
  user("u1", "r0", "start"),
  assistant("a1", "u1", text("ok")),
  user("v1", "a1", "the question"),
  assistant("b1", "v1", text("answer one")),
  branchMarker("k2", "a1"),
  user("v2", "k2", "the question"),
  assistant("b2", "v2", text("answer two")),
  user("w2", "b2", "a follow-up"),
  assistant("c2", "w2", text("more")),
  user("v3", "a1", "an edited question"),
  assistant("b3", "v3", text("answer three")),
];

describe("versionsOf", () => {
  it("lists a prompt's versions with their first answers and where each one shows", () => {
    const p = projectThread(threeVersions(), "b3");
    const versions = versionsOf(p, "v2");
    expect(versions.map((v) => [v.id, v.k, v.answerId])).toEqual([
      ["v1", 1, "b1"],
      ["v2", 2, "b2"],
      ["v3", 3, "b3"],
    ]);
    expect(versions[1]).toMatchObject({ promptId: "v2", headEntry: "b2", revealEntry: "v2" });
  });

  it("answers' own versions compare without prompts", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("one")),
      assistant("a2", "u1", text("two")),
    ];
    const versions = versionsOf(projectThread(entries, "a2"), "a1");
    expect(versions.map((v) => [v.id, v.promptId, v.answerId, v.headEntry])).toEqual([
      ["a1", undefined, "a1", "a1"],
      ["a2", undefined, "a2", "a2"],
    ]);
  });

  it("is empty for a message with one version or one not in the projection", () => {
    const p = projectThread(threeVersions(), "b3");
    expect(versionsOf(p, "u1")).toEqual([]);
    expect(versionsOf(p, "b1")).toEqual([]);
    expect(versionsOf(p, "nope")).toEqual([]);
  });
});

describe("the pair and the dropdowns", () => {
  const versions = () => versionsOf(projectThread(threeVersions(), "b3"), "v1");

  it("opens on the two newest, older on the left", () => {
    expect(initialPair(versions())).toEqual(["v2", "v3"]);
    expect(initialPair(versions().slice(0, 1))).toBeUndefined();
  });

  it("each dropdown lists the others; picking keeps the other column", () => {
    expect(choicesFor(versions(), "v3").map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(pickVersion(["v2", "v3"], 0, "v1")).toEqual(["v1", "v3"]);
    expect(pickVersion(["v2", "v3"], 1, "v1")).toEqual(["v2", "v1"]);
    expect(pickVersion(["v2", "v3"], 0, "v3")).toEqual(["v2", "v3"]);
  });

  it("titles by label, else Version k; prompts show only when they differ", () => {
    const [a, b, c] = versions();
    expect(versionTitle({ k: 2 })).toBe("Version 2");
    expect(versionTitle({ k: 2 }, "cheaper")).toBe("cheaper");
    const p = projectThread(threeVersions(), "b3");
    expect(promptsDiffer(p, a, b)).toBe(false);
    expect(promptsDiffer(p, b, c)).toBe(true);
    const answers = versionsOf(
      projectThread(
        [user("u1", null, "q"), assistant("a1", "u1", text("1")), assistant("a2", "u1", text("2"))],
        "a2",
      ),
      "a1",
    );
    expect(promptsDiffer(p, answers[0], answers[1])).toBe(false);
  });
});
