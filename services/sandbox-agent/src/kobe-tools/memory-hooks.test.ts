import { describe, expect, it } from "vitest";
import { installMemoryHooks, readMemoryRunFile, type MemoryHooksApi } from "./memory-hooks.js";

function fakePi(initialTools: string[]) {
  const handlers = new Map<string, (event: never) => unknown>();
  let active = [...initialTools];
  const api: MemoryHooksApi = {
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = names;
    },
  };
  const fire = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload as never);
  return { api, fire, active: () => active };
}

const file = (content: unknown) => () => JSON.stringify(content);

describe("readMemoryRunFile", () => {
  it("fails closed: missing, unreadable or malformed means off", () => {
    expect(readMemoryRunFile(undefined)).toEqual({ tools: false, text: "" });
    expect(
      readMemoryRunFile("/x", () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({ tools: false, text: "" });
    expect(readMemoryRunFile("/x", () => "not json")).toEqual({ tools: false, text: "" });
    expect(readMemoryRunFile("/x", file({ tools: "yes", text: 1 }))).toEqual({
      tools: false,
      text: "",
    });
  });
  it("gives no text when tools are off", () => {
    expect(readMemoryRunFile("/x", file({ tools: false, text: "secret" }))).toEqual({
      tools: false,
      text: "",
    });
    expect(readMemoryRunFile("/x", file({ tools: true, text: "idx" }))).toEqual({
      tools: true,
      text: "idx",
    });
  });
});

describe("installMemoryHooks", () => {
  it("lists remember/recall only for runs with memory on, re-read on every input", () => {
    let content: unknown = { tools: true, text: "" };
    const pi = fakePi(["bash", "remember", "recall"]);
    installMemoryHooks(pi.api, "/f", () => JSON.stringify(content));
    pi.fire("input");
    expect(pi.active()).toEqual(["bash", "remember", "recall"]);
    content = { tools: false, text: "" };
    pi.fire("input");
    expect(pi.active()).toEqual(["bash"]);
    content = { tools: true, text: "" };
    pi.fire("input");
    expect(pi.active()).toEqual(["bash", "remember", "recall"]);
  });

  it("adds the run's text to that run's system prompt, and nothing when empty", () => {
    let content: unknown = { tools: true, text: "## Saved memory\nidx" };
    const pi = fakePi([]);
    installMemoryHooks(pi.api, "/f", () => JSON.stringify(content));
    expect(pi.fire("before_agent_start", { systemPrompt: "base" })).toEqual({
      systemPrompt: "base\n\n## Saved memory\nidx",
    });
    content = { tools: true, text: "" };
    expect(pi.fire("before_agent_start", { systemPrompt: "base" })).toBeUndefined();
  });

  it("strips invisible characters from a remember call before kobe-policy sees it", () => {
    const pi = fakePi([]);
    installMemoryHooks(pi.api, undefined);
    const input = { content: "a​b" };
    pi.fire("tool_call", { toolName: "remember", input });
    expect(input.content).toBe("ab");
    const other = { content: "a​b" };
    pi.fire("tool_call", { toolName: "write", input: other });
    expect(other.content).toBe("a​b");
  });
});
