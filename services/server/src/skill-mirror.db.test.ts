import { execFileSync } from "node:child_process";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skillPackageHashes } from "@kobe/protocol/node";
import { validateZipBundle } from "./skills/bundle.js";
import { ensureObject } from "./skills/kobe-seed.js";
import { mirrorHttpClient } from "./skills/mirror/http-client.js";
import { SkillMirror } from "./skills/mirror/runner.js";
import { sha256Hex } from "./skills/storage.js";
import type { TestBrowser } from "./testing/browser.js";
import { selfSignedCert, startGitServer, type GitServer } from "./testing/git-http-server.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-343 (SK29, U36): the catalog's optional one-way git mirror against a local HTTPS git
 * server. Off, nothing changes (ac-3); on, each published version becomes a commit and an
 * annotated tag whose tree hashes back to the version's runtime and package hashes (ac-1); pushes
 * are never forced, failures back off per version, show in the Site console and are audited once
 * per streak (ac-2); the token never reaches a stored error. The egress proxy path is covered by
 * http-client.test.ts and the egress proxy's own tests (ac-4).
 */
const CREDS = { username: "x-access-token", token: "mirror-secret-token-42" };
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
let h: Harness;
let git: GitServer;
let cert: { key: string; cert: string };
let admin: TestBrowser;
let member: TestBrowser;
let adminId = "";
let clock = new Date("2026-10-22T10:00:00.000Z");
let mirror: SkillMirror;
let kicks = 0;

const versionIds: Record<string, string> = {};

