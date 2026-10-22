import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skillPackageHashes } from "@kobe/protocol/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitServer, type GitServer } from "../../testing/git-http-server.js";
import { mirrorHttpClient } from "./http-client.js";
import { MirrorSession, MirrorVersionError, type MirrorVersionInput } from "./git-mirror.js";

const enc = (s: string) => new TextEncoder().encode(s);
const CREDS = { username: "x-access-token", token: "tok-secret-123" };
const AUTHOR = { name: "Kobe Registry", email: "registry@kobe.invalid" };

function version(name: string, semver: string, body: string, id: string): MirrorVersionInput {
  const files = new Map<string, Uint8Array>([
    ["SKILL.md", enc(`---\nname: ${name}\ndescription: test\n---\n${body}\n`)],
    ["scripts/build.py", enc("print('hi')\n")],
    ["evals/cases.yaml", enc("cases: []\n")],
    ["kobe.skill.yaml", enc(`apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: ${semver}\n`)],
    ["provenance.json", enc(`{"name":"${name}"}`)],
  ]);
  const hashes = skillPackageHashes(files, { kobeProvenance: true });
  return { registryVersionId: id, name, semver, files, ...hashes };
}

const V1 = version("quarterly-report", "1.0.0", "one", "11111111-1111-4111-8111-111111111111");
const V2 = version("quarterly-report", "1.1.0", "two", "22222222-2222-4222-8222-222222222222");
const W1 = version("weekly-digest", "0.1.0", "w", "33333333-3333-4333-8333-333333333333");

