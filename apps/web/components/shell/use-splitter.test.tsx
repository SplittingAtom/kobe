// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { snapStep, useSplitter, type SplitterOptions, type SplitterRange } from "./use-splitter";

/**
 * KOBE-305 review: the splitter hook's lifecycle on its own (the rail and the artifact column
 * use it): pointer cancel, unmount mid-drag, window resize, listeners after unmount, keys with
 * modifiers, Enter and the default stop. The layout is a plain object the test moves.
 */
let layout: SplitterRange = { value: 280, min: 200, max: 560 };

function harness(overrides: Partial<SplitterOptions> = {}) {
  const calls = { commit: vi.fn(), preview: vi.fn(), reset: vi.fn(), revert: vi.fn() };
  function Handle() {
    const props = useSplitter({
      measure: () => layout,
      observe: () => [], // the window's resize, as without ResizeObserver
      pointerValue: (clientX) => clientX,
      preview: calls.preview,
      commit: calls.commit,
      reset: calls.reset,
      revert: calls.revert,
      snap: 280,
      step: 24,
      fallback: { value: 280, min: 200, max: 560 },
      ...overrides,
    });
    return <div {...props} aria-label="Resize" />;
  }
  const view = render(<Handle />);
  return { ...calls, view, handle: () => screen.getByRole("separator", { name: "Resize" }) };
}

afterEach(() => {
  cleanup();
  layout = { value: 280, min: 200, max: 560 };
  vi.restoreAllMocks();
});

describe("pointer lifecycle", () => {
  it("a cancelled drag commits what it showed, like a release", () => {
    const { handle, commit, preview } = harness();
    fireEvent.pointerDown(handle(), { clientX: 280, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 350, pointerId: 1 });
    expect(preview).toHaveBeenLastCalledWith(350, handle());
    fireEvent.pointerCancel(handle(), { clientX: 350, pointerId: 1 });
    expect(commit).toHaveBeenCalledExactlyOnceWith(350);
    // Over: later moves do nothing.
    fireEvent.pointerMove(handle(), { clientX: 400, pointerId: 1 });
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("keeps the grab offset: a press beside the edge moves the width by the drag only", () => {
    // The handle is 6 px wide and straddles the edge, so a press is rarely on the edge itself:
    // here 1 px right of it (281 for a 280 px width), as at the handle's middle on gate1.
    const { handle, commit, preview } = harness();
    fireEvent.pointerDown(handle(), { clientX: 281, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 341, pointerId: 1 });
    expect(preview).toHaveBeenLastCalledWith(340, handle());
    fireEvent.pointerMove(handle(), { clientX: 401, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 401, pointerId: 1 });
    expect(commit).toHaveBeenCalledExactlyOnceWith(400); // 280 + 120, not the pointer's 401
  });

  it("unmounted mid-drag: the preview is reverted and nothing is committed", () => {
    const { handle, commit, revert, view } = harness();
    fireEvent.pointerDown(handle(), { clientX: 280, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 420, pointerId: 1 });
    view.unmount();
    expect(revert).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("unmounted after a press that never moved: nothing to revert", () => {
    const { handle, revert, view } = harness();
    fireEvent.pointerDown(handle(), { clientX: 280, button: 0, pointerId: 1 });
    view.unmount();
    expect(revert).not.toHaveBeenCalled();
  });
});

describe("measuring", () => {
  it("follows a window resize that moves the bounds, and stops listening once unmounted", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { handle, view } = harness();
    expect(handle().getAttribute("aria-valuemax")).toBe("560");
    layout = { value: 280, min: 200, max: 340 }; // narrower, with the artifact column open
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(handle().getAttribute("aria-valuemax")).toBe("340");
    view.unmount();
    expect(remove.mock.calls.some(([type]) => type === "resize")).toBe(true);
    layout = { value: 280, min: 200, max: 500 };
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
  });

  it("End from a width the window clamped commits the clamped bound", async () => {
    layout = { value: 340, min: 200, max: 340 };
    const { handle, commit } = harness();
    handle().focus();
    await userEvent.setup().keyboard("{End}");
    expect(commit).toHaveBeenLastCalledWith(340);
  });
});

describe("keys", () => {
  it("Enter resets; modified keys go to the browser untouched", async () => {
    const { handle, reset, commit } = harness();
    expect(handle().getAttribute("aria-keyshortcuts")).toBe("Enter");
    handle().focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(reset).toHaveBeenCalledOnce();
    for (const mod of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(fireEvent.keyDown(handle(), { key: "ArrowLeft", ...mod })).toBe(true); // not prevented
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("without a reset, Enter does nothing and there is no shortcut to announce", async () => {
    const { handle, commit } = harness({ reset: undefined });
    expect(handle().hasAttribute("aria-keyshortcuts")).toBe(false);
    handle().focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(commit).not.toHaveBeenCalled();
  });

  it("arrow and Page steps stop on the default on their way past, Home/End don't", async () => {
    layout = { value: 200, min: 200, max: 560 };
    const { handle, commit } = harness();
    handle().focus();
    const user = userEvent.setup();
    await user.keyboard("{PageUp}"); // 200 + 96 would pass 280
    expect(commit).toHaveBeenLastCalledWith(280);
    layout = { value: 296, min: 200, max: 560 };
    await user.keyboard("{ArrowLeft}"); // 296 − 24 would pass 280
    expect(commit).toHaveBeenLastCalledWith(280);
    layout = { value: 280, min: 200, max: 560 };
    await user.keyboard("{ArrowRight}"); // leaving it is a normal step
    expect(commit).toHaveBeenLastCalledWith(304);
    layout = { value: 200, min: 200, max: 560 };
    await user.keyboard("{End}");
    expect(commit).toHaveBeenLastCalledWith(560);
  });

  it("reversed (the pane after the handle, KOBE-459): Left widens it, Right narrows it", async () => {
    const { handle, commit } = harness({ reversed: true, snap: undefined });
    handle().focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(commit).toHaveBeenLastCalledWith(304);
    await userEvent.keyboard("{ArrowRight}");
    expect(commit).toHaveBeenLastCalledWith(256);
    // Home and End still go to the pane's bounds.
    await userEvent.keyboard("{End}");
    expect(commit).toHaveBeenLastCalledWith(560);
  });

  it("snapStep only stops on a crossing", () => {
    expect(snapStep(200, 296, 280)).toBe(280);
    expect(snapStep(560, 464, 280)).toBe(464);
    expect(snapStep(280, 304, 280)).toBe(304);
    expect(snapStep(200, 296, undefined)).toBe(296);
  });
});
