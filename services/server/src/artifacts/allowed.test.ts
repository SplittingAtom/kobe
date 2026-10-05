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
});
