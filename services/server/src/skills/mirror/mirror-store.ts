import {
  registryVersionMirrorSchema,
  type RegistryVersionMirror,
  type SkillMirrorFailure,
} from "@kobe/protocol";
import { SYSTEM_ACTOR, sql, type KobeDb } from "@kobe/db";
import { blockedAmong } from "../blocklist.js";
import { recordAudit } from "../../audit/record.js";

/**
 * The mirror's records (KOBE-343): each catalog version's state against the configured remote in
 * `registry_versions.mirror` (a column the immutability trigger lets change), with backoff, and
 * the counts the Site console shows. Versions mirrored are the published ones: Approved and
 * Deprecated, not suspended. Withdrawn and Revoked versions are never pushed (one already pushed
 * stays: the mirror only appends).
 */

export const MIRROR_BACKOFF_BASE_MS = 60_000;
export const MIRROR_BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const MIRROR_ERROR_MAX = 500;

/** 1 min, 2, 4, … capped at 6 h. */
export function mirrorBackoffMs(attempts: number): number {
  return Math.min(MIRROR_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), MIRROR_BACKOFF_MAX_MS);
}

const PUBLISHED = sql`v.state IN ('approved', 'deprecated') AND v.suspended_at IS NULL`;

export interface PendingVersion {
  readonly id: string;
  readonly name: string;
  readonly semver: string;
  readonly runtimeHash: string;
  readonly packageHash: string;
  readonly runtimeStorageKey: string | null;
  readonly runtimeSizeBytes: number | null;
  readonly packageStorageKey: string | null;
  readonly provenance: Record<string, unknown>;
  readonly mirror: RegistryVersionMirror | null;
}

function parseMirror(v: unknown): RegistryVersionMirror | null {
  const r = registryVersionMirrorSchema.safeParse(v);
  return r.success ? r.data : null;
}

/**
 * Published versions not yet pushed to `url` and not backing off, oldest approval first.
 * A different `url` on a version means another remote: it is pending for this one.
 */
export async function pendingMirrorVersions(
  db: KobeDb,
  url: string,
  now: Date,
  limit: number,
): Promise<PendingVersion[]> {
  const res = await db.execute<{
    id: string;
    name: string;
    semver: string;
    runtime_hash: string;
    package_hash: string;
    runtime_storage_key: string | null;
    runtime_size_bytes: number | null;
    package_storage_key: string | null;
    provenance: Record<string, unknown>;
    mirror: unknown;
  }>(sql`
    SELECT v.id, s.name, v.semver, v.runtime_hash, v.package_hash, v.runtime_storage_key,
           v.runtime_size_bytes, v.package_storage_key, v.provenance, v.mirror
      FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
     WHERE ${PUBLISHED}
       AND (v.mirror IS NULL OR v.mirror->>'url' IS DISTINCT FROM ${url}
            OR (v.mirror->>'status' = 'failed'
                AND COALESCE((v.mirror->>'nextAttemptAt')::timestamptz <= ${now.toISOString()}::timestamptz, true)))
     ORDER BY COALESCE(v.approved_at, v.submitted_at), s.name, v.seq
     LIMIT ${limit}`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    semver: r.semver,
    runtimeHash: r.runtime_hash,
    packageHash: r.package_hash,
    runtimeStorageKey: r.runtime_storage_key,
    runtimeSizeBytes: r.runtime_size_bytes,
    packageStorageKey: r.package_storage_key,
    provenance: r.provenance,
    mirror: parseMirror(r.mirror),
  }));
}

export async function recordMirrorSuccess(
  db: KobeDb,
  v: PendingVersion,
  url: string,
  pushed: { commit: string; tag: string; tree: string; existing: boolean },
  now: Date,
): Promise<void> {
  const doc: RegistryVersionMirror = {
    url,
    status: "pushed",
    commit: pushed.commit,
    tag: pushed.tag,
    tree: pushed.tree,
    pushedAt: now.toISOString(),
    attempts: 0,
    lastAttemptAt: now.toISOString(),
  };
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE registry_versions SET mirror = ${JSON.stringify(doc)}::jsonb, updated_at = now()
       WHERE id = ${v.id}`);
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: "registry.mirror.pushed",
      target: {
        registryVersionId: v.id,
        name: v.name,
        semver: v.semver,
        commit: pushed.commit,
        tag: pushed.tag,
        ...(pushed.existing ? { existing: true as const } : {}),
      },
    });
  });
}

/** Records a failed attempt with its backoff; audits the first failure of a streak only. */
export async function recordMirrorFailure(
  db: KobeDb,
  v: PendingVersion,
  url: string,
  error: string,
  now: Date,
): Promise<RegistryVersionMirror> {
  const previous =
    v.mirror && v.mirror.url === url && v.mirror.status === "failed" ? v.mirror : null;
  const attempts = (previous?.attempts ?? 0) + 1;
  const message = error.slice(0, MIRROR_ERROR_MAX);
  const doc: RegistryVersionMirror = {
    url,
    status: "failed",
    attempts,
    lastError: message,
    lastAttemptAt: now.toISOString(),
    nextAttemptAt: new Date(now.getTime() + mirrorBackoffMs(attempts)).toISOString(),
  };
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE registry_versions SET mirror = ${JSON.stringify(doc)}::jsonb, updated_at = now()
       WHERE id = ${v.id}`);
    if (attempts === 1)
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: "registry.mirror.failed",
        target: { registryVersionId: v.id, name: v.name, semver: v.semver, error: message },
      });
  });
  return doc;
}

