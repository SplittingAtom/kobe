"use client";

/**
 * The file editor's code/output split (KOBE-615): the code on top, a run's output below, with a
 * draggable divider (the shell's window splitter, `use-splitter.ts`, lying across). Drag it, or
 * Up/Down by 5%, Page Up/Down by 20%, Home/End to the bounds; Enter or a double-click goes back to
 * half. The share is the top pane's percentage of the height, so it follows the column as it
 * resizes, and is remembered per viewer in this browser (a convenience: unreadable storage gives
 * the default). The output pane's header collapses it to its bar or closes it.
 */
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useCallback, useId, useState, type CSSProperties, type ReactNode } from "react";
import { useSplitter, type SplitterRange } from "../shell/use-splitter";

export const SPLIT_VAR = "--kobe-editor-split";
export const SPLIT_KEY = "kobe.fileEditor.split";
export const SPLIT_DEFAULT = 50;
export const SPLIT_BOUNDS = { min: 15, max: 85 } as const;
const STEP = 5;

export function readSplit(): number {
  try {
    const raw = Number(window.localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(raw) && raw >= SPLIT_BOUNDS.min && raw <= SPLIT_BOUNDS.max
      ? raw
      : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT;
  }
}

function writeSplit(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(SPLIT_KEY);
    else window.localStorage.setItem(SPLIT_KEY, String(value));
  } catch {
    // Storage blocked (a private window): the share lasts this page only.
  }
}

function container(handle: HTMLElement | null): HTMLElement | null {
  return handle?.closest<HTMLElement>("[data-kobe-split]") ?? null;
}

function measureWith(fallback: number) {
  return (handle: HTMLElement | null): SplitterRange | null => {
    const box = container(handle);
    const top = box?.querySelector<HTMLElement>(":scope > [data-kobe-split-top]");
    const height = box?.getBoundingClientRect().height ?? 0;
    if (!box || !top || height <= 0) return { value: fallback, ...SPLIT_BOUNDS };
    const value = Math.round((top.getBoundingClientRect().height / height) * 100);
    return {
      value: Math.min(SPLIT_BOUNDS.max, Math.max(SPLIT_BOUNDS.min, value)),
      ...SPLIT_BOUNDS,
    };
  };
}

function observe(handle: HTMLElement | null): readonly Element[] {
  const box = container(handle);
  return box ? [box] : [];
}

function pointerValue(clientY: number, handle: HTMLElement): number | null {
  const box = container(handle)?.getBoundingClientRect();
  if (!box || box.height <= 0) return null;
  return ((clientY - box.top) / box.height) * 100;
}

function preview(value: number, handle: HTMLElement): void {
  container(handle)?.style.setProperty(SPLIT_VAR, `${value}%`);
}

export function SplitPane({
  top,
  bottom,
  bottomLabel,
  onClose,
}: {
  readonly top: ReactNode;
  readonly bottom: ReactNode;
  /** The output pane's name ("Run output"). */
  readonly bottomLabel: string;
  /** Close the output: the code takes the full height again. */
  onClose(): void;
}) {
  const id = useId();
  const [share, setShare] = useState(readSplit);
  const [collapsed, setCollapsed] = useState(false);
  const commit = useCallback((next: number) => {
    setShare(next);
    writeSplit(next);
  }, []);
  const reset = useCallback(() => {
    setShare(SPLIT_DEFAULT);
    writeSplit(null);
  }, []);
  const splitter = useSplitter({
    measure: measureWith(share),
    observe,
    pointerValue,
    preview,
    commit,
    reset,
    snap: SPLIT_DEFAULT,
    step: STEP,
    orientation: "horizontal",
    revert: () => undefined,
    fallback: { value: share, ...SPLIT_BOUNDS },
  });
  const style = { [SPLIT_VAR]: `${share}%` } as CSSProperties;
  const Toggle = collapsed ? ChevronUpIcon : ChevronDownIcon;
  return (
    <div
      data-kobe-split=""
      data-collapsed={collapsed || undefined}
      style={style}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div
        data-kobe-split-top=""
        className={
          collapsed
            ? "flex min-h-0 min-w-0 flex-1 flex-col"
            : "flex min-h-0 min-w-0 shrink-0 basis-(--kobe-editor-split) flex-col"
        }
      >
        {top}
      </div>
      {!collapsed && (
        <div
          {...splitter}
          aria-label="Resize the code and its output"
          aria-controls={`${id}-out`}
          className="group flex h-2 shrink-0 cursor-row-resize touch-none items-center focus-visible:outline-none"
        >
          <span
            aria-hidden
            className="bg-border group-hover:bg-ring group-focus-visible:bg-ring h-px w-full group-hover:h-1 group-focus-visible:h-1"
          />
        </div>
      )}
      <section
        id={`${id}-out`}
        aria-label={bottomLabel}
        className={
          collapsed
            ? "flex shrink-0 flex-col border-t"
            : "flex min-h-0 min-w-0 flex-1 flex-col border-t"
        }
      >
        <div className="flex shrink-0 items-center gap-1 py-1">
          <h3 className="me-auto text-xs font-medium">{bottomLabel}</h3>
          <button
            type="button"
            aria-label={collapsed ? "Expand the output" : "Collapse the output"}
            title={collapsed ? "Expand the output" : "Collapse the output"}
            aria-expanded={!collapsed}
            className="hover:bg-muted rounded-md p-0.5"
            onClick={() => setCollapsed((c) => !c)}
          >
            <Toggle aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close the output"
            title="Close the output"
            className="hover:bg-muted rounded-md p-0.5"
            onClick={onClose}
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        </div>
        {!collapsed && <div className="min-h-0 min-w-0 flex-1 overflow-auto">{bottom}</div>}
      </section>
    </div>
  );
}
