import {
  EVAL_OUTPUT_READ_MAX_BYTES,
  EVAL_READ_MAX_FILES,
  EVAL_READ_MAX_TOTAL_BYTES,
  type EvalReadResult,
  type EvalWorkspaceEntry,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import type { CommandOutcome, SandboxTarget } from "../../sandbox-wire/types.js";
import { judgeOutputs } from "./judge-outputs.js";

/**
 * KOBE-326 review M2: the server's re-check of what an eval sandbox returns for `eval.read`
 * (untrusted): a reply that isn't the request's files in order fails the read as a whole (the
 * judge then fails `judge_failed`); bytes past a cap, refused and skipped files reach the judge
 * as unread; binary stays binary.
 */
const TARGET: SandboxTarget = { teamId: "t", userId: "u", evalThreadId: "e" };
const THREAD = "11111111-1111-4111-8111-111111111111";
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const file = (path: string, size: number): EvalWorkspaceEntry => ({ path, type: "file", size });
const read = (path: string, data: string | Buffer, truncated = false) => ({
  path,
  status: "read" as const,
  data: b64(data),
  truncated,
});

/** A router answering `eval.read` with `reply` for the files it was asked about. */
function router(
  reply: (asked: readonly { path: string; size: number }[]) => CommandOutcome,
  seen: { path: string; size: number }[][] = [],
) {
  return {
    evalRead: async (
      _t: SandboxTarget,
      r: { threadId: string; files: readonly { path: string; size: number }[] },
    ) => {
      seen.push([...r.files]);
      return reply(r.files);
    },
  };
}
const ok = (files: EvalReadResult["files"]): CommandOutcome => ({ ok: true, data: { files } });

describe("judgeOutputs (KOBE-326)", () => {
  it("shows text files as text, binary as binary, refused and skipped as unread", async () => {
    const files = [file("a.txt", 2), file("b.bin", 3), file("c.txt", 1), file("d.txt", 1)];
    const out = await judgeOutputs(
      router(() =>
        ok([
          read("a.txt", "hi"),
          read("b.bin", Buffer.from([0, 1, 2])),
          { path: "c.txt", status: "refused", reason: "link" },
          { path: "d.txt", status: "skipped" },
        ]),
      ),
      TARGET,
      THREAD,
      files,
    );
    expect(out).toEqual([
      { path: "a.txt", size: 2, text: "hi" },
      { path: "b.bin", size: 3, text: null },
      { path: "c.txt", size: 1, text: null, unread: true },
      { path: "d.txt", size: 1, text: null, unread: true },
    ]);
  });

  it("treats invalid UTF-8 as binary", async () => {
    const out = await judgeOutputs(
      router(() => ok([read("a", Buffer.from([0xff, 0xfe]))])),
      TARGET,
      THREAD,
      [file("a", 2)],
    );
    expect(out).toEqual([{ path: "a", size: 2, text: null }]);
  });

  it("fails the read as a whole for a reordered, short or long reply, or a failed command", async () => {
    const files = [file("a", 1), file("b", 1)];
    for (const reply of [
      ok([read("b", "x"), read("a", "x")]),
      ok([read("a", "x")]),
      ok([read("a", "x"), read("b", "x"), read("c", "x")]),
      ok([read("a", "x"), read("/etc/passwd", "x")]),
      { ok: true as const, data: { files: "nope" } },
      { ok: false as const, error: { code: "timeout", message: "late" } },
    ])
      expect(
        await judgeOutputs(
          router(() => reply),
          TARGET,
          THREAD,
          files,
        ),
      ).toBeNull();
  });

  it("marks as unread bytes past the file's size or the per-file cap", async () => {
    const big = EVAL_OUTPUT_READ_MAX_BYTES + 10;
    const out = await judgeOutputs(
      router(() =>
        ok([
          read("a", "longer than three"),
          read("b", "x".repeat(EVAL_OUTPUT_READ_MAX_BYTES), true),
        ]),
      ),
      TARGET,
      THREAD,
      [file("a", 3), file("b", big)],
    );
    expect(out?.[0]).toEqual({ path: "a", size: 3, text: null, unread: true });
    expect(out?.[1]?.text).toHaveLength(EVAL_OUTPUT_READ_MAX_BYTES);
  });

  it("refuses a reply past the read's total (review L5)", async () => {
    const n = EVAL_READ_MAX_TOTAL_BYTES / EVAL_OUTPUT_READ_MAX_BYTES + 1;
    const files = Array.from({ length: n }, (_, i) => file(`f${i}`, EVAL_OUTPUT_READ_MAX_BYTES));
    const full = "x".repeat(EVAL_OUTPUT_READ_MAX_BYTES);
    const out = await judgeOutputs(
      router((asked) => ok(asked.map((a) => read(a.path, full)))),
      TARGET,
      THREAD,
      files,
    );
    expect(out).toBeNull();
  });

  it("asks for the first 100 files only; the rest reach the judge as unread", async () => {
    const files = Array.from({ length: EVAL_READ_MAX_FILES + 5 }, (_, i) => file(`f${i}`, 1));
    const seen: { path: string; size: number }[][] = [];
    const out = await judgeOutputs(
      router((asked) => ok(asked.map((a) => read(a.path, "x"))), seen),
      TARGET,
      THREAD,
      files,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(EVAL_READ_MAX_FILES);
    expect(seen[0]?.[0]).toEqual({ path: "f0", size: 1 });
    expect(out).toHaveLength(EVAL_READ_MAX_FILES + 5);
    expect(out?.[EVAL_READ_MAX_FILES - 1]).toEqual({ path: "f99", size: 1, text: "x" });
    expect(out?.slice(EVAL_READ_MAX_FILES).every((o) => o.unread === true)).toBe(true);
  });

  it("sends no command when nothing matched", async () => {
    const seen: { path: string; size: number }[][] = [];
    expect(
      await judgeOutputs(
        router(() => ok([]), seen),
        TARGET,
        THREAD,
        [],
      ),
    ).toEqual([]);
    expect(seen).toEqual([]);
  });
});
