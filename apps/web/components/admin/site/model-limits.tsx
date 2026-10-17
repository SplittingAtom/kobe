"use client";

import { useId, useState } from "react";
import type { CatalogModel, TokenDefaults } from "../../../lib/admin/api/site/models";
import { Checkbox, Field, FormRow, TextInput } from "../../ui/console";

/**
 * A catalog model's output limit, context window and reasoning flag (KOBE-259). An empty field
 * means the site default (chart values), shown as the field's placeholder; a reasoning model gets
 * the higher output default, since its hidden reasoning spends the same allowance.
 */

/** Bounds the server enforces (`MODEL_OUTPUT_TOKENS_RANGE`, `MODEL_CONTEXT_WINDOW_RANGE`). */
const OUTPUT_RANGE = [256, 131_072] as const;
const WINDOW_RANGE = [1_024, 10_000_000] as const;

const tokens = (n: number) => n.toLocaleString("en-US");

export interface LimitsChoice {
  readonly reasoning: boolean;
  readonly maxOutput: string;
  readonly contextWindow: string;
  readonly setReasoning: (v: boolean) => void;
  readonly setMaxOutput: (v: string) => void;
  readonly setContextWindow: (v: string) => void;
  readonly reset: () => void;
}

const text = (n: number | null | undefined) => (n == null ? "" : String(n));

export function useLimitsChoice(model?: CatalogModel): LimitsChoice {
  const initial = {
    reasoning: model?.reasoning ?? false,
    maxOutput: text(model?.maxOutputTokens),
    contextWindow: text(model?.contextWindow),
  };
  const [reasoning, setReasoning] = useState(initial.reasoning);
  const [maxOutput, setMaxOutput] = useState(initial.maxOutput);
  const [contextWindow, setContextWindow] = useState(initial.contextWindow);
  return {
    reasoning,
    maxOutput,
    contextWindow,
    setReasoning,
    setMaxOutput,
    setContextWindow,
    reset: () => {
      setReasoning(initial.reasoning);
      setMaxOutput(initial.maxOutput);
      setContextWindow(initial.contextWindow);
    },
  };
}

const parsed = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/**
 * What changed against `model` (an edit: null clears a value back to the default), or everything
 * set (a new model: empty fields and an unticked flag are left out).
 */
export function limitsChange(
  choice: LimitsChoice,
  model?: CatalogModel,
): {
  readonly reasoning?: boolean;
  readonly maxOutputTokens?: number | null;
  readonly contextWindow?: number | null;
} {
  const maxOutput = parsed(choice.maxOutput);
  const contextWindow = parsed(choice.contextWindow);
  // `??`: an older server (rolling upgrade) sends no limits at all.
  const before = {
    reasoning: model?.reasoning ?? false,
    maxOutputTokens: model?.maxOutputTokens ?? null,
    contextWindow: model?.contextWindow ?? null,
  };
  return {
    ...(choice.reasoning !== before.reasoning ? { reasoning: choice.reasoning } : {}),
    ...(maxOutput !== before.maxOutputTokens ? { maxOutputTokens: maxOutput } : {}),
    ...(contextWindow !== before.contextWindow ? { contextWindow } : {}),
  };
}

function defaultOutput(reasoning: boolean, defaults: TokenDefaults | undefined) {
  if (defaults === undefined) return undefined;
  return reasoning ? defaults.reasoningMaxOutputTokens : defaults.maxOutputTokens;
}

export function LimitsFields({
  choice,
  defaults,
}: {
  readonly choice: LimitsChoice;
  readonly defaults: TokenDefaults | undefined;
}) {
  const id = useId();
  const output = defaultOutput(choice.reasoning, defaults);
  return (
    <>
      <Checkbox
        label="Reasons before answering (a thinking model)."
        hint="Its reasoning counts against the output limit, so it gets the higher default, and Kobe's short calls after a run (conversation titles) ask it for low reasoning effort with more room."
        checked={choice.reasoning}
        onChange={(e) => choice.setReasoning(e.target.checked)}
      />
      <FormRow className="mt-3">
        <Field label="Output limit (tokens, optional)">
          <TextInput
            type="number"
            inputMode="numeric"
            className="w-48"
            min={OUTPUT_RANGE[0]}
            max={OUTPUT_RANGE[1]}
            step={1}
            placeholder={output === undefined ? "Site default" : `Site default: ${tokens(output)}`}
            aria-describedby={`${id}-limits`}
            value={choice.maxOutput}
            onChange={(e) => choice.setMaxOutput(e.target.value)}
          />
        </Field>
        <Field label="Context window (tokens, optional)">
          <TextInput
            type="number"
            inputMode="numeric"
            className="w-48"
            min={WINDOW_RANGE[0]}
            max={WINDOW_RANGE[1]}
            step={1}
            placeholder={
              defaults === undefined
                ? "Site default"
                : `Site default: ${tokens(defaults.contextWindow)}`
            }
            aria-describedby={`${id}-limits`}
            value={choice.contextWindow}
            onChange={(e) => choice.setContextWindow(e.target.value)}
          />
        </Field>
        <p id={`${id}-limits`} className="m-0 basis-full text-sm text-console-muted">
          Leave a field empty for the site default. Each model call may write up to the output
          limit, reasoning included: budgets hold that much while it runs, and a call that is
          stopped or cut off is charged all of it. Use the values your provider documents for this
          model: it refuses calls above its own maximum.
        </p>
      </FormRow>
    </>
  );
}

/** The table cell: each limit, marked when it is a default. */
export function limitsText(m: CatalogModel, defaults: TokenDefaults | undefined): string {
  const output =
    // `== null`: an older server (rolling upgrade) sends no limits at all.
    m.maxOutputTokens != null
      ? tokens(m.maxOutputTokens)
      : `${outputDefaultText(m.reasoning, defaults)} (${m.reasoning ? "reasoning" : "site"} default)`;
  const window =
    m.contextWindow != null
      ? tokens(m.contextWindow)
      : `${defaults === undefined ? "—" : tokens(defaults.contextWindow)} (site default)`;
  return `Output ${output} · Window ${window}${m.reasoning ? " · Reasons" : ""}`;
}

function outputDefaultText(reasoning: boolean, defaults: TokenDefaults | undefined): string {
  const n = defaultOutput(reasoning, defaults);
  return n === undefined ? "—" : tokens(n);
}
