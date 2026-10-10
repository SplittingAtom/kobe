import { describe, expect, it } from "vitest";
import { runMcpContextSchema, runStartFrameSchema, SANDBOX_WIRE_VERSION } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const server = {
  name: "git-hub",
  connector_id: ID,
  tools: [{ name: "search", pi_name: "mcp__git_hub__search" }],
};

describe("run.start mcp (KOBE-111)", () => {
  it("accepts effective servers with Kobe-normalized tool names", () => {
    expect(runMcpContextSchema.safeParse({ servers: [server] }).success).toBe(true);
    expect(runMcpContextSchema.safeParse({ servers: [] }).success).toBe(true);
  });

  it("rejects tool names that are not mcp__<server>__<tool>, and unknown keys", () => {
    const bad = { ...server, tools: [{ name: "search", pi_name: "search" }] };
    expect(runMcpContextSchema.safeParse({ servers: [bad] }).success).toBe(false);
    expect(
      runMcpContextSchema.safeParse({ servers: [{ ...server, url: "http://x" }] }).success,
    ).toBe(false);
    expect(runMcpContextSchema.safeParse({ servers: [server], token: "t" }).success).toBe(false);
  });

  it("is an optional run.start field (older servers omit it)", () => {
    const base = {
      v: SANDBOX_WIRE_VERSION,
      type: "run.start",
      command_id: ID,
      run_id: ID,
      thread_id: ID,
      message: "hi",
    };
    expect(runStartFrameSchema.safeParse(base).success).toBe(true);
    expect(runStartFrameSchema.safeParse({ ...base, mcp: { servers: [server] } }).success).toBe(
      true,
    );
  });
});
