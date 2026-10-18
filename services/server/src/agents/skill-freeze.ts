import type { KobeTx } from "@kobe/db";
import { localNamedSkills } from "../runs/resolver-input.js";
import { blockedAmong } from "../skills/blocklist.js";
import {
  freezePicks,
  frozenStates,
  type FrozenState,
  type SkillManifest,
} from "../skills/frozen.js";

/**
 * Agent publish freezes local skill versions (KOBE-318, SK28). A team agent version's manifest
 * lists, per named team skill, the version a publish picked (`freezePicks`); catalog skills,
 * Kobe's seven included, are never listed and follow the team install (SK27). Personal and gallery
 * agents have no team at publish (they run in any of their user's teams), so they freeze nothing.
 */

/** The manifest a publish of `names` in this team writes now (inside `withTeam`). */
export async function freezeLocalSkills(
  tx: KobeTx,
  teamId: string,
  names: readonly string[],
): Promise<SkillManifest> {
  const local = await localNamedSkills(tx, teamId, names);
  const picks = await freezePicks(tx, teamId, local);
  return { skills: local.flatMap((n) => picks.get(n)?.entry ?? []) };
}

/** What the builder shows for one named team skill of the current version (ac-3). */
export interface SkillUpdate {
  readonly name: string;
  /** The version this agent version froze; null: none (no usable version at publish). */
  readonly frozen: { readonly version: number; readonly semver: string } | null;
  /** Whether runs load the frozen version, or why they leave it out. */
  readonly status: "ok" | "blocklisted" | Exclude<FrozenState, "approved">;
  /** A valid version a republish would freeze instead; null: nothing newer to pick up. */
  readonly update: { readonly version: number; readonly semver: string } | null;
}

/**
 * Per named team skill of a published version: its frozen version and state, and the version a
 * republish would freeze when that differs and can load ("skill update available"). Names that
 * are neither frozen nor have a valid version are left out (nothing to show).
 */
export async function skillUpdates(
  tx: KobeTx,
  teamId: string,
  names: readonly string[],
  manifest: SkillManifest,
): Promise<SkillUpdate[]> {
  const states = await frozenStates(tx, teamId, manifest.skills);
  const blocked = new Set(
    await blockedAmong(
      tx,
      states.flatMap((s) => (s.hash ? [s.hash] : [])),
    ),
  );
  const local = await localNamedSkills(tx, teamId, names);
  const picks = await freezePicks(tx, teamId, local);
  const order = [...new Set([...names, ...manifest.skills.map((s) => s.name)])];
  return order.flatMap((name): SkillUpdate[] => {
    const frozen = states.find((s) => s.entry.name === name);
    const pick = picks.get(name);
    const moved =
      pick !== undefined &&
      pick.valid &&
      (frozen === undefined ||
        frozen.entry.skill_id !== pick.entry.skill_id ||
        frozen.entry.version !== pick.entry.version);
    if (frozen === undefined && !moved) return [];
    const status: SkillUpdate["status"] =
      frozen === undefined
        ? "not_approved"
        : frozen.state !== "approved"
          ? frozen.state
          : frozen.hash !== null && blocked.has(frozen.hash)
            ? "blocklisted"
            : "ok";
    return [
      {
        name,
        frozen: frozen ? { version: frozen.entry.version, semver: frozen.semver } : null,
        status,
        update: moved ? { version: pick.entry.version, semver: pick.semver } : null,
      },
    ];
  });
}
