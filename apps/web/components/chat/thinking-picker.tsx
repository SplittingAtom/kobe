"use client";

import { thinkingRank, type ThinkingLevel } from "@kobe/protocol";
import type { TeamModels } from "../../lib/admin/api/team/models";
import styles from "./chat.module.css";

/** The `<select>` value of "the model's default level". */
const DEFAULT = "";

const LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Thinking off",
  low: "Thinking low",
  medium: "Thinking medium",
  high: "Thinking high",
};

/**
 * The levels the conversation's model offers in this team (KOBE-260), or none: its team
 * settings say what members may pick (site settings narrowed by the team).
 */
export function thinkingChoices(
  models: TeamModels,
  alias: string | null,
): { readonly levels: readonly ThinkingLevel[]; readonly default: ThinkingLevel | null } {
  const model = models.models.find((m) => m.alias === (alias ?? models.default));
  const team = model?.enabled ? model.thinkingInTeam : undefined;
  return { levels: team?.levels ?? [], default: team?.default ?? null };
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

/**
 * The conversation's thinking level (KOBE-260), beside the model picker: shown only when the
 * model lets members choose. The server clamps every run to the site and team settings, so this
 * only asks; a level the team has since lowered shows as what runs get.
 */
export function ThinkingPicker({
  models,
  alias,
  chosen,
  disabled,
  onChoose,
}: {
  readonly models: TeamModels;
  /** The conversation's effective model alias (the agent's pin, the choice, else the default). */
  readonly alias: string | null;
  readonly chosen: ThinkingLevel | null;
  readonly disabled: boolean;
  readonly onChoose: (level: ThinkingLevel | null) => void;
}) {
  const { levels, default: fallback } = thinkingChoices(models, alias);
  if (levels.length === 0) return null;
  const value = shownThinking(chosen, levels);
  return (
    <label className={styles.modelPicker}>
      <span className={styles.visuallyHidden}>Thinking level for this conversation</span>
      <select
        value={value ?? DEFAULT}
        disabled={disabled}
        onChange={(e) =>
          onChoose(e.target.value === DEFAULT ? null : (e.target.value as ThinkingLevel))
        }
      >
        <option value={DEFAULT}>
          {fallback === null ? "Thinking: default" : `${LABELS[fallback]} (default)`}
        </option>
        {levels.map((l) => (
          <option key={l} value={l}>
            {LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
