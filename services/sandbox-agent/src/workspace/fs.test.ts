import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conflictCopyName,
  ensureParents,
  lockServerOwned,
  renameWithin,
  truncateUtf8,
} from "./fs.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "kobe-fs-"));
  dirs.push(d);
  return d;
}

describe("workspace fs helpers", () => {
  it("keeps conflict-copy names within one path segment (255 bytes), never splitting a character", async () => {
    const root = await dir();
    const long = `${"é".repeat(120)}.markdown`; // 249 bytes
    const name = await conflictCopyName(root, `notes/${long}`, new Date("2026-10-03T12:00:00Z"));
    const segment = name.split("/").at(-1) ?? "";
    expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(255);
    expect(segment).toMatch(/^é+\.conflict-20261003T120000Z\.markdown$/);
    expect(truncateUtf8("aé", 2)).toBe("a");
  });

  it("never chmods through a symlinked read-only area", async () => {
    const root = await dir();
    const outside = await dir();
    await writeFile(path.join(outside, "f"), "x", { mode: 0o644 });
    await symlink(outside, path.join(root, "uploads"));
    await lockServerOwned(root, ["uploads/"]);
    expect((await stat(path.join(outside, "f"))).mode & 0o777).toBe(0o644);
    expect((await stat(outside)).mode & 0o200).not.toBe(0);
  });

  it("refuses renames whose parents go through a link", async () => {
    const root = await dir();
    const outside = await dir();
    await mkdir(path.join(root, "a"));
    await writeFile(path.join(root, "a/f"), "x");
    await symlink(outside, path.join(root, "out"));
    await expect(renameWithin(root, "a/f", "out/f")).rejects.toThrow(/link/);
    expect((await lstat(path.join(root, "a/f"))).isFile()).toBe(true);
  });

  it("never leaves a directory of a read-only area group-writable, not even while it is filled (KOBE-162)", async () => {
    const root = await dir();
    await ensureParents(root, "projects/acme/docs/a.md");
    for (const rel of ["projects", "projects/acme", "projects/acme/docs"]) {
      // Owner-only write: a Pi or tool uid holds the workspace group, so a group bit would be a hole.
      expect((await stat(path.join(root, rel))).mode & 0o022, rel).toBe(0);
    }
    // Sandbox-owned folders stay shared (D13).
    await ensureParents(root, "mine/x.txt");
    expect((await stat(path.join(root, "mine"))).mode & 0o020).not.toBe(0);
  });

  it("moves a read-only area root another uid put in its place out of the way (KOBE-162)", async () => {
    const root = await dir();
    await mkdir(path.join(root, "projects/acme"), { recursive: true });
    await writeFile(path.join(root, "projects/acme/fake.md"), "planted");
    // A tool renamed the real folder and made its own: it is not owned by the agent's uid.
    const real = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(real + 1);
    await ensureParents(root, "projects/acme/brief.md");
    vi.restoreAllMocks();
    const names = (await readdir(root)).sort();
    expect(names).toHaveLength(2);
    const aside = names.find((n) => n !== "projects") ?? "";
    expect(aside).toMatch(/^projects\.replaced-/);
    expect(await readFile(path.join(root, aside, "acme/fake.md"), "utf8")).toBe("planted");
    expect(await readdir(path.join(root, "projects/acme"))).toEqual([]);
  });
});
