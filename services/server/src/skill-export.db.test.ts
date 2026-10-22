import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVENANCE_API_VERSION, provenanceSchema } from "@kobe/protocol";
import { skillPackageHashes } from "@kobe/protocol/node";
import { validateZipBundle } from "./skills/bundle.js";
import { ensureObject } from "./skills/kobe-seed.js";
import { mirrorHttpClient } from "./skills/mirror/http-client.js";
import { sha256Hex } from "./skills/storage.js";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { selfSignedCert, startConnectProxy } from "./testing/git-http-server.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { CASES, manifest, skillMd } from "./testing/registry-fixtures.js";

/**
 * KOBE-345 (SK30): exports. A visible team or personal version as a portable zip (with or
 * without evals/) under one `<name>/` folder, only once approved and never blocklisted; a
 * catalog version's portable zip for members, its full package (kobe.skill.yaml, provenance.json)
 * for Site catalog managers only, hashing back to the recorded hashes. Deterministic bytes; an
 * export round-trips through the governed import (KOBE-344).
 */
const team = randomUUID();
const otherTeam = randomUUID();
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
let h: Harness;
let builder: TestBrowser;
let outsider: TestBrowser;
let admin: TestBrowser;
let builderId = "";
let adminId = "";
let cert: { key: string; cert: string };
let served = new Uint8Array();
let fileServer: Server;
let proxy: Awaited<ReturnType<typeof startConnectProxy>>;
const dirs: string[] = [];
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const upload = (name: string, semver: string) =>
  new RawBody(
    zipSync({
      "SKILL.md": strToU8(skillMd(name)),
      "kobe.skill.yaml": strToU8(manifest(name, semver)),
      "scripts/run.py": strToU8("print('hi')\n"),
      "evals/cases.yaml": strToU8(CASES),
    }),
    "application/zip",
  );

/** Unzips an export: path → bytes, and the folder every entry sits in. */
function unpack(zip: Uint8Array): { folder: string; files: Map<string, Uint8Array> } {
  const entries = Object.entries(unzipSync(zip));
  const folders = new Set(entries.map(([p]) => p.split("/")[0]));
  expect(folders.size).toBe(1);
  const folder = [...folders][0] as string;
  return {
    folder,
    files: new Map(entries.map(([p, b]) => [p.slice(folder.length + 1), b])),
  };
}

async function teamVersion(name: string): Promise<{ skillId: string }> {
  const res = await builder.post(`/v1/skills?scope=team`, upload(name, "1.0.0"));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { skillId: res.json.skill.id as string };
}

async function approve(skillId: string) {
  await h.admin.query(
    `UPDATE team_skill_reviews SET status = 'approved', reviewed_by = $2, reviewed_at = now()
      WHERE skill_id = $1`,
    [skillId, builderId],
  );
}

/** A published catalog version with its package stored and a valid provenance. */
async function catalogVersion(
  name: string,
  semver: string,
): Promise<{ id: string; skillId: string }> {
  const skill = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'S.') RETURNING id`,
    [name],
  );
  const skillId = skill.rows[0]?.id as string;
  const valid = validateZipBundle(
    zipSync({
      "SKILL.md": strToU8(skillMd(name)),
      "kobe.skill.yaml": strToU8(manifest(name, semver)),
      "evals/cases.yaml": strToU8(CASES),
    }),
  );
  if (!valid.ok) throw new Error(valid.error.message);
  const b = valid.value;
  const runtimeHash = sha256Hex(b.zip);
  const runtimeKey = await ensureObject(blobs, b.zip, runtimeHash);
  const packageKey = b.packageZip ? await ensureObject(blobs, b.packageZip, b.packageHash) : null;
  const at = new Date().toISOString();
  const provenance = provenanceSchema.parse({
    apiVersion: PROVENANCE_API_VERSION,
    name,
    version: semver,
    hashes: { runtime: runtimeHash, package: b.packageHash },
    source: { scope: "team", teamId: team, skillId: randomUUID(), seq: 1, semver },
    submitter: { userId: builderId, at },
    fromConversation: false,
    origin: {
      kind: "git",
      url: "https://git.test/acme/skills.git",
      commit: "c".repeat(40),
      fetchedSha256: "d".repeat(64),
      modified: true,
    },
    scan: {
      scanner: { name: "kobe-skill-scanner", version: "1", rulesVersion: "1" },
      verdict: "pass",
      findings: [],
    },
    createdAt: at,
  });
  const r = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
       scan, verdict, submitted_by, state, reviewed_by, approved_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, '{}', $8, '{}', '{"findings": []}', 'pass', $9,
       'approved', $10, now()) RETURNING id`,
    [
      skillId,
      semver,
      runtimeHash,
      b.packageHash,
      runtimeKey,
      b.zip.length,
      packageKey,
      JSON.stringify(provenance),
      builderId,
      adminId,
    ],
  );
  return { id: r.rows[0]?.id as string, skillId };
}

