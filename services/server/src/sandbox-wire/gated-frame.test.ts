import type { SandboxToServerFrame } from "@kobe/protocol";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  GatePassed,
  isToolFrame,
  runGatedToolFrame,
  type GateRefusal,
  type RunCheck,
  type ToolFrameGate,
  type ToolFrameSpec,
  type ToolFrameSpecs,
  type ToolFrameType,
} from "./gated-frame.js";

type Frame = Extract<SandboxToServerFrame, { type: "file.open" }>;

const frame: Frame = {
  v: 1,
  type: "file.open",
  request_id: "r1",
  run_id: "11111111-1111-4111-8111-111111111111",
  thread_id: "22222222-2222-4222-8222-222222222222",
  tool_call_id: "c1",
  tool: "open_file",
  input: { path: "a.md" },
};

function gate(over: { caps?: string[]; run?: RunCheck; verdict?: string; max?: number } = {}) {
  const calls: string[] = [];
  const g: ToolFrameGate = {
    hasCapability: (name) => (over.caps ?? ["file_edits"]).includes(name),
    checkToolRun: (_r, _t, type) => {
      calls.push(`run:${type}`);
      return over.run ?? "ok";
    },
    allowance: {
      check: (_r, _c, tool) => {
        calls.push(`check:${tool}`);
        return (over.verdict ?? "ok") as "ok";
      },
      consume: (_r, _c, tool) => {
        calls.push(`consume:${tool}`);
        return (over.verdict ?? "ok") as "ok";
      },
    },
    maxInFlight: over.max ?? 4,
  };
  return { g, calls };
}

function spec(over: Partial<ToolFrameSpec<Frame, "consume">> = {}) {
  const refusals: GateRefusal<"consume">[] = [];
  const acted: GatePassed[] = [];
  const s: ToolFrameSpec<Frame, "consume"> = {
    capabilities: ["file_edits"],
    allowance: "consume",
    refuse: (_f, r) => refusals.push(r),
    act: (_f, passed) => {
      acted.push(passed);
    },
    ...over,
  };
  return { s, refusals, acted };
}

