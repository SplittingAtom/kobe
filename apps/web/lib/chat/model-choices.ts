/**
 * The conversation's model choices (KOBE-44, D30), shared by the model picker and "Regenerate
 * with…" (CE17, KOBE-217): the team's enabled models; the conversation's choice, where null means
 * "follow the team default" (never the default's alias); a choice the team has since disabled;
 * and the agent's pin, which wins over all of it (user decision, KOBE-44).
 */
import { modelName, type TeamModel, type TeamModels } from "../admin/api/team/models";

export interface ModelChoices {
  /** The agent's pinned alias, or null: with a pin there is nothing to choose. */
  readonly pinned: string | null;
  readonly enabled: readonly TeamModel[];
  /** The conversation's choice; null follows the team default. */
  readonly chosen: string | null;
  /** A choice the team has since disabled (runs on it fail until another is chosen). */
  readonly unavailable: boolean;
  /** The team default, when it is enabled. */
  readonly defaultModel: TeamModel | undefined;
}

export function modelChoices(
  data: TeamModels,
  chosen: string | null,
  agentModel: string | null,
): ModelChoices {
  const enabled = data.models.filter((m) => m.enabled);
  return {
    pinned: agentModel,
    enabled,
    chosen,
    unavailable: chosen !== null && !enabled.some((m) => m.alias === chosen),
    defaultModel: enabled.find((m) => m.alias === data.default),
  };
}

/** "Team default (Kimi K2.7 Code)", or "Team default" when the default isn't enabled. */
export function teamDefaultLabel(choices: Pick<ModelChoices, "defaultModel">): string {
  return choices.defaultModel
    ? `Team default (${modelName(choices.defaultModel)})`
    : "Team default";
}

/** A model's name by alias: its catalog label, else the alias itself. */
export function aliasName(data: TeamModels, alias: string): string {
  const model = data.models.find((m) => m.alias === alias);
  return model ? modelName(model) : alias;
}
