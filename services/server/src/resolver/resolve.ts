import { SKILL_BUNDLES_MAX, type ApprovalMode } from "@kobe/protocol";
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
  /** Content hash of the skill bundle (the blocklist keys on it); a catalog version's runtime hash. */
  readonly hash: string;
  /** Where it comes from (KOBE-297: recorded with the run); absent = not said. */
  readonly source?: "team" | "personal" | "catalog";
  /** The version's MAJOR.MINOR.PATCH (KOBE-315: recorded with the run, shown on the badge). */
  readonly semver?: string;
  /** Other hashes of the same version (a catalog version's package hash): blocked together. */
  readonly aliases?: readonly string[];
}

/** A skill a loader already decided to leave out (KOBE-315), with its reason. */
export interface SkillOmission {
  readonly name: string;
  readonly reason: OmissionReason;
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
    /** Named skills whose approved version a rescan suspended (KOBE-313): `suspended`. */
    readonly suspendedSkills?: readonly string[];
    /** Named catalog skills at the team install's pin (KOBE-315, step 2 after the local ones). */
    readonly catalogSkills?: readonly SkillRef[];
    /** Named catalog skills left out: `not_installed`, `revoked`, `suspended` (KOBE-315). */
    readonly skillOmissions?: readonly SkillOmission[];
    /** Exclusive agents ignore the user's skills. */
    readonly exclusiveSkills: boolean;
    /** Named connectors, or `all`: the team's enabled list (agent file `connectors: all`, KOBE-254). */
    readonly connectors: readonly string[] | "all";
  };
  readonly team: {
    readonly models: readonly { readonly alias: string; readonly isDefault: boolean }[];
    readonly connectors: readonly string[];
    /** Team-level switch (KOBE-80): when true, no user-enabled personal skill is used. */
    readonly personalSkillsDisabled: boolean;
    /**
     * Step 1 (KOBE-315, SK27): Required team skills and Required catalog installs. They load for
     * every run in the team, `skills: exclusive` agents too, and count first against the cap.
     */
    readonly requiredSkills?: readonly SkillRef[];
    /** Required installs left out (revoked, suspended): shown for every agent. */
    readonly requiredOmissions?: readonly SkillOmission[];
    /**
     * Step 3: team skills and catalog installs On by default the member has not turned off,
     * Available ones the member turned on (KOBE-297's "Offer to all agents" is On by default),
     * and the member's own catalog adds. Exclusive agents leave them out without a notice.
     */
    readonly offeredSkills?: readonly SkillRef[];
    /** Step-3 skills left out (revoked, suspended): shown unless the agent is exclusive. */
    readonly offeredOmissions?: readonly SkillOmission[];
  };
  readonly user: {
    /** The user's enabled personal skills. */
    readonly skills: readonly SkillRef[];
    /** Personal skills blocked for lack of this team's approval (KOBE-99). */
    readonly unapprovedSkills?: readonly string[];
    /** Personal skills a rescan suspended (KOBE-313), pending this team's review. */
    readonly suspendedSkills?: readonly string[];
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
  | "not_approved"
  | "skill_limit"
  | "suspended"
  | "not_installed"
  | "revoked"
  | "shadowed"
  | "unavailable";

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

/**
 * Most skills one run may carry (KOBE-297): `run.start` refuses more (`SKILL_BUNDLES_MAX`), which
 * would fail the start. Skills count in resolution order (Required first); the rest are omitted
 * as `skill_limit`.
 */
export const RUN_SKILLS_MAX = SKILL_BUNDLES_MAX;

/**
 * The run's skills in the SK27 order (KOBE-315), deduplicated by name (earlier wins):
 * 1. Required team skills and installs (also for `skills: exclusive` agents);
 * 2. the agent's named skills: local ones, then catalog ones at the team install's pin;
 * 3. installs and team skills on for this member, and the member's own adds;
 * 4. the member's personal skills.
 * Exclusive agents stop after step 2. A blocklisted hash (or alias) is omitted, never replaced.
 */
export function resolveSkills(input: ResolveInput): {
  skills: SkillRef[];
  omissions: Omission[];
} {
  const blocked = new Set(input.blockedHashes);
  const isBlocked = (s: SkillRef) =>
    blocked.has(s.hash) || (s.aliases ?? []).some((a) => blocked.has(a));
  const skills: SkillRef[] = [];
  const omissions: Omission[] = [];
  const omitName = (name: string, reason: OmissionReason) =>
    omissions.push({ kind: "skill", name, reason });
  const taken = new Set<string>();
  /**
   * Steps 1–3: an omission for a block, silence for a name an earlier step already loads. A
   * Required or named skill holds its name even when it is left out (`claim`: blocklisted here,
   * or revoked, suspended, not installed or not approved by its loader): a later skill of that
   * name never stands in for the one the admin or builder chose (SK28: never swapped silently).
   */
  const add = (s: SkillRef, claim = false) => {
    if (isBlocked(s)) {
      omitName(s.name, "blocklisted");
      if (claim) taken.add(s.name);
    } else if (!taken.has(s.name)) {
      taken.add(s.name);
      skills.push(s);
    }
  };
  const omitClaimed = (name: string, reason: OmissionReason) => {
    omitName(name, reason);
    taken.add(name);
  };
  const exclusive = input.agent.exclusiveSkills;

  for (const s of input.team.requiredSkills ?? []) add(s, true);
  for (const o of input.team.requiredOmissions ?? []) omitClaimed(o.name, o.reason);
  // A named skill whose name a different Required skill holds (a Team admin's deliberate choice,
  // e.g. the team's own `pdf` over Kobe's, KOBE-317 review S4) is left out with a notice.
  // Names are unique per source (catalog, team), so another source is another skill.
  const required = new Map((input.team.requiredSkills ?? []).map((s) => [s.name, s.source]));
  const shadowedByRequired = (s: SkillRef) =>
    required.has(s.name) && required.get(s.name) !== s.source && !isBlocked(s);

  for (const s of [...input.agent.skills, ...(input.agent.catalogSkills ?? [])]) {
    if (shadowedByRequired(s)) omitName(s.name, "shadowed");
    else add(s, true);
  }
  for (const name of input.agent.unapprovedSkills ?? []) omitClaimed(name, "not_approved");
  for (const name of input.agent.suspendedSkills ?? []) omitClaimed(name, "suspended");
  for (const o of input.agent.skillOmissions ?? []) omitClaimed(o.name, o.reason);
  const steps12 = new Set(taken);

  if (!exclusive) {
    for (const s of input.team.offeredSkills ?? []) add(s);
    for (const o of input.team.offeredOmissions ?? []) omitName(o.name, o.reason);
  }

  for (const s of input.user.skills) {
    if (exclusive) omitName(s.name, "agent_exclusive");
    else if (input.team.personalSkillsDisabled) omitName(s.name, "team_disabled");
    else if (isBlocked(s)) omitName(s.name, "blocklisted");
    else if (steps12.has(s.name)) omitName(s.name, "shadowed_by_agent");
    else if (taken.has(s.name)) omitName(s.name, "shadowed");
    else {
      taken.add(s.name);
      skills.push(s);
    }
  }
  // A personal skill the team's switch or an exclusive agent hides is explained by that, not by
  // its review state.
  const userReason = (otherwise: OmissionReason): OmissionReason =>
    exclusive ? "agent_exclusive" : input.team.personalSkillsDisabled ? "team_disabled" : otherwise;
  for (const name of input.user.unapprovedSkills ?? []) omitName(name, userReason("not_approved"));
  for (const name of input.user.suspendedSkills ?? []) omitName(name, userReason("suspended"));

  for (const s of skills.slice(RUN_SKILLS_MAX)) omitName(s.name, "skill_limit");
  return { skills: skills.slice(0, RUN_SKILLS_MAX), omissions };
}

/**
 * Agent list, team-enabled and user-connected: a connector must pass all three. `all` (KOBE-254)
 * takes the team's list as the agent list, so it passes the same two filters and widens nothing;
 * it names no connector, so one the user has not connected is left out without a notice.
 */
function resolveConnectors(input: ResolveInput): { connectors: string[]; omissions: Omission[] } {
  const all = input.agent.connectors === "all";
  const requested = all ? input.team.connectors : input.agent.connectors;
  const enabled = new Set(input.team.connectors);
  const connected = new Set(input.user.connectedConnectors);
  const connectors: string[] = [];
  const omissions: Omission[] = [];
  for (const name of new Set(requested)) {
    if (!enabled.has(name)) omissions.push({ kind: "connector", name, reason: "not_team_enabled" });
    else if (!connected.has(name)) {
      if (!all) omissions.push({ kind: "connector", name, reason: "not_user_connected" });
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
