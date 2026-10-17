import type { GatewayThinkingRow } from "@kobe/db";
import {
  effectiveThinkingLevel,
  lowestThinking,
  narrowThinkingPolicy,
  strictestThinkingPolicy,
  type ThinkingLevel,
  type ThinkingPolicy,
} from "@kobe/protocol";
import type { Route } from "./routes.js";

/**
 * Thinking enforcement (KOBE-260; levels and policies in `@kobe/protocol` thinking.ts, mapping
 * table in docs/design/thinking-controls.md). For a sandbox's call to a model with a thinking
 * control, the gateway decides the level (the run's recorded level, clamped to the site and team
 * settings in force now) and writes it into the request in the control's form. Pi and the
 * sandbox cannot raise it.
 *
 * How the request is rewritten (review S1): the body is **parsed and rebuilt**. Every top-level
 * reasoning field the caller sent is removed first, in any letter case Bifrost's decoder (sonic,
 * matching keys case-insensitively like Go's `encoding/json`) would accept, then the gateway's own
 * fields are added once. Nothing is appended or merged: under Go decoding a repeated key decodes
 * *into* the earlier object, so a caller's `budget_tokens` would survive an appended `thinking`.
 */

/** The strictest policy per gateway model (several aliases may name one model). */
export function thinkingPolicies(
  rows: readonly GatewayThinkingRow[],
): ReadonlyMap<string, ThinkingPolicy> {
  const byModel = new Map<string, ThinkingPolicy[]>();
  for (const row of rows) {
    const policy = narrowThinkingPolicy(
      {
        control: row.control,
        allowed: row.allowed,
        default: row.default,
        max: row.max,
        lowest: row.lowest,
      },
      row.teamMax,
    );
    byModel.set(row.model, [...(byModel.get(row.model) ?? []), policy]);
  }
  return new Map(
    [...byModel].flatMap(([model, policies]) => {
      const p = strictestThinkingPolicy(policies);
      return p === undefined ? [] : [[model, p] as const];
    }),
  );
}

/** The route each control is written for: a controlled model is called through its own API. */
const CONTROL_ROUTE: Readonly<Record<ThinkingPolicy["control"], Route["kind"] | undefined>> = {
  none: undefined,
  reasoning_effort: "openai",
  anthropic_adaptive: "anthropic",
  anthropic_effort: "anthropic",
  anthropic_budget: "anthropic",
  gemini_budget: "gemini",
};

/** Anthropic `budget_tokens` per level (the API's minimum is 1,024, below `max_tokens`). */
export const ANTHROPIC_BUDGET: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 2_048,
  medium: 8_192,
  high: 24_576,
};
const ANTHROPIC_MIN_BUDGET = 1_024;
/**
 * What an Anthropic budget leaves for the answer (review S3): at least 1,024 tokens and at least a
 * quarter of `max_tokens` (the KOBE-259 output limit, reasoning included), so thinking never takes
 * the whole allowance (the KOBE-258 failure).
 */
export const ANSWER_MIN_TOKENS = 1_024;
export const ANSWER_MIN_SHARE = 0.25;
/** Gemini `thinkingBudget` per level (0 turns thinking off where the model allows it). */
export const GEMINI_BUDGET: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 1_024,
  medium: 8_192,
  high: 24_576,
};

/**
 * Top-level fields that set or shape reasoning in some API or provider extension, removed from
 * every call to a controlled model (compared in folded case). `extra_body` / `extra_params` carry
 * provider extras; `fallbacks` is refused before (see {@link hasFallbacks}).
 */
const REASONING_FIELDS = new Set(
  [
    "reasoning_effort",
    "reasoning",
    "reasoning_max_tokens",
    "reasoning_display",
    "reasoning_format",
    "include_reasoning",
    "thinking",
    "think",
    "enable_thinking",
    "thinking_budget",
    "thinking_config",
    "thinkingconfig",
    "thinking_level",
    "budget_tokens",
    "effort",
    "chat_template_kwargs",
    "extra_body",
    "extra_params",
  ].map((k) => fold(k)),
);
const OUTPUT_CONFIG = fold("output_config");
const GENERATION_KEYS = new Set([fold("generationconfig"), fold("generation_config")]);
const THINKING_KEYS = new Set([fold("thinkingconfig"), fold("thinking_config")]);
const MAX_TOKENS = fold("max_tokens");

