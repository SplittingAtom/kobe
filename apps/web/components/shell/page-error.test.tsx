// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuildWatcher, setActiveWatcher } from "../../lib/build/build-watcher";
import { RELOAD_NOTICE } from "./new-build-banner";
import { PageError } from "./page-error";

/** KOBE-487 ac-5: a failed chunk load shows the reload banner instead of a broken page. */
afterEach(() => {
  cleanup();
  setActiveWatcher(undefined);
});

const chunkError = () =>
  Object.assign(new Error("Loading chunk 7 failed."), { name: "ChunkLoadError" });

describe("PageError", () => {
  it("inside the layout, a chunk error turns the layout's banner on", () => {
    const watcher = createBuildWatcher({
      current: "a",
      fetchBuildId: async () => "a",
      now: () => 0,
    });
    setActiveWatcher(watcher);
    render(<PageError error={chunkError()} reset={vi.fn()} />);
    expect(watcher.isStale()).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("in place of the layout, a chunk error shows the banner itself", async () => {
    const reload = vi.fn();
    render(<PageError error={chunkError()} reset={vi.fn()} standalone reload={reload} />);
    expect(screen.getByRole("status").textContent).toContain(RELOAD_NOTICE);
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("any other error offers to try again", async () => {
    const reset = vi.fn();
    render(<PageError error={new Error("boom")} reset={reset} />);
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
