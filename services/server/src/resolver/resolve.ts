import type { ApprovalMode } from "@kobe/protocol";
import { agentModelNotEnabled } from "../runs/failure-codes.js";
import { strictestApprovalMode } from "../policy/approval-floor.js";

/**
 * Effective run configuration (KOBE-75, KOBE-47a): a pure function of the agent version, team
 * settings, user prefs, the skill blocklist and the install approval floor. No DB, no wiring
 * (KOBE-76 loads the inputs at run start).
 */

/** What an agent file asks for when it names no approval mode (D29 default). */
export const DEFAULT_REQUESTED_MODE: ApprovalMode = "ask-on-write";

export interface SkillRef {
  readonly name: string;
  /** Content hash of the skill bundle (the blocklist keys on it). */
  readonly hash: string;
}

export interface ResolveInput {
  readonly agent: {
    /** The pinned model alias, or null for none. */
    readonly modelAlias: string | null;
    /** Requested approval mode, null for the default. */
    readonly approvalMode: ApprovalMode | null;
    readonly skills: readonly SkillRef[];
    /** Named skills with no approved version for the team (KOBE-99): omitted as `not_approved`. */
    readonly unapprovedSkills?: readonly string[];
    /** Exclusive agents ignore the user's skills. */
    readonly exclusiveSkills: boolean;
    readonly connectors: readonly string[];
  };
  readonly team: {
    readonly models: readonly { readonly alias: string; readonly isDefault: boolean }[];
    readonly connectors: readonly string[];
    /** Team-level switch (KOBE-80): when true, no user-enabled personal skill is used. */
    readonly personalSkillsDisabled: boolean;
  };
  readonly user: {
    /** The user's enabled personal skills. */
    readonly skills: readonly SkillRef[];
    /** Personal skills blocked for lack of this team's approval (KOBE-99). */
    readonly unapprovedSkills?: readonly string[];
    /** A mode the user prefers; can only tighten. */
    readonly approvalMode?: ApprovalMode | null;
    /** Connectors the user has connected (KOBE-76 decides what to pass until KOBE-61). */
    readonly connectedConnectors: readonly string[];
  };
  readonly approvalFloor: ApprovalMode;
  readonly blockedHashes: readonly string[];
}

export type OmissionReason =
  | "agent_exclusive"
  | "team_disabled"
  | "blocklisted"
  | "shadowed_by_agent"
  | "not_team_enabled"
  | "not_user_connected"
  | "no_team_default"
  | "not_approved";

export interface Omission {
  readonly kind: "skill" | "connector" | "model";
  readonly name: string;
  readonly reason: OmissionReason;
}

export interface ResolvedConfig {
  /** Undefined when no alias is pinned and the team has no default. */
  readonly model: string | undefined;
  readonly approvalMode: ApprovalMode;
  readonly skills: readonly SkillRef[];
  readonly connectors: readonly string[];
  readonly omissions: readonly Omission[];
}

export type ResolveResult =
  | { readonly ok: true; readonly value: ResolvedConfig }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

function resolveSkills(input: ResolveInput): {
  skills: SkillRef[];
  omissions: Omission[];
} {
  const blocked = new Set(input.blockedHashes);
  const skills: SkillRef[] = [];
  const omissions: Omission[] = [];
  const omit = (s: SkillRef, reason: OmissionReason) =>
    omissions.push({ kind: "skill", name: s.name, reason });

  for (const s of input.agent.skills) {
    if (blocked.has(s.hash)) omit(s, "blocklisted");
    else skills.push(s);
  }
  for (const name of input.agent.unapprovedSkills ?? []) {
    omissions.push({ kind: "skill", name, reason: "not_approved" });
  }
  const agentNames = new Set(input.agent.skills.map((s) => s.name));
  for (const s of input.user.skills) {
    if (input.agent.exclusiveSkills) omit(s, "agent_exclusive");
    else if (input.team.personalSkillsDisabled) omit(s, "team_disabled");
    else if (blocked.has(s.hash)) omit(s, "blocklisted");
    else if (agentNames.has(s.name)) omit(s, "shadowed_by_agent");
    else skills.push(s);
  }
  // A personal skill the team's switch or an exclusive agent hides is explained by that, not by
  // its review state.
  for (const name of input.user.unapprovedSkills ?? []) {
    const reason = input.agent.exclusiveSkills
      ? "agent_exclusive"
      : input.team.personalSkillsDisabled
        ? "team_disabled"
        : "not_approved";
    omissions.push({ kind: "skill", name, reason });
  }
  return { skills, omissions };
}

/** Agent list, team-enabled and user-connected: a connector must pass all three. */
function resolveConnectors(input: ResolveInput): { connectors: string[]; omissions: Omission[] } {
  const enabled = new Set(input.team.connectors);
  const connected = new Set(input.user.connectedConnectors);
  const connectors: string[] = [];
  const omissions: Omission[] = [];
  for (const name of new Set(input.agent.connectors)) {
    if (!enabled.has(name)) omissions.push({ kind: "connector", name, reason: "not_team_enabled" });
    else if (!connected.has(name)) {
      omissions.push({ kind: "connector", name, reason: "not_user_connected" });
    } else connectors.push(name);
  }
  return { connectors, omissions };
}

export function resolveEffective(input: ResolveInput): ResolveResult {
  const omissions: Omission[] = [];
  const pinned = input.agent.modelAlias;
  let model: string | undefined;
  if (pinned !== null) {
    if (!input.team.models.some((m) => m.alias === pinned)) {
      return { ok: false, error: agentModelNotEnabled(pinned) };
    }
    model = pinned;
  } else {
    model = input.team.models.find((m) => m.isDefault)?.alias;
    if (model === undefined) {
      omissions.push({ kind: "model", name: "(default)", reason: "no_team_default" });
    }
  }

  const skills = resolveSkills(input);
  const connectors = resolveConnectors(input);
  return {
    ok: true,
    value: {
      model,
      approvalMode: strictestApprovalMode(
        input.approvalFloor,
        input.agent.approvalMode ?? DEFAULT_REQUESTED_MODE,
        input.user.approvalMode ?? "auto",
      ),
      skills: skills.skills,
      connectors: connectors.connectors,
      omissions: [...omissions, ...skills.omissions, ...connectors.omissions],
    },
  };
}
