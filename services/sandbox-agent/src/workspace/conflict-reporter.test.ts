import { describe, expect, it } from "vitest";
import type { WorkspaceConflictFrame } from "@kobe/protocol";
import { CONFLICT_QUEUE_MAX, ConflictReporter } from "./conflict-reporter.js";

const report = (n: number) => ({
  path: `f${n}.md`,
  conflict_path: `f${n}.conflict-20261023T120000Z.md`,
  member_sha256: "a".repeat(64),
  agent_sha256: "b".repeat(64),
  at: new Date("2026-10-23T12:00:00Z"),
});

describe("ConflictReporter (KOBE-492)", () => {
  it("sends a workspace.conflict frame with names and hashes only", () => {
    const sent: WorkspaceConflictFrame[] = [];
    const r = new ConflictReporter({ ready: () => true, send: (f) => sent.push(f) > 0 });
    r.report(report(1));
    expect(sent).toEqual([
      {
        v: 1,
        type: "workspace.conflict",
        path: "f1.md",
        conflict_path: "f1.conflict-20261023T120000Z.md",
        member_sha256: "a".repeat(64),
        agent_sha256: "b".repeat(64),
        at: "2026-10-23T12:00:00.000Z",
      },
    ]);
  });

  it("queues while the wire is down (bounded) and flushes oldest first", () => {
    const sent: WorkspaceConflictFrame[] = [];
    let ready = false;
    const r = new ConflictReporter({ ready: () => ready, send: (f) => ready && sent.push(f) > 0 });
    for (let n = 0; n < CONFLICT_QUEUE_MAX + 3; n += 1) r.report(report(n));
    expect(sent).toEqual([]);
    expect(r.pending).toBe(CONFLICT_QUEUE_MAX);
    ready = true;
    r.flush();
    expect(sent.map((f) => f.path)[0]).toBe("f3.md");
    expect(sent).toHaveLength(CONFLICT_QUEUE_MAX);
    expect(r.pending).toBe(0);
  });
});
