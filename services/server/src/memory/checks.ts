import type { KobeTx } from "@kobe/db";
import {
  SEMANTIC_MEMORY_JUSTIFICATION_MAX,
  SEMANTIC_MEMORY_NOTE_MAX,
  SEMANTIC_MEMORY_STATEMENT_MAX,
  codePointLength,
  type SemanticMemoryIssue,
  type SemanticMemoryOverrides,
  type SemanticMemoryScope,
  type SemanticMemoryWarningCode,
} from "@kobe/protocol";
import type { ServerAuditEvent } from "../audit/record.js";
import { lintInstructions } from "./checks/lint.js";
import {
  egressTeamFor,
  extractLinkHosts,
  linkWarnings,
  readEgressModel,
  type LinkHost,
} from "./checks/links.js";
import { findPersonalData } from "./checks/personal.js";
import { policyConflicts, readPolicyAndLexemes, type PolicyConflict } from "./checks/policy.js";
import { findSecret, type SecretHit } from "./checks/secrets.js";
import {
  NEAR_DUPLICATE_WARNING,
  findNearDuplicates,
  type NearDuplicate,
} from "./items/duplicates.js";
import { MemoryItemError, invalid, notAllowed } from "./items/errors.js";
import type { Location } from "./items/location.js";
import { curates, type MemoryWho } from "./items/who.js";
import type { EffectiveMemory } from "./switch-model.js";

/**
 * THE memory save checks (KOBE-379; spec SM9, SM18, SM23). Every path that writes or
 * re-activates a statement calls {@link checkMemoryWrite} in its own transaction, before it
 * writes: the editor (create, edit, a Policy change, Undo, restore from the archive;
 * `items/context.ts` `saveChecks`), and later import commit, candidate save, propose and approve,
 * and suggestions. Restore runs every check like a save (review H-1): a Policy, lint rule or
 * egress change made while the item was archived applies to it. A tags-only edit scans the new
 * tags for secrets ({@link assertNoSecretInTags}). A path that must report rather than refuse
 * (import preview) calls {@link evaluateMemoryWrite} and maps the findings with
 * {@link importRowStatus}. Overrides are audited with {@link overrideAuditEvents}.
 *
 * Rules, by scope (Policy = a Site item with `policy`):
 *
 * | rule                         | user / portable | Workspace / Site       | Policy     |
 * | ---------------------------- | --------------- | ---------------------- | ---------- |
 * | length caps                  | invalid_request | invalid_request        | same       |
 * | secret scan                  | block           | block                  | block      |
 * | instruction lint             | warning         | warning                | exempt     |
 * | personal data                | -               | warning                | warning    |
 * | links (egress model)         | warning         | warning                | warning    |
 * | (portable and Site links are judged by the Site ceiling; user and Workspace by the Workspace) |
 * | near-duplicate (KOBE-378)    | warning         | warning                | warning    |
 * | Policy conflict              | block, override | block, override        | exempt     |
 *
 * A secret has no override. Warnings are refused together with `memory_lint_warning` until the
 * writer saves anyway (`overrides.lint`), recorded on the version (`lint_override`) and audited
 * (`memory.lint.override` with the codes) at every scope. A Policy conflict needs
 * `overrides.policy_conflict` from someone who curates the scope (the owner for personal items,
 * Team admins and stewards for the Workspace, Site curators for the Site), recorded as
 * `policy_override` and audited (`memory.policy.override`).
 */

/** What the store needs to run the checks: the save's transaction, scope, switches and writer. */
export interface MemoryCheckEnv {
  readonly tx: KobeTx;
  readonly loc: Location;
  readonly memory: EffectiveMemory;
  readonly who: MemoryWho;
}

/** The text being saved and what it becomes. */
export interface MemoryWriteSubject {
  readonly scope: SemanticMemoryScope;
  /** The item is (or becomes) Policy: exempt from the instruction lint and Policy conflict. */
  readonly policy: boolean;
  readonly statement: string;
  /**
   * Candidate / proposal fields (Phase B/C), checked when present like the statement: length,
   * secrets, instruction lint (not for Policy), personal data on Workspace and Site items.
   */
  readonly justification?: string | undefined;
  readonly note?: string | undefined;
  /** The item's tags, scanned for secrets (review L-3). */
  readonly tags?: readonly string[] | undefined;
  /** Item ids not to compare with: the item itself and any item the save replaces. */
  readonly except?: readonly string[] | undefined;
}

