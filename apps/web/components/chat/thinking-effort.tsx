/*
 * Vendored from assistant-ui's Reasoning effort element (KOBE-556):
 * https://github.com/assistant-ui/assistant-ui/blob/208cc81de222d85b8c3877445187828cff09feeb/packages/ui/src/components/react/assistant-ui/elements/reasoning-effort.tsx
 * with its `field` surface (surfaces.tsx) inlined. Changed for Kobe: restyled with Kobe's tokens
 * (the pressed pill inverted: foreground fill, background text), sized for the composer's toolbar
 * with a compact variant, pill text centred, a labelled group, a disabled state and a per-level
 * title. The upstream spend bar and readout were removed (KOBE-574), with its `pct` / `announced`
 * helpers.
 *
 * MIT License
 *
 * Copyright (c) 2026 AgentbaseAI Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
"use client";

import { useId } from "react";
import { cn } from "../../lib/utils";

export interface EffortLevel {
  readonly key: string;
  readonly label: string;
  /**
   * A note on the pill, e.g. "Model's default": its tooltip and, for screen readers and touch,
   * its accessible description (an sr-only text the pill names in `aria-describedby`).
   */
  readonly hint?: string;
}

/** The track: assistant-ui's `field` surface, with a real border so forced colours keep it. */
const TRACK =
  "flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-foreground/[0.04] p-px dark:bg-foreground/[0.06]";

/** The chat has no preflight: the pills reset the browser's button border, fill and font. */
const PILL =
  "inline-flex cursor-pointer items-center justify-center rounded-full border-0 [font-family:inherit] font-medium whitespace-nowrap transition-[background-color,color,scale] duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60 forced-colors:aria-pressed:outline";

/**
 * A segmented control of effort levels (assistant-ui's Reasoning effort): one pill button per
 * level, `aria-pressed` on the selected one, inside a group named by an sr-only label. The track
 * alone: no spend bar or readout (KOBE-574).
 */
export function ThinkingEffort({
  label,
  levels,
  selectedKey,
  onSelect,
  disabled = false,
  compact = false,
  className,
}: {
  /** The group's accessible name (visually hidden). */
  readonly label: string;
  readonly levels: readonly EffortLevel[];
  /** The pressed pill; null presses none. */
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
  readonly disabled?: boolean;
  /** The smaller pills on the line below the composer (KOBE-450). */
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-slot="thinking-effort"
      data-size={compact ? "compact" : "default"}
      className={cn("inline-flex min-w-0 shrink-0", className)}
    >
      <span id={labelId} className="sr-only">
        {label}
      </span>
      {levels.map((level) =>
        level.hint === undefined ? null : (
          <span key={level.key} id={`${id}-${level.key}-hint`} className="sr-only">
            {level.hint}
          </span>
        ),
      )}
      <div className={TRACK}>
        {levels.map((level) => {
          const active = level.key === selectedKey;
          return (
            <button
              key={level.key}
              type="button"
              aria-pressed={active}
              title={level.hint}
              aria-describedby={level.hint === undefined ? undefined : `${id}-${level.key}-hint`}
              disabled={disabled}
              onClick={() => onSelect(level.key)}
              className={cn(
                PILL,
                // Text centred (KOBE-574): a line box as tall as the pill, centred by the flex box. The
                // leading goes after the size: tailwind-merge drops a line height set before one.
                compact ? "h-5 px-1.5 text-[0.7rem] leading-5" : "h-6 px-2 text-xs leading-6",
                !disabled && "active:scale-[0.97]",
                active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground enabled:hover:text-foreground bg-transparent",
              )}
            >
              {level.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
