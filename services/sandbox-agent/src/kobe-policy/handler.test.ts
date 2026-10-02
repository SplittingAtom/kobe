import { describe, expect, it, vi } from "vitest";
import type { CheckRequest, Verdict } from "./client.js";
import { BLOCK_PREFIX, createToolCallHandler, type PolicyChecker } from "./handler.js";

function checker(answer: (request: CheckRequest) => Verdict | Promise<Verdict>) {
  const requests: CheckRequest[] = [];
  const policy: PolicyChecker = {
    check: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  return { policy, requests };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "call_1",
  input: { command: "ls" } as Record<string, unknown>,
  ...overrides,
});

describe("kobe-policy tool_call handler", () => {
  it("allows (returns nothing) only on an allow verdict", async () => {
    const { policy, requests } = checker(() => ({ allow: true }));
    const handler = createToolCallHandler(policy);
    expect(await handler(event(), {})).toBeUndefined();
    expect(requests).toEqual([
      { toolCallId: "call_1", tool: "bash", input: { command: "ls" }, signal: undefined },
    ]);
  });

  it("blocks with a policy.denied reason on deny", async () => {
    const { policy } = checker(() => ({ allow: false, reason: "Denied by team rule" }));
    const result = await createToolCallHandler(policy)(event(), {});
    expect(result).toEqual({ block: true, reason: `${BLOCK_PREFIX} Denied by team rule` });
    expect(BLOCK_PREFIX).toBe("policy.denied:");
  });

  it("passes the parent id of nested (codemode) calls and the run's abort signal", async () => {
    const { policy, requests } = checker(() => ({ allow: true }));
    const signal = new AbortController().signal;
    await createToolCallHandler(policy)(
      event({
        toolCallId: "cm1/2",
        parentToolCallId: "cm1",
        toolName: "read",
        input: { path: "a" },
      }),
      { signal },
    );
    expect(requests[0]).toMatchObject({ toolCallId: "cm1/2", parentToolCallId: "cm1", signal });
  });

  it("checks the input as it is when the handler runs (after earlier mutations)", async () => {
    const { policy, requests } = checker(() => ({ allow: true }));
    const e = event();
    e.input.command = "rm -rf /"; // an earlier handler mutated in place
    await createToolCallHandler(policy)(e, {});
    expect(requests[0]?.input).toEqual({ command: "rm -rf /" });
  });

  it("freezes the input before asking, so it cannot change afterwards", async () => {
    let release: (v: Verdict) => void = () => undefined;
    const { policy } = checker(() => new Promise<Verdict>((r) => (release = r)));
    const e = event({ input: { command: "ls", nested: { list: [1, { a: "b" }] } } });
    const pending = createToolCallHandler(policy)(e, {});
    await Promise.resolve();
    expect(Object.isFrozen(e.input)).toBe(true);
    expect(Object.isFrozen((e.input.nested as { list: unknown[] }).list[1])).toBe(true);
    expect(() => {
      "use strict";
      e.input.command = "rm -rf /";
    }).toThrow(TypeError);
    release({ allow: true });
    expect(await pending).toBeUndefined();
  });

  it("freezes all the way down even below an already frozen container", async () => {
    const { policy } = checker(() => ({ allow: true }));
    const child = { command: "ls" };
    const input = Object.freeze({ nested: child });
    await createToolCallHandler(policy)(event({ input }), {});
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("blocks when event.input was swapped for another object while waiting", async () => {
    let release: (v: Verdict) => void = () => undefined;
    const { policy } = checker(() => new Promise<Verdict>((r) => (release = r)));
    const e = event();
    const pending = createToolCallHandler(policy)(e, {});
    await Promise.resolve();
    e.input = { command: "rm -rf /" };
    release({ allow: true });
    expect(await pending).toMatchObject({ block: true, reason: expect.stringMatching(/changed/) });
  });

  it.each([
    ["a getter", () => Object.defineProperty({}, "command", { get: () => "ls", enumerable: true })],
    ["a hidden property", () => Object.defineProperty({ command: "ls" }, "timeout", { value: 1 })],
    ["a proxy", () => new Proxy({ command: "ls" }, {})],
    [
      "a class instance",
      () =>
        new (class X {
          command = "ls";
        })(),
    ],
    ["a function value", () => ({ command: () => "ls" })],
    ["undefined", () => ({ command: undefined })],
    ["NaN", () => ({ timeout: Number.NaN })],
    ["negative zero", () => ({ timeout: -0 })],
    ["a symbol key", () => ({ command: "ls", [Symbol("x")]: 1 })],
    ["an array hole", () => ({ list: [1, , 3] })], // eslint-disable-line no-sparse-arrays
    ["an array with extra properties", () => ({ list: Object.assign([1], { extra: 2 }) })],
    [
      "a shared reference",
      () => {
        const shared = { a: 1 };
        return { x: shared, y: shared };
      },
    ],
    [
      "a cycle",
      () => {
        const o: Record<string, unknown> = {};
        o.self = o;
        return o;
      },
    ],
    [
      "too deep nesting",
      () => {
        let o: Record<string, unknown> = { v: 1 };
        for (let i = 0; i < 200; i += 1) o = { o };
        return o;
      },
    ],
    ["not an object", () => "ls" as unknown as Record<string, unknown>],
    ["an array", () => ["ls"] as unknown as Record<string, unknown>],
  ])("blocks without asking when the input has %s", async (_name, make) => {
    const { policy, requests } = checker(() => ({ allow: true }));
    const result = await createToolCallHandler(policy)(event({ input: make() }), {});
    expect(result).toMatchObject({
      block: true,
      reason: expect.stringMatching(/^policy\.denied:/),
    });
    expect(requests).toHaveLength(0);
  });

  it("accepts a null-prototype object and nested plain data", async () => {
    const { policy } = checker(() => ({ allow: true }));
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      path: "a.txt",
      edits: [{ oldText: "x", newText: "y" }],
      flag: true,
      n: 1.5,
      none: null,
    });
    expect(
      await createToolCallHandler(policy)(event({ toolName: "edit", input }), {}),
    ).toBeUndefined();
  });

  it.each([
    ["empty tool name", { toolName: "" }],
    ["non-string tool name", { toolName: 1 }],
    ["overlong tool name", { toolName: "t".repeat(257) }],
    ["missing call id", { toolCallId: undefined }],
    ["overlong call id", { toolCallId: "c".repeat(129) }],
    ["control char in call id", { toolCallId: "a\nb" }],
    ["bad parent id", { parentToolCallId: "" }],
  ])("blocks without asking on %s", async (_name, overrides) => {
    const { policy, requests } = checker(() => ({ allow: true }));
    const result = await createToolCallHandler(policy)(event(overrides), {});
    expect(result).toMatchObject({ block: true });
    expect(requests).toHaveLength(0);
  });

  it("blocks when the checker throws", async () => {
    const policy: PolicyChecker = { check: vi.fn().mockRejectedValue(new Error("boom")) };
    expect(await createToolCallHandler(policy)(event(), {})).toMatchObject({ block: true });
  });
});
