import { describe, expect, it } from "vitest";
import { ALLOWED_MAX, AllowedArtifactCalls, inputHash } from "./allowed.js";

const input = { kind: "markdown", title: "T", content: "x" };

describe("AllowedArtifactCalls (D-3)", () => {
  it("accepts only the recorded tool, run, call id and canonical input", () => {
    const calls = new AllowedArtifactCalls();
    calls.record("run", "call", "create_artifact", input);
    expect(calls.check("run", "call", "create_artifact", input)).toBe("ok");
    // Key order is irrelevant (canonical JSON); values are not.
    expect(
      calls.check("run", "call", "create_artifact", { content: "x", title: "T", kind: "markdown" }),
    ).toBe("ok");
    expect(calls.check("run", "call", "create_artifact", { ...input, content: "y" })).toBe(
      "input_mismatch",
    );
    expect(calls.check("run", "call", "update_artifact", input)).toBe("not_allowed");
    expect(calls.check("run", "other", "create_artifact", input)).toBe("not_allowed");
    expect(calls.check("run2", "call", "create_artifact", input)).toBe("not_allowed");
  });

  it("keeps the first allowed input of a call, ignores other tools and uncanonical input", () => {
    const calls = new AllowedArtifactCalls();
    calls.record("run", "call", "create_artifact", input);
    calls.record("run", "call", "create_artifact", { ...input, content: "y" });
    expect(calls.check("run", "call", "create_artifact", input)).toBe("ok");
    calls.record("run", "bash-call", "bash", { command: "ls" });
    expect(calls.check("run", "bash-call", "bash", { command: "ls" })).toBe("not_allowed");
    calls.record("run", "bad", "create_artifact", { n: Number.NaN });
    expect(calls.check("run", "bad", "create_artifact", { n: Number.NaN })).toBe("not_allowed");
    expect(inputHash({ n: Number.NaN })).toBeUndefined();
  });

  it("is bounded: the oldest entry is evicted and then fails closed", () => {
    const calls = new AllowedArtifactCalls();
    for (let i = 0; i <= ALLOWED_MAX; i++) calls.record("run", `c${i}`, "create_artifact", input);
    expect(calls.check("run", "c0", "create_artifact", input)).toBe("not_allowed");
    expect(calls.check("run", `c${ALLOWED_MAX}`, "create_artifact", input)).toBe("ok");
  });

  it("consume() makes an allowance single use; check() stays reusable", () => {
    const calls = new AllowedArtifactCalls();
    const input = { query: " a b " };
    calls.record("r", "c1", "recall", input);
    expect(calls.consume("r", "c1", "recall", { query: "other" })).toBe("input_mismatch");
    expect(calls.consume("r", "c1", "recall", input)).toBe("ok");
    expect(calls.consume("r", "c1", "recall", input)).toBe("replayed");
    expect(calls.consume("r", "never", "recall", input)).toBe("not_allowed");
    calls.record("r", "c2", "share_file", { path: "a" });
    expect(calls.check("r", "c2", "share_file", { path: "a" })).toBe("ok");
    expect(calls.check("r", "c2", "share_file", { path: "a" })).toBe("ok");
  });
});

describe("ruleAllowed (KOBE-579, commit_project)", () => {
  const commit = { message: "m" };

  it("is true only for a call recorded with the rule mark", () => {
    const calls = new AllowedArtifactCalls();
    calls.record("run", "rule", "commit_project", commit, { ruleAllowed: true });
    calls.record("run", "deferred", "commit_project", commit, { ruleAllowed: false });
    calls.record("run", "plain", "commit_project", commit);
    expect(calls.ruleAllowed("run", "rule")).toBe(true);
    expect(calls.ruleAllowed("run", "deferred")).toBe(false);
    expect(calls.ruleAllowed("run", "plain")).toBe(false);
    expect(calls.ruleAllowed("run", "unknown")).toBe(false);
  });

  it("fails closed once the entry is evicted from the capped set", () => {
    const calls = new AllowedArtifactCalls();
    calls.record("run", "first", "commit_project", commit, { ruleAllowed: true });
    for (let i = 0; i < ALLOWED_MAX; i++) {
      calls.record("run", `c${i}`, "commit_project", commit, { ruleAllowed: true });
    }
    expect(calls.ruleAllowed("run", "first")).toBe(false);
    expect(calls.check("run", "first", "commit_project", commit)).toBe("not_allowed");
  });
});