let server: GitServer;
const dirs: string[] = [];
beforeAll(async () => {
  server = await startGitServer({ credentials: CREDS });
});
afterAll(async () => {
  await server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function session(url: string): Promise<MirrorSession> {
  const dir = mkdtempSync(path.join(tmpdir(), "kobe-mirror-test-"));
  dirs.push(dir);
  const http = mirrorHttpClient({
    remote: url,
    credentials: CREDS,
    proxy: null,
    allowInsecureHttp: true,
  });
  return MirrorSession.open({ url, branch: "main", http, author: AUTHOR }, dir);
}

/** The files under `skills/<name>/` at `rev`, read back with the git CLI. */
function filesAt(repo: string, rev: string, name: string): Map<string, Uint8Array> {
  const bare = path.join(server.root, `${repo}.git`);
  const list = execFileSync("git", ["ls-tree", "-r", "--name-only", rev, `skills/${name}/`], {
    cwd: bare,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  return new Map(
    list.map((p) => [
      p.slice(`skills/${name}/`.length),
      new Uint8Array(execFileSync("git", ["show", `${rev}:${p}`], { cwd: bare })),
    ]),
  );
}

describe("MirrorSession (KOBE-343)", () => {
  it("commits and tags each version; the tag's tree hashes back to the runtime and package hashes (ac-1)", async () => {
    const url = server.repo("catalog");
    const s = await session(url);
    const a = await s.mirror(V1);
    const b = await s.mirror(W1);
    const c = await s.mirror(V2);
    expect([a.existing, b.existing, c.existing]).toEqual([false, false, false]);
    for (const [v, r] of [
      [V1, a],
      [W1, b],
      [V2, c],
    ] as const) {
      const files = filesAt("catalog", `${r.tag}^{commit}`, v.name);
      expect(skillPackageHashes(files, { kobeProvenance: true })).toEqual({
        runtimeHash: v.runtimeHash,
        packageHash: v.packageHash,
      });
      expect(server.git("catalog", ["cat-file", "-t", r.tag], { bare: true }).trim()).toBe("tag");
      expect(server.git("catalog", ["rev-parse", `${r.tag}^{commit}`], { bare: true }).trim()).toBe(
        r.commit,
      );
      expect(
        server
          .git("catalog", ["rev-parse", `${r.tag}^{commit}:skills/${v.name}`], { bare: true })
          .trim(),
      ).toBe(r.tree);
    }
    expect(a.tag).toBe("quarterly-report/v1.0.0");
    // Kobe's line-ending rule for everything under skills/.
    expect(server.git("catalog", ["show", "main:skills/.gitattributes"], { bare: true })).toBe(
      "* -text\n",
    );
    // A linear, append-only history authored by Kobe; catalog.json lists all three.
    const log = server
      .git("catalog", ["log", "--format=%H %an <%ae>", "main"], { bare: true })
      .trim()
      .split("\n");
    expect(log.map((l) => l.split(" ")[0])).toEqual([c.commit, b.commit, a.commit]);
    expect(log[0]).toContain("Kobe Registry <registry@kobe.invalid>");
    const catalog = JSON.parse(
      server.git("catalog", ["show", "main:catalog.json"], { bare: true }),
    );
    expect(Object.keys(catalog.skills["quarterly-report"].versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(catalog.skills["weekly-digest"].versions["0.1.0"].runtimeHash).toBe(W1.runtimeHash);
    // The token travelled only as Basic credentials to the mirror's own origin.
    expect(server.requests.every((r) => r.authorization?.startsWith("Basic "))).toBe(true);
  });

  it("is idempotent: a tag already there with this tree counts as pushed, nothing is rewritten", async () => {
    const url = server.repo("again");
    const first = await (await session(url)).mirror(V1);
    const head = server.git("again", ["rev-parse", "main"], { bare: true }).trim();
    const second = await (await session(url)).mirror(V1);
    expect(second).toMatchObject({ existing: true, commit: first.commit, tree: first.tree });
    expect(server.git("again", ["rev-parse", "main"], { bare: true }).trim()).toBe(head);
  });

  it("tags a commit already on the branch instead of committing twice (crash between pushes)", async () => {
    const url = server.repo("crash");
    await (await session(url)).mirror(V1);
    const tag = "quarterly-report/v1.0.0";
    // Simulate the tag push never happening.
    server.git("crash", ["tag", "-d", tag], { bare: true });
    const head = server.git("crash", ["rev-parse", "main"], { bare: true }).trim();
    const r = await (await session(url)).mirror(V1);
    expect(r).toMatchObject({ existing: false, commit: head });
    expect(server.git("crash", ["rev-parse", "main"], { bare: true }).trim()).toBe(head);
  });

  it("builds on commits others pushed and never moves a tag with other content (ac-2)", async () => {
    const url = server.repo("shared");
    await (await session(url)).mirror(V1);
    // Someone else pushes a README on top.
    const work = mkdtempSync(path.join(server.root, "other-"));
    execFileSync("git", ["clone", "--quiet", path.join(server.root, "shared.git"), work]);
    execFileSync("sh", [
      "-c",
      `cd ${work} && echo hello > README.md && git add README.md && git -c user.name=o -c user.email=o@x commit -qm readme && git push -q origin main`,
    ]);
    const theirs = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const r = await (await session(url)).mirror(V2);
    expect(server.git("shared", ["rev-parse", `${r.commit}^`], { bare: true }).trim()).toBe(theirs);
    expect(server.git("shared", ["show", "main:README.md"], { bare: true })).toBe("hello\n");
    // A tag with the same name but other content is a conflict, not an overwrite.
    const forged = { ...W1, name: "quarterly-report", semver: "1.1.0" };
    await expect((await session(url)).mirror(forged)).rejects.toBeInstanceOf(MirrorVersionError);
    expect(
      server
        .git("shared", ["rev-parse", "quarterly-report/v1.1.0^{commit}"], { bare: true })
        .trim(),
    ).toBe(r.commit);
  });

  it("fails on refused credentials without leaking the token in the error", async () => {
    const url = server.repo("auth");
    const dir = mkdtempSync(path.join(tmpdir(), "kobe-mirror-test-"));
    dirs.push(dir);
    const http = mirrorHttpClient({
      remote: url,
      credentials: { username: "x", token: "wrong-token-xyz" },
      proxy: null,
      allowInsecureHttp: true,
    });
    const err = await MirrorSession.open({ url, branch: "main", http, author: AUTHOR }, dir).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(String(err?.message)).not.toContain("wrong-token-xyz");
  });
});
