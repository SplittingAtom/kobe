// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetStatus } from "../admin/api/budgets";
import type { ApiResult } from "../api/client";
import { BUDGET_RECHECK_MS, useBudgetFinishing, useThrottledText } from "./use-steering";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useThrottledText (the phase live region)", () => {
  it("shows a change at once, then at most one per interval, ending on the latest", () => {
    const { result, rerender } = renderHook(({ text }) => useThrottledText(text, 2_000), {
      initialProps: { text: "" },
    });
    rerender({ text: "Thinking" });
    expect(result.current).toBe("Thinking");
    rerender({ text: "Running tool bash" });
    rerender({ text: "Thinking again" });
    expect(result.current).toBe("Thinking");
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current).toBe("Thinking again");
  });
});

describe("useBudgetFinishing", () => {
  function reader(states: BudgetStatus["state"][]) {
    return vi.fn(async (): Promise<ApiResult<BudgetStatus>> => ({
      ok: true,
      status: 200,
      data: { state: states.shift() ?? "ok", lines: [] } as BudgetStatus,
    }));
  }

  it("reads at run start and at most once per interval on tool results", async () => {
    const read = reader(["ok", "exhausted"]);
    const { result, rerender } = renderHook(
      ({ results }) => useBudgetFinishing(read, "run-1", results),
      { initialProps: { results: 0 } },
    );
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
    rerender({ results: 1 });
    rerender({ results: 2 });
    rerender({ results: 3 });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(BUDGET_RECHECK_MS));
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(true);
  });

  it("starts over for the next run, and is false without a run", async () => {
    const read = reader(["exhausted", "ok"]);
    const { result, rerender } = renderHook(
      ({ runId }: { runId: string | undefined }) => useBudgetFinishing(read, runId, 0),
      { initialProps: { runId: "run-1" as string | undefined } },
    );
    await act(async () => {});
    expect(result.current).toBe(true);
    rerender({ runId: "run-2" });
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(false);
    rerender({ runId: undefined });
    expect(result.current).toBe(false);
  });
});
