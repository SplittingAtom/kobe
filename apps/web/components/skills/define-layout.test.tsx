// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LayoutPreferencesContext,
  type LayoutPreferences,
  type LayoutPreferencesApi,
} from "../../lib/shell/preferences";
import {
  DefineLayout,
  EDITOR_MIN_PX,
  EDITOR_WIDTH_VAR,
  HANDLE_PX,
  TREE_MIN_PX,
} from "./define-layout";

/**
 * KOBE-459 ac-3: the editor rail resizes with a drag handle (pointer and keys, an ARIA separator
 * with its value), clamped so the tree and the rail keep their floors; the width is saved with the
 * member's layout preferences and a double-click resets it. happy-dom has no layout: the grid is
 * 1000 px wide and the rail as wide as its custom property says (the default: 1000 - 224 - 12).
 */
const SPACE = 1000;
const DEFAULT_WIDTH = SPACE - 224 - HANDLE_PX;

function editorWidth(el: HTMLElement): number {
  const grid = el.closest<HTMLElement>("[data-workbench-define]");
  const raw = grid?.style.getPropertyValue(EDITOR_WIDTH_VAR) ?? "";
  return raw.endsWith("px") ? Number.parseFloat(raw) : DEFAULT_WIDTH;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute("data-workbench-define"))
      return { left: 0, right: SPACE, width: SPACE, top: 0, bottom: 600, height: 600 } as DOMRect;
    if (this.hasAttribute("data-workbench-editor")) {
      const width = editorWidth(this);
      return {
        left: SPACE - width,
        right: SPACE,
        width,
        top: 0,
        bottom: 600,
        height: 600,
      } as DOMRect;
    }
    return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0 } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function view(preferences: LayoutPreferences | null = {}) {
  const save = vi.fn();
  const api: LayoutPreferencesApi = { preferences, save };
  const out = render(
    <LayoutPreferencesContext value={api}>
      <DefineLayout tree={<p>Tree</p>}>
        <p>Editor</p>
      </DefineLayout>
    </LayoutPreferencesContext>,
  );
  const handle = () => screen.getByRole("separator", { name: "Resize the editor" });
  const grid = () => out.container.querySelector<HTMLElement>("[data-workbench-define]");
  return { save, handle, grid, rerender: out.rerender };
}

describe("the editor rail's handle", () => {
  it("is a separator whose value is the rail's width, within the tree's and the rail's floors", () => {
    const { handle } = view();
    expect(handle().getAttribute("aria-orientation")).toBe("vertical");
    expect(handle().getAttribute("aria-valuenow")).toBe(String(DEFAULT_WIDTH));
    expect(handle().getAttribute("aria-valuemin")).toBe(String(EDITOR_MIN_PX));
    expect(handle().getAttribute("aria-valuemax")).toBe(String(SPACE - TREE_MIN_PX - HANDLE_PX));
    expect(handle().getAttribute("aria-controls")).toBe("kobe-workbench-editor");
  });

  it("keys: Left widens the rail, Right narrows it, Home/End hit the floors; each is saved", async () => {
    const { handle, save, grid } = view();
    handle().focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(save).toHaveBeenLastCalledWith({ workbenchEditorWidth: DEFAULT_WIDTH + 24 });
    expect(grid()?.style.getPropertyValue(EDITOR_WIDTH_VAR)).toBe(`${DEFAULT_WIDTH + 24}px`);
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(save).toHaveBeenLastCalledWith({ workbenchEditorWidth: DEFAULT_WIDTH - 24 });
    await userEvent.keyboard("{Home}");
    expect(save).toHaveBeenLastCalledWith({ workbenchEditorWidth: EDITOR_MIN_PX });
    await userEvent.keyboard("{End}");
    // The tree keeps its 12rem beside the widest rail.
    expect(save).toHaveBeenLastCalledWith({
      workbenchEditorWidth: SPACE - TREE_MIN_PX - HANDLE_PX,
    });
  });

  it("a drag moves the rail's left edge with the pointer, clamped, and commits once on release", () => {
    const { handle, save, grid } = view();
    const edge = SPACE - DEFAULT_WIDTH;
    fireEvent.pointerDown(handle(), { clientX: edge, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: edge + 100, pointerId: 1 });
    expect(grid()?.style.getPropertyValue(EDITOR_WIDTH_VAR)).toBe(`${DEFAULT_WIDTH - 100}px`);
    expect(save).not.toHaveBeenCalled();
    // Past the tree's floor: held at the widest rail.
    fireEvent.pointerMove(handle(), { clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 10, pointerId: 1 });
    expect(save).toHaveBeenCalledExactlyOnceWith({
      workbenchEditorWidth: SPACE - TREE_MIN_PX - HANDLE_PX,
    });
  });

  it("applies the member's stored width once loaded, and a double-click resets it", () => {
    const { handle, save, grid, rerender } = view(null);
    expect(grid()?.style.getPropertyValue(EDITOR_WIDTH_VAR)).toBe("");
    rerender(
      <LayoutPreferencesContext value={{ preferences: { workbenchEditorWidth: 600 }, save }}>
        <DefineLayout tree={<p>Tree</p>}>
          <p>Editor</p>
        </DefineLayout>
      </LayoutPreferencesContext>,
    );
    expect(grid()?.style.getPropertyValue(EDITOR_WIDTH_VAR)).toBe("600px");
    fireEvent.doubleClick(handle());
    expect(save).toHaveBeenLastCalledWith({ workbenchEditorWidth: null });
    expect(grid()?.style.getPropertyValue(EDITOR_WIDTH_VAR)).toBe("");
  });

  it("outside the shell (no preferences) it still resizes, saving nothing", async () => {
    render(
      <DefineLayout tree={<p>Tree</p>}>
        <p>Editor</p>
      </DefineLayout>,
    );
    const handle = screen.getByRole("separator", { name: "Resize the editor" });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(handle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_WIDTH + 24));
  });
});
