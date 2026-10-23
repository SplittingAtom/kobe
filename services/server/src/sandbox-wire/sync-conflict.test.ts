import type { KobeDb } from "@kobe/db";
import type { WorkspaceConflictFrame } from "@kobe/protocol";
import { describe, expect, it, vi } from "vitest";
import { ConflictRate, checkConflict, onWorkspaceConflict } from "./sync-conflict.js";

const frame = (over: Partial<WorkspaceConflictFrame> = {}): WorkspaceConflictFrame => ({
  v: 1,
  type: "workspace.conflict",
  path: "docs/notes.md",
  conflict_path: "docs/notes.conflict-20261023T120000Z.md",
  member_sha256: "a".repeat(64),
  agent_sha256: "b".repeat(64),
  at: "2026-10-23T12:00:00.000Z",
  ...over,
});

describe("workspace.conflict checks (KOBE-492)", () => {
  it("takes a conflict copy beside its file", () => {
    expect(checkConflict(frame())).toEqual({
      path: "docs/notes.md",
      conflict_path: "docs/notes.conflict-20261023T120000Z.md",
      member_sha256: "a".repeat(64),
      agent_sha256: "b".repeat(64),
    });
  });

  it.each([
    ["traversal", { path: "../etc/passwd" }],
    ["absolute", { path: "/workspace/docs/notes.md" }],
    ["backslash", { path: "docs\\notes.md" }],
    ["bidi spoof", { conflict_path: "docs/notes.conflict-20261023T120000Z‮.md" }],
    ["not a copy", { conflict_path: "docs/other.md" }],
    ["other folder", { conflict_path: "elsewhere/notes.conflict-20261023T120000Z.md" }],
    ["bad hash", { member_sha256: "zz" }],
    ["oversize", { path: `${"a/".repeat(600)}x` }],
  ])("drops a hostile frame: %s", (_name, over) => {
    expect(checkConflict(frame(over))).toBe("invalid");
  });

  it("drops agent-internal and read-only paths", () => {
    expect(
      checkConflict(
        frame({
          path: ".kobe/state.json",
          conflict_path: ".kobe/state.conflict-20261023T120000Z.json",
        }),
      ),
    ).toBe("internal_path");
    expect(
      checkConflict(
        frame({
          path: "uploads/t/a.csv",
          conflict_path: "uploads/t/a.conflict-20261023T120000Z.csv",
        }),
      ),
    ).toBe("read_only");
  });

  it("rate-limits per connection and refills over time", () => {
    let now = 0;
    const rate = new ConflictRate(3, 6, () => now);
    expect([rate.admit(), rate.admit(), rate.admit(), rate.admit()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now += 10_000; // 6 per minute: one token per 10 s
    expect(rate.admit()).toBe(true);
    expect(rate.admit()).toBe(false);
  });

  it("drops without capability, from an eval sandbox or over the rate, and never sends", () => {
    const send = vi.fn();
    const warn = vi.fn();
    const base = {
      db: {} as KobeDb,
      target: { teamId: "t", userId: "u" },
      log: { warn, error: vi.fn(), info: vi.fn() },
      hasCapability: true,
      rate: new ConflictRate(1, 1, () => 0),
      activeRun: () => undefined,
      send,
    };
    onWorkspaceConflict({ ...base, hasCapability: false }, frame());
    onWorkspaceConflict({ ...base, target: { ...base.target, evalThreadId: "e" } }, frame());
    onWorkspaceConflict(base, frame({ path: "../x" })); // takes the one token, then invalid
    onWorkspaceConflict(base, frame());
    expect(warn.mock.calls.map((c) => (c[0] as { reason: string }).reason)).toEqual([
      "capability_missing",
      "eval_sandbox",
      "invalid",
      "rate",
    ]);
    expect(send).not.toHaveBeenCalled();
  });
});
