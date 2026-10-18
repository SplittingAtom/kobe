"use client";

import {
  THINKING_CONTROLS_BY_KIND,
  THINKING_CONTROLS_WITHOUT_OFF,
  knownThinkingLowest,
  THINKING_LEVELS,
  lowestThinking,
  thinkingRank,
  type ThinkingControl,
  type ThinkingLevel,
  type ThinkingPolicy,
} from "@kobe/protocol";
import { useId, useState } from "react";
import type { CatalogModel, ProviderKind } from "../../../lib/admin/api/site/models";
import { Checkbox, Field, FormRow, Select } from "../../ui/console";

/**
 * A catalog model's thinking settings (KOBE-260): how the model gateway sets the provider's
 * thinking (chosen for the provider, never guessed from the model's name), whether thinking may
 * be on, the level runs use by default and the highest level people may pick per conversation.
 * Only for a model marked as reasoning.
 */

export const NO_THINKING: ThinkingPolicy = {
  control: "none",
  allowed: false,
  default: null,
  max: null,
  lowest: "off",
};

export const THINKING_CONTROL_LABELS: Readonly<Record<ThinkingControl, string>> = {
  none: "Not controlled (the provider decides)",
  reasoning_effort: "reasoning_effort parameter (OpenAI style: OpenAI, Ollama…)",
  anthropic_adaptive: "Adaptive thinking with an effort (can be turned off)",
  anthropic_effort: "Effort only (thinking cannot be turned off)",
  anthropic_budget: "Thinking budget (older Claude models)",
  gemini_budget: "Thinking budget (Gemini thinkingBudget)",
};

export const THINKING_LEVEL_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

export interface ThinkingChoice {
  readonly policy: ThinkingPolicy;
  readonly set: (next: ThinkingPolicy) => void;
  readonly reset: () => void;
}

export function useThinkingChoice(model?: CatalogModel): ThinkingChoice {
  const initial = model?.thinking ?? NO_THINKING;
  const [policy, set] = useState<ThinkingPolicy>(initial);
  return { policy, set, reset: () => set(initial) };
}

const controlsFor = (kind: ProviderKind | undefined): readonly ThinkingControl[] =>
  kind === undefined ? ["none"] : (THINKING_CONTROLS_BY_KIND[kind] ?? ["none"]);

/**
 * The policy the form stands for, made consistent: none without the reasoning flag or for a
 * control the provider does not take; thinking always allowed where it cannot be turned off;
 * levels only when allowed, the default never above the maximum.
 */
export function normalizeThinking(
  p: ThinkingPolicy,
  reasoning: boolean,
  kind: ProviderKind | undefined,
  /** The provider's model id: a family known not to turn thinking off keeps `low` (S2). */
  model = "",
): ThinkingPolicy {
  if (!reasoning || p.control === "none" || !controlsFor(kind).includes(p.control)) {
    return NO_THINKING;
  }
  const lowestValue =
    THINKING_CONTROLS_WITHOUT_OFF.includes(p.control) || knownThinkingLowest(model) === "low"
      ? "low"
      : p.lowest;
  const lowest = lowestThinking({ control: p.control, lowest: lowestValue });
  const allowed = p.allowed || lowest !== "off";
  if (!allowed) {
    return { control: p.control, allowed: false, default: null, max: null, lowest: "off" };
  }
  const max = p.max === null || p.max === "off" ? "high" : p.max;
  const wanted = p.default ?? "low";
  const clamped = thinkingRank(wanted) > thinkingRank(max) ? max : wanted;
  const fallback = thinkingRank(clamped) < thinkingRank(lowest) ? lowest : clamped;
  return { control: p.control, allowed: true, default: fallback, max, lowest: lowestValue };
}

const same = (a: ThinkingPolicy, b: ThinkingPolicy) =>
  a.control === b.control &&
  a.allowed === b.allowed &&
  a.default === b.default &&
  a.max === b.max &&
  a.lowest === b.lowest;

/** `{ thinking }` when the form's policy differs from the stored one (or, new, from none). */
export function thinkingChange(
  choice: ThinkingChoice,
  reasoning: boolean,
  kind: ProviderKind | undefined,
  model?: CatalogModel,
  /** The model id in the form (it may have changed). */
  modelId = model?.model ?? "",
): { readonly thinking?: ThinkingPolicy } {
  const next = normalizeThinking(choice.policy, reasoning, kind, modelId);
  const before = model?.thinking ?? NO_THINKING;
  // An older server sends no thinking settings and takes none.
  if (model !== undefined && model.thinking === undefined && same(next, NO_THINKING)) return {};
  return same(next, before) ? {} : { thinking: next };
}

