import { compareSemver, parseSemver } from "../semver.js";

/**
 * The mirror's `catalog.json` (KOBE-343, SK29): an index of every version the mirror carries,
 * regenerated on each commit from the previous commit's index plus the new version. It never
 * holds a timestamp, person or team, so the same versions always give the same bytes.
 */
export const CATALOG_JSON_PATH = "catalog.json";
export const CATALOG_MIRROR_API_VERSION = "kobe.dev/skill-catalog-mirror/v1";

export interface CatalogEntry {
  readonly name: string;
  readonly semver: string;
  readonly tag: string;
  readonly runtimeHash: string;
  readonly packageHash: string;
}

type Versions = Record<string, { tag: string; runtimeHash: string; packageHash: string }>;
type Index = Record<string, Versions>;

const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const HASH = /^[0-9a-f]{64}$/;

/** The entries of a previous `catalog.json`; anything that doesn't parse is dropped, not kept. */
export function readCatalogJson(bytes: Uint8Array | null): Index {
  if (!bytes) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  const skills = (doc as { skills?: unknown } | null)?.skills;
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) return {};
  const out: Index = {};
  for (const [name, entry] of Object.entries(skills as Record<string, unknown>)) {
    if (!NAME.test(name)) continue;
    const versions = (entry as { versions?: unknown } | null)?.versions;
    if (typeof versions !== "object" || versions === null) continue;
    for (const [semver, v] of Object.entries(versions as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null;
      if (
        !parseSemver(semver) ||
        typeof r?.tag !== "string" ||
        typeof r.runtimeHash !== "string" ||
        typeof r.packageHash !== "string" ||
        !HASH.test(r.runtimeHash) ||
        !HASH.test(r.packageHash)
      )
        continue;
      out[name] = {
        ...out[name],
        [semver]: { tag: r.tag, runtimeHash: r.runtimeHash, packageHash: r.packageHash },
      };
    }
  }
  return out;
}

/** The index without the `name@semver` versions in `drop` (withdrawn: blocklisted). */
export function withoutVersions(index: Index, drop: ReadonlySet<string>): Index {
  if (drop.size === 0) return index;
  return Object.fromEntries(
    Object.entries(index).flatMap(([name, versions]) => {
      const kept = Object.fromEntries(
        Object.entries(versions).filter(([semver]) => !drop.has(`${name}@${semver}`)),
      );
      return Object.keys(kept).length > 0 ? [[name, kept]] : [];
    }),
  );
}

/** The index with `entry` added (or replaced), as stable, pretty-printed UTF-8 JSON. */
export function writeCatalogJson(previous: Index, entry: CatalogEntry): Uint8Array {
  const next: Index = {
    ...previous,
    [entry.name]: {
      ...previous[entry.name],
      [entry.semver]: {
        tag: entry.tag,
        runtimeHash: entry.runtimeHash,
        packageHash: entry.packageHash,
      },
    },
  };
  const skills = Object.fromEntries(
    Object.keys(next)
      .sort()
      .map((name) => {
        const versions = next[name] ?? {};
        const ordered = Object.fromEntries(
          Object.keys(versions)
            .sort(compareSemver)
            .map((semver) => {
              const v = versions[semver] as Versions[string];
              return [
                semver,
                { tag: v.tag, runtimeHash: v.runtimeHash, packageHash: v.packageHash },
              ];
            }),
        );
        return [name, { versions: ordered }];
      }),
  );
  const doc = { apiVersion: CATALOG_MIRROR_API_VERSION, skills };
  return new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
}
