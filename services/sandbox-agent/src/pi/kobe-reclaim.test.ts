import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * kobe-reclaim (images/sandbox/runas) run as the current user on a scratch tree (KOBE-196): the
 * code caches Pi trusts are deleted instead of being opened to the workspace group. GNU find/stat
 * are needed, so Linux only (CI); the real-helper suite runs it as a Pi identity.
 */
const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../images/sandbox/runas/kobe-reclaim.sh",
);
const gid = process.getgid?.() ?? 0;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-reclaim-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const reclaim = () => spawnSync("sh", [SCRIPT, String(gid), dir], { encoding: "utf8" });

describe.skipIf(process.platform !== "linux")("kobe-reclaim code caches (KOBE-196)", () => {
  it("deletes jiti/ and node-compile-cache/ the uid owns, and opens the rest to the group", async () => {
    await mkdir(path.join(dir, "jiti"), { mode: 0o700 });
    await writeFile(path.join(dir, "jiti", "kobe-exec-index.abc.mjs"), "x", { mode: 0o600 });
    await mkdir(path.join(dir, "node-compile-cache", "v22"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, "scratch.txt"), "y", { mode: 0o600 });
    const result = reclaim();
    expect(result.status).toBe(0);
    expect(existsSync(path.join(dir, "jiti"))).toBe(false);
    expect(existsSync(path.join(dir, "node-compile-cache"))).toBe(false);
    const info = await stat(path.join(dir, "scratch.txt"));
    expect(info.mode & 0o070).toBe(0o060);
    expect(info.gid).toBe(gid);
  });

  it("leaves a link of that name alone (it never follows one)", async () => {
    await mkdir(path.join(dir, "elsewhere"));
    await writeFile(path.join(dir, "elsewhere", "f"), "z");
    await symlink(path.join(dir, "elsewhere"), path.join(dir, "jiti"));
    expect(reclaim().status).toBe(0);
    expect((await lstat(path.join(dir, "jiti"))).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(dir, "elsewhere", "f"))).toBe(true);
  });
});
