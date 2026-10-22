import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mirrorHttpClient } from "./skills/mirror/http-client.js";
import type { TestBrowser } from "./testing/browser.js";
import {
  selfSignedCert,
  startConnectProxy,
  startGitServer,
  type GitServer,
} from "./testing/git-http-server.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

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

/** Commits files into the served `acme/skills` repository; returns the commit SHA. */
function commit(files: Record<string, string>, opts: { symlink?: [string, string] } = {}): string {
  const work = mkdtempSync(path.join(git.root, "work-"));
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: git.root, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  run(["clone", "--quiet", path.join(git.root, "acme/skills.git"), "."]);
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
    else if (req.url === "/acme/moved.zip")
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
      http: (url: string) =>
        mirrorHttpClient({
          remote: url,
          credentials: null,
          proxy: {
            url: new URL(url).hostname === "files.test" ? zipProxy.url : gitProxy.url,
            token: () => "site-import",
          },
          ca: [cert.cert, zipCert.cert],
        }),
    },
  }));
  const ids = await Promise.all(["builder", "member"].map((n) => h.createUser(`${n}@import.test`)));
  builderId = ids[0] ?? "";
  await h.createUser("admin@import.test", "admin");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'imp', 'Imp')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder'), ($1, $3, 'member')`,
    [team, ids[0], ids[1]],
  );
  builder = await h.signIn("builder@import.test");
  member = await h.signIn("member@import.test");
  admin = await h.signIn("admin@import.test");
  for (const who of [builder, member]) {
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
});
