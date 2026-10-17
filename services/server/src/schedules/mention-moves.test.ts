import { mentionMarker } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { movedPath, retargetMentions } from "./mention-moves.js";

describe("schedule mentions follow a moved file (KOBE-304)", () => {
  it("maps the moved path and everything under a moved folder", () => {
    expect(movedPath("a.csv", "a.csv", "b.csv")).toBe("b.csv");
    expect(movedPath("d/x/y.csv", "d", "e/d")).toBe("e/d/x/y.csv");
    expect(movedPath("dd/y.csv", "d", "e")).toBeUndefined();
    expect(movedPath("other.csv", "a.csv", "b.csv")).toBeUndefined();
  });

  it("rewrites the mentions and exactly their markers in the prompt", () => {
    const prompt = `Use ${mentionMarker("d/a b.csv")} twice: ${mentionMarker("d/a b.csv")}; not @file(d/a b.csv)`;
    expect(retargetMentions({ prompt, mentions: ["d/a b.csv", "z.csv"] }, "d", "e")).toEqual({
      prompt: `Use ${mentionMarker("e/a b.csv")} twice: ${mentionMarker("e/a b.csv")}; not @file(d/a b.csv)`,
      mentions: ["e/a b.csv", "z.csv"],
    });
  });

  it("leaves a schedule alone when nothing moved, the new path can't be mentioned, or the prompt would grow too long", () => {
    expect(retargetMentions({ prompt: "p", mentions: ["x"] }, "a", "b")).toBeUndefined();
    expect(retargetMentions({ prompt: "p", mentions: ["a"] }, "a", ".kobe/a")).toBeUndefined();
    const long = `${"x".repeat(9_990)}${mentionMarker("a")}`;
    expect(
      retargetMentions({ prompt: long, mentions: ["a"] }, "a", "b".repeat(100)),
    ).toBeUndefined();
  });
});