/**
 * A key as Bifrost's decoder compares it: case-insensitive, Unicode-aware (`toUpperCase` maps the
 * long s `ſ` to `S` and `toLowerCase` the Kelvin sign `K` to `k`, as Go's folding does).
 */
function fold(key: string): string {
  return key.toUpperCase().toLowerCase();
}

export type ThinkingRewrite =
  | {
      readonly ok: true;
      readonly body: Buffer;
      readonly level: ThinkingLevel | undefined;
      /** Thinking tokens the gateway wrote (budget forms): the reservation covers them (S7). */
      readonly budgetTokens?: number;
    }
  | { readonly ok: false; readonly status: 400; readonly code: string; readonly message: string };

/**
 * The level for one call: the run's level clamped to the policy now. A call without a run gets the
 * lowest level (review S4) unless it is an Orbit eval Job's, which has no run and uses the default.
 */
export function callThinkingLevel(
  policy: ThinkingPolicy,
  runLevel: ThinkingLevel | undefined,
  options: { readonly eval?: boolean } = {},
): ThinkingLevel | undefined {
  if (runLevel !== undefined || options.eval === true) {
    return effectiveThinkingLevel(policy, runLevel ?? null);
  }
  return effectiveThinkingLevel(policy, lowestThinking(policy));
}

