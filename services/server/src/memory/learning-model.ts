import type { KobeTx } from "@kobe/db";
import { isModelEnabled } from "../models/team-store.js";
import { readMemorySiteSettings } from "./site-settings.js";
import { readSwitches } from "./switches.js";

/**
 * The learning model (KOBE-381, SM14, Q5), resolved like the skills judge
 * (`skills/evals/start.ts` `judgeModelFor`): the Site's learning model when this Workspace
 * enabled it; else the Workspace's own learning model while it is still enabled; else Learn is
 * unavailable, with a reason. It **never** falls back to the thread's model or the Workspace
 * default: chat content goes only to a model an admin chose for learning.
 */

export type LearningModel =
  | { readonly ok: true; readonly alias: string; readonly source: "site" | "team" }
  | {
      readonly ok: false;
      readonly reason: LearnUnavailableReason;
      readonly message: string;
    };

export const LEARN_UNAVAILABLE_REASONS = [
  "memory_off",
  "learn_off",
  "no_learning_model",
  "learning_model_not_enabled",
] as const;
export type LearnUnavailableReason = (typeof LEARN_UNAVAILABLE_REASONS)[number];

const MESSAGES: Readonly<Record<LearnUnavailableReason, string>> = {
  memory_off: "Memories are turned off for this workspace.",
  learn_off: "Learn from this chat is turned off for this workspace.",
  no_learning_model:
    "No learning model is set. A site admin sets one in Site settings › Memory, or a team admin in Workspace settings › Memory.",
  learning_model_not_enabled:
    "The learning model isn't enabled in this workspace. A team admin enables it in Workspace settings › Models, or picks another learning model.",
};

const unavailable = (reason: LearnUnavailableReason): LearningModel => ({
  ok: false,
  reason,
  message: MESSAGES[reason],
});

/**
 * Pure choice (tested): `enabled` answers whether the Workspace enabled an alias. No thread or
 * default model is an input, so none can be chosen.
 */
export async function pickLearningModel(
  siteAlias: string | null,
  teamAlias: string | null,
  enabled: (alias: string) => Promise<boolean>,
): Promise<LearningModel> {
  if (siteAlias !== null && (await enabled(siteAlias)))
    return { ok: true, alias: siteAlias, source: "site" };
  if (teamAlias !== null && (await enabled(teamAlias)))
    return { ok: true, alias: teamAlias, source: "team" };
  if (siteAlias === null && teamAlias === null) return unavailable("no_learning_model");
  return unavailable("learning_model_not_enabled");
}

/** The model alone (inside the caller's `withTeam` transaction), whatever the switches say. */
export async function learningModelFor(tx: KobeTx, teamId: string): Promise<LearningModel> {
  const site = await readMemorySiteSettings(tx);
  const { team } = await readSwitches(tx, teamId);
  return pickLearningModel(site.learning_model_alias, team.learningModelAlias, (a) =>
    isModelEnabled(tx, teamId, a),
  );
}

/** Whether Learn from this chat can run in this Workspace now, and with which model. */
export async function learnAvailability(tx: KobeTx, teamId: string): Promise<LearningModel> {
  const { memory } = await readSwitches(tx, teamId);
  if (!memory.memories) return unavailable("memory_off");
  if (!memory.learn) return unavailable("learn_off");
  return learningModelFor(tx, teamId);
}
