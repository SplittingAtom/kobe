import { describe, expect, it } from "vitest";
import { APPROVAL_TTL_MS, type PolicyDecision, type ToolDescriptor } from "@kobe/protocol";
import {
  guardViewedFile,
  isViewedFileAsk,
  proposeAvailable,
  viewedFileTarget,
  type ViewedFileGuard,
} from "./viewed-file-guard.js";

const NOW = new Date("2026-10-23T10:00:00.000Z");
const pi = (name: string): ToolDescriptor => ({
  name,
  source: "pi",
  risk: "write",
  open_world: false,
  scope: "sandbox",
});
const mcp: ToolDescriptor = {
  name: "write",
  source: "mcp",
  connector_id: "00000000-0000-4000-8000-000000000001",
  risk: "write",
  open_world: true,
  scope: "external",
};

const ALLOW: PolicyDecision = {
  effect: "allow",
  risk: "write",
  reasons: [{ code: "dangerous_mode", stage: "approval_mode", message: "Dangerous." }],
};
const ASK: PolicyDecision = {
  effect: "require_approval",
  risk: "write",
  reasons: [{ code: "risk_write", stage: "risk_class", message: "write changes data" }],
  expires_at: NOW.toISOString(),
};
const DENY: PolicyDecision = {
  effect: "deny",
  risk: "write",
  reasons: [{ code: "agent_tool_deny", stage: "team_deny", message: "denied" }],
};

function guard(over: Partial<ViewedFileGuard> = {}): ViewedFileGuard {
  return {
    tool: pi("write"),
    input: { path: "notes/plan.md", content: "x" },
    viewedPath: "notes/plan.md",
    canPropose: true,
    now: NOW,
    ...over,
  };
}

describe("viewedFileTarget (KOBE-493 path normalisation)", () => {
  it.each([
    ["notes/plan.md", "notes/plan.md"],
    ["/workspace/notes/plan.md", "notes/plan.md"],
    ["./notes/plan.md", "notes/plan.md"],
    ["notes/../notes/plan.md", "notes/plan.md"],
    ["/workspace/x/../notes/./plan.md", "notes/plan.md"],
    ["notes//plan.md", "notes/plan.md"],
    ["notes/plan.md/", "notes/plan.md"],
    ["/workspace/notes/plan.md/", "notes/plan.md"],
  ])("%s -> %s", (raw, want) => {
    expect(viewedFileTarget(pi("write"), { path: raw })).toBe(want);
  });

  it("is case-sensitive and leaves other places alone", () => {
    expect(viewedFileTarget(pi("write"), { path: "Notes/Plan.md" })).toBe("Notes/Plan.md");
    expect(viewedFileTarget(pi("write"), { path: "/etc/passwd" })).toBeUndefined();
    expect(viewedFileTarget(pi("write"), { path: "/workspace" })).toBeUndefined();
    expect(viewedFileTarget(pi("write"), { path: "../outside.md" })).toBeUndefined();
    expect(viewedFileTarget(pi("write"), { path: "~/plan.md" })).toBeUndefined();
    expect(viewedFileTarget(pi("write"), { path: 7 })).toBeUndefined();
    expect(viewedFileTarget(pi("write"), "not an object")).toBeUndefined();
  });

  it("covers Pi write and edit only", () => {
    expect(viewedFileTarget(pi("edit"), { path: "a.md" })).toBe("a.md");
    for (const name of ["propose_file_edit", "open_file", "read", "bash", "run_python"]) {
      expect(viewedFileTarget(pi(name), { path: "a.md" })).toBeUndefined();
    }
    expect(viewedFileTarget(mcp, { path: "a.md" })).toBeUndefined();
  });
});

describe("guardViewedFile (KOBE-493)", () => {
  it("ac-1: with file_edits a write or edit to the viewed file is denied with an actionable error", () => {
    for (const before of [ALLOW, ASK]) {
      const out = guardViewedFile(before, guard());
      expect(out.effect).toBe("deny");
      expect(out.reasons[0]).toEqual({
        code: "viewed_file",
        stage: "site_deny",
        message:
          "The user is viewing notes/plan.md. Propose the change with propose_file_edit instead; nothing was written.",
      });
    }
    const edit = guardViewedFile(
      ALLOW,
      guard({ tool: pi("edit"), input: { path: "/workspace/notes/plan.md", edits: [] } }),
    );
    expect(edit.effect).toBe("deny");
  });

  it("ac-2: without file_edits it asks, also where the engine allowed (Dangerous, remembered)", () => {
    const fromAllow = guardViewedFile(ALLOW, guard({ canPropose: false }));
    expect(fromAllow).toEqual({
      effect: "require_approval",
      risk: "write",
      reasons: [
        {
          code: "viewed_file",
          stage: "ask_rule",
          message:
            "The user is viewing notes/plan.md; write would change it directly instead of proposing the change.",
        },
      ],
      expires_at: new Date(NOW.getTime() + APPROVAL_TTL_MS).toISOString(),
    });
    const fromAsk = guardViewedFile(ASK, guard({ canPropose: false }));
    expect(fromAsk.effect).toBe("require_approval");
    expect(fromAsk.reasons.map((r) => r.code)).toEqual(["viewed_file", "risk_write"]);
  });

  it("keeps an engine deny as it is", () => {
    expect(guardViewedFile(DENY, guard())).toBe(DENY);
    expect(guardViewedFile(DENY, guard({ canPropose: false }))).toBe(DENY);
  });

  it("ac-3: leaves other paths, other tools and runs without a viewed file alone", () => {
    expect(guardViewedFile(ALLOW, guard({ input: { path: "notes/other.md" } }))).toBe(ALLOW);
    expect(guardViewedFile(ALLOW, guard({ input: { path: "Notes/plan.md" } }))).toBe(ALLOW);
    expect(guardViewedFile(ALLOW, guard({ viewedPath: undefined }))).toBe(ALLOW);
    expect(guardViewedFile(ALLOW, guard({ tool: pi("propose_file_edit") }))).toBe(ALLOW);
    expect(guardViewedFile(ALLOW, guard({ tool: pi("open_file") }))).toBe(ALLOW);
    expect(guardViewedFile(ALLOW, guard({ tool: mcp }))).toBe(ALLOW);
  });
});

describe("isViewedFileAsk (KOBE-493: never remembered)", () => {
  it("spots the guard's reason among others", () => {
    expect(isViewedFileAsk([{ code: "risk_write" }, { code: "viewed_file" }])).toBe(true);
    expect(isViewedFileAsk([{ code: "site_ask_rule" }])).toBe(false);
  });
});

describe("proposeAvailable (KOBE-493: ask when the agent can't propose)", () => {
  const agent = (deny: string[], allow: string[] = []) => ({
    agent_id: null,
    version: null,
    tools_allow: allow,
    tools_deny: deny,
    dangerous_tools: [],
  });
  it("needs file_edits and propose_file_edit left by the agent's tool lists", () => {
    expect(proposeAvailable(agent([]), true, "a.md")).toBe(true);
    expect(proposeAvailable(agent([]), false, "a.md")).toBe(false);
    expect(proposeAvailable(agent(["propose_file_edit"]), true, "a.md")).toBe(false);
    expect(proposeAvailable(agent(["propose_*"]), true, "a.md")).toBe(false);
    expect(proposeAvailable(agent([], ["write"]), true, "a.md")).toBe(false);
    expect(proposeAvailable(agent(["bash"]), true, "a.md")).toBe(true);
  });
});
