"use client";

import { WORKBENCH_EDITOR_WIDTH_BOUNDS } from "@kobe/protocol";
import { useCallback, type CSSProperties, type ReactNode } from "react";
import { useShellPreferences, useStoredPreference } from "../../lib/shell/preferences";
import { useSplitter, type SplitterRange } from "../shell/use-splitter";

/**
 * The Workbench's Define tab (KOBE-459): the file tree on the left and the editor rail (SKILL.md's
 * form or the file picked, then Lint and Scan) on the right, taking most of the width. From md the
 * rail resizes with a drag handle, the shell's window splitter (`use-splitter.ts`, as the
 * workspace rail and the artifact column): drag it, or Left/Right (the rail is after the handle,
 * so Left widens it), Page Up/Down, Home/End; Enter or a double-click goes back to the default.
 * The tree and the rail each keep a minimum width. The width is saved per member with the other
 * layout preferences (server-side, `workbench_editor_width`). Below md the tree stacks above a
 * full-width rail and there is no handle.
 */
export const EDITOR_WIDTH_VAR = "--kobe-editor-width";
export const EDITOR_RAIL_ID = "kobe-workbench-editor";
/** The tree's floor (12rem) and the handle's strip, in px. */
export const TREE_MIN_PX = 192;
export const HANDLE_PX = 12;
export const EDITOR_MIN_PX = WORKBENCH_EDITOR_WIDTH_BOUNDS.min;
const STEP_PX = 24;

/**
 * The rail's width is `--kobe-editor-width` held within both floors; by default it is what a
 * 14rem tree leaves. A width the panel can no longer hold shrinks to fit (the tree keeps 12rem).
 */
const GRID = [
  "grid grid-cols-[minmax(0,1fr)] gap-4",
  "[--kobe-editor-width:calc(100%_-_14rem_-_12px)]",
  "md:gap-0 md:grid-cols-[minmax(12rem,1fr)_12px_minmax(min(20rem,100%),min(var(--kobe-editor-width),calc(100%_-_12rem_-_12px)))]",
].join(" ");

function regions(handle: HTMLElement | null) {
  const grid = handle?.closest<HTMLElement>("[data-workbench-define]") ?? null;
  const editor = grid?.querySelector<HTMLElement>(":scope > [data-workbench-editor]") ?? null;
  return { grid, editor };
}

/** The rail's width and its bounds: the tree keeps its floor beside it. */
function measure(handle: HTMLElement | null): SplitterRange | null {
  const { grid, editor } = regions(handle);
  const space = grid?.getBoundingClientRect().width ?? 0;
  const width = editor?.getBoundingClientRect().width ?? 0;
  const max = Math.floor(space - TREE_MIN_PX - HANDLE_PX);
  if (width <= 0 || max < EDITOR_MIN_PX) return null;
  return { value: width, min: EDITOR_MIN_PX, max };
}

function observe(handle: HTMLElement | null): readonly Element[] {
  const { grid, editor } = regions(handle);
  return grid && editor ? [grid, editor] : [];
}

/** The rail's right edge stays put: the pointer at the handle sets its left edge. */
function pointerValue(clientX: number, handle: HTMLElement): number | null {
  const { editor } = regions(handle);
  return editor ? editor.getBoundingClientRect().right - clientX : null;
}

function preview(width: number, handle: HTMLElement): void {
  regions(handle).grid?.style.setProperty(EDITOR_WIDTH_VAR, `${width}px`);
}

/** The member's rail width (null: the default), applied once the shell's preferences load. */
export function useEditorWidth() {
  const shell = useShellPreferences();
  const preferences = shell?.preferences ?? null;
  const save = shell?.save;
  const stored = useStoredPreference<number | null>({
    initial: null,
    ready: preferences !== null,
    resolve: () => preferences?.workbenchEditorWidth ?? null,
    save: save && ((workbenchEditorWidth) => save({ workbenchEditorWidth })),
  });
  const { commit } = stored;
  const setWidth = useCallback(
    (next: number) => commit(Math.max(EDITOR_MIN_PX, Math.round(next))),
    [commit],
  );
  const resetWidth = useCallback(() => commit(null), [commit]);
  return { width: stored.value, setWidth, resetWidth };
}

function EditorRailHandle({
  width,
  onChange,
  onReset,
}: {
  readonly width: number | null;
  onChange(width: number): void;
  onReset(): void;
}) {
  const splitter = useSplitter({
    measure,
    observe,
    pointerValue,
    preview,
    commit: (next) => {
      if (next !== width) onChange(next);
    },
    reset: onReset,
    reversed: true,
    revert: () => {
      const grid = document.querySelector<HTMLElement>("[data-workbench-define]");
      if (width === null) grid?.style.removeProperty(EDITOR_WIDTH_VAR);
      else grid?.style.setProperty(EDITOR_WIDTH_VAR, `${width}px`);
    },
    step: STEP_PX,
    fallback: { value: width ?? EDITOR_MIN_PX, min: EDITOR_MIN_PX, max: EDITOR_MIN_PX },
  });
  return (
    <div
      {...splitter}
      aria-label="Resize the editor"
      aria-controls={EDITOR_RAIL_ID}
      className="group hidden cursor-col-resize touch-none justify-center focus-visible:outline-none md:flex"
    >
      <span
        aria-hidden="true"
        className="h-full w-px bg-console-border group-hover:w-1 group-hover:bg-console-accent group-focus-visible:w-1 group-focus-visible:bg-console-accent"
      />
    </div>
  );
}

export function DefineLayout({
  tree,
  children,
}: {
  readonly tree: ReactNode;
  /** The editor rail's content. */
  readonly children: ReactNode;
}) {
  const { width, setWidth, resetWidth } = useEditorWidth();
  const style =
    width === null ? undefined : ({ [EDITOR_WIDTH_VAR]: `${width}px` } as CSSProperties);
  return (
    <div data-workbench-define="" className={GRID} style={style}>
      <div className="min-w-0 md:pe-3">{tree}</div>
      <EditorRailHandle width={width} onChange={setWidth} onReset={resetWidth} />
      <div id={EDITOR_RAIL_ID} data-workbench-editor="" className="min-w-0 md:ps-3">
        {children}
      </div>
    </div>
  );
}
