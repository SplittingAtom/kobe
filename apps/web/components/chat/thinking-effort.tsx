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
import { formatTokens } from "../../lib/admin/usage-format";
import { cn } from "../../lib/utils";

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
  "cursor-pointer rounded-full border-0 [font-family:inherit] font-medium whitespace-nowrap transition-[background-color,color,scale] duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60 forced-colors:aria-pressed:outline";

/**
 * A segmented control of effort levels (assistant-ui's Reasoning effort): one pill button per
 * level, `aria-pressed` on the selected one, inside a group named by an sr-only label. Under the
 * pills, one short line: a thin bar of the spend over the budget and "spent / budget", only when
 * both are known (a budget of 0 counts as unknown: nothing to fill). The line sits under the
 * track and never widens the control past it by more than the readout's few characters, so the
 * toolbar's fold width (KOBE-418) holds with the readout shown.
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
  /** The budget the spend is graded against, in tokens; undefined: unknown. */
  readonly budget?: number | undefined;
  /** The spend is an estimate, not the provider's count. */
  readonly estimated?: boolean | undefined;
  /** The smaller pills on the line below the composer (KOBE-450). */
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const known = spent !== undefined && budget !== undefined && budget > 0;
  const used = known ? pct(spent, budget) : 0;
  const approx = estimated ? "≈" : "";
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-slot="thinking-effort"
      data-size={compact ? "compact" : "default"}
      className={cn("inline-flex min-w-0 shrink-0 flex-col gap-0.5", className)}
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
        <div className="flex items-center gap-1.5">
          <span
            role="progressbar"
            aria-label="Thinking budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={announced(used)}
            aria-valuetext={
              estimated
                ? `about ${formatTokens(spent)} of ${formatTokens(budget)} thinking tokens (estimated)`
                : `${formatTokens(spent)} of ${formatTokens(budget)} thinking tokens`
            }
            className="bg-foreground/[0.06] inset-ring-border block h-[3px] min-w-6 flex-1 overflow-hidden rounded-full inset-ring forced-colors:outline"
          >
            <span
              className="bg-brand-primary block h-full rounded-full transition-[width] duration-500 forced-color-adjust-none motion-reduce:transition-none"
              style={{ width: `${used}%` }}
            />
          </span>
          <span
            aria-hidden
            className="text-muted-foreground shrink-0 font-mono text-[10px] leading-none tracking-tight whitespace-nowrap tabular-nums"
          >
            {approx}
            {formatTokens(spent)} / {formatTokens(budget)}
          </span>
        </div>
      )}
    </div>
  );
}
