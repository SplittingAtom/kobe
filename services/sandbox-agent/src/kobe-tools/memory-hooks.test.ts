import { describe, expect, it } from "vitest";
import {
  CONFLICT_NOTE_TYPE,
  installMemoryHooks,
  registerProjectHooks,
  readMemoryRunFile,
  type MemoryHooksApi,
} from "./memory-hooks.js";

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
    expect(readMemoryRunFile(undefined)).toEqual({
      tools: false,
      text: "",
      project: "",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
    });
    expect(
      readMemoryRunFile("/x", () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({
      tools: false,
      text: "",
      project: "",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
    });
    expect(readMemoryRunFile("/x", () => "not json")).toEqual({
      tools: false,
      text: "",
      project: "",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
    });
    expect(readMemoryRunFile("/x", file({ tools: "yes", text: 1 }))).toEqual({
      tools: false,
      text: "",
      project: "",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
    });
  });
  it("gives no text when tools are off", () => {
    expect(readMemoryRunFile("/x", file({ tools: false, text: "secret" }))).toEqual({
      tools: false,
      text: "",
      project: "",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
    });
    expect(readMemoryRunFile("/x", file({ tools: true, text: "idx" }))).toEqual({
      tools: true,
      text: "idx",
      project: "",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
    });
    // Project instructions do not depend on memory being on.
    expect(readMemoryRunFile("/x", file({ tools: false, text: "", project: "P" }))).toEqual({
      tools: false,
      text: "",
      project: "P",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
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
    content = { tools: false, text: "", project: "", viewing: "" };
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

  it("adds the project block after memory, also with memory off", () => {
    const pi = fakePi([]);
    installMemoryHooks(pi.api, "/f", () =>
      JSON.stringify({ tools: true, text: "MEM", project: "PROJ" }),
    );
    expect(pi.fire("before_agent_start", { systemPrompt: "base" })).toEqual({
      systemPrompt: "base\n\nMEM\n\nPROJ",
    });
    const off = fakePi([]);
    installMemoryHooks(off.api, "/f", () =>
      JSON.stringify({ tools: false, text: "", project: "PROJ" }),
    );
    expect(off.fire("before_agent_start", { systemPrompt: "base" })).toEqual({
      systemPrompt: "base\n\nPROJ",
    });
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

describe("viewed file in the run's prompt (KOBE-462)", () => {
  it("appends the viewing section to this run's system prompt only, memory or not", () => {
    const pi = fakePi([]);
    let content: unknown = { tools: false, text: "", project: "", viewing: "## Viewed" };
    installMemoryHooks(pi.api, "/x", () => JSON.stringify(content));
    expect(pi.fire("before_agent_start", { systemPrompt: "BASE" })).toEqual({
      systemPrompt: "BASE\n\n## Viewed",
    });
    content = { tools: false, text: "", project: "" };
    expect(pi.fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
    expect(readMemoryRunFile("/x", file({ tools: false, text: "", viewing: 3 }))).toEqual({
      tools: false,
      text: "",
      project: "",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
    });
  });
});

describe("sync conflict notes (KOBE-492)", () => {
  it("adds the run-start note to this run's system prompt", () => {
    const pi = fakePi([]);
    installMemoryHooks(pi.api, "/x", () =>
      JSON.stringify({ tools: false, text: "", viewing: "## Viewed", conflicts: "## Conflicts" }),
    );
    expect(pi.fire("before_agent_start", { systemPrompt: "BASE" })).toEqual({
      systemPrompt: "BASE\n\n## Viewed\n\n## Conflicts",
    });
  });

  it("adds a mid-run note as a hidden custom message before every later model call", () => {
    const pi = fakePi([]);
    let content: unknown = { tools: false, text: "" };
    installMemoryHooks(pi.api, "/x", () => JSON.stringify(content));
    const messages = [{ role: "user", content: "hi" }];
    expect(pi.fire("context", { messages })).toBeUndefined();
    content = { tools: false, text: "", conflicts_live: "## Conflicts live" };
    const out = pi.fire("context", { messages }) as { messages: Record<string, unknown>[] };
    expect(out.messages.slice(0, 1)).toEqual(messages);
    expect(out.messages[1]).toMatchObject({
      role: "custom",
      customType: CONFLICT_NOTE_TYPE,
      content: "## Conflicts live",
      display: false,
    });
    expect(messages).toHaveLength(1); // the transcript itself is not changed
    // Not in the system prompt: only the run-start note is.
    expect(pi.fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
  });

  it("fails closed on a malformed note field", () => {
    expect(readMemoryRunFile("/x", file({ tools: true, text: "m", conflicts_live: 1 }))).toEqual({
      tools: false,
      text: "",
      project: "",
      viewing: "",
      conflicts: "",
      conflictsLive: "",
      projectWrite: false,
    });
  });
});

describe("registerProjectHooks (KOBE-580)", () => {
  it("lists commit_project only for runs whose viewer may edit the project, re-read on every input", () => {
    let content: unknown = { tools: false, text: "", project_write: true };
    const pi = fakePi(["read", "commit_project"]);
    registerProjectHooks(pi.api, "/x", () => JSON.stringify(content));
    pi.fire("input", {});
    expect(pi.active()).toContain("commit_project");
    expect(pi.active()).toContain("read");
    content = { tools: false, text: "", project_write: false };
    pi.fire("input", {});
    expect(pi.active()).not.toContain("commit_project");
    content = { tools: false, text: "" }; // an older agent's file: no access
    pi.fire("input", {});
    expect(pi.active()).not.toContain("commit_project");
    content = { tools: false, text: "", project_write: "yes" }; // malformed: off
    pi.fire("input", {});
    expect(pi.active()).not.toContain("commit_project");
    content = { tools: false, text: "", project_write: true };
    pi.fire("input", {});
    expect(pi.active().filter((n) => n === "commit_project")).toHaveLength(1);
  });

  it("never lists it without a run file", () => {
    const pi = fakePi(["read", "commit_project"]);
    registerProjectHooks(pi.api, undefined);
    pi.fire("input", {});
    expect(pi.active()).toEqual(["read"]);
  });
});