describe("runGatedToolFrame (KOBE-706)", () => {
  it("runs capability, run check and allowance in order, then the action with a proof", () => {
    const { g, calls } = gate();
    const { s, refusals, acted } = spec();
    runGatedToolFrame(g, s, frame);
    expect(calls).toEqual(["run:file.open", "consume:open_file"]);
    expect(refusals).toEqual([]);
    expect(acted).toHaveLength(1);
    expect(acted[0]).toBeInstanceOf(GatePassed);
  });

  it("refuses a missing capability (or extra requirement) before anything else", () => {
    for (const [caps, alsoRequires] of [
      [[], undefined],
      [["file_edits"], () => false],
    ] as const) {
      const { g, calls } = gate({ caps: [...caps] });
      const { s, refusals, acted } = spec(alsoRequires ? { alsoRequires } : {});
      runGatedToolFrame(g, s, frame);
      expect(refusals).toEqual([{ stage: "capability" }]);
      expect(calls).toEqual([]);
      expect(acted).toEqual([]);
    }
  });

  it("needs every listed capability", () => {
    const { g } = gate({ caps: ["memory"] });
    const { s, refusals } = spec({ capabilities: ["memory", "semantic_memory"] });
    runGatedToolFrame(g, s, frame);
    expect(refusals).toEqual([{ stage: "capability" }]);
  });

  it("stops at a kind's own check before the run", () => {
    const { g, calls } = gate();
    const { s, refusals, acted } = spec({ beforeRun: () => true });
    runGatedToolFrame(g, s, frame);
    expect(calls).toEqual([]);
    expect(refusals).toEqual([]);
    expect(acted).toEqual([]);
  });

  it("answers nothing for a lease violation and refuses an ended run once", () => {
    const v = gate({ run: "violation" });
    const sv = spec();
    runGatedToolFrame(v.g, sv.s, frame);
    expect(sv.refusals).toEqual([]);
    expect(v.calls).toEqual(["run:file.open"]);

    const e = gate({ run: "ended" });
    const se = spec();
    runGatedToolFrame(e.g, se.s, frame);
    expect(se.refusals).toEqual([{ stage: "ended" }]);
    expect(e.calls).toEqual(["run:file.open"]);
    expect(se.acted).toEqual([]);
  });

  it.each(["not_allowed", "input_mismatch", "replayed"])("refuses verdict %s", (verdict) => {
    const { g } = gate({ verdict });
    const { s, refusals, acted } = spec();
    runGatedToolFrame(g, s, frame);
    expect(refusals).toEqual([{ stage: "verdict", verdict }]);
    expect(acted).toEqual([]);
  });

  it("checks (not consumes) for `check` kinds, with the declared tool name", () => {
    const { g, calls } = gate();
    const s: ToolFrameSpec<Frame, "check"> = {
      capabilities: ["file_edits"],
      allowance: "check",
      tool: "recall",
      refuse: () => undefined,
      act: () => undefined,
    };
    runGatedToolFrame(g, s, frame);
    expect(calls).toEqual(["run:file.open", "check:recall"]);
  });

  it("refuses a frame naming no tool when the spec names none either, asking nothing", () => {
    type Read = Extract<SandboxToServerFrame, { type: "memory.read" }>;
    const read: Read = {
      v: 1,
      type: "memory.read",
      request_id: "r1",
      run_id: frame.run_id,
      thread_id: frame.thread_id,
      tool_call_id: "c1",
      input: { query: "tea" },
    };
    const { g, calls } = gate();
    const refusals: GateRefusal<"check">[] = [];
    const act = vi.fn();
    const s: ToolFrameSpec<Read, "check"> = {
      capabilities: ["file_edits"],
      allowance: "check",
      refuse: (_f, r) => refusals.push(r),
      act,
    };
    runGatedToolFrame(g, s, read);
    expect(refusals).toEqual([{ stage: "verdict", verdict: "not_allowed" }]);
    expect(calls).toEqual(["run:memory.read"]);
    expect(act).not.toHaveBeenCalled();
  });

  it("stops at a kind's check after the allowance (no slot taken)", () => {
    const { g } = gate({ max: 1 });
    const inFlight = { count: 0 };
    const { s, acted } = spec({ afterAllowance: () => true, inFlight });
    runGatedToolFrame(g, s, frame);
    expect(acted).toEqual([]);
    expect(inFlight.count).toBe(0);
  });

  it("refuses past the in-flight cap and frees the slot when the action settles", async () => {
    const { g } = gate({ max: 1 });
    const inFlight = { count: 0 };
    let finish: () => void = () => undefined;
    const act = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { s, refusals } = spec({ inFlight, act });
    runGatedToolFrame(g, s, frame);
    expect(inFlight.count).toBe(1);
    runGatedToolFrame(g, s, frame);
    expect(refusals).toEqual([{ stage: "busy" }]);
    expect(act).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((r) => setImmediate(r));
    expect(inFlight.count).toBe(0);
    runGatedToolFrame(g, s, frame);
    expect(act).toHaveBeenCalledTimes(2);
  });

  it("lets a synchronous throw of the action propagate (as before the gate existed)", () => {
    const { g } = gate();
    const { s, refusals } = spec({
      act: () => {
        throw new Error("boom");
      },
    });
    expect(() => runGatedToolFrame(g, s, frame)).toThrow("boom");
    expect(refusals).toEqual([]);
  });

  it("classifies tool frames by the spec map's own keys", () => {
    const specs = { "file.open": spec().s } as unknown as ToolFrameSpecs;
    expect(isToolFrame(frame, specs)).toBe(true);
    expect(isToolFrame({ v: 1, type: "ping", nonce: "n" }, specs)).toBe(false);
  });
});

describe("tool frame types (KOBE-706)", () => {
  it("guard exactly the frames a tool sends after its policy check", () => {
    expectTypeOf<ToolFrameType>().toEqualTypeOf<
      | "artifact.put"
      | "file.share"
      | "memory.put"
      | "memory.read"
      | "memory.show"
      | "project.commit"
      | "file.edit_propose"
      | "file.open"
      | "notebook.run"
      | "skill.draft_save"
    >();
  });

  it("make a gate proof only inside the gate", () => {
    // @ts-expect-error the constructor is private: only runGatedToolFrame makes a GatePassed
    expect(() => new GatePassed()).not.toThrow();
    // @ts-expect-error a look-alike object is not a GatePassed (private field)
    const forged: GatePassed = { passed: true };
    expect(forged).toBeDefined();
  });
});
