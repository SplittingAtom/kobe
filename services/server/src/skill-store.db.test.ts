import { randomUUID } from "node:crypto";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSkillBundle } from "@kobe/skill-scanner";
import { runWithAuditContext } from "./audit/context.js";
import { validateZipBundle } from "./skills/bundle.js";
import { IntegrityError } from "./skills/blob-read.js";
import { PostgresSkillStore, type PutPackageInput, type SkillStore } from "./skills/skill-store.js";
import { sha256Hex } from "./skills/storage.js";
import type { SkillLocation } from "./skills/store.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * The SkillStore interface (KOBE-310, spec SK29) against its only implementation: records in
 * Postgres, verified content-addressed bytes in the object store, deduplicated by hash within a
 * location, a corrupted object refused, and the export of a skill's packages.
 */
const PREFIX = "kobe/";
const objects = new MemoryObjects();
let h: Harness;
let store: SkillStore;
let userId: string;
const teamA = randomUUID();
const teamB = randomUUID();

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Skill ${name}\n---\n${body}\n`;
function bundleOf(name: string, files: Record<string, string> = {}, body = "Body.") {
  const zip = zipSync(
    Object.fromEntries(
      Object.entries({ "SKILL.md": skillMd(name, body), ...files }).map(([k, v]) => [
        k,
        strToU8(v),
      ]),
    ) as Zippable,
  );
  const result = validateZipBundle(zip);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const put = (location: SkillLocation, bundle: PutPackageInput["bundle"], semver?: string) =>
  asUser(() =>
    store.putPackage(location, {
      bundle,
      source: "zip",
      uploadedBy: userId,
      scan: scanSkillBundle([]),
      ...(semver ? { semver } : {}),
    }),
  );
const asUser = <T>(fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, fn);
const team = (teamId: string): SkillLocation => ({ scope: "team", teamId });
const keysUnder = (location: SkillLocation, hash: string) =>
  objects.keys(
    `${PREFIX}skills/${location.scope === "team" ? `teams/${location.teamId}` : `users/${location.ownerUserId}`}/${hash}/`,
  );
const files = (zip: Uint8Array) => Object.keys(unzipSync(zip)).sort();

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: PREFIX } });
  userId = await h.createUser("store@skills.test");
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'store-a', 'A'), ($2, 'store-b', 'B')`,
    [teamA, teamB],
  );
  if (!h.deps.blobs) throw new Error("no blobs");
  store = new PostgresSkillStore(h.deps.database.db, h.deps.blobs);
});

afterAll(async () => {
  await h?.close();
});

