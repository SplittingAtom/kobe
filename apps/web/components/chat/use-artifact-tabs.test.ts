// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useArtifactTabs } from "./use-artifact-tabs";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

afterEach(() => localStorage.clear());

describe("useArtifactTabs (KOBE-200)", () => {
  it("applies every update queued in one tick: an auto-open and a close", () => {
    const { result } = renderHook(() => useArtifactTabs("kobe.artifactTabs:t:x"));
    act(() => {
      result.current.openArtifact(id(1));
      result.current.openArtifact(id(2));
    });
    act(() => {
      result.current.autoOpen(id(3));
      result.current.closeTab(id(1));
      result.current.activate(id(2));
    });
    expect(result.current.tabs).toEqual({ open: [id(2), id(3)], active: id(2) });
  });

  it("swaps the set with the key and remembers each", () => {
    const { result, rerender } = renderHook(({ key }) => useArtifactTabs(key), {
      initialProps: { key: "k:a" as string | null },
    });
    act(() => result.current.autoOpen(id(1)));
    rerender({ key: "k:b" });
    expect(result.current.tabs.open).toEqual([]);
    rerender({ key: null });
    expect(result.current.tabs.open).toEqual([]);
    rerender({ key: "k:a" });
    expect(result.current.tabs).toEqual({ open: [id(1)], active: id(1) });
  });
});
