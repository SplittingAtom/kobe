// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEvalStream, breakStream } from "./testing/fake-event-source";
import {
  EVAL_POLL_MS,
  MAX_POLL_FAILURES,
  STREAM_RETRIES,
  STREAM_RETRY_MS,
  useLiveEval,
} from "./use-live-eval";

/**
 * KOBE-328 review: the stream first, reopened with backoff after an error, polling only when the
 * retries are spent, `stalled` when polling gives up, and nothing left behind on cleanup.
 */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("useLiveEval", () => {
  it("reopens a failed stream with growing delays, and a working stream resets them", async () => {
    const stream = new FakeEvalStream();
    const reload = vi.fn(async () => true);
    renderHook(() => useLiveEval(["e-1"], reload, stream.factory));
    stream.sources[0]?.fail();
    await advance(STREAM_RETRY_MS - 10);
    expect(stream.sources).toHaveLength(1);
    await advance(20);
    expect(stream.sources).toHaveLength(2);
    expect(stream.sources[0]?.closed).toBe(true);
    // An event on the new stream: the next error starts again from the first delay.
    stream.sources[1]?.emit("skill.eval.progress");
    expect(reload).toHaveBeenCalledTimes(1);
    stream.sources[1]?.fail();
    await advance(STREAM_RETRY_MS + 10);
    expect(stream.sources).toHaveLength(3);
    expect(stream.urls.every((u) => u === "/v1/skill-evals/e-1/events")).toBe(true);
  });

  it("falls back to polling once the retries are spent, then reports a stall", async () => {
    const stream = new FakeEvalStream();
    let ok = true;
    const reload = vi.fn(async () => ok);
    const { result } = renderHook(() => useLiveEval(["e-1"], reload, stream.factory));
    await breakStream(stream, advance, STREAM_RETRIES, STREAM_RETRY_MS);
    expect(stream.sources).toHaveLength(STREAM_RETRIES + 1);
    await advance(EVAL_POLL_MS + 10);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.stalled).toBe(false);
    ok = false;
    await advance(EVAL_POLL_MS * (MAX_POLL_FAILURES + 3));
    expect(reload).toHaveBeenCalledTimes(1 + MAX_POLL_FAILURES);
    expect(result.current.stalled).toBe(true);
  });

  it("cleans up on unmount and when the open evals change", async () => {
    const stream = new FakeEvalStream();
    const reload = vi.fn(async () => true);
    const { rerender, unmount } = renderHook(
      ({ ids }: { ids: string[] }) => useLiveEval(ids, reload, stream.factory),
      { initialProps: { ids: ["e-1"] } },
    );
    stream.sources[0]?.fail(); // a reopen is pending
    rerender({ ids: ["e-2"] });
    expect(stream.sources[0]?.closed).toBe(true);
    expect(stream.urls).toEqual(["/v1/skill-evals/e-1/events", "/v1/skill-evals/e-2/events"]);
    await advance(STREAM_RETRY_MS * 8);
    // The pending reopen of e-1 never happened.
    expect(stream.urls.filter((u) => u.includes("e-1"))).toHaveLength(1);
    unmount();
    expect(stream.sources[1]?.closed).toBe(true);
    await advance(EVAL_POLL_MS * 5);
    expect(reload).not.toHaveBeenCalled();
  });

  it("opens no stream when nothing is open", () => {
    const stream = new FakeEvalStream();
    renderHook(() => useLiveEval([], async () => true, stream.factory));
    expect(stream.urls).toEqual([]);
  });
});
