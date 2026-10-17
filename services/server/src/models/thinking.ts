import type { ModelProviderKind, ThinkingLevelValue, modelCatalog } from "@kobe/db";
import {
  effectiveThinkingLevel,
  narrowThinkingPolicy,
  selectableThinkingLevels,
  teamThinkingProblem,
  thinkingControlFits,
  thinkingControlSchema,
  thinkingLevelSchema,
  thinkingPolicyProblem,
  type ThinkingLevel,
  type ThinkingPolicy,
} from "@kobe/protocol";
import { z } from "zod";

/**
 * Thinking settings on the server (KOBE-260; rules in `@kobe/protocol` thinking.ts): the site
 * catalog's per-model policy, a team's narrowing, and the level a run starts with.
 */

type CatalogRow = typeof modelCatalog.$inferSelect;

/** The `thinking` object of the catalog API: the whole policy, replaced at once. */
export const thinkingPolicySchema = z.strictObject({
  control: thinkingControlSchema,
  allowed: z.boolean({ error: "allowed is true or false" }),
  default: thinkingLevelSchema.nullable(),
  max: thinkingLevelSchema.nullable(),
});
export type ThinkingPolicyInput = z.infer<typeof thinkingPolicySchema>;

/** A team's maximum (null: the site's). */
export const teamThinkingMaxSchema = thinkingLevelSchema.nullable();

export const NO_THINKING: ThinkingPolicy = {
  control: "none",
  allowed: false,
  default: null,
  max: null,
};

/** A catalog row's policy. */
export function catalogThinking(
  row: Pick<CatalogRow, "thinkingControl" | "thinkingAllowed" | "thinkingDefault" | "thinkingMax">,
): ThinkingPolicy {
  return {
    control: row.thinkingControl,
    allowed: row.thinkingAllowed,
    default: row.thinkingDefault,
    max: row.thinkingMax,
  };
}

/** The policy as columns (insert or update). */
export const thinkingColumns = (p: ThinkingPolicy) => ({
  thinkingControl: p.control,
  thinkingAllowed: p.allowed,
  thinkingDefault: p.default,
  thinkingMax: p.max,
});

export type ThinkingCheck =
  | { readonly ok: true; readonly policy: ThinkingPolicy }
  | { readonly ok: false; readonly error: "thinking_invalid"; readonly message: string };

/**
 * The policy a catalog write ends with (`next` given, else the stored one) checked against the
 * model's provider kind and reasoning flag: the same rules as the database's checks, with a
 * message an admin can act on.
 */
export function checkCatalogThinking(
  next: ThinkingPolicy | undefined,
  before: ThinkingPolicy,
  kind: ModelProviderKind,
  reasoning: boolean,
): ThinkingCheck {
  const policy = next ?? before;
  if (!thinkingControlFits(kind, policy.control)) {
    return {
      ok: false,
      error: "thinking_invalid",
      message: `The thinking control ${policy.control} does not fit a ${kind} provider. Pick one for this provider, or none.`,
    };
  }
  const problem = thinkingPolicyProblem(policy, reasoning);
  return problem === undefined
    ? { ok: true, policy }
    : { ok: false, error: "thinking_invalid", message: `Thinking: ${problem}.` };
}

/** Why a team maximum is refused for this site policy (it may only narrow). */
export function checkTeamThinking(
  site: ThinkingPolicy,
  teamMax: ThinkingLevelValue | null,
): string | undefined {
  const problem = teamThinkingProblem(site, teamMax);
  return problem === undefined ? undefined : `Thinking: ${problem}.`;
}

/** What the API shows for a model's thinking (site console, team console, chat). */
export interface ThinkingView {
  readonly control: ThinkingPolicy["control"];
  readonly allowed: boolean;
  readonly default: ThinkingLevel | null;
  readonly max: ThinkingLevel | null;
}

export const thinkingView = (p: ThinkingPolicy): ThinkingView => ({
  control: p.control,
  allowed: p.allowed,
  default: p.default,
  max: p.max,
});

/** For the chat: the policy in force for the team, the default level and what members may pick. */
export interface ChatThinkingView {
  readonly default: ThinkingLevel | null;
  readonly levels: readonly ThinkingLevel[];
}

export function chatThinking(
  site: ThinkingPolicy,
  teamMax: ThinkingLevel | null,
): ChatThinkingView {
  const policy = narrowThinkingPolicy(site, teamMax);
  return {
    default: effectiveThinkingLevel(policy, null) ?? null,
    levels: selectableThinkingLevels(policy),
  };
}

/**
 * A run's level when it starts: the conversation's choice (else the model's default) clamped to
 * the site policy narrowed by the team. Undefined: the model has no thinking control.
 */
export function runThinkingLevel(
  site: ThinkingPolicy,
  teamMax: ThinkingLevel | null,
  chosen: ThinkingLevel | null,
): ThinkingLevel | undefined {
  return effectiveThinkingLevel(narrowThinkingPolicy(site, teamMax), chosen);
}
