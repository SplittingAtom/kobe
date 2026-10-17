/**
 * Reads pnpm-lock.yaml (v9) into a dependency graph and classifies every package by how Kobe uses
 * it: shipped in a deployable's image (production closure of apps/* and services/*), dev-only, and
 * whether it only installs on some platforms (os/cpu/libc). The package set comes from the lockfile,
 * not from node_modules, so the inventory is the same on every machine.
 */
import { parseAllDocuments } from "yaml";

export interface LockedPackage {
  readonly name: string;
  readonly version: string;
  /** Has os/cpu/libc constraints, or is reachable only through such a package. */
  readonly platformOnly: boolean;
  /** Deployable importers (e.g. "apps/web") whose production closure contains the package. */
  readonly shippedBy: readonly string[];
}

type DepMap = Readonly<Record<string, string | { readonly version: string }>>;

interface Importer {
  readonly dependencies?: DepMap;
  readonly optionalDependencies?: DepMap;
  readonly devDependencies?: DepMap;
}

interface Snapshot {
  readonly dependencies?: DepMap;
  readonly optionalDependencies?: DepMap;
}

interface PackageMeta {
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly os?: unknown;
  readonly cpu?: unknown;
  readonly libc?: unknown;
}

interface Lockfile {
  readonly importers: Readonly<Record<string, Importer>>;
  readonly packages: Readonly<Record<string, PackageMeta>>;
  readonly snapshots: Readonly<Record<string, Snapshot | null>>;
}

/** `next@16.3.8(react@19.3.0)` → `next@16.3.8`; scoped names keep their leading `@`. */
export function packageKey(snapshotKey: string): string {
  const paren = snapshotKey.indexOf("(");
  return paren === -1 ? snapshotKey : snapshotKey.slice(0, paren);
}

export function splitKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0) throw new Error(`Not a name@version key: ${key}`);
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

type Target = { kind: "snapshot"; key: string } | { kind: "importer"; path: string };

function joinPath(base: string, relative: string): string {
  const parts = base === "." ? [] : base.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.length === 0 ? "." : parts.join("/");
}

function resolveRef(name: string, ref: string, importerPath: string): Target {
  if (ref.startsWith("link:")) {
    return { kind: "importer", path: joinPath(importerPath, ref.slice("link:".length)) };
  }
  // An alias (`string-width-cjs: string-width@4.2.3`) names the real package itself.
  const aliased = !/^\d/.test(ref) && ref.indexOf("@", 1) > 0;
  return { kind: "snapshot", key: aliased ? ref : `${name}@${ref}` };
}

function refOf(value: string | { readonly version: string }): string {
  return typeof value === "string" ? value : value.version;
}

function entries(...maps: (DepMap | undefined)[]): [string, string][] {
  return maps.flatMap((m) =>
    Object.entries(m ?? {}).map(([n, v]) => [n, refOf(v)] as [string, string]),
  );
}

export function parseLockfile(text: string): Lockfile {
  // pnpm 11+ writes the package manager's own lock as a first document; the project is the last.
  const docs = parseAllDocuments(text).map((d) => d.toJS() as Partial<Lockfile> | null);
  const project = docs.filter((d) => d?.snapshots && d.packages && d.importers).pop();
  if (!project) throw new Error("pnpm-lock.yaml has no importers/packages/snapshots document");
  return project as Lockfile;
}

interface Walk {
  readonly lock: Lockfile;
  readonly skipPlatform: boolean;
  /** Production closures skip peers (see closure()). */
  readonly skipPeers: boolean;
}

function isPlatform(lock: Lockfile, key: string): boolean {
  const meta = lock.packages[key];
  return (
    meta !== undefined &&
    (meta.os !== undefined || meta.cpu !== undefined || meta.libc !== undefined)
  );
}

/** Package keys reachable from the given starting edges (production edges only past the start). */
function closure(walk: Walk, start: readonly [string, string, string][]): Set<string> {
  const seenSnapshots = new Set<string>();
  const seenImporters = new Set<string>();
  const found = new Set<string>();
  const queue: Target[] = start.map(([name, ref, from]) => resolveRef(name, ref, from));
  while (queue.length > 0) {
    const target = queue.pop() as Target;
    if (target.kind === "importer") {
      if (seenImporters.has(target.path)) continue;
      seenImporters.add(target.path);
      const importer = walk.lock.importers[target.path] ?? {};
      for (const [n, r] of entries(importer.dependencies, importer.optionalDependencies)) {
        queue.push(resolveRef(n, r, target.path));
      }
      continue;
    }
    if (seenSnapshots.has(target.key)) continue;
    seenSnapshots.add(target.key);
    const key = packageKey(target.key);
    if (walk.skipPlatform && isPlatform(walk.lock, key)) continue;
    found.add(key);
    const snapshot = walk.lock.snapshots[target.key] ?? {};
    // Peers are provided by whoever depends on the package (already walked when they are
    // production dependencies there); following them would pull in a sibling's dev peers.
    const peers = (walk.skipPeers && walk.lock.packages[key]?.peerDependencies) || {};
    for (const [n, r] of entries(snapshot.dependencies, snapshot.optionalDependencies)) {
      if (!(n in peers)) queue.push(resolveRef(n, r, "."));
    }
  }
  return found;
}

function edges(path: string, ...maps: (DepMap | undefined)[]): [string, string, string][] {
  return entries(...maps).map(([n, r]) => [n, r, path]);
}

/**
 * Every package in the lockfile that some importer reaches, with how it is used. `deployables` are
 * the importers whose production dependencies ship in an image.
 */
export function classifyPackages(lock: Lockfile, deployables: readonly string[]): LockedPackage[] {
  const all: [string, string, string][] = Object.entries(lock.importers).flatMap(([path, imp]) =>
    edges(path, imp.dependencies, imp.optionalDependencies, imp.devDependencies),
  );
  const reachable = closure({ lock, skipPlatform: false, skipPeers: false }, all);
  const portable = closure({ lock, skipPlatform: true, skipPeers: false }, all);
  const shipped = new Map<string, string[]>();
  for (const path of deployables) {
    const imp = lock.importers[path];
    if (!imp) throw new Error(`Deployable ${path} is not an importer in pnpm-lock.yaml`);
    const prod = closure(
      { lock, skipPlatform: false, skipPeers: true },
      edges(path, imp.dependencies, imp.optionalDependencies),
    );
    for (const key of prod) shipped.set(key, [...(shipped.get(key) ?? []), path]);
  }
  return [...reachable].sort().map((key) => ({
    ...splitKey(key),
    platformOnly: !portable.has(key),
    shippedBy: (shipped.get(key) ?? []).slice().sort(),
  }));
}
