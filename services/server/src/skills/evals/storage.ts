import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { canonicalZip, fixtureWorkspacePath, type SkillEvalSuite } from "@kobe/protocol";
import { unzipSync } from "fflate";
import type { BlobStore } from "../../retention/blobs.js";
import { readVerified } from "../blob-read.js";

// Where a skill eval's objects live (KOBE-325): its own tree `<prefix>teams/<team>/skill-evals/
// <eval run>/`, never a thread's (retention's thread sweep never looks here). Both keys carry
// their object's SHA-256, so every read is verified: `bundle-<runtime hash>.zip` (the scanned
// runtime zip the "with" executions load) and `fixtures-<sha256>.zip` (the cases' fixtures, from
// `evals/fixtures/`, never in the runtime zip). Purges delete them only for deleted rows.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A fixtures zip holds at most 25 cases × 20 files; the package (≤ its own limits) bounds it. */
const FIXTURES_MAX_BYTES = 64 * 1024 * 1024;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export function evalTree(prefix: string, teamId: string, evalRunId: string): string {
  if (!UUID.test(teamId) || !UUID.test(evalRunId))
    throw new Error("skill eval keys: team and eval run must be UUIDs");
  return `${prefix}teams/${teamId}/skill-evals/${evalRunId}/`;
}

export const evalBundleKey = (tree: string, runtimeHash: string): string =>
  `${tree}bundle-${runtimeHash}.zip`;
export const evalFixturesKey = (tree: string, sha256: string): string =>
  `${tree}fixtures-${sha256}.zip`;

/** The SHA-256 a skill eval key names, or null. */
export function hashOfEvalKey(key: string): string | null {
  const m = /-([0-9a-f]{64})\.zip$/.exec(key);
  return m?.[1] && SHA256.test(m[1]) ? m[1] : null;
}

/**
 * The fixtures every case of the suite names, from the package's `evals/fixtures/`: entries keyed
 * by the case's own name (`fixtures/sales.csv`). Null when no case has fixtures.
 */
export function fixturesZip(
  files: ReadonlyMap<string, Uint8Array>,
  suite: SkillEvalSuite,
): Uint8Array | null {
  const named = new Map<string, Uint8Array>();
  for (const c of suite.cases)
    for (const f of c.files) {
      const bytes = files.get(`evals/${f}`);
      if (!bytes) throw new Error(`the package has no evals/${f}`);
      named.set(f, bytes);
    }
  return named.size === 0 ? null : canonicalZip(named);
}

/** The case's fixtures as `eval.prepare` lists them: workspace path, hash and size. */
export function caseFixtureList(
  files: ReadonlyMap<string, Uint8Array>,
  caseFiles: readonly string[],
): { path: string; sha256: string; size: number }[] {
  return caseFiles.map((f) => {
    const bytes = files.get(f);
    if (!bytes) throw new Error(`the fixtures zip has no ${f}`);
    return { path: fixtureWorkspacePath(f), sha256: sha256Hex(bytes), size: bytes.length };
  });
}

export async function putEvalObject(blobs: BlobStore, key: string, bytes: Uint8Array) {
  await blobs.objects.put(key, Readable.from([Buffer.from(bytes)]), bytes.length);
}

/** The stored fixtures, verified against the hash in their key; null when missing. */
export async function readFixtures(
  blobs: BlobStore,
  key: string,
): Promise<Map<string, Uint8Array> | null> {
  const hash = hashOfEvalKey(key);
  if (!hash) return null;
  const zip = await readVerified(blobs, key, hash, null);
  if (!zip) return null;
  if (zip.length > FIXTURES_MAX_BYTES) throw new Error("the fixtures zip is too large");
  return new Map(Object.entries(unzipSync(zip)));
}