/** Makes every failed version for `url` due now (a Site admin's Retry); returns how many. */
export async function retryMirrorNow(db: KobeDb, url: string): Promise<number> {
  return db.transaction(async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      UPDATE registry_versions v SET mirror = v.mirror - 'nextAttemptAt', updated_at = now()
       WHERE v.mirror->>'url' = ${url} AND v.mirror->>'status' = 'failed'
      RETURNING v.id`);
    await recordAudit(tx, {
      action: "registry.mirror.retried",
      target: { versions: res.rows.length },
    });
    return res.rows.length;
  });
}

export interface MirrorCounts {
  readonly pushed: number;
  readonly withdrawn: number;
  readonly pending: number;
  readonly failed: number;
  readonly lastPushedAt: string | null;
  readonly failures: readonly SkillMirrorFailure[];
}

export const MIRROR_FAILURES_SHOWN = 20;

/** The console's numbers for `url`: pushed, failed and still pending published versions. */
export async function mirrorCounts(db: KobeDb, url: string | null): Promise<MirrorCounts> {
  const counts = await db.execute<{
    published: number;
    pushed: number;
    failed: number;
    withdrawn: number;
    last: string | null;
  }>(sql`
    SELECT count(*)::int AS published,
           count(*) FILTER (WHERE v.mirror->>'url' = ${url} AND v.mirror->>'status' = 'pushed')::int
             AS pushed,
           count(*) FILTER (WHERE v.mirror->>'url' = ${url} AND v.mirror->>'status' = 'failed')::int
             AS failed,
           count(*) FILTER (WHERE v.mirror->>'url' = ${url} AND v.mirror->>'status' = 'withdrawn')::int
             AS withdrawn,
           max(v.mirror->>'pushedAt') FILTER (WHERE v.mirror->>'url' = ${url}) AS last
      FROM registry_versions v WHERE ${PUBLISHED}`);
  const c = counts.rows[0] ?? { published: 0, pushed: 0, failed: 0, withdrawn: 0, last: null };
  const failed = url
    ? await db.execute<{ id: string; name: string; semver: string; mirror: unknown }>(sql`
        SELECT v.id, s.name, v.semver, v.mirror
          FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
         WHERE ${PUBLISHED} AND v.mirror->>'url' = ${url} AND v.mirror->>'status' = 'failed'
         ORDER BY v.mirror->>'lastAttemptAt' DESC
         LIMIT ${MIRROR_FAILURES_SHOWN}`)
    : { rows: [] };
  const failures = failed.rows.flatMap((r): SkillMirrorFailure[] => {
    const m = parseMirror(r.mirror);
    if (!m) return [];
    return [
      {
        registryVersionId: r.id,
        name: r.name,
        semver: r.semver,
        attempts: m.attempts,
        lastError: m.lastError ?? "",
        lastAttemptAt: m.lastAttemptAt,
        nextAttemptAt: m.nextAttemptAt ?? null,
      },
    ];
  });
  return {
    pushed: url ? c.pushed : 0,
    failed: url ? c.failed : 0,
    withdrawn: url ? c.withdrawn : 0,
    pending: url ? c.published - c.pushed - c.failed - c.withdrawn : c.published,
    lastPushedAt: url ? c.last : null,
    failures,
  };
}

/**
 * Withdraws blocklisted versions from the mirror (KOBE-343 review): every published version whose
 * runtime or package hash (or a hash of its group) is on the site skill blocklist gets status
 * `withdrawn` for `url` (a pushed commit and tag are kept in the record: they stay on the remote,
 * Kobe never rewrites history); one taken off the blocklist is pending again. Returns the
 * withdrawn versions as `name@semver`, to leave out of the next `catalog.json`.
 */
export async function withdrawBlocked(db: KobeDb, url: string, now: Date): Promise<Set<string>> {
  const res = await db.execute<{
    id: string;
    name: string;
    semver: string;
    runtime_hash: string;
    package_hash: string;
    mirror: unknown;
  }>(sql`
    SELECT v.id, s.name, v.semver, v.runtime_hash, v.package_hash, v.mirror
      FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
     WHERE ${PUBLISHED}`);
  const hashes = [...new Set(res.rows.flatMap((r) => [r.runtime_hash, r.package_hash]))];
  const blocked = new Set(await db.transaction((tx) => blockedAmong(tx, hashes)));
  const withdrawn = new Set<string>();
  for (const r of res.rows) {
    const m = parseMirror(r.mirror);
    const here = m?.url === url ? m : null;
    if (blocked.has(r.runtime_hash) || blocked.has(r.package_hash)) {
      withdrawn.add(`${r.name}@${r.semver}`);
      if (here?.status === "withdrawn") continue;
      const doc: RegistryVersionMirror = {
        url,
        status: "withdrawn",
        ...(here?.commit ? { commit: here.commit } : {}),
        ...(here?.tag ? { tag: here.tag } : {}),
        ...(here?.tree ? { tree: here.tree } : {}),
        ...(here?.pushedAt ? { pushedAt: here.pushedAt } : {}),
        attempts: 0,
        lastAttemptAt: now.toISOString(),
      };
      await db.execute(sql`
        UPDATE registry_versions SET mirror = ${JSON.stringify(doc)}::jsonb, updated_at = now()
         WHERE id = ${r.id}`);
    } else if (here?.status === "withdrawn") {
      await db.execute(sql`
        UPDATE registry_versions SET mirror = NULL, updated_at = now() WHERE id = ${r.id}`);
    }
  }
  return withdrawn;
}
