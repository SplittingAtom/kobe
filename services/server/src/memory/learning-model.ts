import { eq, modelCatalog, type KobeTx } from "@kobe/db";
import { isModelEnabled } from "../models/team-store.js";
import { readMemorySiteSettings } from "./site-settings.js";
import { readSwitches, type MemorySwitches } from "./switches.js";

/**
 * The learning model (KOBE-381, SM14, Q5), in the judge pattern's "fails clearly" form
 * (`skills/evals/start.ts` `judgeModelFor`, minus its fallbacks): the Workspace's own learning
 * model when one is set (it must be enabled in the Workspace), else the Site's learning model
 * (it must be enabled in the Workspace), else Learn is unavailable, with a reason. A set but
 * unusable choice never falls through to the other one, and nothing **ever** falls back to the
 * thread's model or the Workspace default: chat content goes only to a model an admin chose.
 */

export type LearningModel =
  | { readonly ok: true; readonly alias: string; readonly source: "site" | "team" }
  | {
      readonly ok: false;
      readonly reason: LearnUnavailableReason;
      readonly message: string;
    };

/** Each names the actual cause and where to fix it (review L4). */
export const LEARN_UNAVAILABLE_REASONS = [
  "site_memory_off",
  "memory_off",
  "site_learn_off",
  "learn_off",
  "no_learning_model",
  "learning_model_not_enabled",
  "learning_model_removed",
  "invalid_learning_model",
] as const;
export type LearnUnavailableReason = (typeof LEARN_UNAVAILABLE_REASONS)[number];

const MESSAGES: Readonly<Record<LearnUnavailableReason, string>> = {
  site_memory_off:
    "A site admin turned memory or memories off for the site (Site settings › Memory).",
  memory_off: "Memory or memories are turned off for this workspace (Workspace settings › Memory).",
  site_learn_off:
    "A site admin turned Learn from this chat off for the site (Site settings › Memory).",
  learn_off: "Learn from this chat is turned off for this workspace (Workspace settings › Memory).",
  no_learning_model:
    "No learning model is set. A site admin sets one in Site settings › Memory, or a team admin in Workspace settings › Memory.",
  learning_model_not_enabled:
    "The learning model isn't enabled in this workspace. A team admin enables it in Workspace settings › Models, or picks another learning model in Workspace settings › Memory.",
  learning_model_removed:
    "The learning model was removed from the site's models. Choose another learning model (Workspace settings › Memory, or Site settings › Memory for the site's).",
  invalid_learning_model:
    "This workspace's stored learning model isn't valid. A team admin chooses it again in Workspace settings › Memory.",
};

const unavailable = (reason: LearnUnavailableReason): LearningModel => ({
  ok: false,
  reason,
  message: MESSAGES[reason],
});

/** What the Workspace's models say about one alias. */
export type ModelState = "enabled" | "not_enabled" | "removed";

/**
 * Pure choice (tested): the Workspace's own model when set (`teamAlias`, or `teamAliasInvalid`
 * for a stored value that no longer parses: that fails, it never means "unset"), else the Site's.
 * `state` answers for the one chosen alias. No thread or default model is an input, so none can
 * be chosen, and a set but unusable choice never falls through.
 */
export async function pickLearningModel(
  siteAlias: string | null,
  teamAlias: string | null,
  state: (alias: string) => Promise<ModelState>,
  teamAliasInvalid = false,
): Promise<LearningModel> {
  if (teamAliasInvalid) return unavailable("invalid_learning_model");
  const [alias, source] =
    teamAlias !== null ? [teamAlias, "team" as const] : [siteAlias, "site" as const];
  if (alias === null) return unavailable("no_learning_model");
  const s = await state(alias);
  if (s === "removed") return unavailable("learning_model_removed");
  if (s === "not_enabled") return unavailable("learning_model_not_enabled");
  return { ok: true, alias, source };
}

async function modelState(tx: KobeTx, teamId: string, alias: string): Promise<ModelState> {
  if (await isModelEnabled(tx, teamId, alias)) return "enabled";
  const [m] = await tx
    .select({ alias: modelCatalog.alias })
    .from(modelCatalog)
    .where(eq(modelCatalog.alias, alias));
  return m ? "not_enabled" : "removed";
}

/**
 * The model alone (inside the caller's `withTeam` transaction), whatever the switches say. Pass
 * the switches when already read (review L6).
 */
export async function learningModelFor(
  tx: KobeTx,
  teamId: string,
  switches?: MemorySwitches,
): Promise<LearningModel> {
  const site = await readMemorySiteSettings(tx);
  const s = switches ?? (await readSwitches(tx, teamId));
  return pickLearningModel(
    site.learning_model_alias,
    s.team.learningModelAlias,
    (a) => modelState(tx, teamId, a),
    s.teamAliasInvalid,
  );
}

/** Whether Learn from this chat can run in this Workspace now, and with which model. */
export async function learnAvailability(
  tx: KobeTx,
  teamId: string,
  switches?: MemorySwitches,
): Promise<LearningModel> {
  const s = switches ?? (await readSwitches(tx, teamId));
  const reason = learnSwitchReason(s);
  return reason ? unavailable(reason) : learningModelFor(tx, teamId, s);
}

/** Which switch keeps Learn off, Site first (pure). */
export function learnSwitchReason(s: MemorySwitches): LearnUnavailableReason | null {
  if (!s.site.memoryEnabled || !s.site.memoriesEnabled) return "site_memory_off";
  if (!s.team.memoryEnabled || !s.team.memoriesEnabled) return "memory_off";
  if (!s.site.learnEnabled) return "site_learn_off";
  if (!s.team.learnEnabled) return "learn_off";
  return null;
}