export interface MemoryFindings {
  /** Why the text is refused as invalid (a field over its cap), or null. */
  readonly invalid: string | null;
  /** A credential: blocks, never overridable. */
  readonly secret: SecretHit | null;
  /** Lint, personal-data, link and near-duplicate warnings, in that order. */
  readonly warnings: SemanticMemoryIssue[];
  readonly duplicates: NearDuplicate[];
  readonly policyConflicts: PolicyConflict[];
}

/** What a save went through: written to the version and audited by the caller. */
export interface MemoryCheckOutcome {
  readonly lintOverride: boolean;
  readonly policyOverride: boolean;
  /** Codes of the warnings saved over. */
  readonly warnings: string[];
  /** Policy items (id and version) saved over, at most 25. */
  readonly policyConflicts: readonly PolicyConflict[];
}

/** A save that went through no override (a write without a statement change). */
export const NO_OVERRIDES: MemoryCheckOutcome = {
  lintOverride: false,
  policyOverride: false,
  warnings: [],
  policyConflicts: [],
};

const MESSAGES: Readonly<Record<Exclude<SemanticMemoryWarningCode, `link_${string}`>, string>> = {
  near_duplicate: NEAR_DUPLICATE_WARNING.message,
  instruction_imperative:
    "Reads like an instruction to the agent. A memory states a fact or a preference; it never gives the agent orders.",
  instruction_tools:
    "Mentions tools, approvals or the system prompt. A memory can't change what the agent may do or what needs approval.",
  instruction_fetch:
    "Asks to fetch or open a web address. A memory can't make the agent visit a link.",
  instruction_egress:
    "Asks to widen internet access or use a connector. A memory can't change either: ask an admin with Request access.",
  personal_email: "Contains an email address. Everyone who can read these memories will see it.",
  personal_phone: "Contains a phone number. Everyone who can read these memories will see it.",
  personal_sensitive:
    "Names a person near sensitive information (health, pay, discipline, family or identity documents). Everyone who can read these memories will see it.",
};
const issue = (code: keyof typeof MESSAGES): SemanticMemoryIssue => ({
  code,
  message: MESSAGES[code],
});

const LENGTHS = [
  ["statement", SEMANTIC_MEMORY_STATEMENT_MAX],
  ["justification", SEMANTIC_MEMORY_JUSTIFICATION_MAX],
  ["note", SEMANTIC_MEMORY_NOTE_MAX],
] as const;

/** The checks that need no database: lengths, secrets, lint, personal data, link hosts. */
export function scanMemoryText(subject: MemoryWriteSubject): {
  readonly invalid: string | null;
  readonly secret: SecretHit | null;
  readonly warnings: SemanticMemoryIssue[];
  readonly links: LinkHost[];
} {
  for (const [field, max] of LENGTHS) {
    const value = subject[field];
    if (value !== undefined && codePointLength(value) > max)
      return {
        invalid: `${field} exceeds ${max} characters.`,
        secret: null,
        warnings: [],
        links: [],
      };
  }
  const texts = [subject.statement, subject.justification, subject.note].filter(
    (t): t is string => t !== undefined,
  );
  for (const text of [...texts, ...(subject.tags ?? [])]) {
    const secret = findSecret(text);
    if (secret) return { invalid: null, secret, warnings: [], links: [] };
  }
  const shared = subject.scope === "team" || subject.scope === "site";
  const codes = texts.flatMap((text) => [
    ...(subject.policy ? [] : lintInstructions(text)),
    ...(shared ? findPersonalData(text) : []),
  ]);
  const warnings = [...new Set(codes)].map(issue);
  return { invalid: null, secret: null, warnings, links: extractLinkHosts(subject.statement) };
}

/** Runs every check and reports; never refuses (the import preview's view). */
export async function evaluateMemoryWrite(
  env: MemoryCheckEnv,
  subject: MemoryWriteSubject,
): Promise<MemoryFindings> {
  const text = scanMemoryText(subject);
  if (text.invalid !== null || text.secret !== null)
    return { ...text, warnings: [], duplicates: [], policyConflicts: [] };
  const except = subject.except ?? [];
  const links =
    text.links.length === 0
      ? []
      : linkWarnings(
          text.links,
          await readEgressModel(env.tx, egressTeamFor(subject.scope, env.loc.teamId)),
          subject.scope,
        );
  const duplicates = await findNearDuplicates(env.tx, env.loc, subject.statement, except);
  let conflicts: PolicyConflict[] = [];
  if (!subject.policy && env.memory.policy) {
    const { policies, lexemes } = await readPolicyAndLexemes(env.tx, subject.statement, except);
    conflicts = policyConflicts(subject.statement, lexemes, policies);
  }
  return {
    invalid: null,
    secret: null,
    warnings: [
      ...text.warnings,
      ...links,
      ...(duplicates.length > 0 ? [NEAR_DUPLICATE_WARNING] : []),
    ],
    duplicates,
    policyConflicts: conflicts,
  };
}

