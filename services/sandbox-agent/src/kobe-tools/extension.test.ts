import { duplexPair } from "node:stream";
import { describe, expect, it } from "vitest";
import { connectTools, registerKobeTools } from "./extension.js";
import type { ToolDefinitionLike } from "./tools.js";

describe("connectTools", () => {
  it("takes the fd from the environment once and removes it", () => {
    const [ours] = duplexPair();
    const opened: number[] = [];
    const env: Record<string, string | undefined> = { KOBE_TOOLS_FD: "4" };
    const transport = connectTools({ env, openChannel: (fd) => (opened.push(fd), ours) });
    expect(transport).toBeDefined();
    expect(opened).toEqual([4]);
    expect(env.KOBE_TOOLS_FD).toBeUndefined();
    ours.destroy();
  });

  it("is absent without the variable (an agent without the capability): nothing to register", () => {
    expect(
      connectTools({
        env: {},
        openChannel: () => {
          throw new Error("no");
        },
      }),
    ).toBeUndefined();
  });

  it.each(["abc", "3", "-1", "99999", "4 "])("refuses a bad fd (%s) with a warning", (fd) => {
    const warnings: string[] = [];
    expect(
      connectTools({ env: { KOBE_TOOLS_FD: fd }, warn: (m) => warnings.push(m) }),
    ).toBeUndefined();
    expect(warnings[0]).toMatch(/invalid KOBE_TOOLS_FD/);
  });

  it("registers no tool when the fd cannot be opened", () => {
    const warnings: string[] = [];
    const transport = connectTools({
      env: { KOBE_TOOLS_FD: "4" },
      openChannel: () => {
        throw new Error("not a socket");
      },
      warn: (m) => warnings.push(m),
    });
    expect(transport).toBeUndefined();
    expect(warnings[0]).toMatch(/not a socket/);
  });
});

describe("registerKobeTools", () => {
  it("registers both artifact tools with Pi", () => {
    const [ours] = duplexPair();
    const transport = connectTools({ env: { KOBE_TOOLS_FD: "4" }, openChannel: () => ours });
    const names: string[] = [];
    registerKobeTools({ registerTool: (t: ToolDefinitionLike) => names.push(t.name) }, transport);
    expect(names).toEqual(["create_artifact", "update_artifact"]);
    ours.destroy();
  });

  it("registers nothing without a transport", () => {
    const names: string[] = [];
    registerKobeTools({ registerTool: (t: ToolDefinitionLike) => names.push(t.name) }, undefined);
    expect(names).toEqual([]);
  });
});
