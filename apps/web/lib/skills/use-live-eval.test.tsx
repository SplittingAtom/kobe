// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEvalStream } from "./testing/fake-event-source";
import { EVAL_POLL_MS, MAX_POLL_FAILURES, useLiveEval } from "./use-live-eval";

/** KOBE-328 review: the stream first, polling on error, stopped on unmount or repeated failure. */
afterEach(() => {
  vi.useRealTimers();
});

describe("useLiveEval", () => {
  it("stops polling on unmount and after repeated failures", async () => {
    vi.useFakeTimers();
    const stream = new FakeEvalStream();
    const reload = vi.fn(async () => false);
    const { unmount } = renderHook(() => useLiveEval(["e-1"], reload, stream.factory));
    stream.sources[0]?.fail();
    await vi.advanceTimersByTimeAsync(EVAL_POLL_MS * (MAX_POLL_FAILURES + 3));
    expect(reload).toHaveBeenCalledTimes(MAX_POLL_FAILURES);
    unmount();
    const ok = vi.fn(async () => true);
    const second = renderHook(() => useLiveEval(["e-2"], ok, stream.factory));
    stream.sources[1]?.fail();
    await vi.advanceTimersByTimeAsync(EVAL_POLL_MS);
    expect(ok).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(stream.sources[1]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(EVAL_POLL_MS * 3);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("opens no stream when nothing is open", () => {
    const stream = new FakeEvalStream();
    renderHook(() => useLiveEval([], async () => true, stream.factory));
    expect(stream.urls).toEqual([]);
  });
});