async function publish(name: string, semver: string, state = "approved"): Promise<string> {
  const skill = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'S.')
     ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id`,
    [name],
  );
  const skillId = skill.rows[0]?.id as string;
  const valid = validateZipBundle(
    zipSync({
      "SKILL.md": strToU8(`---\nname: ${name}\ndescription: Does ${name}.\n---\n# ${semver}\n`),
      "kobe.skill.yaml": strToU8(
        `apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: ${semver}\nsummary: S.\nlicense: Apache-2.0\n`,
      ),
      "evals/cases.yaml": strToU8("cases: []\n"),
      "scripts/run.py": strToU8("print('hi')\n"),
    }),
  );
  if (!valid.ok) throw new Error(valid.error.message);
  const b = valid.value;
  const runtimeHash = sha256Hex(b.zip);
  const runtimeKey = await ensureObject(blobs, b.zip, runtimeHash);
  const packageKey = b.packageZip ? await ensureObject(blobs, b.packageZip, b.packageHash) : null;
  const seq = Number(
    (
      await h.admin.query<{ n: number }>(
        `SELECT count(*)::int + 1 AS n FROM registry_versions WHERE skill_id = $1`,
        [skillId],
      )
    ).rows[0]?.n,
  );
  const r = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
       scan, verdict, submitted_by, state, reviewed_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}', '{}', '{}', '{"findings": []}', 'pass', $9,
       $10::registry_version_state, $9, now() + make_interval(secs => $3::int))
     RETURNING id`,
    [
      skillId,
      semver,
      seq,
      runtimeHash,
      b.packageHash,
      runtimeKey,
      b.zip.length,
      packageKey,
      adminId,
      state,
    ],
  );
  const id = r.rows[0]?.id as string;
  versionIds[`${name}@${semver}`] = id;
  return id;
}

const mirrorDoc = async (id: string) =>
  (
    await h.admin.query<{ mirror: Record<string, unknown> | null }>(
      `SELECT mirror FROM registry_versions WHERE id = $1`,
      [id],
    )
  ).rows[0]?.mirror ?? null;

const audits = async (action: string) =>
  (
    await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows.map((r) => r.target);

async function setMirror(url: string | null, enabled = true) {
  const res = await admin.put("/v1/site/skills/registry/settings", {
    mirror: url ? { enabled, url } : { enabled: false },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

/** The files under `skills/<name>/` at a tag, read back with the git CLI. */
function filesAtTag(repo: string, tag: string, name: string): Map<string, Uint8Array> {
  const bare = path.join(git.root, `${repo}.git`);
  const list = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", `${tag}^{commit}`, `skills/${name}/`],
    {
      cwd: bare,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean);
  return new Map(
    list.map((p) => [
      p.slice(`skills/${name}/`.length),
      new Uint8Array(execFileSync("git", ["show", `${tag}^{commit}:${p}`], { cwd: bare })),
    ]),
  );
}

beforeAll(async () => {
  cert = selfSignedCert("localhost");
  git = await startGitServer({ credentials: CREDS, tls: cert });
  // The app gets a handle that counts kicks (sweeps run explicitly here, for determinism).
  h = await openHarness({ blobs }, () => ({
    skillMirror: { kick: () => void (kicks += 1), missing: () => mirror.missing() },
  }));
  adminId = await h.createUser("admin@mirror.test", "admin");
  await h.createUser("member@mirror.test");
  admin = await h.signIn("admin@mirror.test");
  member = await h.signIn("member@mirror.test");
  // Only this test's versions are in the catalog.
  await h.admin.query(`UPDATE registry_versions SET suspended_at = now()`);
  mirror = new SkillMirror({
    db: h.deps.database.db,
    pool: h.deps.database.pool,
    blobs,
    credentials: CREDS,
    egress: null,
    author: { name: "Kobe Registry", email: "registry@kobe.invalid" },
    now: () => clock,
    transport: (remote) =>
      mirrorHttpClient({ remote, credentials: CREDS, proxy: null, ca: cert.cert }),
  });
});
afterAll(async () => {
  await h?.close();
  await git?.close();
});

describe("the catalog's git mirror (KOBE-343)", () => {
  it("does nothing while off (ac-3)", async () => {
    await publish("quarterly-report", "1.0.0");
    expect(await mirror.sweep()).toEqual({ ran: false, reason: "off" });
    expect(await mirrorDoc(versionIds["quarterly-report@1.0.0"] as string)).toBeNull();
    expect(git.requests).toEqual([]);
    const status = await admin.get("/v1/site/skills/registry/mirror");
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ enabled: false, url: null, pushed: 0, failed: 0 });
  });

  it("pushes each published version as a commit and annotated tag matching its hashes (ac-1)", async () => {
    await publish("quarterly-report", "1.1.0");
    await publish("weekly-digest", "0.1.0");
    await publish("withdrawn-one", "1.0.0", "withdrawn");
    const url = git.repo("catalog");
    const before = kicks;
    await setMirror(url);
    // Turning the mirror on kicks it.
    expect(kicks).toBe(before + 1);
    expect(await mirror.sweep()).toEqual({ ran: true, pushed: 3, failed: 0 });
    for (const key of ["quarterly-report@1.0.0", "quarterly-report@1.1.0", "weekly-digest@0.1.0"]) {
      const [name, semver] = key.split("@") as [string, string];
      const id = versionIds[key] as string;
      const doc = await mirrorDoc(id);
      expect(doc).toMatchObject({ url, status: "pushed", tag: `${name}/v${semver}`, attempts: 0 });
      const row = (
        await h.admin.query<{ runtime_hash: string; package_hash: string }>(
          `SELECT runtime_hash, package_hash FROM registry_versions WHERE id = $1`,
          [id],
        )
      ).rows[0];
      const files = filesAtTag("catalog", `${name}/v${semver}`, name);
      expect(files.has("evals/cases.yaml")).toBe(true);
      expect(skillPackageHashes(files, { kobeProvenance: true })).toEqual({
        runtimeHash: row?.runtime_hash,
        packageHash: row?.package_hash,
      });
      expect(
        git.git("catalog", ["cat-file", "-t", `${name}/v${semver}`], { bare: true }).trim(),
      ).toBe("tag");
    }
    // Withdrawn versions are never pushed.
    expect(await mirrorDoc(versionIds["withdrawn-one@1.0.0"] as string)).toBeNull();
    expect(git.git("catalog", ["tag", "-l"], { bare: true })).not.toContain("withdrawn-one");
    expect((await audits("registry.mirror.pushed")).map((t) => t.tag).sort()).toEqual([
      "quarterly-report/v1.0.0",
      "quarterly-report/v1.1.0",
      "weekly-digest/v0.1.0",
    ]);
    // A second sweep has nothing to do and pushes nothing.
    const head = git.git("catalog", ["rev-parse", "main"], { bare: true });
    expect(await mirror.sweep()).toEqual({ ran: true, pushed: 0, failed: 0 });
    expect(git.git("catalog", ["rev-parse", "main"], { bare: true })).toBe(head);
    const status = await admin.get("/v1/site/skills/registry/mirror");
    expect(status.json).toMatchObject({
      enabled: true,
      url,
      branch: "main",
      ready: true,
      pushed: 3,
      pending: 0,
      failed: 0,
      hostInCeiling: false,
    });
  });

  it("backs off a failing version, shows it, audits the streak once, and never leaks the token (ac-2)", async () => {
    const broken = await publish("broken-bytes", "1.0.0");
    const keys = (
      await h.admin.query<{ r: string; p: string | null }>(
        `SELECT runtime_storage_key AS r, package_storage_key AS p FROM registry_versions
          WHERE id = $1`,
        [broken],
      )
    ).rows[0];
    // Its bytes are gone from the object store.
    objects.lost.add(keys?.r as string);
    if (keys?.p) objects.lost.add(keys.p);
    await publish("weekly-digest", "0.2.0");
    expect(await mirror.sweep()).toEqual({ ran: true, pushed: 1, failed: 1 });
    const doc = await mirrorDoc(broken);
    expect(doc).toMatchObject({ status: "failed", attempts: 1 });
    expect(String(doc?.lastError)).toMatch(/not in the object store/);
    // Not due yet: skipped. After the backoff: retried, attempts 2, no second audit row.
    expect(await mirror.sweep()).toEqual({ ran: true, pushed: 0, failed: 0 });
    clock = new Date(clock.getTime() + 61_000);
    expect(await mirror.sweep()).toEqual({ ran: true, pushed: 0, failed: 1 });
    expect(await mirrorDoc(broken)).toMatchObject({ status: "failed", attempts: 2 });
    expect((await audits("registry.mirror.failed")).length).toBe(1);
    const status = await admin.get("/v1/site/skills/registry/mirror");
    expect(status.json).toMatchObject({ failed: 1, pushed: 4 });
    expect((status.json as { failures: { name: string; attempts: number }[] }).failures).toEqual([
      expect.objectContaining({ name: "broken-bytes", attempts: 2 }),
    ]);
    // Retry now: due at once, audited.
    const retry = await admin.post("/v1/site/skills/registry/mirror/retry", {});
    expect(retry.json).toEqual({ versions: 1 });
    expect((await mirrorDoc(broken))?.nextAttemptAt).toBeUndefined();
    expect((await audits("registry.mirror.retried")).length).toBe(1);
    await h.admin.query(`UPDATE registry_versions SET suspended_at = now() WHERE id = $1`, [
      broken,
    ]);
  });

  it("stops on a remote failure, records it on the oldest pending version, and redacts the token", async () => {
    await setMirror(`${git.origin}/nowhere.git`);
    const result = await mirror.sweep();
    expect(result).toMatchObject({ ran: true, pushed: 0, failed: 1 });
    const failed = (
      await h.admin.query<{ mirror: { lastError: string } }>(
        `SELECT mirror FROM registry_versions WHERE mirror->>'status' = 'failed'
           AND mirror->>'url' LIKE '%nowhere%'`,
      )
    ).rows;
    expect(failed).toHaveLength(1);
    expect(failed[0]?.mirror.lastError).not.toContain(CREDS.token);
    const all = (
      await h.admin.query<{ m: string }>(`SELECT mirror::text AS m FROM registry_versions`)
    ).rows;
    expect(all.some((r) => r.m?.includes(CREDS.token))).toBe(false);
  });

  it("a new remote gets the whole catalog; an existing tag is never moved", async () => {
    const url = git.repo("second");
    await setMirror(url);
    clock = new Date(clock.getTime() + 7 * 3600_000);
    expect(await mirror.sweep()).toMatchObject({ ran: true, pushed: 4, failed: 0 });
    // Back to the first remote: already there, nothing rewritten (existing tags count as pushed).
    const first = path.join(git.root, "catalog.git");
    const head = execFileSync("git", ["rev-parse", "main"], { cwd: first, encoding: "utf8" });
    await setMirror(`${git.origin}/catalog.git`);
    expect(await mirror.sweep()).toMatchObject({ ran: true, failed: 0 });
    const pushedAgain = await audits("registry.mirror.pushed");
    expect(pushedAgain.filter((t) => t.existing === true).length).toBeGreaterThanOrEqual(3);
    const after = execFileSync("git", ["rev-list", "main"], { cwd: first, encoding: "utf8" });
    expect(after).toContain(head.trim());
  });

  it("is for Site admins only", async () => {
    expect((await member.get("/v1/site/skills/registry/mirror")).status).toBe(403);
    expect((await member.post("/v1/site/skills/registry/mirror/retry", {})).status).toBe(403);
    await setMirror(null);
    expect((await admin.post("/v1/site/skills/registry/mirror/retry", {})).status).toBe(409);
  });
});