const refuse = (code: string, message: string): ThinkingRewrite => ({
  ok: false,
  status: 400,
  code,
  message,
});

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The request with the call's thinking level written in the control's form. Count-only routes and
 * models without a control pass unchanged; a controlled model called through another API is
 * refused (its control is only known in its own API's form).
 */
export function applyThinking(
  body: Buffer,
  route: Route,
  policy: ThinkingPolicy | undefined,
  level: ThinkingLevel | undefined,
): ThinkingRewrite {
  if (policy === undefined || policy.control === "none" || level === undefined) {
    return { ok: true, body, level: undefined };
  }
  if (route.path.endsWith("/count_tokens") || route.path.endsWith(":countTokens")) {
    return { ok: true, body, level };
  }
  if (CONTROL_ROUTE[policy.control] !== route.kind) {
    return refuse(
      "thinking_route_refused",
      "This model's thinking is set through its provider's own API; call it there.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return refuse("invalid_request", "The body must be a JSON object.");
  }
  if (!isObject(parsed)) return refuse("invalid_request", "The body must be a JSON object.");
  const stripped = withoutReasoning(parsed);
  const out = (written: JsonObject, budgetTokens?: number): ThinkingRewrite => ({
    ok: true,
    body: Buffer.from(JSON.stringify(written)),
    level,
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  });
  switch (policy.control) {
    case "reasoning_effort": {
      const effort = level === "off" ? "none" : level;
      return out(
        route.path === "/v1/responses"
          ? { ...stripped, reasoning: { effort } }
          : { ...stripped, reasoning_effort: effort },
      );
    }
    case "anthropic_adaptive":
    case "anthropic_effort":
      return out({ ...stripped, ...anthropicAdaptive(level, outputFormat(parsed)) });
    case "anthropic_budget": {
      const thinking = anthropicBudget(level, lastValue(parsed, MAX_TOKENS), policy);
      if (thinking === "no_room") {
        return refuse(
          "thinking_budget_too_small",
          "max_tokens leaves no room for this model's smallest thinking budget (1,024 tokens), " +
            "and it cannot turn thinking off: raise max_tokens above 1,024.",
        );
      }
      return out(
        { ...stripped, thinking },
        thinking.type === "enabled" ? thinking.budget_tokens : undefined,
      );
    }
    case "gemini_budget":
      return out(geminiBudget(stripped, level), GEMINI_BUDGET[level]);
  }
}

/**
 * The body without any reasoning field (and without `output_config`, rebuilt by the caller), and
 * with one `max_tokens` (re-review R1): case variants collapse to the value Go's decoder would read
 * (the last), so the provider and the budget below see the same limit whichever way Bifrost
 * matches keys.
 */
function withoutReasoning(json: JsonObject): JsonObject {
  const maxTokens = lastValue(json, MAX_TOKENS);
  const kept = Object.entries(json).filter(([key]) => {
    const k = fold(key);
    return !REASONING_FIELDS.has(k) && k !== OUTPUT_CONFIG && k !== MAX_TOKENS;
  });
  return Object.fromEntries(
    maxTokens === undefined ? kept : [...kept, ["max_tokens", maxTokens] as const],
  );
}

/** The value Bifrost would read for a folded key: the last one in the body. */
function lastValue(json: JsonObject, folded: string): unknown {
  let value: unknown;
  for (const [key, v] of Object.entries(json)) if (fold(key) === folded) value = v;
  return value;
}

/** The caller's structured-output format (`output_config.format`), the one part kept. */
function outputFormat(json: JsonObject): unknown {
  let format: unknown;
  for (const [key, v] of Object.entries(json)) {
    if (fold(key) !== OUTPUT_CONFIG || !isObject(v)) continue;
    for (const [k, inner] of Object.entries(v)) if (fold(k) === "format") format = inner;
  }
  return format;
}

/** Anthropic adaptive thinking with an effort; `disabled` for off (only where it can be off). */
function anthropicAdaptive(level: ThinkingLevel, format: unknown): JsonObject {
  const keep = format === undefined ? {} : { format };
  if (level === "off") {
    return {
      thinking: { type: "disabled" },
      ...(format === undefined ? {} : { output_config: keep }),
    };
  }
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { ...keep, effort: level },
  };
}

type AnthropicThinking =
  { readonly type: "disabled" } | { readonly type: "enabled"; readonly budget_tokens: number };

/**
 * Anthropic's older budget form (review S3): at most `max_tokens` minus the answer's share, at
 * least 1,024. With less room than that (re-review R3):
 *
 * - a model that can turn thinking off gets `disabled` on purpose: thinking would take the room
 *   the answer needs (the KOBE-258 failure), and the provider accepts it;
 * - a model that cannot gets the smallest budget (1,024) while `max_tokens` is above it, else
 *   `no_room`: the provider would refuse any form, so the gateway refuses with a clear message.
 */
export function anthropicBudget(
  level: ThinkingLevel,
  maxTokens: unknown,
  policy: Pick<ThinkingPolicy, "control" | "lowest">,
): AnthropicThinking | "no_room" {
  if (level === "off") return { type: "disabled" };
  const max =
    typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0
      ? maxTokens
      : undefined;
  const room =
    max === undefined
      ? Infinity
      : max - Math.max(ANSWER_MIN_TOKENS, Math.ceil(max * ANSWER_MIN_SHARE));
  const budget = Math.min(ANTHROPIC_BUDGET[level], room);
  if (budget >= ANTHROPIC_MIN_BUDGET) return { type: "enabled", budget_tokens: budget };
  if (lowestThinking(policy) === "off") return { type: "disabled" };
  return max !== undefined && max > ANTHROPIC_MIN_BUDGET
    ? { type: "enabled", budget_tokens: ANTHROPIC_MIN_BUDGET }
    : "no_room";
}

/** Gemini: `generationConfig.thinkingConfig`, every other generation setting kept. */
function geminiBudget(json: JsonObject, level: ThinkingLevel): JsonObject {
  const thinkingConfig = { thinkingBudget: GEMINI_BUDGET[level], includeThoughts: level !== "off" };
  const out: JsonObject = {};
  let placed = false;
  for (const [key, value] of Object.entries(json)) {
    if (!GENERATION_KEYS.has(fold(key))) {
      out[key] = value;
      continue;
    }
    const config = isObject(value)
      ? Object.fromEntries(Object.entries(value).filter(([k]) => !THINKING_KEYS.has(fold(k))))
      : {};
    out[key] = { ...config, thinkingConfig };
    placed = true;
  }
  if (!placed) out.generationConfig = { thinkingConfig };
  return out;
}
