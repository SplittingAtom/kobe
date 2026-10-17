import type { ThinkingLowest, ThinkingPolicy } from "./thinking.js";

/**
 * What Kobe knows about well-known model families' thinking (KOBE-260 review S2): which cannot
 * turn thinking off, and which refuse Anthropic's `budget_tokens`. Used as the default when a site
 * admin adds a model, and to refuse a catalog entry that would make every "off" run fail. The site
 * admin still chooses the control and the lowest level for anything not listed here.
 */

/** The model id's last path segment in lower case (`openai/gpt-5` → `gpt-5`). */
const bare = (model: string): string => model.toLowerCase().split("/").at(-1) ?? "";

/** Families whose provider refuses to turn thinking off (`none`, `budget 0`, `disabled`). */
const NO_OFF: readonly RegExp[] = [
  // OpenAI reasoning models: o-series and GPT-5 (5.1 and later accept `none`); GPT-5 Pro.
  /^o\d/,
  /^gpt-5(-(mini|nano|codex|chat))?(-\d{4}-\d{2}-\d{2})?$/,
  /^gpt-5.*-pro/,
  /^gpt-6(?!-(sol|luna))/,
  // Gemini Pro models think always (`thinkingBudget: 0` is refused).
  /^gemini-2\.5-pro/,
  /^gemini-3(\.\d+)?-pro/,
  // Claude models that refuse `thinking: {type: "disabled"}`.
  /^claude-(opus|sonnet)-5-5/,
  /^claude-(fable|mythos)/,
];

/** Claude models that refuse `thinking: {type: "enabled", budget_tokens}`. */
const NO_BUDGET = /^claude-(opus-4-[7-9]|opus-[5-9]|sonnet-[5-9]|haiku-[5-9]|fable|mythos)/;

/** The lowest level a known model accepts (`low` when it cannot turn thinking off), else none. */
export function knownThinkingLowest(model: string): ThinkingLowest | undefined {
  const id = bare(model);
  return NO_OFF.some((r) => r.test(id)) ? "low" : undefined;
}

/** Why a policy does not fit a known model, or undefined. */
export function knownThinkingProblem(model: string, policy: ThinkingPolicy): string | undefined {
  if (policy.control === "none") return undefined;
  if (knownThinkingLowest(model) === "low" && policy.lowest === "off") {
    return `${model} cannot turn thinking off: set its lowest level to low`;
  }
  if (policy.control === "anthropic_budget" && NO_BUDGET.test(bare(model))) {
    return `${model} refuses thinking budgets: use adaptive thinking or effort`;
  }
  return undefined;
}