const secretError = (hit: SecretHit) =>
  new MemoryItemError(
    "memory_secret",
    `This looks like ${hit.label}. Remove it: secrets can never be saved in memory.`,
  );

/** Refuses what the findings and overrides don't allow; otherwise what to record. */
export function enforceMemoryFindings(
  findings: MemoryFindings,
  overrides: SemanticMemoryOverrides | undefined,
  who: MemoryWho,
  scope: SemanticMemoryScope,
): MemoryCheckOutcome {
  if (findings.invalid !== null) throw invalid(findings.invalid);
  if (findings.secret !== null) throw secretError(findings.secret);
  const { warnings, duplicates, policyConflicts: conflicts } = findings;
  if (warnings.length > 0 && overrides?.lint !== true) {
    const onlyDuplicate = warnings.every((w) => w.code === NEAR_DUPLICATE_WARNING.code);
    throw new MemoryItemError(
      "memory_lint_warning",
      onlyDuplicate
        ? "A similar memory already exists. Save anyway if this one is different."
        : "Check the warnings, then save anyway if this memory is right.",
      { warnings: warnings.slice(0, 20), ...(duplicates.length > 0 ? { duplicates } : {}) },
    );
  }
  if (conflicts.length > 0) {
    if (overrides?.policy_conflict !== true)
      throw new MemoryItemError(
        "memory_policy_conflict",
        "This may contradict Site Policy. Read the Policy, then save anyway only if it doesn't.",
        { policy_conflicts: conflicts.slice(0, 25) },
      );
    if (!curates(who, scope)) throw notAllowed("Only curators save over Site Policy here.");
  }
  return {
    lintOverride: warnings.length > 0,
    policyOverride: conflicts.length > 0,
    warnings: warnings.map((w) => w.code),
    policyConflicts: conflicts.slice(0, 25),
  };
}

/** The entry point: runs every check and refuses, or says what the save went through. */
export async function checkMemoryWrite(
  env: MemoryCheckEnv,
  subject: MemoryWriteSubject,
  overrides: SemanticMemoryOverrides | undefined,
): Promise<MemoryCheckOutcome> {
  return enforceMemoryFindings(
    await evaluateMemoryWrite(env, subject),
    overrides,
    env.who,
    subject.scope,
  );
}

/**
 * A write that changes only an item's tags (kind, `as_of`): the statement is unchanged and
 * already active, so only the new tags need the secret scan (review L-3).
 */
export function assertNoSecretInTags(tags: readonly string[]): void {
  for (const tag of tags) {
    const hit = findSecret(tag);
    if (hit) throw secretError(hit);
  }
}

/**
 * An import row's status from its findings (the contract's row statuses; `invalid` rows that
 * don't parse never get here): blocked > invalid > warning (lint or Policy) > duplicate > new.
 */
export function importRowStatus(
  findings: MemoryFindings,
): "blocked" | "invalid" | "warning" | "duplicate" | "new" {
  if (findings.secret !== null) return "blocked";
  if (findings.invalid !== null) return "invalid";
  const others = findings.warnings.filter((w) => w.code !== NEAR_DUPLICATE_WARNING.code);
  if (others.length > 0 || findings.policyConflicts.length > 0) return "warning";
  return findings.duplicates.length > 0 ? "duplicate" : "new";
}

/** The audit rows of a save's overrides (actor from the request; item and version named). */
export function overrideAuditEvents(
  outcome: MemoryCheckOutcome,
  at: { scope: SemanticMemoryScope; itemId: string; version: number; teamId: string | null },
): ServerAuditEvent[] {
  const { scope, itemId, version, teamId } = at;
  const events: ServerAuditEvent[] = [];
  if (outcome.lintOverride)
    events.push({
      action: "memory.lint.override",
      teamId,
      target: { scope, itemId, version, warnings: outcome.warnings },
    });
  if (outcome.policyOverride)
    events.push({
      action: "memory.policy.override",
      teamId,
      target: {
        scope,
        itemId,
        version,
        conflicts: outcome.policyConflicts.map((c) => ({ id: c.id, version: c.version })),
      },
    });
  return events;
}
