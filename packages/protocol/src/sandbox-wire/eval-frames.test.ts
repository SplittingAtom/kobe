import { describe, expect, it } from "vitest";
import { EVAL_OUTPUT_READ_MAX_BYTES } from "../skill-evals/outputs.js";
import {
  EVAL_READ_MAX_FILES,
  evalReadFrameSchema,
  evalReadResultSchema,
  evalSnapshotFrameSchema,
} from "./eval-frames.js";

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

describe("eval.read (KOBE-326)", () => {
  const frame = (files: unknown[]) => ({
    v: 1,
    type: "eval.read",
    command_id: "c1",
    thread_id: "11111111-1111-4111-8111-111111111111",
    files,
  });
  it("names workspace paths and walked sizes only", () => {
    expect(evalReadFrameSchema.safeParse(frame([{ path: "outputs/a.txt", size: 3 }])).success).toBe(
      true,
    );
    // Nothing else rides along: no rubric, nonce or message text reaches the sandbox.
    expect(
      evalReadFrameSchema.safeParse(frame([{ path: "outputs/a.txt", size: 3, rubric: "x" }]))
        .success,
    ).toBe(false);
    expect(
      evalReadFrameSchema.safeParse({ ...frame([{ path: "a", size: 1 }]), nonce: "n" }).success,
    ).toBe(false);
    for (const bad of ["/etc/passwd", "../x", "a//b", "./a"])
      expect(evalReadFrameSchema.safeParse(frame([{ path: bad, size: 1 }])).success, bad).toBe(
        false,
      );
    expect(evalReadFrameSchema.safeParse(frame([])).success).toBe(false);
    const many = Array.from({ length: EVAL_READ_MAX_FILES + 1 }, (_, i) => ({
      path: `f${i}`,
      size: 1,
    }));
    expect(evalReadFrameSchema.safeParse(frame(many)).success).toBe(false);
  });
  it("bounds what comes back: base64 of at most the read cap per file", () => {
    const ok = (files: unknown[]) => evalReadResultSchema.safeParse({ files }).success;
    expect(ok([{ path: "a", status: "read", data: "aGk=", truncated: false }])).toBe(true);
    expect(ok([{ path: "a", status: "refused", reason: "link" }])).toBe(true);
    expect(ok([{ path: "a", status: "skipped" }])).toBe(true);
    expect(ok([{ path: "a", status: "refused", reason: "other" }])).toBe(false);
    const big = "A".repeat((Math.ceil(EVAL_OUTPUT_READ_MAX_BYTES / 3) + 1) * 4);
    expect(ok([{ path: "a", status: "read", data: big, truncated: true }])).toBe(false);
    expect(ok([{ path: "a", status: "read", data: "not base64!", truncated: false }])).toBe(false);
  });
});