beforeAll(async () => {
  cert = selfSignedCert("files.test");
  fileServer = createServer({ key: cert.key, cert: cert.cert }, (_req, res) =>
    res.writeHead(200).end(served),
  );
  fileServer.listen(0, "127.0.0.1");
  await once(fileServer, "listening");
  proxy = await startConnectProxy({
    accept: () => true,
    upstreamPort: (fileServer.address() as AddressInfo).port,
  });
  h = await openHarness({ blobs }, () => ({
    skillImport: {
      http: (url: string, deadlineAt: number) =>
        mirrorHttpClient({
          deadlineAt,
          remote: url,
          credentials: null,
          proxy: { url: proxy.url, token: () => "t" },
          ca: cert.cert,
        }),
    },
  }));
  builderId = await h.createUser("builder@export.test");
  const outsiderId = await h.createUser("outsider@export.test");
  adminId = await h.createUser("admin@export.test", "admin");
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'exp', 'Exp'), ($2, 'oth', 'Oth')`,
    [team, otherTeam],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder'), ($3, $4, 'builder')`,
    [team, builderId, otherTeam, outsiderId],
  );
  builder = await h.signIn("builder@export.test");
  outsider = await h.signIn("outsider@export.test");
  admin = await h.signIn("admin@export.test");
  for (const [who, t] of [
    [builder, team],
    [outsider, otherTeam],
  ] as const) {
    expect((await who.put("/v1/me/teams/active", { teamId: t })).status).toBe(200);
    who.team = t;
  }
  await admin.put("/v1/site/skills/registry/settings", { importAllowlist: ["files.test"] });
});

