import { z } from "zod";

/**
 * Thinking controls (KOBE-260): how much a reasoning model may think, set per model by site
 * admins, narrowed per team, chosen per chat by members, and enforced by the model gateway on
 * every call (the sandbox and Pi cannot raise it).
 *
 * **Levels** are provider-neutral: {@link THINKING_LEVELS}, ordered. Each model names the
 * **control** its provider understands ({@link THINKING_CONTROLS}, chosen by a site admin, never
 * guessed from the model name); the gateway writes the level into the request in that control's
 * form (services/model-gateway/src/thinking.ts, mapping table in docs/design/thinking-controls.md).
 *
 * **Policy** of a model ({@link ThinkingPolicy}): its control, whether thinking is allowed at all,
 * the default level and the highest level members may pick. A team may lower the maximum
 * ({@link narrowThinkingPolicy}); the effective level of a run is the member's choice (or the
 * default) clamped into the policy ({@link effectiveThinkingLevel}).
 */
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const thinkingLevelSchema = z.enum(THINKING_LEVELS, {
  error: "a thinking level is off, low, medium or high",
});

/**
 * How a provider turns thinking on, off and up (the request fields the gateway writes):
 *
 * - `none`: the provider offers no control; Kobe sends nothing and records no level.
 * - `reasoning_effort`: OpenAI-style `reasoning_effort` (`none` for off). OpenAI, Ollama (its
 *   OpenAI-compatible API maps `none` to `think: false`) and OpenAI-compatible servers that
 *   honour it.
 * - `anthropic_adaptive`: Anthropic adaptive thinking with `output_config.effort`; off is
 *   `thinking: {type: "disabled"}` (models that accept turning it off).
 * - `anthropic_effort`: Anthropic `output_config.effort` only; thinking cannot be turned off
 *   (models that refuse `disabled`), so the lowest level is `low`.
 * - `anthropic_budget`: Anthropic `thinking: {type: "enabled", budget_tokens}` (older models);
 *   off is `disabled`.
 * - `gemini_budget`: Gemini `generationConfig.thinkingConfig.thinkingBudget` (0 for off, for
 *   models that allow it).
 */
export const THINKING_CONTROLS = [
  "none",
  "reasoning_effort",
  "anthropic_adaptive",
  "anthropic_effort",
  "anthropic_budget",
  "gemini_budget",
] as const;
export type ThinkingControl = (typeof THINKING_CONTROLS)[number];
export const thinkingControlSchema = z.enum(THINKING_CONTROLS, {
  error: "not a supported thinking control",
});

/** Controls that cannot turn thinking off at all: their lowest level is always `low`. */
export const THINKING_CONTROLS_WITHOUT_OFF: readonly ThinkingControl[] = ["anthropic_effort"];

/**
 * The lowest level a model accepts (KOBE-260 review S2): `off` when its provider can turn
 * thinking off, `low` when it cannot (o-series and GPT-5, Gemini 2.5/3 Pro, Claude Sonnet 5.5 and
 * Opus 5.5, …). `off` is then never sent: it means the lowest level, so it never causes a 400.
 */
export const THINKING_LOWEST = ["off", "low"] as const;
export type ThinkingLowest = (typeof THINKING_LOWEST)[number];
export const thinkingLowestSchema = z.enum(THINKING_LOWEST, {
  error: "the lowest level is off or low",
});

/** The provider kinds (model catalog) each control fits: it is written in that API's form. */
export const THINKING_CONTROLS_BY_KIND: Readonly<Record<string, readonly ThinkingControl[]>> = {
  openai: ["none", "reasoning_effort"],
  ollama: ["none", "reasoning_effort"],
  openai_compatible: ["none", "reasoning_effort"],
  anthropic: ["none", "anthropic_adaptive", "anthropic_effort", "anthropic_budget"],
  gemini: ["none", "gemini_budget"],
};

/** Whether `control` may be chosen for a model of provider `kind`. */
export function thinkingControlFits(kind: string, control: ThinkingControl): boolean {
  return (THINKING_CONTROLS_BY_KIND[kind] ?? ["none"]).includes(control);
}

export const thinkingRank = (level: ThinkingLevel): number => THINKING_LEVELS.indexOf(level);
export const minThinking = (a: ThinkingLevel, b: ThinkingLevel): ThinkingLevel =>
  thinkingRank(a) <= thinkingRank(b) ? a : b;
const maxThinking = (a: ThinkingLevel, b: ThinkingLevel): ThinkingLevel =>
  thinkingRank(a) >= thinkingRank(b) ? a : b;

/**
 * The lowest level a model's policy can express: `low` for a control without off, else the
 * model's own `lowest`.
 */
export function lowestThinking(policy: Pick<ThinkingPolicy, "control" | "lowest">): ThinkingLevel {
  return THINKING_CONTROLS_WITHOUT_OFF.includes(policy.control) ? "low" : policy.lowest;
}

/**
 * A model's thinking settings. `allowed` false (only for a model that can turn it off): thinking
 * is off for every run. `allowed` true: runs use `default` unless the member picks another level,
 * at most `max`, never below `lowest`. `control: "none"`: Kobe does not control it (`allowed`
 * false, levels null, lowest off).
 */
