import { describe, expect, it } from "vitest";
import type { PolicyDecision } from "@kobe/protocol";
import { distinctSiblings, mapLimited } from "./fan-out.js";
import type { ActiveRunContext } from "./run-context.js";

const run = (id: string, extra: Partial<ActiveRunContext> = {}): ActiveRunContext => ({
  runId: id,
  threadId: id,
  trigger: "user",
  agentId: null,
  agentVersion: null,
  mode: "ask-on-write",
  toolsAllow: [],
  toolsDeny: [],
  ...extra,
});

describe("distinctSiblings", () => {
  it("keeps one run per policy context other than the named run's", () => {
    const named = run("a");
    const runs = [
      named,
      run("b"),
      run("c", { mode: "auto" }),
      run("d", { mode: "auto" }),
      run("e", { toolsAllow: ["x", "y"] }),
      run("f", { toolsAllow: ["y", "x"] }),
      run("g", { trigger: "schedule", mode: "auto" }),
    ];
    expect(distinctSiblings(named, runs).map((r) => r.runId)).toEqual(["c", "e", "g"]);
  });
});

describe("mapLimited", () => {
  it("never runs more than the limit at once and keeps order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {
        effect: "allow",
        risk: "read",
        reasons: [{ code: "risk_read", stage: "risk_class", message: String(n) }],
      } as PolicyDecision;
    });
    expect(peak).toBe(3);
    expect(out.map((d) => d.reasons[0]?.message)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });
});