afterAll(async () => {
  await h?.close();
  proxy?.close();
  fileServer?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("exports (KOBE-345)", () => {
  it("exports an approved team version as a portable zip, deterministic, for those who see it (ac-1, ac-3)", async () => {
    const { skillId } = await teamVersion("report");
    const url = `/v1/skills/${skillId}/versions/1/export?format=portable`;
    expect((await builder.get(url)).status).toBe(409);
    await approve(skillId);
    const res = await builder.get(url);
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("x-kobe-sha256")).toBe(sha256(res.bytes));
    const { folder, files } = unpack(res.bytes);
    expect(folder).toBe("report");
    expect([...files.keys()].sort()).toEqual(["SKILL.md", "scripts/run.py"]);
    // Same version, same bytes.
    expect(sha256((await builder.get(url)).bytes)).toBe(sha256(res.bytes));
    const evals = unpack(
      (await builder.get(`/v1/skills/${skillId}/versions/1/export?format=portable_evals`)).bytes,
    );
    expect([...evals.files.keys()].sort()).toEqual([
      "SKILL.md",
      "evals/cases.yaml",
      "scripts/run.py",
    ]);
    // It unpacks into .agents/skills/<name>/ (and is a Pi --skill dir) as is.
    const root = mkdtempSync(path.join(tmpdir(), "kobe-export-"));
    dirs.push(root);
    for (const [p, b] of files) {
      const dest = path.join(root, ".agents/skills", folder, p);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, b);
    }
    const md = readFileSync(path.join(root, ".agents/skills/report/SKILL.md"), "utf8");
    expect(md).toMatch(/^---\nname: report\n/);
    // Others can't see it; the full package is the catalog's; audited.
    expect((await outsider.get(url)).status).toBe(404);
    expect(
      (await builder.get(`/v1/skills/${skillId}/versions/1/export?format=package`)).status,
    ).toBe(400);
    const audit = await h.admin.query<{ target: Record<string, unknown>; team_id: string }>(
      `SELECT target, team_id FROM audit_log WHERE action = 'skill.exported' ORDER BY seq`,
    );
    expect(audit.rows[0]).toMatchObject({
      team_id: team,
      target: { scope: "team", name: "report", format: "portable", sha256: sha256(res.bytes) },
    });
  });

  it("refuses a blocklisted version", async () => {
    const { skillId } = await teamVersion("blocked-one");
    await approve(skillId);
    const hash = (
      await h.admin.query<{ content_hash: string }>(
        `SELECT content_hash FROM team_skill_versions WHERE skill_id = $1`,
        [skillId],
      )
    ).rows[0]?.content_hash;
    await h.admin.query(
      `INSERT INTO skill_blocklist (content_hash, reason, added_by) VALUES ($1, 'bad', $2)`,
      [hash, builderId],
    );
    expect(
      (await builder.get(`/v1/skills/${skillId}/versions/1/export?format=portable`)).status,
    ).toBe(422);
  });

  it("round-trips through the governed import: same files, the export's hash as the origin", async () => {
    const { skillId } = await teamVersion("roundtrip");
    await approve(skillId);
    const res = await builder.get(`/v1/skills/${skillId}/versions/1/export?format=portable_evals`);
    served = new Uint8Array(res.bytes);
    const imported = await builder.post("/v1/skills/drafts/import", {
      kind: "zip",
      url: "https://files.test/roundtrip.zip",
      sha256: sha256(res.bytes),
    });
    expect(imported.status, JSON.stringify(imported.json)).toBe(201);
    expect(imported.json.draft.origin).toMatchObject({
      kind: "zip",
      fetchedSha256: sha256(res.bytes),
    });
    const draft = await builder.get(`/v1/skills/drafts/${imported.json.draft.id}`);
    const exported = unpack(res.bytes).files;
    expect((draft.json.files as { path: string }[]).map((f) => f.path).sort()).toEqual(
      [...exported.keys()].sort(),
    );
    for (const [p, b] of exported) {
      const got = await builder.get(`/v1/skills/drafts/${imported.json.draft.id}/files/${p}`);
      expect(Buffer.from(got.bytes).equals(Buffer.from(b)), p).toBe(true);
    }
  });

  it("exports a catalog version: package for Site catalog managers, hashing back; portable for members (ac-2, ac-3)", async () => {
    const v = await catalogVersion("ledger", "1.2.0");
    const site = `/v1/site/skills/registry/versions/${v.id}/export?format=package`;
    expect((await builder.get(site)).status).toBe(403);
    const pkg = await admin.get(site);
    expect(pkg.status, pkg.text).toBe(200);
    const { folder, files } = unpack(pkg.bytes);
    expect(folder).toBe("ledger");
    expect(files.has("kobe.skill.yaml")).toBe(true);
    const provenance = provenanceSchema.parse(
      JSON.parse(new TextDecoder().decode(files.get("provenance.json"))),
    );
    expect(provenance.origin).toMatchObject({ commit: "c".repeat(40), modified: true });
    const row = (
      await h.admin.query<{ runtime_hash: string; package_hash: string }>(
        `SELECT runtime_hash, package_hash FROM registry_versions WHERE id = $1`,
        [v.id],
      )
    ).rows[0];
    expect(skillPackageHashes(files, { kobeProvenance: true })).toEqual({
      runtimeHash: row?.runtime_hash,
      packageHash: row?.package_hash,
    });
    // No names or emails leave: only ids.
    expect(new TextDecoder().decode(pkg.bytes)).not.toMatch(/@export\.test/);
    const member = `/v1/skills/catalog/${v.skillId}/versions/1.2.0/export?format=portable`;
    const portable = await builder.get(member);
    expect(portable.status, portable.text).toBe(200);
    expect([...unpack(portable.bytes).files.keys()]).toEqual(["SKILL.md"]);
    // Blocked in the team, suspended: refused.
    await h.admin.query(
      `INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by) VALUES ($1, $2, $3)`,
      [team, v.skillId, builderId],
    );
    expect((await builder.get(member)).status).toBe(422);
    await h.admin.query(`UPDATE registry_versions SET suspended_at = now() WHERE id = $1`, [v.id]);
    expect((await admin.get(site)).status).toBe(404);
  });

  it("refuses archived catalog skills, keeps deprecated versions, and rate-limits (review)", async () => {
    const v = await catalogVersion("archivable", "1.0.0");
    const site = `/v1/site/skills/registry/versions/${v.id}/export?format=package`;
    const member = `/v1/skills/catalog/${v.skillId}/versions/1.0.0/export?format=portable`;
    await h.admin.query(`UPDATE registry_versions SET state = 'deprecated' WHERE id = $1`, [v.id]);
    expect((await builder.get(member)).status).toBe(200);
    await h.admin.query(`UPDATE registry_skills SET status = 'archived' WHERE id = $1`, [
      v.skillId,
    ]);
    expect((await builder.get(member)).status).toBe(404);
    expect((await admin.get(site)).status).toBe(404);
    // The catalog package: at most 10 a minute per manager (404s count too).
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await admin.get(site)).status);
    expect(statuses).toContain(429);
    // Member exports: 30 a minute.
    const many: number[] = [];
    for (let i = 0; i < 32; i++) many.push((await builder.get(member)).status);
    expect(many).toContain(429);
  });
});
