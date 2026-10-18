import type { KobeTx } from "@kobe/db";
import { localNamedSkills } from "../runs/resolver-input.js";
import { blockedAmong } from "../skills/blocklist.js";
import {
  freezePicks,
  frozenStates,
  type FrozenState,
  type LeftOutReason,
  type SkillManifest,
} from "../skills/frozen.js";

/**
 * Agent publish freezes local skill versions (KOBE-318, SK28). A team agent version's manifest
 * lists, per named team skill, the newest loadable version at publish (`freezePicks`); a named
 * team skill with none is left out and the publish says so. Catalog skills, Kobe's seven
 * included, are never listed and follow the team install (SK27). Personal and gallery agents have
 * no team at publish (they run in any of their user's teams), so they freeze nothing.
 */

/** A named team skill a publish left out of the manifest, and why (a publish warning). */
export interface SkillLeftOut {
  readonly name: string;
  readonly reason: LeftOutReason;
}

export interface Frozen {
  readonly manifest: SkillManifest;
  readonly leftOut: readonly SkillLeftOut[];
}

/** The manifest a publish of `names` in this team writes now (inside `withTeam`). */
export async function freezeLocalSkills(
  tx: KobeTx,
  teamId: string,
  names: readonly string[],
): Promise<Frozen> {
  const local = await localNamedSkills(tx, teamId, names);
  const { picks, leftOut } = await freezePicks(tx, teamId, local);
  return {
    manifest: { skills: local.flatMap((n) => picks.get(n)?.entry ?? []) },
    leftOut: local.flatMap((name) => {
      const reason = leftOut.get(name);
      return reason ? [{ name, reason }] : [];
    }),
  };
}

/** What the builder shows for one named team skill of the current version (ac-3). */
export interface SkillUpdate {
  readonly name: string;
  /** The version this agent version froze; null: none (no loadable version at publish). */
  readonly frozen: { readonly version: number; readonly semver: string } | null;
  /**
   * Whether runs load the frozen version, or why they leave it out. Not frozen: why it has no
   * loadable version now (`not_approved` too when one became loadable since: see `update`).
   */
  readonly status: "ok" | "blocklisted" | Exclude<FrozenState, "approved">;
  /** A loadable version a republish would freeze instead; null: nothing to pick up. */
  readonly update: { readonly version: number; readonly semver: string } | null;
}

/**
 * Per named team skill of a published version: its frozen version and state, and the version a
 * republish would freeze when that differs ("skill update available"). A name left out at
 * publish is listed with why it still can't load, or with the version that now can.
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
  const { picks, leftOut } = await freezePicks(tx, teamId, local);
  const order = [...new Set([...local, ...manifest.skills.map((s) => s.name)])];
  return order.flatMap((name): SkillUpdate[] => {
    const frozen = states.find((s) => s.entry.name === name);
    const pick = picks.get(name);
    const moved =
      pick !== undefined &&
      (frozen === undefined ||
        frozen.entry.skill_id !== pick.entry.skill_id ||
        frozen.entry.version !== pick.entry.version);
    const update = moved ? { version: pick.entry.version, semver: pick.semver } : null;
    if (frozen === undefined) {
      return [{ name, frozen: null, status: leftOut.get(name) ?? "not_approved", update }];
    }
    const status: SkillUpdate["status"] =
      frozen.state !== "approved"
        ? frozen.state
        : frozen.hash !== null && blocked.has(frozen.hash)
          ? "blocklisted"
          : "ok";
    return [
      {
        name,
        frozen: { version: frozen.entry.version, semver: frozen.semver },
        status,
        update,
      },
    ];
  });
}
