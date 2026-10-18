import { randomUUID } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeHash, runtimeZip } from "@kobe/protocol/node";
import { runWithAuditContext } from "./audit/context.js";
import { addBlocked, blockedAmong, isBlocked, removeBlocked } from "./skills/blocklist.js";
import pg from "pg";
import { recomputeOnce, recomputeSkillHashes } from "./skills/hash-checks.js";
import { PostgresSkillStore } from "./skills/skill-store.js";
import { sha256Hex } from "./skills/storage.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-310, docs/skill-package.md "Identity": the recompute sorts every stored hash into same,
 * alias or legacy, idempotently; the blocklist then treats an alias group as one identity, and a
 * legacy version keeps its stored hash alone and can't be exported.
 */
const objects = new MemoryObjects();
const silent = { info: () => {}, warn: () => {}, error: () => {} };
let h: Harness;
let userId: string;
const teamA = randomUUID();
const teamB = randomUUID();
const SKILL_MD = "---\nname: shared\ndescription: Shared payload\n---\nBody.\n";
const PAYLOAD = { "SKILL.md": SKILL_MD, "scripts/run.py": "print(1)\n" };
const zip = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, [strToU8(v), { level: 0 }]]),
    ) as Zippable,
  );
const asMap = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([k, v]) => [k, strToU8(v)]));
const RUNTIME = runtimeHash(asMap(PAYLOAD));
const stored = {
  a: zip({ ...PAYLOAD, "evals/cases.yaml": "a: 1\n" }),
  b: zip({
    ...PAYLOAD,
    "evals/cases.yaml": "b: 2\n",
    "kobe.skill.yaml": "apiVersion: kobe.dev/skill/v1\nname: shared\nversion: 0.1.0\nsummary: S.\n",
  }),
  c: runtimeZip(asMap(PAYLOAD)),
  d: zip({ ...PAYLOAD, "provenance.json": "{}" }),
  e: zip({ ...PAYLOAD, "Evals/cases.yaml": "e: 1\n" }),
  f: zip({ ...PAYLOAD, "notes.md": "lost object" }),
};
const hash = Object.fromEntries(
  Object.entries(stored).map(([k, v]) => [k, sha256Hex(v)]),
) as Record<keyof typeof stored, string>;
const asUser = <T>(fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);
let personalSkill = "";