export interface ThinkingPolicy {
  readonly control: ThinkingControl;
  readonly allowed: boolean;
  readonly default: ThinkingLevel | null;
  readonly max: ThinkingLevel | null;
  readonly lowest: ThinkingLowest;
}

/** Why a site policy is refused (API validation; the database checks the same rules). */
export function thinkingPolicyProblem(p: ThinkingPolicy, reasoning: boolean): string | undefined {
  if (p.control === "none") {
    return p.allowed || p.default !== null || p.max !== null || p.lowest !== "off"
      ? "a model without a thinking control has no thinking levels"
      : undefined;
  }
  if (!reasoning) return "thinking controls are only for a model marked as reasoning";
  if (THINKING_CONTROLS_WITHOUT_OFF.includes(p.control) && p.lowest !== "low") {
    return "this control cannot turn thinking off, so its lowest level is low";
  }
  const lowest = lowestThinking(p);
  if (!p.allowed) {
    if (lowest !== "off") return "this model cannot turn thinking off, so thinking stays allowed";
    return p.default !== null || p.max !== null
      ? "levels are only set when thinking is allowed"
      : undefined;
  }
  if (p.default === null || p.max === null) return "thinking needs a default and a maximum level";
  if (p.max === "off") return "the maximum level is above off when thinking is allowed";
  if (thinkingRank(p.default) < thinkingRank(lowest))
    return "this model cannot turn thinking off, so the default is at least low";
  if (thinkingRank(p.default) > thinkingRank(p.max)) return "the default is above the maximum";
  return undefined;
}

/**
 * The site policy narrowed by a team's maximum (`null`: the site's). A team can only lower it:
 * `off` (where the control can turn it off) disallows thinking for the team; a level above the
 * site's is ignored; the default comes down to the maximum.
 */
export function narrowThinkingPolicy(
  site: ThinkingPolicy,
  teamMax: ThinkingLevel | null,
): ThinkingPolicy {
  if (teamMax === null || site.control === "none" || !site.allowed) return site;
  const lowest = lowestThinking(site);
  const max = maxThinking(minThinking(site.max ?? lowest, teamMax), lowest);
  if (max === "off") {
    return { control: site.control, allowed: false, default: null, max: null, lowest: "off" };
  }
  return {
    control: site.control,
    allowed: true,
    default: minThinking(site.default ?? lowest, max),
    max,
    lowest: site.lowest,
  };
}

/** Whether a team maximum narrows (or keeps) the site policy: never above the site's maximum. */
export function teamThinkingProblem(
  site: ThinkingPolicy,
  teamMax: ThinkingLevel | null,
): string | undefined {
  if (teamMax === null) return undefined;
  if (site.control === "none") return "this model has no thinking control";
  if (!site.allowed) {
    return teamMax === "off" ? undefined : "thinking is off for this model on the site";
  }
  if (thinkingRank(teamMax) > thinkingRank(site.max ?? "off")) {
    return "a team can only lower the site's maximum";
  }
  if (thinkingRank(teamMax) < thinkingRank(lowestThinking(site))) {
    return "this model cannot turn thinking off";
  }
  return undefined;
}

/**
 * The level a run or call uses: the requested level (a member's per-chat choice, a run's
 * recorded level), else the policy's default, clamped into the policy. Undefined for a model
 * without a control (nothing is sent; the provider decides).
 */
export function effectiveThinkingLevel(
  policy: ThinkingPolicy,
  requested: ThinkingLevel | null | undefined,
): ThinkingLevel | undefined {
  if (policy.control === "none") return undefined;
  const lowest = lowestThinking(policy);
  if (!policy.allowed) return lowest;
  const max = policy.max ?? lowest;
  const wanted = requested ?? policy.default ?? lowest;
  return maxThinking(minThinking(wanted, max), lowest);
}

/** The levels a member may pick for a model (empty: no choice to offer). */
export function selectableThinkingLevels(policy: ThinkingPolicy): readonly ThinkingLevel[] {
  if (policy.control === "none" || !policy.allowed || policy.max === null) return [];
  const from = thinkingRank(lowestThinking(policy));
  const to = thinkingRank(policy.max);
  return to > from ? THINKING_LEVELS.slice(from, to + 1) : [];
}

/** How strict a policy is: its ceiling (-1 when thinking is off). */
const ceiling = (p: ThinkingPolicy): number =>
  p.control === "none" ? Infinity : p.allowed && p.max !== null ? thinkingRank(p.max) : -1;

/**
 * The strictest of several policies for one provider model (several catalog aliases may name it;
 * review N1): the server records and the gateway writes the same level. Undefined for none.
 */
export function strictestThinkingPolicy(
  policies: readonly ThinkingPolicy[],
): ThinkingPolicy | undefined {
  let out: ThinkingPolicy | undefined;
  for (const p of policies) if (out === undefined || ceiling(p) < ceiling(out)) out = p;
  return out;
}