export function ThinkingFields({
  choice,
  reasoning,
  kind,
  model,
}: {
  readonly choice: ThinkingChoice;
  readonly reasoning: boolean;
  readonly kind: ProviderKind | undefined;
  /** The provider's model id as typed (known families can't turn thinking off). */
  readonly model: string;
}) {
  const id = useId();
  if (!reasoning) return null;
  const controls = controlsFor(kind);
  const p = normalizeThinking(choice.policy, reasoning, kind, model);
  const lowest = p.control === "none" ? "off" : lowestThinking(p);
  const fixedLowest =
    THINKING_CONTROLS_WITHOUT_OFF.includes(p.control) || knownThinkingLowest(model) === "low";
  const set = (over: Partial<ThinkingPolicy>) =>
    choice.set(normalizeThinking({ ...p, ...over }, reasoning, kind, model));
  const levels = THINKING_LEVELS.filter((l) => thinkingRank(l) >= thinkingRank(lowest));
  return (
    <fieldset className="m-0 mb-3 border-0 p-0" aria-describedby={`${id}-hint`}>
      <legend className="mb-1 font-semibold">Thinking</legend>
      <FormRow className="mt-0">
        <Field label="How the gateway sets it">
          <Select
            value={p.control}
            onChange={(e) =>
              set({
                control: e.target.value as ThinkingControl,
                allowed: true,
                default: p.default ?? "low",
                max: p.max ?? "high",
              })
            }
          >
            {controls.map((c) => (
              <option key={c} value={c}>
                {THINKING_CONTROL_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
      </FormRow>
      {p.control !== "none" && (
        <>
          <Checkbox
            label="The model can turn thinking off"
            hint={
              lowest === "off"
                ? "Off is sent to the provider as off."
                : fixedLowest
                  ? "This model can't turn thinking off: Off uses the lowest level (low)."
                  : "Can't be turned off: Off uses the lowest level (low), so it never fails."
            }
            checked={lowest === "off"}
            disabled={fixedLowest}
            onChange={(e) => set({ lowest: e.target.checked ? "off" : "low", allowed: true })}
          />
          <Checkbox
            label="Allow thinking"
            hint={
              lowest === "off"
                ? "Unticked, every run asks this model not to think (thinking off)."
                : "This model can't turn thinking off: the lowest level is low."
            }
            checked={p.allowed}
            disabled={lowest !== "off"}
            onChange={(e) =>
              set({
                allowed: e.target.checked,
                default: e.target.checked ? "low" : null,
                max: e.target.checked ? "high" : null,
              })
            }
          />
          {p.allowed && (
            <FormRow className="mt-3">
              <Field label="Default level">
                <Select
                  value={p.default ?? lowest}
                  onChange={(e) => set({ default: e.target.value as ThinkingLevel })}
                >
                  {levels
                    .filter((l) => thinkingRank(l) <= thinkingRank(p.max ?? "high"))
                    .map((l) => (
                      <option key={l} value={l}>
                        {THINKING_LEVEL_LABELS[l]}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Highest level people may pick">
                <Select
                  value={p.max ?? "high"}
                  onChange={(e) => set({ max: e.target.value as ThinkingLevel })}
                >
                  {levels
                    .filter((l) => l !== "off")
                    .map((l) => (
                      <option key={l} value={l}>
                        {THINKING_LEVEL_LABELS[l]}
                      </option>
                    ))}
                </Select>
              </Field>
            </FormRow>
          )}
        </>
      )}
      <p id={`${id}-hint`} className="m-0 text-sm text-console-muted">
        Pick the mechanism your provider documents for this model. The model gateway writes the
        run&apos;s level into every call in that form, so neither the sandbox nor the agent can
        raise it; team admins can only lower the maximum. Reasoning counts against the output limit.
      </p>
    </fieldset>
  );
}

/** The table cell's text, or "" for a model without a thinking control. */
export function thinkingText(m: CatalogModel): string {
  const p = m.thinking;
  if (p === undefined || p.control === "none") return "";
  if (!p.allowed) return "Thinking off";
  const def = THINKING_LEVEL_LABELS[p.default ?? "low"].toLowerCase();
  const max = THINKING_LEVEL_LABELS[p.max ?? "high"].toLowerCase();
  const fixed = lowestThinking(p) === "low" ? " (can't be turned off)" : "";
  return `Thinking ${def}, up to ${max}${fixed}`;
}
