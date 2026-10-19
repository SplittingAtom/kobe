import { describe, expect, it } from "vitest";
import { evalSnapshotFrameSchema } from "./eval-frames.js";

describe("eval.snapshot roots (KOBE-325 review L3)", () => {
  const frame = (roots: string[]) => ({
    v: 1,
    type: "eval.snapshot",
    command_id: "c1",
    thread_id: "11111111-1111-4111-8111-111111111111",
    roots,
    hash_paths: [],
  });
  it("takes workspace directories and the whole workspace", () => {
    expect(evalSnapshotFrameSchema.safeParse(frame(["", "outputs/", "a/b/"])).success).toBe(true);
  });
  it("refuses anything that leaves /workspace or is not a directory", () => {
    for (const bad of ["/etc/", "../x/", "outputs", "a//b/", "./"])
      expect(evalSnapshotFrameSchema.safeParse(frame([bad])).success, bad).toBe(false);
  });
});
