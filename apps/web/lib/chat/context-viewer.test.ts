import { describe, expect, it } from "vitest";
import {
  approximateNotice,
  buildRows,
  findMatches,
  formatShare,
  mayOpenContext,
  splitMatches,
  gaugeModel,
  nextWakeDelay,
  readThreadContext,
  visibleRange,
  WRAP_COLUMNS,
} from "./context-viewer";
import { contextOf, section } from "./testing/context-fixtures";

const THREAD = "00000000-0000-4000-8000-000000000001";

const answering =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readThreadContext", () => {
  it("validates a 200 and sends the team header", async () => {
    let seen: Headers | undefined;
    const ctx = contextOf([section("system_prompt", 10)]);
    const fetchFn: typeof fetch = async (_url, init) => {
      seen = new Headers(init?.headers);
      return answering(200, ctx)("");
    };
    const read = await readThreadContext(THREAD, "team-1", fetchFn);
    expect(read).toEqual({ kind: "ready", context: ctx });
    expect(seen?.get("x-kobe-team")).toBe("team-1");
  });

  it("reports a 202 as waking", async () => {
    const read = await readThreadContext(
      THREAD,
      "t",
      answering(202, { status: "waking", retry_after_ms: 2000 }),
    );
    expect(read).toEqual({ kind: "waking", retryAfterMs: 2000 });
  });

  it("refuses a 200 that does not match the contract", async () => {
    const read = await readThreadContext(THREAD, "t", answering(200, { sections: "<b>" }));
    expect(read).toMatchObject({ kind: "error", terminal: false });
  });

  it("uses the contract's fixed message and marks terminal codes", async () => {
    const refused = await readThreadContext(
      THREAD,
      "t",
      answering(409, {
        code: "sandbox_refused",
        message:
          "Your workspace can't be started, so its context can't be read. Ask a site admin to check it.",
      }),
    );
    expect(refused).toMatchObject({ kind: "error", code: "sandbox_refused", terminal: true });
    // A 5xx's own text is never shown: the contract's message for its code is.
    const unavailable = await readThreadContext(
      THREAD,
      "t",
      answering(502, { code: "context_unavailable", message: "something internal" }),
    );
    expect(unavailable).toEqual({
      kind: "error",
      code: "context_unavailable",
      message: "The context could not be read from your workspace. Try again.",
      terminal: false,
    });
  });

  it("maps 404, network failures and unknown bodies to fixed messages", async () => {
    expect(
      await readThreadContext(THREAD, "t", answering(404, { code: "thread_not_found" })),
    ).toMatchObject({ kind: "error", terminal: true });
    const offline = await readThreadContext(THREAD, "t", async () => {
      throw new TypeError("offline");
    });
    expect(offline).toMatchObject({ kind: "error", code: "network_error", terminal: false });
    expect(await readThreadContext(THREAD, "t", answering(500, "oops"))).toMatchObject({
      kind: "error",
      terminal: false,
    });
  });
});

describe("nextWakeDelay", () => {
  it("backs off from the server's hint and caps", () => {
    expect(nextWakeDelay(0, 2000)).toBe(2000);
    expect(nextWakeDelay(1, 2000)).toBe(3000);
    expect(nextWakeDelay(10, 2000)).toBe(10_000);
    // Never faster than the floor, whatever the hint.
    expect(nextWakeDelay(0, 10)).toBe(2000);
  });
});

describe("gaugeModel", () => {
  it("stacks kinds in the model's order, groups tool calls and results, leaves the rest free", () => {
    const ctx = contextOf([
      section("system_prompt", 100),
      section("tool_definitions", 50),
      section("user_message", 30),
      section("tool_call", 10),
      section("tool_result", 10),
      section("assistant_message", 20),
    ]);
    const model = gaugeModel(ctx, null);
    expect(model.slices.map((s) => [s.kind, s.tokens, s.firstSection])).toEqual([
      ["system_prompt", 100, 0],
      ["tool_definitions", 50, 1],
      ["user_message", 30, 2],
      ["assistant_message", 20, 5],
      ["tools", 20, 3],
    ]);
    expect(model.window).toBe(1000);
    expect(model.free).toBe(780);
    expect(model.slices[0]?.share).toBeCloseTo(0.1);
    expect(model.freeShare).toBeCloseTo(0.78);
  });

  it("falls back to the gauge's window, and to the total without one", () => {
    const ctx = contextOf([section("user_message", 40)], { context_window: null });
    expect(gaugeModel(ctx, 200).window).toBe(200);
    const bare = gaugeModel(ctx, null);
    expect(bare.window).toBeNull();
    expect(bare.free).toBe(0);
    expect(bare.slices[0]?.share).toBe(1);
  });

  it("caps at the total when the context is over the window", () => {
    const ctx = contextOf([section("user_message", 300)], { context_window: 200 });
    const model = gaugeModel(ctx, null);
    expect(model.over).toBe(true);
    expect(model.free).toBe(0);
    expect(model.slices[0]?.share).toBe(1);
  });
});

