"use client";

import { thinkingRank, type ThinkingControl, type ThinkingLevel } from "@kobe/protocol";
import type { TeamModels } from "../../lib/admin/api/team/models";
import { ThinkingEffort } from "./thinking-effort";

export const THINKING_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Thinking off",
  low: "Thinking low",
  medium: "Thinking medium",
  high: "Thinking high",
};

/** The "model's default" choice, naming the level when the team sets one. */
export function thinkingDefaultLabel(fallback: ThinkingLevel | null): string {
  return fallback === null ? "Thinking: default" : `${THINKING_LABELS[fallback]} (default)`;
}

/**
 * The levels the conversation's model offers in this team (KOBE-260), or none: its team
 * settings say what members may pick (site settings narrowed by the team), and its control
 * (KOBE-557; null when unknown).
 */
export function thinkingChoices(
  models: TeamModels,
  alias: string | null,
): {
  readonly levels: readonly ThinkingLevel[];
  readonly default: ThinkingLevel | null;
  readonly control: ThinkingControl | null;
} {
  const model = models.models.find((m) => m.alias === (alias ?? models.default));
  const team = model?.enabled ? model.thinkingInTeam : undefined;
  return {
    levels: team?.levels ?? [],
    default: team?.default ?? null,
    control: team?.control ?? null,
  };
}

/** A chosen level as the runs will use it: never above what the team now allows. */
export function shownThinking(
  chosen: ThinkingLevel | null,
  levels: readonly ThinkingLevel[],
): ThinkingLevel | null {
  if (chosen === null || levels.length === 0) return chosen;
  if (levels.includes(chosen)) return chosen;
  const top = levels.at(-1) as ThinkingLevel;
  return thinkingRank(chosen) > thinkingRank(top) ? top : (levels[0] as ThinkingLevel);
}

/** The pills' labels (KOBE-556): the level alone, the group says it is thinking. */
export const EFFORT_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** The default pill's tooltip (KOBE-556). */
export const MODEL_DEFAULT_TITLE = "Model's default";

/**
 * The conversation's thinking level (KOBE-260), beside the model picker: shown only when the
 * model lets members choose. Since KOBE-556 it is assistant-ui's Reasoning effort control
 * (thinking-effort.tsx): one pill per level the team allows, the member's choice pressed, else
 * the default's pill (titled "Model's default"; choosing it stores null so the conversation keeps
 * following the team's default). The server clamps every run to the site and team settings, so
 * this only asks; a level the team has since lowered shows as what runs get. The pills are about
 * the next run; the latest run's reasoning spend is recorded by KOBE-557 (usage API) and no longer
 * shown in the composer (KOBE-574).
 */
export function ThinkingPicker({
  models,
  alias,
  chosen,
  disabled,
  onChoose,
  compact = false,
}: {
  readonly models: TeamModels;
  /** The conversation's effective model alias (the agent's pin, the choice, else the default). */
  readonly alias: string | null;
  readonly chosen: ThinkingLevel | null;
  readonly disabled: boolean;
  readonly onChoose: (level: ThinkingLevel | null) => void;
  /** The smaller pills on the line below the composer (KOBE-450). */
  readonly compact?: boolean;
}) {
  const { levels, default: fallback } = thinkingChoices(models, alias);
  const shown = shownThinking(chosen, levels) ?? fallback;
  if (levels.length === 0) return null;
  return (
    <ThinkingEffort
      label="Thinking level for this conversation"
      levels={levels.map((l) => ({
        key: l,
        label: EFFORT_LABELS[l],
        ...(l === fallback ? { hint: MODEL_DEFAULT_TITLE } : {}),
      }))}
      selectedKey={shown}
      disabled={disabled}
      onSelect={(key) => onChoose(key === fallback ? null : (key as ThinkingLevel))}
      compact={compact}
    />
  );
}