describe("put and get by hash", () => {
  it("stores the runtime zip under its hash and the package zip apart; get verifies both", async () => {
    const bundle = bundleOf("reporter", { "evals/cases.yaml": "cases: []\n" });
    const result = await put(team(teamA), bundle);
    if (!result.ok) throw new Error(result.error);
    const { version } = result;
    expect(version.contentHash).toBe(sha256Hex(bundle.zip));
    expect(version.packageHash).toBe(bundle.packageHash);
    const runtime = await store.getPackage(team(teamA), version.contentHash);
    expect(files(runtime ?? new Uint8Array())).toEqual(["SKILL.md"]);
    const pkg = await store.getPackage(team(teamA), bundle.packageHash);
    expect(files(pkg ?? new Uint8Array())).toEqual(["SKILL.md", "evals/cases.yaml"]);
    // Teams are walls: another team can't read it by hash.
    expect(await store.getPackage(team(teamB), version.contentHash)).toBeNull();
    const checks = await h.admin.query(
      `SELECT runtime_hash FROM skill_hash_checks WHERE stored_hash = $1`,
      [version.contentHash],
    );
    expect(checks.rows).toEqual([{ runtime_hash: version.contentHash }]);
  });

  it("deduplicates bytes by hash within a location, never across locations", async () => {
    const first = bundleOf("dedupe", { "evals/cases.yaml": "a: 1\n" });
    const evalsOnly = bundleOf("dedupe", { "evals/cases.yaml": "a: 2\n" });
    expect(sha256Hex(evalsOnly.zip)).toBe(sha256Hex(first.zip));
    const v1 = await put(team(teamA), first);
    const v2 = await put(team(teamA), evalsOnly);
    if (!v1.ok || !v2.ok) throw new Error("upload refused");
    // An evals-only change is a new version with the same runtime hash (one runtime object).
    expect(v2.version).toMatchObject({ seq: 2, contentHash: v1.version.contentHash });
    expect(keysUnder(team(teamA), v1.version.contentHash)).toHaveLength(1);
    expect(v2.version.storageKey).toBe(v1.version.storageKey);
    expect(v2.version.packageStorageKey).not.toBe(v1.version.packageStorageKey);
    // Another team stores the same bytes again: objects never cross locations (teams are walls).
    const again = await put(team(teamB), first);
    if (!again.ok) throw new Error(again.error);
    expect(again.version.storageKey).not.toBe(v1.version.storageKey);
    expect(keysUnder(team(teamB), v1.version.contentHash)).toHaveLength(1);
  });

  it("refuses an identical package, and removes only the objects that upload wrote", async () => {
    const bundle = bundleOf("twice");
    const v1 = await put(team(teamA), bundle);
    if (!v1.ok) throw new Error(v1.error);
    const before = objects.objects.size;
    const again = await put(team(teamA), bundle);
    expect(again).toMatchObject({ ok: false, error: "unchanged" });
    expect(objects.objects.size).toBe(before);
    expect(objects.objects.has(v1.version.storageKey)).toBe(true);
  });

  it("refuses a corrupted object instead of serving it", async () => {
    const bundle = bundleOf("tampered", {}, "Original.");
    const result = await put(team(teamA), bundle);
    if (!result.ok) throw new Error(result.error);
    const key = result.version.storageKey;
    const original = objects.objects.get(key) as Buffer;
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 30] = (corrupt[corrupt.length - 30] ?? 0) ^ 0xff;
    objects.objects.set(key, corrupt);
    await expect(store.getPackage(team(teamA), result.version.contentHash)).rejects.toBeInstanceOf(
      IntegrityError,
    );
    const opened = await store.openVersion(team(teamA), result.skill.id, 1);
    if (!opened) throw new Error("not opened");
    await expect(
      (async () => {
        for await (const _chunk of opened.body) void _chunk;
      })(),
    ).rejects.toBeInstanceOf(IntegrityError);
    objects.objects.set(key, Buffer.concat([original, Buffer.from("x")]));
    expect(await store.openVersion(team(teamA), result.skill.id, 1)).toBeNull();
    objects.objects.set(key, original);
    expect(await store.getPackage(team(teamA), result.version.contentHash)).not.toBeNull();
  });
});

describe("versions, approval and export", () => {
  it("lists newest first, records an approval and exports packages oldest first", async () => {
    const v1 = await put(team(teamA), bundleOf("exported", {}, "One."), "1.0.0");
    const v2 = await put(
      team(teamA),
      bundleOf("exported", { "kobe.skill.yaml": manifest("1.1.0") }, "Two."),
    );
    const v3 = await put(team(teamA), bundleOf("exported", {}, "Three."), "2.0.0");
    if (!v1.ok || !v2.ok || !v3.ok) throw new Error("upload refused");
    const id = v1.skill.id;
    expect((await store.listVersions(team(teamA), id)).map((v) => v.semver)).toEqual([
      "2.0.0",
      "1.1.0",
      "1.0.0",
    ]);
    const approved = await asUser(() =>
      store.recordApproval(
        teamA,
        { skillId: id, version: 1 },
        { status: "approved", note: null, reviewerId: userId },
      ),
    );
    expect(approved).toMatchObject({ ok: true, review: { status: "approved", semver: "1.0.0" } });
    const exported = await store.export(team(teamA), id, { fromSeq: 2 });
    expect(exported.map((e) => e.version.semver)).toEqual(["1.1.0", "2.0.0"]);
    const [second] = exported;
    if (!second || !("bytes" in second)) throw new Error("no bytes");
    expect(files(second.bytes)).toEqual(["SKILL.md", "kobe.skill.yaml"]);
    expect(sha256Hex(second.bytes)).toBe(v2.version.packageHash);
    expect(await store.export(team(teamB), id)).toEqual([]);
  });
});

const manifest = (version: string) =>
  `apiVersion: kobe.dev/skill/v1\nname: exported\nversion: ${version}\nsummary: Exports.\n`;