/** A version as a release before KOBE-310 stored it: the whole upload, hashed as it was. */
async function legacyVersion(
  where: { team: string } | { personal: string },
  version: number,
  key: keyof typeof stored,
) {
  const bytes = stored[key];
  const storageKey = `kobe/legacy/${key}`;
  if (key !== "f") objects.objects.set(storageKey, Buffer.from(bytes));
  const cols = `version, semver, seq, frontmatter, source, content_hash, storage_key, size_bytes,
    file_count, uncompressed_bytes, uploaded_by`;
  const vals = [
    version,
    `0.${version}.0`,
    version,
    "{}",
    "zip",
    hash[key],
    storageKey,
    bytes.length,
    2,
    10,
    userId,
  ];
  if ("team" in where) {
    await h.admin.query(
      `INSERT INTO team_skill_versions (team_id, skill_id, ${cols}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [where.team, await teamSkill(where.team, version), ...vals],
    );
  } else {
    await h.admin.query(
      `INSERT INTO personal_skill_versions (skill_id, ${cols}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [where.personal, ...vals],
    );
  }
}
async function teamSkill(team: string, latest: number): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO team_skills (team_id, owner_user_id, slug, description, latest_version)
     VALUES ($1, $2, 'shared', 'd', $3)
     ON CONFLICT (team_id, slug) DO UPDATE SET latest_version = EXCLUDED.latest_version
     RETURNING id`,
    [team, userId, latest],
  );
  return rows[0]?.id as string;
}

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  userId = await h.createUser("hashes@skills.test");
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'hash-a', 'A'), ($2, 'hash-b', 'B')`,
    [teamA, teamB],
  );
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO personal_skills (owner_user_id, slug, description, latest_version)
     VALUES ($1, 'shared', 'd', 4) RETURNING id`,
    [userId],
  );
  personalSkill = rows[0]?.id as string;
  await legacyVersion({ team: teamA }, 1, "a");
  await legacyVersion({ team: teamB }, 1, "b");
  await legacyVersion({ personal: personalSkill }, 1, "c");
  await legacyVersion({ personal: personalSkill }, 2, "d");
  await legacyVersion({ personal: personalSkill }, 3, "e");
  await legacyVersion({ personal: personalSkill }, 4, "f");
});

afterAll(async () => {
  await h?.close();
});

const db = () => h.deps.database.db;
const blobs = () => {
  if (!h.deps.blobs) throw new Error("no blobs");
  return h.deps.blobs;
};

describe("the one-off recompute", () => {
  it("records same, alias and legacy outcomes and skips an unreadable object", async () => {
    const report = await recomputeSkillHashes({ db: db(), blobs: blobs(), log: silent });
    expect(report).toEqual({ checked: 5, same: 1, aliased: 2, legacy: 2, unreadable: 1 });
    const { rows } = await h.admin.query(
      `SELECT stored_hash, runtime_hash, problems FROM skill_hash_checks WHERE stored_hash = ANY($1)`,
      [Object.values(hash)],
    );
    const byHash = new Map(rows.map((r) => [r.stored_hash, r]));
    expect(byHash.get(hash.a)).toMatchObject({ runtime_hash: RUNTIME, problems: [] });
    expect(byHash.get(hash.b)).toMatchObject({ runtime_hash: RUNTIME, problems: [] });
    expect(byHash.get(hash.c)).toMatchObject({ runtime_hash: hash.c });
    expect(hash.c).toBe(RUNTIME);
    expect(byHash.get(hash.d)).toMatchObject({
      runtime_hash: null,
      problems: ["provenance_not_allowed"],
    });
    expect(byHash.get(hash.e)).toMatchObject({
      runtime_hash: null,
      problems: ["reserved_name_case"],
    });
    expect(byHash.has(hash.f)).toBe(false);
  });

  it("is idempotent: a second run checks only what is still unrecorded", async () => {
    const report = await recomputeSkillHashes({ db: db(), blobs: blobs(), log: silent });
    expect(report).toEqual({ checked: 0, same: 0, aliased: 0, legacy: 0, unreadable: 1 });
    objects.objects.set("kobe/legacy/f", Buffer.from(stored.f));
    const third = await recomputeSkillHashes({ db: db(), blobs: blobs(), log: silent });
    // Its stored zip was not canonical (files out of order): an alias of its runtime hash.
    expect(third).toEqual({ checked: 1, same: 0, aliased: 1, legacy: 0, unreadable: 0 });
  });
});

describe("the blocklist works on alias groups", () => {
  it("blocks every stored hash of a payload when one is listed, and unblocks them together", async () => {
    const listed = await asUser(() =>
      addBlocked(db(), { hash: hash.a, reason: "malware", userId }),
    );
    expect(listed).not.toBeNull();
    const blocked = await db().transaction((tx) =>
      blockedAmong(tx, [hash.a, hash.b, hash.c, hash.d, hash.e]),
    );
    expect(blocked.sort()).toEqual([hash.a, hash.b, hash.c].sort());
    // Adding another member of a blocked group is a no-op.
    expect(
      await asUser(() => addBlocked(db(), { hash: hash.b, reason: "again", userId })),
    ).toBeNull();
    expect(
      await asUser(() => addBlocked(db(), { hash: RUNTIME, reason: "again", userId })),
    ).toBeNull();
    // Removing any member (even one never listed itself) unblocks the whole group.
    expect(await asUser(() => removeBlocked(db(), hash.b))).toBe(true);
    expect(await db().transaction((tx) => blockedAmong(tx, [hash.a, hash.b, hash.c]))).toEqual([]);
    expect(await asUser(() => removeBlocked(db(), hash.b))).toBe(false);
  });

  it("keeps a legacy hash a group of one", async () => {
    await asUser(() => addBlocked(db(), { hash: hash.d, reason: "legacy", userId }));
    expect(await db().transaction((tx) => isBlocked(tx, hash.d))).toBe(true);
    expect(await db().transaction((tx) => blockedAmong(tx, [hash.c, hash.e]))).toEqual([]);
    expect(await asUser(() => removeBlocked(db(), hash.d))).toBe(true);
  });
});

describe("legacy versions", () => {
  it("are not exportable until re-saved; valid stored ones export their stored package", async () => {
    const store = new PostgresSkillStore(db(), blobs());
    const exported = await store.export({ scope: "personal", ownerUserId: userId }, personalSkill);
    expect(
      exported.map((e) => ("legacy" in e ? { legacy: e.legacy } : { bytes: sha256Hex(e.bytes) })),
    ).toEqual([
      { bytes: hash.c },
      { legacy: ["provenance_not_allowed"] },
      { legacy: ["reserved_name_case"] },
      { bytes: hash.f },
    ]);
  });
});

describe("export never assumes an unchecked hash is clean (KOBE-310 review S2)", () => {
  async function newPersonalSkill(slug: string, versions: Record<string, string>[]) {
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO personal_skills (owner_user_id, slug, description, latest_version)
       VALUES ($1, $2, 'd', $3) RETURNING id`,
      [userId, slug, versions.length],
    );
    const skill = rows[0]?.id as string;
    for (const [i, files] of versions.entries()) {
      const bytes = zip(files);
      const key = `kobe/legacy/${slug}/${i + 1}`;
      objects.objects.set(key, Buffer.from(bytes));
      await h.admin.query(
        `INSERT INTO personal_skill_versions (skill_id, version, semver, seq, frontmatter, source,
           content_hash, storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
         VALUES ($1, $2, $3, $2, '{}', 'zip', $4, $5, $6, 1, 1, $7)`,
        [skill, i + 1, `0.${i + 1}.0`, sha256Hex(bytes), key, bytes.length, userId],
      );
    }
    return skill;
  }
  const md = "---\nname: manifested\ndescription: Has a manifest\n---\nBody.\n";
  const manifest = (version: string, name = "manifested") =>
    `apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: ${version}\nsummary: S.\n`;

  it("checks on demand, and refuses invalid or contradicting manifests", async () => {
    const skill = await newPersonalSkill("manifested", [
      { "SKILL.md": md, "notes.md": "plain, never checked" },
      { "SKILL.md": md, "kobe.skill.yaml": "apiVersion: nope\n" },
      { "SKILL.md": md, "kobe.skill.yaml": manifest("0.3.0", "other-name") },
      { "SKILL.md": md, "kobe.skill.yaml": manifest("9.9.9") },
      { "SKILL.md": md, "kobe.skill.yaml": manifest("0.5.0") },
    ]);
    const store = new PostgresSkillStore(db(), blobs());
    const exported = await store.export({ scope: "personal", ownerUserId: userId }, skill);
    expect(exported.map((e) => ("legacy" in e ? e.legacy : "ok"))).toEqual([
      "ok",
      ["invalid_manifest"],
      ["invalid_manifest"],
      ["manifest_version_mismatch"],
      "ok",
    ]);
    // The on-demand checks were recorded like the recompute's.
    const first = exported[0];
    if (!first || !("runtimeHash" in first)) throw new Error("first not exported");
    const row = await h.admin.query(
      `SELECT runtime_hash FROM skill_hash_checks WHERE stored_hash = $1`,
      [first.version.contentHash],
    );
    expect(row.rows).toEqual([{ runtime_hash: first.runtimeHash }]);
  });
});