describe("buildRows", () => {
  it("labels each section and splits its text into lines, wrapping long ones", () => {
    const long = "a".repeat(WRAP_COLUMNS + 5);
    const { rows, firstRow } = buildRows([
      section("system_prompt", 1, "one\ntwo"),
      section("user_message", 1, long),
      section("other", 1, ""),
    ]);
    expect(rows).toEqual([
      { type: "label", section: 0 },
      { type: "line", section: 0, text: "one" },
      { type: "line", section: 0, text: "two" },
      { type: "label", section: 1 },
      { type: "line", section: 1, text: "a".repeat(WRAP_COLUMNS) },
      { type: "line", section: 1, text: "aaaaa" },
      { type: "label", section: 2 },
      { type: "line", section: 2, text: "" },
    ]);
    expect(firstRow).toEqual([0, 3, 6]);
  });
});

describe("findMatches", () => {
  it("finds line rows case-insensitively; an empty query finds nothing", () => {
    const { rows } = buildRows([section("user_message", 1, "Hello\nworld\nHELLO again")]);
    expect(findMatches(rows, "hello")).toEqual([1, 3]);
    expect(findMatches(rows, "  ")).toEqual([]);
  });
});

describe("visibleRange", () => {
  it("windows the rows around the viewport with overscan", () => {
    expect(visibleRange({ scrollTop: 0, viewport: 100, rowPx: 20, count: 1000 })).toEqual([0, 25]);
    expect(visibleRange({ scrollTop: 2000, viewport: 100, rowPx: 20, count: 1000 })).toEqual([
      80, 125,
    ]);
    expect(visibleRange({ scrollTop: 19_900, viewport: 100, rowPx: 20, count: 1000 })).toEqual([
      975, 1000,
    ]);
  });
});

describe("formatShare and approximateNotice", () => {
  it("formats shares for the legend", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.0004)).toBe("<0.1%");
    expect(formatShare(0.052)).toBe("5.2%");
    expect(formatShare(0.05)).toBe("5%");
    expect(formatShare(0.456)).toBe("46%");
  });

  it("names what an approximate answer may lack", () => {
    expect(approximateNotice(contextOf([]))).toBeNull();
    expect(
      approximateNotice(
        contextOf([], { exact: false, source: "session", missing: ["memory", "older_history"] }),
      ),
    ).toBe(
      "Approximate — the sandbox restarted since the last model call. May lack: memory, older history.",
    );
  });
});

describe("splitMatches", () => {
  it("marks matches on the original text, also where lower-casing changes the length", () => {
    // "İ".toLowerCase() is two code units: offsets from a lower-cased copy would shift.
    expect(splitMatches("İİ abc ABC", "abc")).toEqual([
      { text: "İİ ", hit: false },
      { text: "abc", hit: true },
      { text: " ", hit: false },
      { text: "ABC", hit: true },
    ]);
    expect(splitMatches("a.b axb", ".")).toEqual([
      { text: "a", hit: false },
      { text: ".", hit: true },
      { text: "b axb", hit: false },
    ]);
    expect(splitMatches("plain", "  ")).toEqual([{ text: "plain", hit: false }]);
  });

  it("finds regex characters literally", () => {
    const { rows } = buildRows([section("user_message", 1, "a(b\nab")]);
    expect(findMatches(rows, "a(b")).toEqual([1]);
  });
});

describe("mayOpenContext", () => {
  it("is false until the summary has loaded and for a shared reader", () => {
    expect(mayOpenContext(null)).toBe(false);
    expect(mayOpenContext(undefined)).toBe(false);
    expect(mayOpenContext({ readOnly: true })).toBe(false);
    expect(mayOpenContext({ readOnly: false })).toBe(true);
    expect(mayOpenContext({})).toBe(true);
  });
});
