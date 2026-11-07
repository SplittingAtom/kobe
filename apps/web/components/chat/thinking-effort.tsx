/*
 * Vendored from assistant-ui's Reasoning effort element (KOBE-556):
 * https://github.com/assistant-ui/assistant-ui/blob/208cc81de222d85b8c3877445187828cff09feeb/packages/ui/src/components/react/assistant-ui/elements/reasoning-effort.tsx
 * with its `field` surface (surfaces.tsx) and the `pct` / `announced` helpers (utils/range.ts)
 * inlined. Changed for Kobe: restyled with Kobe's tokens (the bar in the brand accent), sized for
 * the composer's toolbar with a compact variant, a labelled group, a disabled state, a per-level
 * title, and the readout and bar shown only when both the spend and the budget are known (an
 * estimate marked as one).
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

const fmt = (n: number) => n.toLocaleString("en-US");

/** `value` as a share of `total`, as a percentage in `0…100` (assistant-ui utils/range). */
function pct(value: number, total: number): number {
  if (!(total > 0)) return 0;
  const share = (value / total) * 100;
  return Number.isNaN(share) ? 0 : Math.min(100, Math.max(0, share));
}

/** A `0…100` share as it should be announced: no float error read out (utils/range). */
const announced = (share: number) => Math.round(share * 10) / 10;

export interface EffortLevel {
  readonly key: string;
  readonly label: string;
  /** The pill's tooltip, e.g. "Model's default". */
  readonly title?: string;
}

/** The track: assistant-ui's `field` surface, with a real border so forced colours keep it. */
const TRACK =
  "flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-foreground/[0.04] p-px dark:bg-foreground/[0.06]";

/** The chat has no preflight: the pills reset the browser's button border, fill and font. */
const PILL =
  "cursor-pointer rounded-full border-0 [font-family:inherit] font-medium whitespace-nowrap transition-[background-color,color,scale] duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60 forced-colors:aria-pressed:outline";

/**
 * A segmented control of effort levels (assistant-ui's Reasoning effort): one pill button per
 * level, `aria-pressed` on the selected one, inside a group named by an sr-only label. Below the
 * pills, "spent / budget" and a thin bar of the spend over the selected level's budget, only when
 * both are known (a budget of 0 counts as unknown: nothing to fill).
 */
export function ThinkingEffort({
  label,
  levels,
  selectedKey,
  onSelect,
  disabled = false,
  spent,
  budget,
  estimated = false,
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
  /** Reasoning tokens spent (the latest run's); undefined: unknown. */
  readonly spent?: number | undefined;
  /** The selected level's budget in tokens; undefined: unknown. */
  readonly budget?: number | undefined;
  /** The spend is an estimate, not the provider's count. */
  readonly estimated?: boolean | undefined;
  /** The smaller pills on the line below the composer (KOBE-450). */
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const labelId = useId();
  const known = spent !== undefined && budget !== undefined && budget > 0;
  const used = known ? pct(spent, budget) : 0;
  const approx = estimated ? "≈" : "";
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-slot="thinking-effort"
      data-size={compact ? "compact" : "default"}
      className={cn("inline-flex min-w-0 shrink-0 flex-col gap-[3px]", className)}
    >
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <div className={TRACK}>
          {levels.map((level) => {
            const active = level.key === selectedKey;
            return (
              <button
                key={level.key}
                type="button"
                aria-pressed={active}
                title={level.title}
                disabled={disabled}
                onClick={() => onSelect(level.key)}
                className={cn(
                  PILL,
                  compact ? "h-5 px-1.5 text-[0.7rem]" : "h-6 px-2 text-xs",
                  !disabled && "active:scale-[0.97]",
                  active
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground enabled:hover:text-foreground bg-transparent",
                )}
              >
                {level.label}
              </button>
            );
          })}
        </div>
        {known && (
          <span
            aria-hidden
            className="text-muted-foreground font-mono text-[11px] tracking-tight whitespace-nowrap tabular-nums"
          >
            {approx}
            {fmt(spent)} / {fmt(budget)}
          </span>
        )}
      </div>
      {known && (
        <span
          role="progressbar"
          aria-label="Thinking budget used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={announced(used)}
          aria-valuetext={
            estimated
              ? `about ${fmt(spent)} of ${fmt(budget)} thinking tokens (estimated)`
              : `${fmt(spent)} of ${fmt(budget)} thinking tokens`
          }
          className="bg-foreground/[0.06] inset-ring-border block h-[3px] w-full overflow-hidden rounded-full inset-ring forced-colors:outline"
        >
          <span
            className="bg-brand-primary block h-full rounded-full transition-[width] duration-500 forced-color-adjust-none motion-reduce:transition-none"
            style={{ width: `${used}%` }}
          />
        </span>
      )}
    </div>
  );
}