describe("one replica at a time (KOBE-310 review S3)", () => {
  it("skips the run while another replica holds the lock", async () => {
    const other = new pg.Client({ connectionString: h.adminUrl });
    await other.connect();
    try {
      await other.query(
        `SELECT pg_advisory_lock(hashtextextended('kobe.skills.hash_recompute', 0))`,
      );
      expect(
        await recomputeOnce({ database: h.deps.database, blobs: blobs(), log: silent }),
      ).toBeNull();
      await other.query(
        `SELECT pg_advisory_unlock(hashtextextended('kobe.skills.hash_recompute', 0))`,
      );
      expect(
        await recomputeOnce({ database: h.deps.database, blobs: blobs(), log: silent }),
      ).toMatchObject({ unreadable: 0 });
    } finally {
      await other.end();
    }
  });

  it("picks up versions written after an earlier run (a previous-release pod mid-upgrade)", async () => {
    const files = { "SKILL.md": SKILL_MD.replace("Body.", "Late."), "evals/late.yaml": "a: 1\n" };
    const bytes = zip(files);
    const late = sha256Hex(bytes);
    objects.objects.set("kobe/legacy/late", Buffer.from(bytes));
    await h.admin.query(
      `INSERT INTO personal_skill_versions (skill_id, version, semver, seq, frontmatter, source,
         content_hash, storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
       VALUES ($1, 9, '0.9.0', 9, '{}', 'zip', $2, 'kobe/legacy/late', $3, 2, 10, $4)`,
      [personalSkill, late, bytes.length, userId],
    );
    const report = await recomputeOnce({ database: h.deps.database, blobs: blobs(), log: silent });
    expect(report).toMatchObject({ checked: 1, aliased: 1 });
  });
});
