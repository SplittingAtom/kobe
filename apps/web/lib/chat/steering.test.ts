import { describe, expect, it } from "vitest";
import { newLiveRun, type LiveRun, type ToolActivity } from "./live";
import {
  formatElapsed,
  moveItem,
  phaseText,
  queuedMessages,
  runPhase,
  runStartedAt,
  steeringMode,
} from "./steering";
import { initialThreadState, type ThreadState } from "./thread-state";

const T = "00000000-0000-4000-8000-000000000001";
const R = "00000000-0000-4000-8000-000000000002";

function tool(over: Partial<ToolActivity>): ToolActivity {
  return { egressBlocked: [], artifacts: [], files: [], ...over };
}

function running(live: Partial<LiveRun> = {}, over: Partial<ThreadState> = {}): ThreadState {
  return {
    ...initialThreadState(T),
    phase: "ready",
    runs: [{ runId: R, threadId: T, status: "running", trigger: "user" }],
    live: { ...newLiveRun(R), started: true, ...live },
    ...over,
  };
}

const call = (name: string) =>
  ({ tool_call_id: "c", tool: name, input: {}, risk: "read" }) as ToolActivity["call"];

describe("runPhase and steeringMode", () => {
  it("is idle with nothing running, queued or interrupted", () => {
    const state = { ...initialThreadState(T), phase: "ready" as const };
    expect(runPhase(state, false)).toBeUndefined();
    expect(steeringMode(state, undefined)).toBe("idle");
  });

  it("waking, thinking, running a tool, then thinking again", () => {
    expect(runPhase(running({ waking: "first_start" }), false)).toEqual({
      kind: "waking",
      reason: "first_start",
    });
    expect(runPhase(running(), false)).toEqual({ kind: "thinking" });
    const busy = running({ tools: { a: tool({ call: call("bash") }) } });
    expect(runPhase(busy, false)).toEqual({ kind: "tool", tool: "bash" });
    expect(steeringMode(busy, runPhase(busy, false))).toBe("active");
    const done = running({
      tools: { a: tool({ call: call("bash"), result: {} as ToolActivity["result"] }) },
    });
    expect(runPhase(done, false)).toEqual({ kind: "thinking" });
  });

  it("waits for approval (event or run status) before anything else", () => {
    const asked = running({
      tools: { a: tool({ call: call("w"), approvalRequested: {} as never }) },
    });
    const phase = runPhase(asked, true);
    expect(phase).toEqual({ kind: "approval" });
    expect(steeringMode(asked, phase)).toBe("waiting");
    const byStatus = running(
      {},
      { runs: [{ runId: R, threadId: T, status: "waiting_approval", trigger: "user" }] },
    );
    expect(runPhase(byStatus, false)).toEqual({ kind: "approval" });
  });

  it("finishing on budget wins over tools and thinking", () => {
    const busy = running({ tools: { a: tool({ call: call("bash") }) } });
    expect(runPhase(busy, true)).toEqual({ kind: "budget" });
    expect(phaseText({ kind: "budget" })).toBe("Finishing on budget");
  });

  it("queued without a run; interrupted over everything", () => {
    const queued: ThreadState = {
      ...initialThreadState(T),
      pending: [
        { runId: "b", status: "queued", queuePos: 2, content: "B", parentEntryId: null },
        { runId: "a", status: "queued", queuePos: 1, content: "A", parentEntryId: null },
      ],
    };
    expect(steeringMode(queued, undefined)).toBe("queued");
    expect(queuedMessages(queued).map((m) => m.content)).toEqual(["A", "B"]);
    const lost = { ...queued, summary: { status: "interrupted" } as ThreadState["summary"] };
    expect(steeringMode(lost, undefined)).toBe("interrupted");
  });

  it("starts from the stream's run.started, else the server's snapshot", () => {
    expect(runStartedAt(running({ startedAt: "2026-10-13T10:00:00Z" }))).toBe(
      "2026-10-13T10:00:00Z",
    );
    const snap = running(
      {},
      {
        runs: [
          {
            runId: R,
            threadId: T,
            status: "running",
            trigger: "user",
            startedAt: "2026-10-13T09:00:00Z",
          },
        ],
      },
    );
    expect(runStartedAt(snap)).toBe("2026-10-13T09:00:00Z");
  });
});

describe("helpers", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(725_000)).toBe("12:05");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("moves an item, clamped, without touching the input", () => {
    const ids = ["a", "b", "c"] as const;
    expect(moveItem(ids, 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(ids, 0, 9)).toEqual(["b", "c", "a"]);
    expect(moveItem(ids, 1, 1)).toBe(ids);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
