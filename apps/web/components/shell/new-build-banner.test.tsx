// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuildWatcher } from "../../lib/build/build-watcher";
import { isReloadRequested, resetReloadRequest } from "../../lib/build/reload-draft";
import { NewBuildBanner, RELOAD_NOTICE } from "./new-build-banner";

/** KOBE-487 ac-2/ac-4: the banner appears on a newer build, never reloads by itself. */
afterEach(() => {
  cleanup();
  resetReloadRequest();
});

function watcherServing(id: string) {
  return createBuildWatcher({ current: "old", fetchBuildId: async () => id, now: () => 0 });
}

describe("NewBuildBanner", () => {
  it("shows nothing while the build is unchanged", async () => {
    const watcher = watcherServing("old");
    render(<NewBuildBanner watcher={watcher} reload={vi.fn()} />);
    await act(() => watcher.check("visible"));
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("announces a newer build and reloads only when asked", async () => {
    const watcher = watcherServing("new");
    const reload = vi.fn();
    render(<NewBuildBanner watcher={watcher} reload={reload} />);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await watcher.check("visible");
    });
    expect(screen.getByRole("status").textContent).toContain(RELOAD_NOTICE);
    expect(reload).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Reload" });
    await userEvent.tab();
    expect(document.activeElement).toBe(button); // keyboard reachable
    await userEvent.keyboard("{Enter}");
    expect(isReloadRequested()).toBe(true); // the composer keeps its draft on unload
    expect(reload).toHaveBeenCalledOnce();
  });
});
