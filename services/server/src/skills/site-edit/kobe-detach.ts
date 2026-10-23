import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../../audit/record.js";
import type { BlobStore } from "../../retention/blobs.js";
import { loadKobePackages, type KobePackage } from "../kobe-packages.js";
import { seedKobeSkills, type KobeSeedResult } from "../kobe-seed.js";
import { diffPackages, readPackage, type PackageDiff } from "../registry/review-diff.js";
import { compareSemver } from "../semver.js";
import { isSiteAdmin } from "./site-admin.js";
import { newestSemver, storedOf, storedVersion, versionRows } from "./catalog-view.js";

/**
 * Detached Kobe skills (KOBE-495, as KOBE-494's customized gallery agents). A Site admin's first
 * edit of a Kobe-shipped catalog skill detaches it in the edit's own transaction, under the skill's
 * row lock (the Kobe seed takes the same lock and then skips it). The console compares the
 * shipped package with the skill's newest version, and Reset to Kobe re-attaches it when the
 * shipped version is above every version the Site published (otherwise the seed would refuse it
 * as not newer: the skill stays detached and the admin is told why). After a reset the shipped
 * package is seeded at once (the next start would anyway).
 */

/** Marks a Kobe skill detached (no-op for a maintainer skill or one detached already). */
export async function detachInTx(tx: KobeTx, skillId: string, userId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ name: string }>(sql`
    UPDATE registry_skills s SET detached_at = now(), detached_by = ${userId},
      detached_from_version = (
        SELECT v.semver FROM registry_versions v
         WHERE v.skill_id = s.id AND v.publisher = 'kobe' ORDER BY v.seq DESC LIMIT 1),
      updated_at = now()
     WHERE s.id = ${skillId} AND s.publisher = 'kobe' AND s.detached_at IS NULL
       AND EXISTS (SELECT 1 FROM registry_versions v WHERE v.skill_id = s.id AND v.publisher = 'kobe')
    RETURNING s.name, s.detached_from_version`);
  const row = rows[0] as { name: string; detached_from_version: string } | undefined;
  if (!row) return false;
  await recordAudit(tx, {
    action: "skill.detached",
    target: { skillId, name: row.name, fromSemver: row.detached_from_version },
  });
  return true;
}

export interface KobeDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  /** The package set; defaults to the one the server ships (tests pass their own). */
  readonly packages?: () => Promise<readonly KobePackage[]>;
}

async function shipped(deps: KobeDeps, name: string): Promise<KobePackage | null> {
  const all = await (deps.packages ?? loadKobePackages)();
  return all.find((p) => p.name === name) ?? null;
}

export interface KobeCompare {
  /** The skill's newest version (what teams get now). */
  readonly current: { readonly id: string; readonly semver: string; readonly publisher: string };
  readonly shipped: { readonly semver: string };
  readonly diff: PackageDiff;
}

export type CompareResult =
  | { readonly ok: true; readonly compare: KobeCompare }
  | { readonly ok: false; readonly code: "not_found" | "not_kobe" | "not_shipped" | "not_stored" };

/** The shipped package against the skill's newest version, file by file. */
export async function compareWithKobe(deps: KobeDeps, skillId: string): Promise<CompareResult> {
  const { rows } = await deps.db.execute<{ name: string; publisher: string }>(sql`
    SELECT name, publisher::text AS publisher FROM registry_skills WHERE id = ${skillId}`);
  const skill = rows[0];
  if (!skill) return { ok: false, code: "not_found" };
  if (skill.publisher !== "kobe") return { ok: false, code: "not_kobe" };
  const p = await shipped(deps, skill.name);
  if (!p) return { ok: false, code: "not_shipped" };
  const current = (await versionRows(deps.db, skillId))[0];
  if (!current) return { ok: false, code: "not_found" };
  const stored = await storedVersion(deps.db, skillId, current.id);
  const before = stored ? await readPackage(deps.blobs, storedOf(stored)) : null;
  if (!before) return { ok: false, code: "not_stored" };
  return {
    ok: true,
    compare: {
      current: { id: current.id, semver: current.semver, publisher: current.publisher },
      shipped: { semver: p.semver },
      diff: diffPackages(before, p.bundle.packageZip ?? p.bundle.zip),
    },
  };
}

export type ResetResult =
  | { readonly ok: true; readonly shippedSemver: string; readonly seed: KobeSeedResult | null }
  | {
      readonly ok: false;
      readonly code: "forbidden" | "not_found" | "not_kobe" | "not_detached" | "not_shipped";
    }
  | {
      readonly ok: false;
      readonly code: "shipped_not_above";
      readonly shippedSemver: string;
      readonly siteSemver: string;
    };

/**
 * Re-attaches a detached Kobe skill (Reset to Kobe). Refused, and left detached, while the
 * shipped version isn't above the Site's own newest one. The site draft goes with the reset.
 */
export async function resetToKobe(
  deps: KobeDeps,
  skillId: string,
  userId: string,
): Promise<ResetResult> {
  const { rows } = await deps.db.execute<{ name: string; publisher: string }>(sql`
    SELECT name, publisher::text AS publisher FROM registry_skills WHERE id = ${skillId}`);
  const skill = rows[0];
  if (!skill) return { ok: false, code: "not_found" };
  if (skill.publisher !== "kobe") return { ok: false, code: "not_kobe" };
  const p = await shipped(deps, skill.name);
  if (!p) return { ok: false, code: "not_shipped" };
  const result = await deps.db.transaction(async (tx): Promise<ResetResult> => {
    if (!(await isSiteAdmin(tx, userId))) return { ok: false, code: "forbidden" };
    const locked = await tx.execute<{ detached: boolean; from: string | null }>(sql`
      SELECT detached_at IS NOT NULL AS detached, detached_from_version AS from
        FROM registry_skills WHERE id = ${skillId} FOR UPDATE`);
    const row = locked.rows[0];
    if (!row?.detached) return { ok: false, code: "not_detached" };
    const site = newestSemver(
      (await versionRows(tx, skillId)).filter((v) => v.publisher === "site"),
    );
    if (site !== null && compareSemver(p.semver, site) <= 0)
      return { ok: false, code: "shipped_not_above", shippedSemver: p.semver, siteSemver: site };
    await tx.execute(sql`
      UPDATE registry_skills SET detached_at = NULL, detached_by = NULL,
        detached_from_version = NULL, kobe_shipped_version = NULL, updated_at = now()
       WHERE id = ${skillId}`);
    await tx.execute(sql`DELETE FROM site_skill_drafts WHERE skill_id = ${skillId}`);
    await recordAudit(tx, {
      action: "skill.reset_to_kobe",
      target: {
        skillId,
        name: skill.name,
        fromSemver: row.from ?? p.semver,
        shippedSemver: p.semver,
      },
    });
    return { ok: true, shippedSemver: p.semver, seed: null };
  });
  if (!result.ok) return result;
  // The shipped version now, rather than at the next start (best effort: a start retries).
  const seeded = await seedKobeSkills({
    db: deps.db,
    blobs: deps.blobs,
    log: deps.log,
    packages: [p],
  }).catch((err: unknown) => {
    deps.log.error({ err, skillId }, "skills: Kobe skill not re-seeded after Reset to Kobe");
    return [];
  });
  return { ...result, seed: seeded[0] ?? null };
}
