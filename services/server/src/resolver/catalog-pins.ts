/**
 * Which catalog version an install or a member add runs (KOBE-315, SK25, SK31): a pure function of
 * the skill's versions and the pin. Pinned runs exactly its version; Track within major the
 * highest runnable version of the pinned version's major; Track latest the highest of any major.
 *
 * - Deprecated versions keep working (pinned or tracked).
 * - Withdrawn: a pinned install keeps it; tracking moves to the next highest in range.
 * - Revoked stops at once; tracking moves within its range only (never across majors).
 * - Track latest's range is the newest published major (approved, deprecated, withdrawn or
 *   revoked): when that major's versions are revoked or withdrawn, it does not drop back to an
 *   older major (SK31: no automatic move across majors, even on Revoke).
 * - Suspended (a rescan turned it Block, KOBE-313): never runs, and an older version does not take
 *   its place (the reviewer decides it again).
 */
export interface CatalogVersion {
  readonly id: string;
  readonly semver: string;
  readonly seq: number;
  readonly state: string;
  readonly suspended: boolean;
  readonly runtimeHash: string;
  readonly packageHash: string;
}

export interface CatalogPin {
  readonly pinMode: "pinned" | "within_major" | "latest";
  readonly versionId: string;
}

export type CatalogPick =
  | { readonly ok: true; readonly version: CatalogVersion }
  | { readonly ok: false; readonly reason: "not_approved" | "revoked" | "suspended" };

const PINNED_RUNS = new Set(["approved", "deprecated", "withdrawn"]);
const TRACKED_RUNS = new Set(["approved", "deprecated"]);
const PUBLISHED = new Set(["approved", "deprecated", "withdrawn", "revoked"]);
const majorOf = (semver: string) => Number(semver.split(".", 1)[0]);

/** The major a tracking pin follows: the install's own, or for latest the newest published one. */
function rangeMajor(versions: readonly CatalogVersion[], base: CatalogVersion, pin: CatalogPin) {
  if (pin.pinMode !== "latest") return majorOf(base.semver);
  return versions
    .filter((v) => PUBLISHED.has(v.state))
    .reduce((m, v) => Math.max(m, majorOf(v.semver)), majorOf(base.semver));
}

export function pickCatalogVersion(
  versions: readonly CatalogVersion[],
  pin: CatalogPin,
): CatalogPick {
  const base = versions.find((v) => v.id === pin.versionId);
  if (!base) return { ok: false, reason: "not_approved" };
  if (pin.pinMode === "pinned") {
    if (base.state === "revoked") return { ok: false, reason: "revoked" };
    if (!PINNED_RUNS.has(base.state)) return { ok: false, reason: "not_approved" };
    return base.suspended ? { ok: false, reason: "suspended" } : { ok: true, version: base };
  }
  const major = rangeMajor(versions, base, pin);
  const range = versions.filter((v) => majorOf(v.semver) === major);
  const top = range
    .filter((v) => TRACKED_RUNS.has(v.state))
    .reduce<CatalogVersion | undefined>((a, b) => (a && a.seq > b.seq ? a : b), undefined);
  if (!top)
    return {
      ok: false,
      reason: range.some((v) => v.state === "revoked") ? "revoked" : "not_approved",
    };
  return top.suspended ? { ok: false, reason: "suspended" } : { ok: true, version: top };
}
