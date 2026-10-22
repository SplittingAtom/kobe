import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import type { HttpClient } from "isomorphic-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provenanceSchema } from "@kobe/protocol";
import { mirrorHttpClient } from "./skills/mirror/http-client.js";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import {
  selfSignedCert,
  startConnectProxy,
  startGitServer,
  type GitServer,
} from "./testing/git-http-server.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { CASES, GOLDEN, manifest, promoteTeamVersion } from "./testing/registry-fixtures.js";

/**
 * KOBE-344 (SK30, U37): governed import. Only the Site's allowlist (default none, hosts or
 * host/owner), Builders only, a git commit by SHA (never a ref) or a zip pinned by SHA-256,
 * fetched once through a CONNECT proxy standing in for the egress proxy, re-hashed and checked
 * like an upload, into a private draft with its origin; nothing is fetched afterwards.
 */
const team = randomUUID();
let h: Harness;
let git: GitServer;
let zipServer: Server;
let builder: TestBrowser;
let member: TestBrowser;
let lead: TestBrowser;
let admin: TestBrowser;
let builderId = "";
let gitProxy: Awaited<ReturnType<typeof startConnectProxy>>;
let zipProxy: Awaited<ReturnType<typeof startConnectProxy>>;
let cert: { key: string; cert: string };
let zipBytes: Uint8Array;
const GIT_URL = "https://git.test/acme/skills.git";
const ZIP_URL = "https://files.test/acme/pdf.zip";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Does ${name} things. Use when asked about ${name}.\n---\n# ${name}\n${body}\n`;
const fetches = () => gitProxy.connects.length + zipProxy.connects.length;

/**
 * A host that refuses a bare SHA in a want, like servers without allowReachableSHA1InWant over
 * a stateful protocol: this test's "nosha" repositories answer any shallow fetch with an error.
 */
function refuseShaFor(url: string, http: HttpClient): HttpClient {
  if (!url.includes("/nosha")) return http;
  return {
    async request(req) {
      const chunks: Uint8Array[] = [];
      for await (const c of req.body ?? []) chunks.push(c);
      const body = Buffer.concat(chunks);
      if (body.includes("deepen "))
        return { url: req.url, statusCode: 500, statusMessage: "no", headers: {} };
      return http.request({
        ...req,
        body: (async function* () {
          yield new Uint8Array(body);
        })(),
      });
    },
  };
}

/** Commits files into the served `acme/skills` repository; returns the commit SHA. */
function commit(
  files: Record<string, string>,
  opts: { symlink?: [string, string]; repo?: string } = {},
): string {
  const work = mkdtempSync(path.join(git.root, "work-"));
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: git.root, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  run(["clone", "--quiet", path.join(git.root, `${opts.repo ?? "acme/skills"}.git`), "."]);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    writeFileSync(path.join(work, p), text);
  }
  if (opts.symlink) symlinkSync(opts.symlink[1], path.join(work, opts.symlink[0]));
  run(["add", "-A"]);
  run(["-c", "user.name=o", "-c", "user.email=o@x", "commit", "-qm", "c"]);
  run(["push", "-q", "origin", "HEAD:main"]);
  return run(["rev-parse", "HEAD"]);
}

