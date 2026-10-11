import { MODEL_CONTEXT_WINDOW_RANGE, MODEL_OUTPUT_TOKENS_RANGE } from "@kobe/db";
import type { ModelLimits } from "@kobe/protocol";
import { z } from "zod";

/**
 * A model's output limit and context window (KOBE-259). The catalog may set both per model; a null
 * falls back to these site defaults (chart `server.modelDefaults`, config
 * `KOBE_MODEL_DEFAULT_*`). Reasoning models (the catalog's admin-set `reasoning` flag) get a
 * higher output default: their hidden reasoning spends the same allowance as the answer.
 */
export interface ModelTokenDefaults {
  readonly maxOutputTokens: number;
  readonly reasoningMaxOutputTokens: number;
  readonly contextWindow: number;
}

/**
 * - 16,384 output tokens: what every model got before KOBE-259, so nothing changes for models
 *   that do not reason.
 * - 32,768 for reasoning models: twice that, since glm-5.3 spent all 16,384 on reasoning (KOBE-258
 *   incident). Not any provider's maximum; a provider that allows less refuses the call, and an
 *   admin then sets the model's own limit.
 * - 128,000 context window: the value Pi used for every model before.
 */
export const MODEL_TOKEN_DEFAULTS: ModelTokenDefaults = {
  maxOutputTokens: 16_384,
  reasoningMaxOutputTokens: 32_768,
  contextWindow: 128_000,
};

/** What the catalog holds for a model (nulls: the defaults). */
export interface CatalogTokenLimits {
  readonly maxOutputTokens: number | null;
  readonly contextWindow: number | null;
  readonly reasoning: boolean;
}

/**
 * The limits a run's model gets: the catalog's values, else the defaults. An output limit that
 * would fill the window (a default next to a small window set in the catalog, or a default window
 * lowered after an admin's limit was set) becomes half the window, so input always has room.
 */
export function effectiveModelLimits(
  catalog: CatalogTokenLimits,
  defaults: ModelTokenDefaults,
): ModelLimits {
  const contextWindow = catalog.contextWindow ?? defaults.contextWindow;
  const wanted =
    catalog.maxOutputTokens ??
    (catalog.reasoning ? defaults.reasoningMaxOutputTokens : defaults.maxOutputTokens);
  return {
    max_output_tokens: wanted < contextWindow ? wanted : Math.floor(contextWindow / 2),
    context_window: contextWindow,
  };
}

/**
 * The window an admin's output limit must stay below (the model's own, else the default), when
 * the limit does not; undefined when it fits or is not set.
 */
export function outputLimitProblem(
  maxOutputTokens: number | null,
  contextWindow: number | null,
  defaults: ModelTokenDefaults,
): number | undefined {
  if (maxOutputTokens === null) return undefined;
  const window = contextWindow ?? defaults.contextWindow;
  return maxOutputTokens < window ? undefined : window;
}

const tokens = (name: string, [min, max]: readonly [number, number], fallback: number) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .min(min, `${name} must be between ${min} and ${max}`)
    .max(max, `${name} must be between ${min} and ${max}`)
    .default(fallback);

const tokenDefaultsSchema = z
  .object({
    KOBE_MODEL_DEFAULT_MAX_OUTPUT_TOKENS: tokens(
      "KOBE_MODEL_DEFAULT_MAX_OUTPUT_TOKENS",
      MODEL_OUTPUT_TOKENS_RANGE,
      MODEL_TOKEN_DEFAULTS.maxOutputTokens,
    ),
    KOBE_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS: tokens(
      "KOBE_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS",
      MODEL_OUTPUT_TOKENS_RANGE,
      MODEL_TOKEN_DEFAULTS.reasoningMaxOutputTokens,
    ),
    KOBE_MODEL_DEFAULT_CONTEXT_WINDOW: tokens(
      "KOBE_MODEL_DEFAULT_CONTEXT_WINDOW",
      MODEL_CONTEXT_WINDOW_RANGE,
      MODEL_TOKEN_DEFAULTS.contextWindow,
    ),
  })
  .superRefine((v, ctx) => {
    for (const name of [
      "KOBE_MODEL_DEFAULT_MAX_OUTPUT_TOKENS",
      "KOBE_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS",
    ] as const) {
      if (v[name] >= v.KOBE_MODEL_DEFAULT_CONTEXT_WINDOW) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `${name} must be below KOBE_MODEL_DEFAULT_CONTEXT_WINDOW`,
        });
      }
    }
  });

/** The site defaults from the environment (config `KOBE_MODEL_DEFAULT_*`, KOBE-259). */
export function parseModelTokenDefaults(env: Readonly<Record<string, string | undefined>>) {
  return tokenDefaultsSchema
    .transform((v): ModelTokenDefaults => ({
      maxOutputTokens: v.KOBE_MODEL_DEFAULT_MAX_OUTPUT_TOKENS,
      reasoningMaxOutputTokens: v.KOBE_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS,
      contextWindow: v.KOBE_MODEL_DEFAULT_CONTEXT_WINDOW,
    }))
    .safeParse(env);
}