async function allow(entries: string[]) {
  const r = await admin.put("/v1/site/skills/registry/settings", { importAllowlist: entries });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

const importGit = (who: TestBrowser, commitSha: string, extra: Record<string, unknown> = {}) =>
  who.post("/v1/skills/drafts/import", { kind: "git", url: GIT_URL, commit: commitSha, ...extra });

beforeAll(async () => {
  cert = selfSignedCert("git.test");
  const zipCert = selfSignedCert("files.test");
  git = await startGitServer({ tls: cert });
  mkdirSync(path.join(git.root, "acme"), { recursive: true });
  git.repo("acme/skills");
  zipBytes = zipSync({ "SKILL.md": strToU8(skillMd("pdf", "From a zip.")) });
  zipServer = createServer({ key: zipCert.key, cert: zipCert.cert }, (req, res) => {
    if (req.url === "/acme/pdf.zip") res.writeHead(200).end(zipBytes);
    else if (req.url === "/acme/slow.zip") {
      // Trickles: never idle long enough for a timeout, but never done before the deadline.
      res.writeHead(200);
      const t = setInterval(() => res.write(Buffer.alloc(16)), 200);
      res.on("close", () => clearInterval(t));
    } else if (req.url === "/acme/moved.zip")
      res.writeHead(302, { location: "https://evil.example.org/x.zip" }).end();
    else res.writeHead(404).end();
  });
  zipServer.listen(0, "127.0.0.1");
  await once(zipServer, "listening");
  const accept = (auth: string | undefined) => auth === "Bearer site-import";
  gitProxy = await startConnectProxy({ accept, upstreamPort: Number(new URL(git.origin).port) });
  zipProxy = await startConnectProxy({
    accept,
    upstreamPort: (zipServer.address() as AddressInfo).port,
  });
  h = await openHarness({ blobs: { objects: new MemoryObjects(), prefix: "kobe/" } }, () => ({
    skillImport: {
      deadlineMs: 3_000,
      http: (url: string, deadlineAt: number) =>
        refuseShaFor(
          url,
          mirrorHttpClient({
            deadlineAt,
            remote: url,
            credentials: null,
            proxy: {
              url: new URL(url).hostname === "files.test" ? zipProxy.url : gitProxy.url,
              token: () => "site-import",
            },
            ca: [cert.cert, zipCert.cert],
          }),
        ),
    },
  }));
  const ids = await Promise.all(
    ["builder", "member", "lead"].map((n) => h.createUser(`${n}@import.test`)),
  );
  builderId = ids[0] ?? "";
  await h.createUser("admin@import.test", "admin");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'imp', 'Imp')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder'), ($1, $3, 'member'),
       ($1, $4, 'team_admin')`,
    [team, ids[0], ids[1], ids[2]],
  );
  builder = await h.signIn("builder@import.test");
  member = await h.signIn("member@import.test");
  lead = await h.signIn("lead@import.test");
  admin = await h.signIn("admin@import.test");
  for (const who of [builder, member, lead]) {
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
  }
});

afterAll(async () => {
  await h?.close();
  await git?.close();
  gitProxy?.close();
  zipProxy?.close();
  zipServer?.close();
});

describe("governed import (KOBE-344)", () => {
  it("refuses everything by default, other owners, members, and refs instead of SHAs (ac-1)", async () => {
    const sha = commit({ "skills/pdf/SKILL.md": skillMd("pdf", "v1") });
    expect((await importGit(builder, sha)).status).toBe(403);
    await allow(["git.test/other"]);
    const other = await importGit(builder, sha);
    expect(other.status).toBe(403);
    expect(other.json.code).toBe("import_not_allowed");
    await allow(["git.test/acme", "files.test"]);
    expect((await importGit(member, sha)).status).toBe(403);
    expect((await importGit(builder, "main")).status).toBe(400);
    expect((await importGit(builder, sha.slice(0, 12))).status).toBe(400);
    expect(fetches()).toBe(0);
  });

  it("imports a commit's folder as a draft with origin, whatever main says later (ac-2, ac-3)", async () => {
    const v1 = commit({
      "skills/report/SKILL.md": skillMd("report", "version one"),
      "skills/report/scripts/run.py": "print(1)\n",
      "README.md": "repo readme\n",
    });
    const v2 = commit({ "skills/report/SKILL.md": skillMd("report", "version two, changed") });
    expect(v2).not.toBe(v1);
    const res = await importGit(builder, v1, { path: "skills/report" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const draft = res.json.draft as Record<string, unknown> & { id: string };
    expect(draft).toMatchObject({
      name: "report",
      startedFrom: "git",
      mine: true,
      shared: false,
      origin: {
        kind: "git",
        url: GIT_URL,
        commit: v1,
        path: "skills/report",
        importedBy: builderId,
      },
    });
    const files = await builder.get(`/v1/skills/drafts/${draft.id}`);
    expect((files.json.files as { path: string }[]).map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "scripts/run.py",
    ]);
    const md = await builder.get(`/v1/skills/drafts/${draft.id}/files/SKILL.md`);
    expect(md.text).toContain("version one");
    // Audited with the origin; nothing is fetched to read or use the draft (ac-4).
    const audit = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'skill.draft.created' AND target->>'draftId' = $1`,
      [draft.id],
    );
    expect(audit.rows[0]?.target.origin).toMatchObject({ kind: "git", commit: v1 });
    const before = fetches();
    await builder.get(`/v1/skills/drafts/${draft.id}`);
    expect(fetches()).toBe(before);
    // The origin never changes.
    const upd = await h.admin
      .query(`UPDATE skill_drafts SET origin = '{"kind":"git"}' WHERE id = $1`, [draft.id])
      .catch((e: { code?: string }) => e.code);
    expect(upd).toBe("55000");
  });

  it("refuses unknown commits, missing folders, symlinks and git-reserved names", async () => {
    expect((await importGit(builder, "f".repeat(40))).json.code).toBe("commit_not_found");
    const sha = commit({ "skills/a/SKILL.md": skillMd("a", "x") });
    expect((await importGit(builder, sha, { path: "skills/nope" })).json.code).toBe(
      "path_not_found",
    );
    const linked = commit(
      { "skills/b/SKILL.md": skillMd("b", "x") },
      { symlink: ["skills/b/link", "/etc/passwd"] },
    );
    const sym = await importGit(builder, linked, { path: "skills/b" });
    expect(sym.status).toBe(422);
    expect(sym.json.code).toBe("unsupported_entry");
    const attrs = commit({
      "skills/c/SKILL.md": skillMd("c", "x"),
      "skills/c/.gitattributes": "* text\n",
    });
    const bad = await importGit(builder, attrs, { path: "skills/c" });
    expect(bad.status).toBe(400);
    expect(String(bad.json.message)).toMatch(/\.gitattributes \(git_reserved\)/);
  });

  it("imports a zip pinned by its SHA-256, and refuses another hash or a redirect", async () => {
    const ok = await builder.post("/v1/skills/drafts/import", {
      kind: "zip",
      url: ZIP_URL,
      sha256: sha256(zipBytes),
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.draft).toMatchObject({
      name: "pdf",
      startedFrom: "upload",
      origin: { kind: "zip", url: ZIP_URL, fetchedSha256: sha256(zipBytes) },
    });
    const wrong = await builder.post("/v1/skills/drafts/import", {
      kind: "zip",
      url: ZIP_URL,
      sha256: "0".repeat(64),
    });
    expect(wrong.json.code).toBe("hash_mismatch");
    const moved = await builder.post("/v1/skills/drafts/import", {
      kind: "zip",
      url: "https://files.test/acme/moved.zip",
      sha256: sha256(zipBytes),
    });
    expect(moved.json.code).toBe("fetch_failed");
    expect(String(moved.json.message)).toMatch(/redirect/);
  });

  it("carries the origin into the saved version and the promoted catalog provenance (review)", async () => {
    const sha = commit({
      "skills/ledger/SKILL.md": skillMd("ledger", "keeps books"),
      "skills/ledger/kobe.skill.yaml": manifest("ledger", "1.0.0"),
      "skills/ledger/evals/cases.yaml": CASES,
    });
    const made = await importGit(builder, sha, { path: "skills/ledger" });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const draft = made.json.draft as { id: string; rev: number };
    const saved = await builder.request(
      "POST",
      `/v1/skills/drafts/${draft.id}/versions`,
      { destination: "team", semver: "1.0.0", changelog: "Imported." },
      { "if-match": String(draft.rev) },
    );
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    const skillId = saved.json.skill.id as string;
    const version = saved.json.version.version as number;
    const row = await h.admin.query<{ origin: Record<string, unknown>; package_hash: string }>(
      `SELECT origin, package_hash FROM team_skill_versions WHERE skill_id = $1 AND version = $2`,
      [skillId, version],
    );
    expect(row.rows[0]?.origin).toMatchObject({
      kind: "git",
      url: GIT_URL,
      commit: sha,
      path: "skills/ledger",
      importedBy: builderId,
    });
    expect(row.rows[0]?.origin).not.toHaveProperty("modified");
    // Versions are immutable: the origin too.
    const upd = await h.admin
      .query(`UPDATE team_skill_versions SET origin = NULL WHERE skill_id = $1`, [skillId])
      .catch((e: { message?: string }) => e.message);
    expect(String(upd)).toMatch(/immutable/);
    // Promotion: the team review and a fresh full eval, as the registry fixtures leave them.
    const hash = row.rows[0]?.package_hash;
    await h.admin.query(
      `INSERT INTO skill_eval_runs (team_id, started_by, subject_kind, subject_id, subject_rev,
         skill_name, package_hash, runtime_hash, bundle_key, bundle_size, mode, status, suite, limits,
         progress_total, progress_done, scorecard, finished_at)
       VALUES ($1, $2, 'team', $3, $4, 'x', $5, repeat('b', 64), 'k', 1, 'full', 'completed', '{}',
         '{}', 5, 5, $6, now())`,
      [team, builderId, skillId, version, hash, JSON.stringify({ ...GOLDEN, packageHash: hash })],
    );
    await h.admin.query(
      `UPDATE team_skill_reviews SET status = 'approved', reviewed_by = $3, reviewed_at = now()
        WHERE team_id = $1 AND skill_id = $2 AND version = $4`,
      [team, skillId, builderId, version],
    );
    // A Team admin submits directly (a Builder's request would wait for their confirmation).
    const registryVersionId = await promoteTeamVersion(lead, skillId, version);
    const prov = await h.admin.query<{ provenance: Record<string, unknown> }>(
      `SELECT provenance FROM registry_versions WHERE id = $1`,
      [registryVersionId],
    );
    // What the mirror writes as provenance.json (and export reads): it parses, origin included.
    expect(provenanceSchema.safeParse(prov.rows[0]?.provenance).success).toBe(true);
    expect(prov.rows[0]?.provenance.origin).toEqual({
      kind: "git",
      url: GIT_URL,
      commit: sha,
      path: "skills/ledger",
      fetchedSha256: (made.json.draft as { origin: { fetchedSha256: string } }).origin
        .fetchedSha256,
    });
  });

  it("bounds what a pack expands to, fetches the commit alone where the host allows it, and stops past the deadline (review)", async () => {
    // The commit alone (as GitHub serves a reachable SHA): its 40 MiB blob is refused before
    // isomorphic-git inflates it.
    git.repo("acme/big");
    const big = commit(
      { "SKILL.md": skillMd("big", "x"), "zeros.bin": "\0".repeat(40 * 1024 * 1024) },
      { repo: "acme/big" },
    );
    const bomb = await builder.post("/v1/skills/drafts/import", {
      kind: "git",
      url: "https://git.test/acme/big.git",
      commit: big,
    });
    expect(bomb.status).toBe(413);
    expect(bomb.json.code).toBe("too_large");
    // A host that refuses a bare SHA (this test's "nosha" repositories): every branch is fetched
    // and the commit read among them; a big blob anywhere on them is refused too.
    git.repo("acme/nosha");
    const url = "https://git.test/acme/nosha.git";
    const small = commit({ "SKILL.md": skillMd("small", "x") }, { repo: "acme/nosha" });
    const ok = await builder.post("/v1/skills/drafts/import", { kind: "git", url, commit: small });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.draft).toMatchObject({ name: "small", origin: { commit: small } });
    commit({ "zeros.bin": "\0".repeat(40 * 1024 * 1024) }, { repo: "acme/nosha" });
    const all = await builder.post("/v1/skills/drafts/import", { kind: "git", url, commit: small });
    expect(all.json.code).toBe("too_large");
    const started = Date.now();
    const slow = await builder.post("/v1/skills/drafts/import", {
      kind: "zip",
      url: "https://files.test/acme/slow.zip",
      sha256: "a".repeat(64),
    });
    expect(slow.json.code).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("marks a version modified when the imported draft was edited before saving (review)", async () => {
    const sha = commit({ "skills/edited/SKILL.md": skillMd("edited", "original") });
    const made = await importGit(builder, sha, { path: "skills/edited" });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const draft = made.json.draft as { id: string; rev: number };
    const put = await builder.request(
      "PUT",
      `/v1/skills/drafts/${draft.id}/files/notes.md`,
      new RawBody(new TextEncoder().encode("my own notes\n"), "text/markdown"),
      { "if-match": String(draft.rev) },
    );
    expect(put.status, JSON.stringify(put.json)).toBeLessThan(300);
    const rev = (await builder.get(`/v1/skills/drafts/${draft.id}`)).json.draft.rev as number;
    const saved = await builder.request(
      "POST",
      `/v1/skills/drafts/${draft.id}/versions`,
      { destination: "team", semver: "1.0.0", changelog: "Edited." },
      { "if-match": String(rev) },
    );
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    const row = await h.admin.query<{ origin: Record<string, unknown> }>(
      `SELECT origin FROM team_skill_versions WHERE skill_id = $1`,
      [saved.json.skill.id],
    );
    expect(row.rows[0]?.origin).toMatchObject({ commit: sha, modified: true });
  });
});
